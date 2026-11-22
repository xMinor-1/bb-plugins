// bb-plugin-automation-hub — backend.
//
// The hub keeps no schedule of its own. bb's built-in Automations plugin owns
// every automation and run; the hub reads and drives it over
// `bb.sdk.plugins.callRpc`, adds a few facts of its own in bb.storage.kv (watch
// interval, what to do when a watch fires, which chat hears about it), and:
//   - serves the Automation Hub page (overview, runs, pause, resume, run now);
//   - gives agents one tool, automation_hub_create, that previews a draft and,
//     once the person agrees, creates a scheduled job, a one-time job or a watch;
//   - forwards a watch's findings to the chat it was set up in, so the model
//     only runs when a check found something.
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";

import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

import {
  WATCH_INTERVALS,
  classify,
  cronEverySeconds,
  describeCron,
  everyText,
  agentCronTooFrequent,
  validCron,
  stripOf,
  subMinuteWrapper,
  watchCron,
  type Hours,
  type Interpreter,
  type Kind,
} from "./src/schedule";
import { recreateInput } from "./src/restore";
import { capItem, findingMessage, takeFindings } from "./src/forward";

const AUTOMATIONS = "automations";
const CHANGED = "hub-changed";
const META_KEY = "meta";
const TRASH_KEY = "trash";
const TRASH_KEEP_MS = 24 * 3_600_000;
const FORWARD_EVERY_MS = 15_000;
const FORWARD_GAP_MS = 120_000;
const OUTPUT_CAP = 4_000;
const PENDING_MAX = 20;
const SEND_FAILURES_PAUSE = 5;
const NOISE_WINDOW_MS = 30 * 60_000;
const NOISE_MAX_SENDS = 10;
const DAMAGED = "bb cannot read this automation's settings. Delete it and set it up again.";

// ---------- shapes from the built-in Automations plugin ----------

interface BbAutomation {
  id: string;
  projectId: string;
  name: string;
  enabled: boolean;
  trigger: { triggerType: "schedule"; cron: string; timezone: string } | { triggerType: "once"; runAt: number };
  execution: { mode: "agent" | "script"; prompt?: string; providerId?: string; model?: string; interpreter?: string; storedScriptPath?: string };
  createdByThreadId: string | null;
  nextRunAt: number | null;
  lastRunAt: number | null;
  runCount: number;
  lastRunStatus: "running" | "succeeded" | "failed" | "skipped" | null;
  lastRunThreadId: string | null;
  lastError: string | null;
}

interface BbRun {
  id: string;
  automationId: string;
  runMode: "agent" | "script";
  threadId: string | null;
  status: "running" | "succeeded" | "failed" | "skipped";
  trigger: "schedule" | "manual";
  skipReason: string | null;
  error: string | null;
  output: string | null;
  exitCode: number | null;
  scheduledFor: number;
  startedAt: number;
  finishedAt: number | null;
}

/** What the hub remembers about automations it created. */
interface HubMeta {
  kind: Kind;
  everySeconds?: number;
  hours?: Hours;
  onHit?: string;
  when?: string;
  forwardThreadId?: string;
  lastSeenRunAt?: number;
  lastForwardAt?: number;
  pending?: string[];
  /** Hash of the last finding, so the same output twice in a row is one finding. */
  lastHash?: string;
  /** Findings dropped because more than PENDING_MAX waited. */
  dropped?: number;
  /** Failed sends in a row; the watch pauses after SEND_FAILURES_PAUSE. */
  sendFailures?: number;
  /** When findings were sent recently, to pause a watch that fires on almost every check. */
  forwardTimes?: number[];
}
type MetaStore = Record<string, HubMeta>;

// ---------- wire shapes ----------

