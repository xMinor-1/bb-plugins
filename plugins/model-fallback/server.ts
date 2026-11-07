// bb-plugin-model-fallback — server entry.
//
// When a turn fails on a rate limit, an overload, a 5xx or a timeout, or the
// model stops moving (reasoning or an answer open too long, or silence), the
// plugin counts down, stops the hung turn and continues the thread on the
// next model of its ladder. Only models from the allowed list that the
// thread's machine actually offers are ever used.
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { disallowedModels, LadderError, parseLadders, type Ladder } from "./src/shared/ladder";
import { createPolicy, parseRules, PolicyError, type Policy } from "./src/shared/policy";
import { THREAD_CHANGED, type ThreadState, type ThreadView } from "./src/shared/state";
import { Engine, EVENT_PAGE, type EngineConfig, type EngineSdk, type EventRow, type InputBlock, type ThreadInfo } from "./src/server/engine";
import { MESSAGE_LANGUAGES, type MessageLanguage } from "./src/server/message";

const THREAD_ID = z.string().regex(/^thr_[A-Za-z0-9]{1,64}$/);
const TICK_MS = 15_000;

export const rpcContract = defineRpcContract({
  thread_view: {
    input: z.object({ threadId: THREAD_ID }),
    output: z.custom<ThreadView>((value) => typeof value === "object" && value !== null),
  },
  thread_cancel: { input: z.object({ threadId: THREAD_ID }), output: z.object({ ok: z.literal(true) }) },
  thread_switch_now: { input: z.object({ threadId: THREAD_ID }), output: z.object({ ok: z.literal(true) }) },
  thread_return: { input: z.object({ threadId: THREAD_ID }), output: z.object({ ok: z.literal(true) }) },
});
export type RpcContract = typeof rpcContract;

function minutes(label: string, fallback: number, description: string) {
  return {
    type: "number" as const,
    label,
    description,
    default: fallback,
    experimental_schema: z.number().min(0).max(240),
  };
}

