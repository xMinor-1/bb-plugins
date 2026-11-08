// bb-plugin-http-data-service — server entry.
//
// The server keeps no company data. The service is reached from the host entry on
// the machine where agents run (src/host.ts); this module decides WHO may get the
// answers:
//   1. Agent tools and the skill are offered only to provider/model pairs in
//      `allowedModels`.
//   2. Each tool call checks the model of the thread's latest dispatched turn
//      (recorded by the dispatch hook), so switching models mid-thread does not
//      keep the tools working. bb does not tell a tool which turn called it.
//   3. A thread that has received the guide or an answer is marked; the dispatch
//      hook refuses to send it, or any fork down its line, to a model outside the
//      list, because the whole history would go to that model.
//   4. The panel's RPC methods answer the panel, the bb CLI and agents (bb shows
//      them all as `client`), never another plugin, and none of them returns service
//      data: the sign-in check answers only "worked" or why not. Other plugins get
//      only `setupStatus`.
//
// This guards against mistakes, not against a malicious agent: an agent with a shell
// runs as the same user as the password store and as the `bb` command (see the README).
//
// Tools are static registrations, and a build's settings arrive after the plugin is
// installed, so the methods are not separate tools: one call tool takes the method
// name, and the list reaches agents in their instructions and in the guide tool.
import { defineRpcContract, experimental_PluginRpcRefusal, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { checkResultSchema, connectionStatusSchema, hostContract, type ConnectionStatus, type FailureCode, type RequestOutput } from "./contract";
import { createPolicy, parseRules, PolicyError, type Policy } from "./src/shared/policy";
import { buildQuery, ConfigError, methodsText, normalizeBaseUrl, parseMethods, type ParamValue, type ServiceMethod } from "./src/shared/service-config";
import { setupFromStatus, setupStatusContract, setupStep } from "./src/shared/setup";

const hostIdInput = z.object({ hostId: z.string().min(1).max(200) }).strict();
const machineSchema = z.object({ id: z.string(), name: z.string(), connected: z.boolean() }).strict();
const ruleSchema = z.object({ provider: z.string(), model: z.string() }).strict();

export const rpcContract = defineRpcContract({
  machines: {
    input: z.null(),
    output: z.object({ machines: z.array(machineSchema), lastUsed: z.string().nullable() }).strict(),
  },
  config: {
    input: z.null(),
    output: z
      .object({
        name: z.string(),
        summary: z.string(),
        notice: z.string(),
        /** Short text drawn as the sidebar icon instead of the database mark; null for the mark. */
        iconText: z.string().nullable(),
        /** The address people sign in to. They do not type it. */
        address: z.string().nullable(),
        /** Why the configuration cannot be used; null when it can. */
        problem: z.string().nullable(),
        canCheck: z.boolean(),
        rules: z.array(ruleSchema),
        /** The build's plain words for who may read the data; null shows the rules. */
        rulesText: z.string().nullable(),
      })
      .strict(),
  },
  status: { input: hostIdInput, output: connectionStatusSchema },
  saveConnection: {
    input: hostIdInput.extend({ user: z.string().min(1).max(200), password: z.string().min(1).max(500).optional() }),
    output: connectionStatusSchema,
  },
  forget: { input: hostIdInput, output: connectionStatusSchema },
  checkSignIn: {
    input: hostIdInput.extend({ retry: z.boolean().optional() }),
    output: z.union([checkResultSchema, z.object({ ok: z.literal(false), code: z.literal("notConfigured"), status: z.null() }).strict()]),
  },
});

const SKILL = "http-data-service";
const TOOL_GUIDE = "data_service_guide";
const TOOL_CALL = "data_service_call";
const TOOL_NAMES = [TOOL_GUIDE, TOOL_CALL];
const DATA_TIMEOUT_MS = 120_000;
const SETUP_TIMEOUT_MS = 10_000;
const SETUP_FRESH_MS = 5_000;
const MAX_FORK_DEPTH = 100;

const paramValue = z.union([z.string().max(4000), z.number(), z.boolean(), z.array(z.union([z.string().max(1000), z.number()])).max(200)]);

interface Execution {
  providerId: string;
  model: string | null;
  at: number;
}

interface ServiceConfig {
  name: string;
  summary: string;
  notice: string;
  iconText: string | null;
  guide: string;
  baseUrl: string | null;
  methods: ServiceMethod[];
  checkMethod: ServiceMethod | null;
  problem: string | null;
}

interface RawSettings {
  serviceName: string;
  summary: string;
  notice: string;
  iconText: string;
  baseUrl: string;
  methods: string;
  checkMethod: string;
  guide: string;
}

function readConfig(raw: RawSettings): ServiceConfig {
  const problems: string[] = [];
  let baseUrl: string | null = null;
  if (raw.baseUrl.trim() === "") problems.push("The service address is not set");
  else {
    try {
      baseUrl = normalizeBaseUrl(raw.baseUrl);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  let methods: ServiceMethod[] = [];
  try {
    methods = parseMethods(raw.methods);
    if (methods.length === 0) problems.push("No methods are configured");
  } catch (error) {
    problems.push(error instanceof ConfigError ? error.message : String(error));
  }
  const checkMethod = methods.find((method) => method.name === raw.checkMethod.trim()) ?? null;
  if (methods.length > 0 && (!checkMethod || checkMethod.params.some((param) => param.required))) {
    problems.push("The check method must be one of the methods and take no required parameters");
  }
  return {
    name: raw.serviceName.trim() || "Data Service",
    summary: raw.summary.trim(),
    notice: raw.notice.trim(),
    iconText: readIconText(raw.iconText),
    guide: raw.guide,
    baseUrl,
    methods,
    checkMethod,
    problem: problems[0] ?? null,
  };
}

export const ICON_TEXT_MAX = 3;

/** The icon text, or null for the database mark: empty or longer than the icon fits. */
export function readIconText(value: string): string | null {
  const text = value.trim();
  const length = Array.from(text).length;
  return length > 0 && length <= ICON_TEXT_MAX ? text : null;
}

/** What the agent should do about a failure. Text for agents stays English. */
function failureText(name: string, output: Extract<RequestOutput, { ok: false }>): string {
  const page = `the ${name} page in the bb sidebar`;
  const detail = output.detail ? ` The service said: ${output.detail}` : "";
  const texts: Record<FailureCode, string> = {
    unauthorized: `The service refused the login or password. Signing in is paused so the account is not locked. Ask the user to update the password on ${page}. Never ask for it in chat.`,
    paused: `Signing in is paused after a refused password. Ask the user to update the password on ${page}. Never ask for it in chat.`,
    noPassword: `The user has not signed in on this machine. Ask them to enter their login and password on ${page}. Never ask for them in chat.`,
    addressChanged: `The service address changed since the user signed in. Ask them to sign in again on ${page}.`,
    forbidden: `This account has no right to this method (HTTP 403). Tell the user to ask whoever grants access.${detail}`,
    notFound: `The service has no such address (HTTP 404). Tell the user the build's configuration needs a fix.${detail}`,
    redirect: `The service answered with a redirect (HTTP ${output.status}); it is not followed so the password stays with the configured address. Tell the user the build's configuration needs a fix.`,
    badRequest: `The service rejected the request (HTTP ${output.status}).${detail}`,
    serverError: `The service failed (HTTP ${output.status}). It may be temporary. Do not make up an answer.${detail}`,
    notJson: "The service answered with something other than JSON, for example a sign-in page. Tell the user the data could not be read.",
    tls: "The service's certificate is not trusted on this machine. Tell the user; do not try to work around it.",
    unreachable: "The service cannot be reached from this machine. Ask the user whether the corporate network or VPN is on.",
    timeout: "The service did not answer in time. Try once more with a narrower request, then tell the user.",
    storeError: `This machine's password store did not answer. Ask the user to sign in again on ${page}.`,
    badAddress: "The build's service address is invalid. Tell the user the configuration needs a fix.",
  };
  return `Error: ${texts[output.code]}`;
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    serviceName: {
      type: "string",
      label: "Service name",
      description: "What people and agents call the service.",
      default: "",
      experimental_schema: z.string().max(100),
    },
    summary: {
      type: "string",
      label: "What the service answers",
      description: "One line that tells agents when to use it.",
      default: "",
      experimental_schema: z.string().max(500),
    },
    notice: {
      type: "string",
      label: "Notice on the sign-in page",
      description: "Optional: what people should know about the data they get.",
      default: "",
      experimental_multiline: true,
      experimental_schema: z.string().max(1000),
    },
    iconText: {
      type: "string",
      label: "Sidebar icon text",
      description: `Optional: up to ${ICON_TEXT_MAX} characters drawn as the sidebar icon instead of the database mark, for example the service's short name.`,
      default: "",
      experimental_schema: z.string().max(20).refine((value) => value.trim() === "" || readIconText(value) !== null, `Up to ${ICON_TEXT_MAX} characters`),
    },
    baseUrl: {
      type: "string",
      label: "Service address",
      description: "The https:// address the method paths are relative to. People do not enter it.",
      default: "",
      experimental_schema: z.string().max(500),
    },
    methods: {
      type: "string",
      label: "Methods (JSON)",
      description: "JSON list of { name, path, summary, params, reference }. See the plugin README.",
      default: "",
      experimental_multiline: true,
      experimental_schema: z.string().max(200_000),
    },
    checkMethod: {
      type: "string",
      label: "Method for the sign-in check",
      description: "A method without required parameters. The check drops its answer.",
      default: "",
      experimental_schema: z.string().max(100),
    },
    guide: {
      type: "string",
      label: "Guide for agents (Markdown)",
      description: "How to answer questions from this service. Only allowed models read it, through the guide tool.",
      default: "",
      experimental_multiline: true,
      experimental_schema: z.string().max(100_000),
    },
    allowedModelsText: {
      type: "string",
      label: "Who may read the data, in plain words",
      description: "Optional: what the sign-in page says instead of the rules below, for example \"Only agents on the company's models\". Empty shows the rules as written.",
      default: "",
      experimental_schema: z.string().max(300),
    },
    allowedModels: {
      type: "string",
      label: "Agents allowed to read the data",
      description: "One rule per line: <provider-id> <model-glob>, for example `acp-opencode corp/*`. Empty means no agent gets the tools.",
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
  });

  let policy: Policy = createPolicy([]);
  let config: ServiceConfig = readConfig({ serviceName: "", summary: "", notice: "", iconText: "", baseUrl: "", methods: "", checkMethod: "", guide: "" });
  let rulesText = "";
  const apply = (raw: RawSettings & { allowedModels: string; allowedModelsText: string }) => {
    rulesText = raw.allowedModelsText.trim();
    try {
      policy = createPolicy(parseRules(raw.allowedModels));
    } catch (error) {
      // A broken rule list fails closed: nobody gets the data until it is fixed.
      policy = createPolicy([]);
      bb.log.warn(error instanceof PolicyError ? error.message : String(error));
    }
    config = readConfig(raw);
  };
  apply(await settings.get());
  settings.onChange((next) => {
    apply(next);
    setupAnswers.clear();
  });

  const host = bb.hosts.experimental_client({ contract: hostContract });
  const kv = bb.storage.kv;
  const execKey = (threadId: string) => `exec:${threadId}`;
  const taintKey = (threadId: string) => `taint:${threadId}`;

  async function isTainted(threadId: string | null | undefined): Promise<boolean> {
    if (!threadId) return false;
    return ((await kv.get(taintKey(threadId))) ?? null) !== null;
  }
  /**
   * Whether this thread or any thread it was forked from holds the data. A fork carries its
   * parents' history, however deep. A line longer than the limit counts as holding it.
   */
  async function lineTainted(thread: { id: string; sourceThreadId?: string | null }): Promise<boolean> {
    if (await isTainted(thread.id)) return true;
    const seen = new Set([thread.id]);
    let next = thread.sourceThreadId ?? null;
    while (next) {
      if (seen.has(next)) return false;
      if (seen.size >= MAX_FORK_DEPTH) return true;
      seen.add(next);
      if (await isTainted(next)) return true;
      // A thread deleted from a marked line kept its own mark (see thread.deleted), so its end stops the walk safely.
      next = await bb.sdk.threads.get({ threadId: next }).then((parent) => parent.sourceThreadId ?? null, () => null);
    }
    return false;
  }
  const markTainted = (threadId: string) => kv.set(taintKey(threadId), { at: Date.now() });

  // ---------- Who may receive the data ----------

  bb.experimental_hooks.on("message.dispatch", async (ctx) => {
    const { providerId, model } = ctx.requestedExecution;
    const thread = ctx.thread;
    const tainted = await lineTainted(thread);
    if (tainted && !policy.allows(providerId, model)) {
      return {
        action: "reject",
        message: `This thread contains ${config.name} data, so only the allowed models can continue it. Switch back to one of them, or start a new thread.`,
      };
    }
    if (tainted && !(await isTainted(thread.id))) await markTainted(thread.id);
    // Tool calls check the model of the turn that is running, not the one the thread started with.
    await kv.set(execKey(thread.id), { providerId, model, at: Date.now() } satisfies Execution);
    return { action: "proceed" };
  });

  bb.agents.configure((ctx) => {
    if (!policy.allows(ctx.provider.id, ctx.provider.model)) return { tools: [], skills: [] };
    const about = config.summary ? ` ${config.summary}` : "";
    const methods = config.methods.map((method) => method.name).join(", ");
    return {
      tools: TOOL_NAMES,
      skills: [SKILL],
      instructions: `${config.name}:${about} Before the first question in a thread call ${TOOL_GUIDE}, then read data with ${TOOL_CALL}. If they are not listed directly, find them with your tool search before saying they are missing. Methods: ${methods || "none configured"}.`,
    };
  });

  bb.events.on("thread.deleted", async ({ thread }) => {
    await kv.delete(execKey(thread.id));
    // The mark outlives the thread: forks of it still carry its history, and bb cannot say when the last
    // one is gone. A deleted thread in the middle of a line takes the line's mark, because after this
    // nothing can walk through it. One short record per such thread.
    if (await lineTainted(thread)) await markTainted(thread.id);
  });

  /** Whether the model running this thread may read the data. */
  async function modelAllowed(threadId: string): Promise<string | null> {
    const execution = await kv.get<Execution>(execKey(threadId));
    if (execution && policy.allows(execution.providerId, execution.model)) return null;
    const who = execution ? `${execution.providerId} ${execution.model ?? "(default model)"}` : "this agent";
    return `${config.name} data is not available to ${who}. Only the allowed models can read it.`;
  }

  async function threadMachine(threadId: string): Promise<string | null> {
    const thread = await bb.sdk.threads.get({ threadId });
    if (!thread.environmentId) return null;
    return (await bb.sdk.environments.get({ environmentId: thread.environmentId })).hostId;
  }

  const toolError = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
  const toolText = (text: string) => ({ content: [{ type: "text" as const, text }], isError: false });

  // ---------- Agent tools ----------

  bb.agents.registerTool({
    name: TOOL_GUIDE,
    description: "How to answer questions from the configured data service: the rules, the list of methods with parameters, or the full reference of one method.",
    presentation: { label: { pending: "Reading the data service guide", completed: "Read the data service guide" } },
    parameters: z.object({ method: z.string().max(100).optional().describe("A method name, for its full reference. Omit for the rules and the method list.") }),
    execute: async ({ method }, ctx) => {
      const refused = await modelAllowed(ctx.threadId);
      if (refused) return toolError(refused);
      await markTainted(ctx.threadId);
      if (config.problem) return toolError(`Error: ${config.name} is not configured: ${config.problem}.`);
      if (method) {
        const found = config.methods.find((candidate) => candidate.name === method);
        if (!found) return toolError(`Error: no method "${method}". Methods: ${config.methods.map((candidate) => candidate.name).join(", ")}`);
        return toolText([`# ${found.name}`, found.summary, "", methodsText([found]), "", found.reference].join("\n").trim());
      }
      return toolText([config.guide.trim(), "", "## Methods", methodsText(config.methods)].join("\n").trim());
    },
  });

  bb.agents.registerTool({
    name: TOOL_CALL,
    description: "Read data from the configured data service. Read-only: one GET request to a configured method, signed in as the user. Returns the service's JSON as is.",
    presentation: { label: { pending: "Reading from the data service", completed: "Read from the data service" } },
    parameters: z.object({
      method: z.string().min(1).max(100).describe(`A method name from ${TOOL_GUIDE}`),
      params: z.record(z.string(), paramValue).optional().describe("The method's parameters by name"),
    }),
    execute: async ({ method, params }, ctx) => {
      const refused = await modelAllowed(ctx.threadId);
      if (refused) return toolError(refused);
      if (config.problem || !config.baseUrl) return toolError(`Error: ${config.name} is not configured: ${config.problem ?? "no address"}.`);
      const found = config.methods.find((candidate) => candidate.name === method);
      if (!found) return toolError(`Error: no method "${method}". Methods: ${config.methods.map((candidate) => candidate.name).join(", ")}`);
      let query: Record<string, string>;
      try {
        query = buildQuery(found, params as Record<string, ParamValue> | undefined);
      } catch (error) {
        return toolError(`Error: ${error instanceof Error ? error.message : String(error)}`);
      }
      const hostId = await threadMachine(ctx.threadId);
      if (!hostId) return toolError(`This thread has no machine to reach ${config.name} from yet.`);
      // Marked before the call: the thread holds company data from here on.
      await markTainted(ctx.threadId);
      const output = await host.call("request", { baseUrl: config.baseUrl, path: found.path, query }, { hostId, signal: ctx.signal, timeoutMs: DATA_TIMEOUT_MS });
      if (!output.ok) return toolError(failureText(config.name, output));
      const note = output.truncated ? "\n\n[The answer was cut at the size limit and is incomplete. Narrow the request; do not present this as all the data.]" : "";
      return toolText(`${output.text}${note}`);
    },
  });

  // ---------- The sign-in panel ----------

  /** Recent host answers for setupStatus, by machine. */
  const setupAnswers = new Map<string, { at: number; status: Promise<ConnectionStatus> }>();

  type RpcHandlers = Parameters<typeof bb.rpc.register<typeof rpcContract>>[1];
  type Handler = (input: unknown, context: Parameters<RpcHandlers["status"]>[1]) => unknown;
  /** The panel's methods are for this plugin's own panel and people, not for other plugins. */
  const ownCallers = (handlers: RpcHandlers): RpcHandlers =>
    Object.fromEntries(
      Object.entries(handlers as Record<string, Handler>).map(([name, handler]) => [
        name,
        ((input, context) => {
          if (context.experimental_caller.kind !== "client") {
            throw new experimental_PluginRpcRefusal({ code: "forbidden", message: "The data service does not answer other plugins." });
          }
          return handler(input, context);
        }) satisfies Handler,
      ]),
    ) as unknown as RpcHandlers;

  /** A change on the panel: the setup page should see it at once. */
  const changed = <T>(answer: Promise<T>): Promise<T> => answer.finally(() => setupAnswers.clear());

  const needAddress = (): string => {
    if (!config.baseUrl) throw new Error(config.problem ?? "The service address is not set");
    return config.baseUrl;
  };

  const handlers: RpcHandlers = {
    machines: async () => {
      const hosts = await bb.sdk.hosts.list();
      return {
        machines: hosts
          .filter((candidate) => candidate.lifecycle.phase !== "destroyed")
          .map((candidate) => ({ id: candidate.id, name: candidate.name, connected: candidate.status === "connected" })),
        lastUsed: (await kv.get<string>("ui:lastHost")) ?? null,
      };
    },
    config: () => ({
      name: config.name,
      summary: config.summary,
      notice: config.notice,
      iconText: config.iconText,
      address: config.baseUrl,
      problem: config.problem,
      canCheck: config.checkMethod !== null && config.problem === null,
      rules: [...policy.rules],
      rulesText: rulesText || null,
    }),
    status: async ({ hostId }) => {
      await kv.set("ui:lastHost", hostId);
      return host.call("status", { baseUrl: config.baseUrl }, { hostId, timeoutMs: 60_000 });
    },
    saveConnection: ({ hostId, user, password }) =>
      changed(host.call("saveConnection", { baseUrl: needAddress(), user, ...(password ? { password } : {}) }, { hostId, timeoutMs: 60_000 })),
    forget: ({ hostId }) => changed(host.call("forget", { baseUrl: config.baseUrl }, { hostId, timeoutMs: 60_000 })),
    checkSignIn: async ({ hostId, retry }) => {
      if (!config.baseUrl || !config.checkMethod || config.problem) return { ok: false as const, code: "notConfigured" as const, status: null };
      return changed(host.call("checkSignIn", { baseUrl: config.baseUrl, path: config.checkMethod.path, ...(retry ? { retry } : {}) }, { hostId, timeoutMs: 120_000 }));
    },
  };
  bb.rpc.register(rpcContract, ownCallers(handlers));

  // ---------- The onboarding step (src/shared/setup.ts) ----------

  async function setupMachine(requested: string | undefined): Promise<string | null> {
    if (requested) return requested;
    const hosts = (await bb.sdk.hosts.list()).filter((candidate) => candidate.lifecycle.phase !== "destroyed");
    const last = await kv.get<string>("ui:lastHost");
    if (last && hosts.some((candidate) => candidate.id === last)) return last;
    const { primaryHostId } = await bb.sdk.system.config();
    return primaryHostId ?? hosts[0]?.id ?? null;
  }

  async function setupOn(machine: string, lang: "en" | "ru") {
    const found = (await bb.sdk.hosts.list()).find((candidate) => candidate.id === machine);
    if (!found || found.lifecycle.phase === "destroyed" || found.status !== "connected") return setupStep("problem", "offline", lang);
    let cached = setupAnswers.get(machine);
    if (!cached || Date.now() - cached.at > SETUP_FRESH_MS) {
      const status = host.call("status", { baseUrl: config.baseUrl }, { hostId: machine, timeoutMs: SETUP_TIMEOUT_MS });
      cached = { at: Date.now(), status };
      setupAnswers.set(machine, cached);
      status.catch(() => setupAnswers.delete(machine));
    }
    try {
      return setupFromStatus(await cached.status, lang);
    } catch (error) {
      bb.log.info(`setupStatus: ${machine} could not read its state: ${error instanceof Error ? error.message : String(error)}`);
      return setupStep("problem", "unreadable", lang);
    }
  }

  bb.rpc.register(
    setupStatusContract,
    {
      setupStatus: async ({ lang = "en", hostId: requested }) => {
        if (!config.baseUrl) return setupStep("problem", "notConfigured", lang);
        const machine = await setupMachine(requested);
        return machine ? setupOn(machine, lang) : setupStep("problem", "noMachine", lang);
      },
    },
    { experimental_discoverable: true, experimental_description: "Data service sign-in state for a bb build's onboarding page." },
  );
}