const itemSchema = z.object({
  id: z.string(),
  projectId: z.string(),
  projectName: z.string(),
  name: z.string(),
  enabled: z.boolean(),
  kind: z.enum(["watch", "schedule", "once"]),
  mode: z.enum(["agent", "script"]),
  status: z.enum(["running", "failed", "ok", "skipped", "never", "paused", "auto-paused", "finished"]),
  runAt: z.number().nullable(),
  cron: z.string().nullable(),
  timezone: z.string().nullable(),
  everySeconds: z.number().nullable(),
  nextRunAt: z.number().nullable(),
  lastRunAt: z.number().nullable(),
  lastRunStatus: z.string().nullable(),
  lastError: z.string().nullable(),
  lastRunThreadId: z.string().nullable(),
  createdByThreadId: z.string().nullable(),
  runCount: z.number(),
  prompt: z.string().nullable(),
  scriptPath: z.string().nullable(),
  onHit: z.string().nullable(),
  when: z.string().nullable(),
  fromHub: z.boolean(),
  strip: z.string().nullable(),
  firedRecently: z.number().nullable(),
});
export type HubItem = z.infer<typeof itemSchema>;

const runSchema = z.object({
  id: z.string(),
  status: z.string(),
  trigger: z.string(),
  threadId: z.string().nullable(),
  error: z.string().nullable(),
  skipReason: z.string().nullable(),
  output: z.string().nullable(),
  startedAt: z.number(),
  finishedAt: z.number().nullable(),
});
export type HubRun = z.infer<typeof runSchema>;

const ref = z.object({ projectId: z.string().min(1), automationId: z.string().min(1) });

export const rpcContract = defineRpcContract({
  hub_overview: { input: z.null(), output: z.object({ items: z.array(itemSchema), fetchedAt: z.number(), templates: z.array(z.object({ title: z.string(), description: z.string(), prompt: z.string() })), error: z.string().nullable() }) },
  hub_runs: { input: ref.extend({ limit: z.number().int().min(1).max(100).default(20) }), output: z.object({ runs: z.array(runSchema) }) },
  hub_pause: { input: ref, output: z.object({ ok: z.literal(true) }) },
  hub_resume: { input: ref, output: z.object({ ok: z.literal(true) }) },
  hub_run: { input: ref, output: z.object({ ok: z.literal(true) }) },
  hub_delete: { input: ref, output: z.object({ ok: z.literal(true), restorable: z.boolean() }) },
  hub_restore: { input: z.object({ automationId: z.string().min(1) }), output: z.object({ automationId: z.string() }) },
});

/** A deleted automation the page can bring back for a day: its create input and the hub's facts. */
interface TrashEntry {
  deletedAt: number;
  name: string;
  create: Record<string, unknown>;
  meta?: HubMeta;
}
type TrashStore = Record<string, TrashEntry>;


const templateSchema = z.array(z.object({ title: z.string().min(1).max(80), description: z.string().max(200).default(""), prompt: z.string().min(1).max(2000) })).max(12);