function readConfig(values: {
  allowedModels: string;
  ladders: string;
  graceSeconds: number;
  thinkingMinutes: number;
  answerMinutes: number;
  silenceMinutes: number;
  language: string;
}, log: (message: string) => void): EngineConfig {
  let policy: Policy = createPolicy([]);
  let ladders: Ladder[] = [];
  try {
    policy = createPolicy(parseRules(values.allowedModels));
    ladders = parseLadders(values.ladders);
  } catch (error) {
    // A broken setting fails closed: no switching until it is fixed.
    log(`settings rejected, switching is off: ${error instanceof PolicyError || error instanceof LadderError ? error.message : String(error)}`);
    policy = createPolicy([]);
    ladders = [];
  }
  const outside = disallowedModels(ladders, policy);
  if (outside.length > 0) log(`ladder models outside allowedModels are skipped: ${outside.join(", ")}`);
  return {
    policy,
    ladders,
    graceMs: Math.round(values.graceSeconds * 1000),
    limits: {
      thinkingMinutes: values.thinkingMinutes,
      answerMinutes: values.answerMinutes,
      silenceMinutes: values.silenceMinutes,
    },
    language: (MESSAGE_LANGUAGES as readonly string[]).includes(values.language)
      ? (values.language as MessageLanguage)
      : "English",
  };
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    allowedModels: {
      type: "string",
      label: "Allowed models",
      description:
        "One rule per line: <provider-id> <model-glob>, for example `acp-opencode corp/*`. The plugin never moves a thread to a model these rules do not allow. Empty means it never switches.",
      experimental_multiline: true,
      default: "",
      experimental_schema: z.string().max(8000).refine((value) => {
        try {
          parseRules(value);
          return true;
        } catch {
          return false;
        }
      }, "Each line must be: <provider-id> <model-glob>"),
    },
    ladders: {
      type: "string",
      label: "Fallback ladders",
      description:
        "One ladder per line: <provider-id> <model> > <model> > <model>, for example `acp-opencode corp/coder > corp/daily > corp/fast`. A turn that fails or hangs on a model continues on the next one of the first ladder that names it.",
      experimental_multiline: true,
      default: "",
      experimental_schema: z.string().max(8000).refine((value) => {
        try {
          parseLadders(value);
          return true;
        } catch {
          return false;
        }
      }, "Each line must be: <provider-id> <model> > <model>"),
    },
    graceSeconds: {
      type: "number",
      label: "Countdown, seconds",
      description: "How long the thread shows the coming switch with Cancel and Switch now before it happens. 0 switches at once.",
      default: 30,
      experimental_schema: z.number().min(0).max(600),
    },
    thinkingMinutes: minutes("Thinking limit, minutes", 7, "A model still thinking after this long counts as hung. 0 turns the check off."),
    answerMinutes: minutes("Answer limit, minutes", 6, "A model still writing one answer after this long counts as hung. 0 turns the check off."),
    silenceMinutes: minutes(
      "Silence limit, minutes",
      7,
      "A running turn with no events at all for this long counts as hung. A slow tool, command or a pending approval never does. 0 turns the check off.",
    ),
    language: {
      type: "select",
      label: "Message language",
      description: "Language of the message the plugin posts when it moves a turn to another model. The agent and the person both read it.",
      options: [...MESSAGE_LANGUAGES],
      default: "English",
    },
  });

  const kv = bb.storage.kv;
  const key = (threadId: string) => `thread:${threadId}`;

  const sdk: EngineSdk = {
    async getThread(threadId) {
      try {
        const thread = await bb.sdk.threads.get({ threadId });
        const info: ThreadInfo = {
          id: thread.id,
          providerId: thread.providerId,
          status: thread.status,
          environmentId: thread.environmentId ?? null,
          archived: thread.archivedAt !== null || thread.deletedAt !== null,
        };
        return info;
      } catch {
        return null;
      }
    },
    async listRunning() {
      return (await bb.sdk.threads.listRunning()).map((item) => ({ id: item.id, hostId: item.hostId }));
    },
    async listEvents(threadId, query, limit) {
      const page = String(Math.min(limit, EVENT_PAGE));
      const rows =
        query.order === "asc"
          ? await bb.sdk.threads.events.list({ threadId, order: "asc", afterSeq: String(query.afterSeq), limit: page })
          : await bb.sdk.threads.events.list({
              threadId,
              order: "desc",
              limit: page,
              ...(query.beforeSeq === null ? {} : { beforeSeq: String(query.beforeSeq) }),
            });
      return rows.map((row): EventRow => ({ seq: row.seq, type: row.type, createdAt: row.createdAt, data: row.data }));
    },
    async stop(threadId) {
      await bb.sdk.threads.stop({ threadId });
    },
    async setModel(threadId, model) {
      await bb.sdk.threads.update({ threadId, model });
    },
    async send(threadId, model, input: InputBlock[]) {
      await bb.sdk.threads.send({
        threadId,
        mode: "queue-if-active",
        model,
        input: input as unknown as Parameters<typeof bb.sdk.threads.send>[0]["input"],
      });
    },
    async catalog(thread) {
      if (thread.environmentId === null) throw new Error("thread has no environment yet");
      const result = await bb.sdk.providers.models({ environmentId: thread.environmentId, providerId: thread.providerId });
      return result.models.map((item) => ({ model: item.model, displayName: item.displayName }));
    },
    async hostConnected(thread, hostId) {
      try {
        let id = hostId;
        if (id === null && thread.environmentId !== null) {
          id = (await bb.sdk.environments.get({ environmentId: thread.environmentId })).hostId;
        }
        if (id === null) return false;
        return (await bb.sdk.hosts.get({ hostId: id })).status === "connected";
      } catch {
        return false;
      }
    },
    async hasQueuedRetry(threadId) {
      const rows = await bb.sdk.threads.queue.list({ threadId });
      return rows.some((row) => row.threadId === threadId && row.payload.kind === "retry");
    },
  };

  const engine = new Engine(
    sdk,
    {
      get: (threadId) => kv.get<ThreadState>(key(threadId)),
      set: (threadId, state) => kv.set(key(threadId), state),
      threadIds: async () => (await kv.list("thread:")).map((name) => name.slice("thread:".length)),
    },
    readConfig(await settings.get(), (message) => bb.log.warn(message)),
    {
      pluginId: bb.pluginId,
      now: () => Date.now(),
      publish: (threadId) => bb.realtime.publish(THREAD_CHANGED, { threadId }),
      log: (message) => bb.log.info(message),
    },
  );
  settings.onChange((next) => engine.configure(readConfig(next, (message) => bb.log.warn(message))));
  await engine.init();
  bb.onDispose(() => engine.dispose());

  bb.events.on("turn.failed", async (event) => {
    try {
      await engine.onTurnFailed({
        threadId: event.threadId,
        requestId: event.requestId,
        inputAccepted: event.inputAccepted,
        errorInfo: event.errorInfo
          ? { category: event.errorInfo.category, httpStatusCode: event.errorInfo.httpStatusCode }
          : null,
      });
    } catch (error) {
      bb.log.warn(`${event.threadId}: failed turn not handled: ${String(error)}`);
    }
  });

  bb.events.on("experimental_thread.events", async ({ thread }) => {
    try {
      await engine.onThreadEvents(thread.id);
    } catch (error) {
      bb.log.warn(`${thread.id}: events not read: ${String(error)}`);
    }
  });

  bb.background.service("watch", {
    async start(signal) {
      while (!signal.aborted) {
        try {
          await engine.tick();
        } catch (error) {
          bb.log.warn(`watch pass failed: ${String(error)}`);
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, TICK_MS);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
      }
    },
  });

  bb.rpc.register(rpcContract, {
    thread_view: ({ threadId }) => engine.view(threadId),
    thread_cancel: async ({ threadId }) => {
      await engine.cancel(threadId);
      return { ok: true as const };
    },
    thread_switch_now: async ({ threadId }) => {
      await engine.switchNow(threadId);
      return { ok: true as const };
    },
    thread_return: async ({ threadId }) => {
      await engine.returnModel(threadId);
      return { ok: true as const };
    },
  });
}