const DEFAULT_TEMPLATES = [
  { title: "Morning digest", description: "Every weekday: what changed overnight, in a few lines", prompt: "Set up an automation: every weekday at 9:00, summarise what changed overnight in my projects and tell me in this chat." },
  { title: "Weekly report", description: "Every Monday: last week's numbers in a file", prompt: "Set up an automation: every Monday morning, put together last week's report and save it as a file." },
  { title: "Watch a page", description: "Check a web page often and tell me when it changes", prompt: "Set up a watch: check a web page often and tell me as soon as it changes." },
  { title: "Watch a folder", description: "Tell me when a new file appears", prompt: "Set up a watch: tell me when a new file appears in a folder." },
];

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    templates: {
      type: "string",
      label: "Templates (JSON)",
      description:
        'Cards under "Start from a template": a JSON array of {"title","description","prompt"}. A card opens a new chat with its prompt. Empty: the built-in examples.',
      default: "",
      experimental_multiline: true,
    },
    timezone: {
      type: "string",
      label: "Time zone for new automations",
      description: "IANA name such as Europe/Moscow. Empty: the server's own time zone.",
      default: "",
    },
  });

  const log = bb.log;
  const kv = bb.storage.kv;

  async function call<T>(method: string, input: unknown): Promise<T> {
    // The built-in plugin validates its own output; the hub reads the fields it needs.
    return bb.sdk.plugins.callRpc<T>({ pluginId: AUTOMATIONS, method, input: input as never, outputSchema: z.unknown() as z.ZodType<T> });
  }

  let metaQueue: Promise<unknown> = Promise.resolve();
  function withMeta<T>(work: (meta: MetaStore) => Promise<T> | T): Promise<T> {
    const next = metaQueue.then(async () => {
      const meta = (await kv.get<MetaStore>(META_KEY)) ?? {};
      const result = await work(meta);
      await kv.set(META_KEY, meta);
      return result;
    });
    metaQueue = next.catch(() => undefined);
    return next;
  }
  const readMeta = async () => (await kv.get<MetaStore>(META_KEY)) ?? {};

  let trashQueue: Promise<unknown> = Promise.resolve();
  function withTrash<T>(work: (trash: TrashStore) => T): Promise<T> {
    const next = trashQueue.then(async () => {
      const trash = (await kv.get<TrashStore>(TRASH_KEY)) ?? {};
      const result = work(trash);
      await kv.set(TRASH_KEY, trash);
      return result;
    });
    trashQueue = next.catch(() => undefined);
    return next;
  }

  async function templates() {
    const raw = (await settings.get()).templates.trim();
    if (raw === "") return DEFAULT_TEMPLATES;
    try {
      return templateSchema.parse(JSON.parse(raw));
    } catch (error) {
      log.warn(`templates setting is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
      return DEFAULT_TEMPLATES;
    }
  }

  async function timezone(): Promise<string> {
    const set = (await settings.get()).timezone.trim();
    return set || Intl.DateTimeFormat().resolvedOptions().timeZone || "UTC";
  }

  // ---------- overview ----------

  // Run strips for watches, re-read when the automation's last run changes and at most every 10 s.
  // Manual runs do not move lastRunAt, so the age limit is what picks them up.
  const stripCache = new Map<string, { at: number; key: string; strip: string; fired: number }>();

  async function recentStrip(a: BbAutomation): Promise<{ strip: string; fired: number } | null> {
    const cached = stripCache.get(a.id);
    const key = `${a.lastRunAt}:${a.lastRunStatus}:${a.enabled}`;
    if (cached && cached.key === key && Date.now() - cached.at < 10_000) return cached;
    try {
      const { runs } = await call<{ runs: BbRun[] }>("automations_runs", { projectId: a.projectId, automationId: a.id, limit: 40 });
      const strip = stripOf(runs);
      const fired = strip.split("").filter((c) => c === "h").length;
      const entry = { at: Date.now(), key, strip, fired };
      stripCache.set(a.id, entry);
      return entry;
    } catch {
      return null;
    }
  }

  function statusOf(a: BbAutomation): HubItem["status"] {
    if (a.lastRunStatus === "running") return "running";
    if (!a.enabled) {
      if (a.trigger.triggerType === "once" && a.nextRunAt === null && a.runCount > 0) return "finished";
      if (a.lastRunStatus === "failed") return "auto-paused";
      return "paused";
    }
    if (a.lastRunStatus === "failed") return "failed";
    if (a.lastRunStatus === null) return "never";
    return a.lastRunStatus === "skipped" ? "skipped" : "ok";
  }

  function damagedItem(a: { id: string; projectId: string; name: string }, projectName: string): HubItem {
    return {
      id: a.id,
      projectId: a.projectId,
      projectName,
      name: a.name,
      enabled: false,
      kind: "schedule",
      mode: "agent",
      status: "failed",
      runAt: null,
      cron: null,
      timezone: null,
      everySeconds: null,
      nextRunAt: null,
      lastRunAt: null,
      lastRunStatus: "failed",
      lastError: DAMAGED,
      lastRunThreadId: null,
      createdByThreadId: null,
      runCount: 0,
      prompt: null,
      scriptPath: null,
      onHit: null,
      when: null,
      fromHub: false,
      strip: null,
      firedRecently: null,
    };
  }

  async function overview() {
    const [{ automations }, meta] = await Promise.all([
      call<{ automations: { automation: BbAutomation; project: { id: string; name: string } }[] }>("automations_overview", null),
      readMeta(),
    ]);
    const items: HubItem[] = [];
    for (const { automation: a, project } of automations) {
      if ("problem" in a || !a.trigger || !a.execution) {
        // bb keeps the row but cannot read its settings; show it so it can be deleted.
        items.push(damagedItem(a, project.name));
        continue;
      }
      const m = meta[a.id];
      const cron = a.trigger.triggerType === "schedule" ? a.trigger.cron : null;
      const kind = classify(a.trigger, m?.everySeconds ?? null, a.execution.mode);
      const every = m?.everySeconds ?? (cron ? cronEverySeconds(cron) : null);
      const recent = kind === "watch" ? await recentStrip(a) : null;
      items.push({
        id: a.id,
        projectId: a.projectId,
        projectName: project.name,
        name: a.name,
        enabled: a.enabled,
        kind,
        mode: a.execution.mode,
        status: statusOf(a),
        runAt: a.trigger.triggerType === "once" ? a.trigger.runAt : null,
        cron,
        timezone: a.trigger.triggerType === "schedule" ? a.trigger.timezone : null,
        everySeconds: every,
        nextRunAt: a.nextRunAt ?? (a.trigger.triggerType === "once" && a.enabled ? a.trigger.runAt : null),
        lastRunAt: a.lastRunAt,
        lastRunStatus: a.lastRunStatus,
        lastError: a.lastError,
        lastRunThreadId: a.lastRunThreadId,
        createdByThreadId: a.createdByThreadId,
        runCount: a.runCount,
        prompt: a.execution.mode === "agent" ? (a.execution.prompt ?? null) : null,
        scriptPath: a.execution.mode === "script" ? (a.execution.storedScriptPath ?? null) : null,
        onHit: m?.onHit ?? null,
        when: m?.when ?? null,
        fromHub: m !== undefined,
        strip: recent?.strip ?? null,
        firedRecently: recent?.fired ?? null,
      });
    }
    return items;
  }

  const publish = () => bb.realtime.publish(CHANGED, { at: Date.now() });

  bb.rpc.register(rpcContract, {
    hub_overview: async () => {
      const t = await templates();
      try {
        return { items: await overview(), fetchedAt: Date.now(), templates: t, error: null };
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        log.warn(`overview failed: ${message}`);
        // The panel words it in the person's language; this is the cause only.
        return { items: [], fetchedAt: Date.now(), templates: t, error: message };
      }
    },
    hub_runs: async ({ projectId, automationId, limit }) => {
      const { runs } = await call<{ runs: BbRun[] }>("automations_runs", { projectId, automationId, limit });
      return {
        runs: runs.map((r) => ({
          id: r.id,
          status: r.status,
          trigger: r.trigger,
          threadId: r.threadId,
          error: r.error,
          skipReason: r.skipReason,
          output: r.output === null ? null : r.output.slice(0, OUTPUT_CAP),
          startedAt: r.startedAt,
          finishedAt: r.finishedAt,
        })),
      };
    },
    hub_pause: async (input) => {
      await call("automations_pause", input);
      publish();
      return { ok: true as const };
    },
    hub_resume: async (input) => {
      await call("automations_resume", input);
      publish();
      return { ok: true as const };
    },
    hub_run: async (input) => {
      await call("automations_run", input);
      stripCache.delete(input.automationId);
      publish();
      return { ok: true as const };
    },
    hub_delete: async (input) => {
      // Keep enough to undo before bb forgets the automation and its script file.
      const stored = await call<Record<string, unknown>>("automations_get", input).catch((error: unknown) => {
        log.warn(`delete ${input.automationId}: could not read it first: ${error instanceof Error ? error.message : String(error)}`);
        return null;
      });
      const create = stored
        ? await recreateInput(stored, (path) =>
            readFile(path, "utf8").catch((error: unknown) => {
              log.warn(`delete ${input.automationId}: could not read its script: ${error instanceof Error ? error.message : String(error)}`);
              throw error;
            }),
          )
        : null;
      const meta = (await readMeta())[input.automationId];
      // Into the trash first: if the deletion then fails, the entry is taken out again.
      await withTrash((trash) => {
        const now = Date.now();
        for (const [id, entry] of Object.entries(trash)) if (now - entry.deletedAt > TRASH_KEEP_MS) delete trash[id];
        if (create) trash[input.automationId] = { deletedAt: now, name: String(create.name), create, ...(meta ? { meta } : {}) };
      });
      try {
        await call("automations_delete", input);
      } catch (error) {
        await withTrash((trash) => void delete trash[input.automationId]);
        throw error;
      }
      stripCache.delete(input.automationId);
      await withMeta((store) => void delete store[input.automationId]);
      publish();
      return { ok: true as const, restorable: create !== null };
    },
    hub_restore: async ({ automationId }) => {
      const entry = await withTrash((trash) => trash[automationId]);
      if (!entry) throw new Error("This automation can no longer be brought back.");
      const created = await call<{ id: string }>("automations_create", entry.create);
      if (entry.meta) {
        const meta = entry.meta;
        await withMeta((store) => {
          // Findings from before the deletion were already handled.
          store[created.id] = { ...meta, lastSeenRunAt: Date.now(), pending: [] };
        });
      }
      await withTrash((trash) => void delete trash[automationId]);
      publish();
      return { automationId: created.id };
    },
  });

  // ---------- watch findings → the chat the watch was set up in ----------

  const hashOf = (text: string) => createHash("sha256").update(text).digest("hex").slice(0, 16);
  const message = (error: unknown) => (error instanceof Error ? error.message : String(error));

  async function sendToChat(threadId: string, text: string) {
    await bb.sdk.threads.send({ threadId, mode: "auto", input: [{ type: "text", text, mentions: [] }] });
  }

  async function forwardOne(id: string, m: HubMeta, a: BbAutomation) {
    // 100 runs cover well over an hour of one-minute ticks, so a slow pass loses nothing.
    const { runs } = await call<{ runs: BbRun[] }>("automations_runs", { projectId: a.projectId, automationId: id, limit: 100 });
    const since = m.lastSeenRunAt ?? 0;
    const fresh = runs
      .filter((r) => r.startedAt > since && r.status === "succeeded" && (r.output ?? "").trim() !== "")
      .sort((x, y) => x.startedAt - y.startedAt);
    const newest = runs.reduce((acc, r) => (r.finishedAt !== null ? Math.max(acc, r.startedAt) : acc), since);
    let lastHash = m.lastHash;
    const incoming: string[] = [];
    for (const r of fresh) {
      const text = r.output!.trim();
      const hash = hashOf(text);
      if (hash === lastHash) continue; // the same output as the previous finding
      lastHash = hash;
      incoming.push(capItem(text));
    }
    const all = [...(m.pending ?? []), ...incoming];
    const dropped = (m.dropped ?? 0) + Math.max(0, all.length - PENDING_MAX);
    const pending = all.slice(-PENDING_MAX);
    const now = Date.now();
    const save = (patch: Partial<HubMeta>) =>
      withMeta((store) => {
        if (store[id]) Object.assign(store[id], { lastSeenRunAt: newest, lastHash }, patch);
      });
    if (pending.length === 0 || now - (m.lastForwardAt ?? 0) < FORWARD_GAP_MS) {
      await save({ pending, dropped });
      return;
    }
    const recent = (m.forwardTimes ?? []).filter((t) => now - t < NOISE_WINDOW_MS);
    if (recent.length >= NOISE_MAX_SENDS) {
      // A check that finds something every time is most likely broken; each finding wakes the model.
      await call("automations_pause", { projectId: a.projectId, automationId: id }).catch((error: unknown) => log.warn(`pause ${id}: ${message(error)}`));
      await sendToChat(
        m.forwardThreadId!,
        `[Automation Hub] The watch "${a.name}" found something on almost every check (${recent.length} messages in 30 minutes), so it is paused. Its check most likely prints output even when nothing changed. Tell the user and offer to fix the check; it can be turned back on on the Automation Hub page.`,
      ).catch((error: unknown) => log.warn(`noise note for ${id}: ${message(error)}`));
      await save({ pending: [], dropped: 0, forwardTimes: [], lastForwardAt: now });
      publish();
      return;
    }
    const { sent, rest } = takeFindings(pending);
    try {
      await sendToChat(m.forwardThreadId!, findingMessage(a.name, sent, rest.length + dropped, m.onHit));
    } catch (error) {
      const failures = (m.sendFailures ?? 0) + 1;
      log.warn(`could not forward findings of ${id} (${failures} in a row): ${message(error)}`);
      if (failures >= SEND_FAILURES_PAUSE) {
        // The chat is gone or refuses messages; checking further only piles up findings nobody reads.
        await call("automations_pause", { projectId: a.projectId, automationId: id }).catch((e: unknown) => log.warn(`pause ${id}: ${message(e)}`));
        publish();
      }
      await save({ pending, dropped, sendFailures: failures, lastForwardAt: now });
      return;
    }
    await save({ pending: rest, dropped: 0, sendFailures: 0, lastForwardAt: now, forwardTimes: [...recent, now] });
  }

  async function forwardFindings() {
    const meta = await readMeta();
    const watches = Object.entries(meta).filter(([, m]) => m.kind === "watch" && m.forwardThreadId);
    if (watches.length === 0) return;
    const { automations } = await call<{ automations: { automation: BbAutomation }[] }>("automations_overview", null);
    const byId = new Map(automations.map((x) => [x.automation.id, x.automation]));
    for (const [id, m] of watches) {
      const a = byId.get(id);
      if (!a) {
        await withMeta((store) => void delete store[id]);
        continue;
      }
      // One watch failing must not hold up the others.
      try {
        await forwardOne(id, m, a);
      } catch (error) {
        log.warn(`forwarding ${id} failed: ${message(error)}`);
      }
    }
  }

  bb.background.service("forward-findings", {
    async start(signal) {
      while (!signal.aborted) {
        try {
          await forwardFindings();
        } catch (error) {
          log.warn(`forwarding failed: ${error instanceof Error ? error.message : String(error)}`);
        }
        await new Promise<void>((resolve) => {
          const timer = setTimeout(resolve, FORWARD_EVERY_MS);
          signal.addEventListener("abort", () => {
            clearTimeout(timer);
            resolve();
          }, { once: true });
        });
      }
    },
  });

  // ---------- the agent tool ----------

  const TOOL = "automation_hub_create";
  const createParams = z.object({
    confirm: z.boolean().describe("false: only return the draft to show the user. true: create it, only after the user agreed to that exact draft."),
    name: z.string().min(1).max(200).describe("Short name in the user's language, as it will appear in the list"),
    kind: z.enum(["schedule", "watch", "once"]).describe("schedule: an agent task on a timetable; watch: a frequent check without the model; once: one agent task at a set time"),
    when: z.string().max(200).optional().describe("The schedule in the user's words, e.g. 'every Monday at 9:00'"),
    cron: z.string().max(100).optional().describe("schedule only: five-field cron, e.g. '0 9 * * 1'"),
    run_at: z.string().max(40).optional().describe("once only: ISO 8601 date and time with offset, e.g. 2026-11-23T09:00:00+03:00"),
    task: z.string().max(20000).optional().describe("schedule and once: the full instruction the agent gets on every run, self-contained"),
    every_seconds: z.number().int().optional().describe(`watch only: one of ${WATCH_INTERVALS.join(", ")}`),
    active_hours: z.enum(["always", "weekdays_9_19"]).optional().describe("watch only: when to check"),
    check_script: z.string().max(200000).optional().describe("watch only: the check. Prints nothing when there is nothing new; prints a short finding when there is"),
    interpreter: z.enum(["bash", "python3", "node"]).optional().describe("watch only: how to run check_script"),
    on_hit: z.string().max(2000).optional().describe("watch only: what the agent should do with a finding, in the user's words"),
  });
  type CreateArgs = z.infer<typeof createParams>;

  const HAS_OFFSET = /(?:[zZ]|[+-]\d\d:?\d\d)$/;

  function draftProblem(a: CreateArgs): string | null {
    if (a.kind === "schedule") {
      if (!a.cron || !validCron(a.cron)) return "kind schedule needs a valid five-field cron, numbers in range, e.g. '0 9 * * 1-5'.";
      if (agentCronTooFrequent(a.cron)) return "An agent task runs at most once an hour: give the minute as one number, e.g. '0 9 * * 1-5'. For frequent checks use kind watch.";
      if (!a.task) return "kind schedule needs task: the instruction for each run.";
    }
    if (a.kind === "once") {
      if (!a.run_at || Number.isNaN(Date.parse(a.run_at)) || !HAS_OFFSET.test(a.run_at.trim())) return "kind once needs run_at as ISO 8601 with the user's offset, e.g. 2026-11-23T09:00:00+03:00.";
      if (Date.parse(a.run_at) <= Date.now()) return "run_at is in the past.";
      if (!a.task) return "kind once needs task: the instruction for the run.";
    }
    if (a.kind === "watch") {
      // Watches are shell scripts; a Windows computer may have no bash for bb to run them with.
      if (process.platform === "win32") return "Watches are not available on Windows yet. Offer a schedule instead: an agent task that checks on a timetable, every hour at most often.";
      if (!a.every_seconds || !(WATCH_INTERVALS as readonly number[]).includes(a.every_seconds)) return `kind watch needs every_seconds, one of ${WATCH_INTERVALS.join(", ")}.`;
      if (!a.check_script) return "kind watch needs check_script.";
      if (!a.on_hit) return "kind watch needs on_hit: what to do with a finding.";
    }
    return null;
  }

  /** What will actually be created, worked out from the fields, not from the agent's wording. */
  function draftText(a: CreateArgs, tz: string): string {
    const lines = [`Draft automation: ${a.name}`];
    if (a.kind === "watch") {
      const script = a.check_script!.split("\n");
      lines.push("Kind: watch (a check without the model; the model runs only when it finds something)");
      lines.push(`How often: ${everyText(a.every_seconds!)}`);
      lines.push(`When: ${a.active_hours === "weekdays_9_19" ? "weekdays 9:00–19:00" : "always while bb is open"} (${tz})`);
      lines.push(`On a finding: ${a.on_hit}`);
      lines.push("Findings go to: this chat");
      lines.push(`Check (${a.interpreter ?? "bash"}, ${script.length} lines):`, ...script.slice(0, 40), ...(script.length > 40 ? ["…"] : []));
    } else if (a.kind === "once") {
      const at = new Date(Date.parse(a.run_at!)).toLocaleString("en-GB", { timeZone: tz, dateStyle: "full", timeStyle: "short" });
      lines.push("Kind: one time, an agent task");
      lines.push(`When: ${at} (${tz})`);
      lines.push(`Task: ${a.task}`);
      lines.push("Runs with: the same agent and model as this chat");
    } else {
      lines.push("Kind: on a schedule, an agent task");
      lines.push(`When: ${describeCron(a.cron!.trim())} (cron ${a.cron!.trim()}, ${tz})`);
      if (a.when) lines.push(`The user asked for: ${a.when}`);
      lines.push(`Task: ${a.task}`);
      lines.push("Runs with: the same agent and model as this chat");
    }
    return lines.join("\n");
  }

  bb.agents.registerTool({
    name: TOOL,
    description:
      "Create a recurring job, a one-time job or a frequent watch in bb from what the user asked for. Call with confirm=false first and show the draft; call with confirm=true only after the user agreed. Read the automation-hub skill before the first call.",
    presentation: { label: { pending: "Preparing an automation", completed: "Prepared an automation" } },
    parameters: createParams,
    execute: async (args, ctx) => {
      const fail = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
      const problem = draftProblem(args);
      if (problem) return fail(problem);
      const tz = await timezone();
      if (!args.confirm) {
        return {
          content: [
            {
              type: "text" as const,
              text: `${draftText(args, tz)}\n\nNothing is created yet. Check that "When" matches what the user asked; if it does not, fix the fields and call again. Then show the draft to the user in their language, say in plain words what the check of a watch does (show the code if they ask), and ask to confirm.`,
            },
          ],
        };
      }
      try {
        const thread = await bb.sdk.threads.get({ threadId: ctx.threadId });
        const projectId = (thread as { projectId: string }).projectId;
        let trigger: unknown;
        let execution: unknown;
        const meta: HubMeta = { kind: args.kind, when: args.when };
        if (args.kind === "watch") {
          const every = args.every_seconds!;
          const hours = args.active_hours ?? "always";
          const interpreter: Interpreter = args.interpreter ?? "bash";
          trigger = { triggerType: "schedule", cron: watchCron(every, hours), timezone: tz };
          const subMinute = every < 60;
          execution = {
            mode: "script",
            script: subMinute ? subMinuteWrapper(args.check_script!, interpreter, every) : args.check_script!,
            interpreter: subMinute ? "bash" : interpreter,
            timeoutMs: subMinute ? 110_000 : 120_000,
            workingDirectory: { type: "automation-storage" },
          };
          Object.assign(meta, { everySeconds: every, hours, onHit: args.on_hit, forwardThreadId: ctx.threadId, lastSeenRunAt: Date.now() });
        } else {
          const options = await bb.sdk.threads.defaultExecutionOptions({ threadId: ctx.threadId }).catch(() => null);
          const providerId = (thread as { providerId?: string }).providerId;
          if (!providerId || !options?.model) return fail("Could not read this chat's agent and model to run the task with.");
          trigger =
            args.kind === "once"
              ? { triggerType: "once", runAt: Date.parse(args.run_at!) }
              : { triggerType: "schedule", cron: args.cron!.trim(), timezone: tz };
          execution = {
            mode: "agent",
            prompt: args.task!,
            providerId,
            model: options.model,
            reasoningLevel: options.reasoningLevel || "medium",
            permissionMode: options.permissionMode ?? "auto",
            // Not the environment of this chat: it may be archived long before the automation stops.
            environment: { type: "project-default" },
          };
        }
        const created = await call<{ automation?: { id: string; nextRunAt: number | null }; id?: string; nextRunAt?: number | null }>(
          "automations_create",
          { projectId, name: args.name, enabled: true, trigger, execution, origin: "agent", createdByThreadId: ctx.threadId },
        );
        const automation = created.automation ?? (created as { id: string; nextRunAt: number | null });
        await withMeta((store) => {
          store[automation.id] = meta;
        });
        publish();
        const next = automation.nextRunAt ? new Date(automation.nextRunAt).toLocaleString("en-GB", { timeZone: tz }) : "not scheduled";
        return {
          content: [
            {
              type: "text" as const,
              text: `Created ${automation.id} (${args.name}). Next run: ${next} (${tz}). It is listed on the Automation Hub page.${args.kind === "watch" ? " Findings will arrive in this chat as messages." : ""}`,
            },
          ],
        };
      } catch (error) {
        return fail(`bb did not create the automation: ${error instanceof Error ? error.message : String(error)}`);
      }
    },
  });

  bb.agents.configure(() => ({ tools: [TOOL], skills: ["automation-hub"] }));
  log.info("loaded");
}
