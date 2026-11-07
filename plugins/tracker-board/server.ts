// bb-plugin-tracker-board — server entry.
//
// A board for a REST task tracker. The tracker is reached from the host entry on
// the machine where agents run (src/host.ts), with the person's API key from that
// machine's OS store. This module holds the configuration and decides who may do what:
//   1. People change issues from the panel directly: a click there is their decision.
//      The panel's RPC methods answer the panel and the bb CLI (bb shows both as
//      `client`), never another plugin.
//   2. Agents read issues through the tools, and change them only through
//      tracker_propose_changes, which shows a confirmation form in the chat and
//      applies only what the person approves there.
//   3. Tools and the skill go only to provider/model pairs in `allowedModels`. A
//      thread that has received tracker data is marked; the dispatch hook keeps it,
//      and its forks, on allowed models. A message that mentions a task with "@"
//      is held to the same rule.
//
// This guards against mistakes, not against a malicious agent: an agent with a shell
// runs as the same user as the key store and the `bb` command (see the README).
import { experimental_PluginRpcRefusal, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { hostContract, type FailureCode, type KeyStatus } from "./contract";
import { loadBoard, loadParents, parseSource, sourceKey, type Board, type Source } from "./src/server/board";
import { apply, describe, mapLimit, plan } from "./src/server/engine";
import { rpcContract, type BoardView, type ConfigView, type IssueView, type StatusView } from "./src/server/rpc-contract";
import { Tracker, TrackerError, type StatusInfo } from "./src/server/tracker";
import { changeSchema, SKIP_TEXT, type Change, type ChangeResult, type PlannedChange } from "./src/shared/changes";
import { LIMITS } from "./src/shared/limits";
import { findKey, KEY_PATTERN, splitPrefix, type Issue, type Person } from "./src/shared/model";
import { createPolicy, parseRules, PolicyError, type Policy } from "./src/shared/policy";
import { fromExport, prefsSchema, type Prefs } from "./src/shared/prefs";
import { categoryOf, normalizeBaseUrl, parseProfile, ProfileError, type Profile } from "./src/shared/profile";
import { setupFromStatus, setupStatusContract, setupStep, type SetupLang } from "./src/shared/setup";
import { compositionOf, mergeTemplates, parseTemplates, TemplatesError, type TemplatesConfig } from "./src/shared/templates";

const SKILL = "tracker-board";
const TOOL_GUIDE = "tracker_guide";
const TOOL_SEARCH = "tracker_search";
const TOOL_GET = "tracker_get_issues";
const TOOL_PEOPLE = "tracker_people";
const TOOL_PROPOSE = "tracker_propose_changes";
const TOOL_NAMES = [TOOL_GUIDE, TOOL_SEARCH, TOOL_GET, TOOL_PEOPLE, TOOL_PROPOSE];
const CONFIRM_RENDERER = "confirm-changes";
const MENTION_PROVIDER = "issues";
const CHANGED_CHANNEL = "changed";
const CALL_TIMEOUT_MS = 90_000;
const CONFIRM_TIMEOUT_MS = 60 * 60_000;
const MAX_FORK_DEPTH = 100;
const ME_TTL_MS = 10 * 60_000;
const STATUS_TTL_MS = 60 * 60_000;
/** A tracker's own status list joins boards and menus only up to this size. */
const MAX_LISTED_STATUSES = 60;
const PEOPLE_TTL_MS = 10 * 60_000;

interface Execution {
  providerId: string;
  model: string | null;
  at: number;
}

interface Config {
  name: string;
  baseUrl: string | null;
  profile: Profile | null;
  templates: TemplatesConfig;
  guide: string;
  allowQuery: boolean;
  problem: string | null;
}

interface RawSettings {
  trackerName: string;
  baseUrl: string;
  apiProfile: string;
  templates: string;
  guide: string;
  allowQuery: boolean;
}

function readConfig(raw: RawSettings): Config {
  const problems: string[] = [];
  let baseUrl: string | null = null;
  if (raw.baseUrl.trim() === "") problems.push("The tracker address is not set");
  else {
    try {
      baseUrl = normalizeBaseUrl(raw.baseUrl);
    } catch (error) {
      problems.push(error instanceof Error ? error.message : String(error));
    }
  }
  let profile: Profile | null = null;
  try {
    profile = parseProfile(raw.apiProfile);
  } catch (error) {
    problems.push(error instanceof ProfileError ? error.message : String(error));
  }
  let templates: TemplatesConfig = { templates: [], bundles: [] };
  try {
    templates = parseTemplates(raw.templates);
  } catch (error) {
    problems.push(error instanceof TemplatesError ? error.message : String(error));
  }
  return { name: raw.trackerName.trim() || "Tracker", baseUrl, profile, templates, guide: raw.guide, allowQuery: raw.allowQuery, problem: problems[0] ?? null };
}

/**
 * An error the panel can word: `tracker-board:<code>[:<status>]`, then JSON with the
 * tracker's own words and the machine the request went from.
 */
function panelError(error: unknown, machineName: (id: string) => string): Error {
  if (error instanceof TrackerError) {
    const extra = { detail: error.detail, machine: error.machine ? machineName(error.machine) : null };
    return new Error(`tracker-board:${error.code}${error.status ? `:${error.status}` : ""} ${JSON.stringify(extra)}`);
  }
  return error instanceof Error ? error : new Error(String(error));
}

/** What the agent should do about a failure. Text for agents stays English. */
function failureText(name: string, error: unknown): string {
  if (!(error instanceof TrackerError)) return `Error: ${error instanceof Error ? error.message : String(error)}`;
  const page = `the ${name} page in the bb sidebar`;
  const detail = error.detail ? ` The tracker said: ${error.detail}` : "";
  const texts: Record<TrackerError["code"], string> = {
    unauthorized: `The tracker refused the API key. Ask the user to save a new key in the settings on ${page}. Never ask for it in chat.`,
    noKey: `The user has not saved an API key on this machine. Ask them to do it in the settings on ${page}. Never ask for it in chat.`,
    addressChanged: `The tracker address changed since the key was saved. Ask the user to save the key again on ${page}.`,
    forbidden: `This account has no right to do that (HTTP 403).${detail}`,
    notFound: `The tracker has no such issue or address (HTTP 404).${detail}`,
    conflict: `The tracker refused the change because of a conflict (HTTP 409). Read the issue again.${detail}`,
    redirect: `The tracker answered with a redirect (HTTP ${error.status}); it is not followed so the key stays with the configured address. Tell the user the configuration needs a fix.`,
    badRequest: `The tracker rejected the request (HTTP ${error.status}).${detail}`,
    serverError: `The tracker failed (HTTP ${error.status}). It may be temporary. Do not make up an answer.${detail}`,
    notJson: "The tracker answered with something other than JSON, for example a sign-in page. Tell the user the data could not be read.",
    tls: "The tracker's certificate is not trusted on this machine. Tell the user; do not try to work around it.",
    unreachable: "The tracker cannot be reached from this machine. Ask the user whether the corporate network or VPN is on.",
    timeout: "The tracker did not answer in time. Try once more, then tell the user.",
    storeError: `This machine's key store did not answer. Ask the user to save the key again on ${page}.`,
    badAddress: "The tracker address in the configuration is invalid. Tell the user the configuration needs a fix.",
    notConfigured: `The plugin's configuration cannot do this: ${error.detail ?? "a request is missing"}.`,
    badAnswer: `The tracker's answer could not be read: ${error.detail ?? "unexpected format"}.`,
  };
  return `Error: ${texts[error.code]}`;
}

const short = (text: string, max: number) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

function issueLine(issue: Issue): string {
  const parts = [
    `${issue.key} [${issue.kind}${issue.type !== issue.kind ? `/${issue.type}` : ""}] "${short(issue.summary, 200)}"`,
    `status: ${issue.statusName ? `${issue.statusName} (${issue.status})` : issue.status}`,
    `assignee: ${issue.assignee ? `${issue.assigneeName ?? "?"} (${issue.assignee})` : "nobody"}`,
  ];
  if (issue.priority) parts.push(`priority: ${issue.priority}`);
  if (issue.parent) parts.push(`parent: ${issue.parent}`);
  if (issue.labels.length > 0) parts.push(`labels: ${issue.labels.join(", ")}`);
  if (issue.due) parts.push(`due: ${issue.due}`);
  return parts.join("; ");
}

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    trackerName: {
      type: "string",
      label: "Tracker name",
      description: "What people and agents call the tracker.",
      default: "",
      experimental_schema: z.string().max(100),
    },
    baseUrl: {
      type: "string",
      label: "API address",
      description: "The https:// address the API profile's paths are relative to. People do not enter it.",
      default: "",
      experimental_schema: z.string().max(500),
    },
    apiProfile: {
      type: "string",
      label: "API profile (JSON)",
      description: "How to read and change issues in this tracker: requests, field paths, statuses. See the plugin README.",
      default: "",
      experimental_multiline: true,
      experimental_schema: z.string().max(200_000),
    },
    templates: {
      type: "string",
      label: "Templates (JSON)",
      description: "Child issue templates and bundles everyone gets. People add their own in the panel.",
      default: "",
      experimental_multiline: true,
      experimental_schema: z.string().max(200_000),
    },
    guide: {
      type: "string",
      label: "Guide for agents (Markdown)",
      description: "Conventions of your tracker: queues, statuses, what labels mean. Only allowed models read it.",
      default: "",
      experimental_multiline: true,
      experimental_schema: z.string().max(100_000),
    },
    allowQuery: {
      type: "boolean",
      label: "Boards from a search query",
      description: "Let people open a board from the tracker's own query language.",
      default: true,
    },
    allowedModels: {
      type: "string",
      label: "Agents allowed to use the tracker",
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
  let config: Config = readConfig({ trackerName: "", baseUrl: "", apiProfile: "", templates: "", guide: "", allowQuery: true });
  const apply_ = (raw: RawSettings & { allowedModels: string }) => {
    try {
      policy = createPolicy(parseRules(raw.allowedModels));
    } catch (error) {
      // A broken rule list fails closed: no agent gets the tools until it is fixed.
      policy = createPolicy([]);
      bb.log.warn(error instanceof PolicyError ? error.message : String(error));
    }
    config = readConfig(raw);
    statusCache.clear();
  };
  const statusCache = new Map<string, { at: number; map: Map<string, StatusInfo> }>();
  const meCache = new Map<string, { at: number; me: Person }>();
  const names = new Map<string, { at: number; name: string }>();
  apply_(await settings.get());
  settings.onChange((next) => apply_(next));

  const host = bb.hosts.experimental_client({ contract: hostContract });
  const kv = bb.storage.kv;

  // ---------- Machines and the tracker ----------

  async function liveHosts() {
    return (await bb.sdk.hosts.list()).filter((candidate) => candidate.lifecycle.phase !== "destroyed");
  }

  /** The machine the panel works through: the one picked last, else bb's primary machine. */
  async function panelHost(): Promise<string> {
    const hosts = await liveHosts();
    const last = await kv.get<string>("ui:host");
    if (last && hosts.some((candidate) => candidate.id === last)) return last;
    const { primaryHostId } = await bb.sdk.system.config();
    const id = primaryHostId ?? hosts.find((candidate) => candidate.status === "connected")?.id ?? hosts[0]?.id;
    if (!id) throw new Error("tracker-board:noMachine");
    return id;
  }

  async function threadHost(threadId: string): Promise<string | null> {
    const thread = await bb.sdk.threads.get({ threadId });
    if (!thread.environmentId) return null;
    return (await bb.sdk.environments.get({ environmentId: thread.environmentId })).hostId;
  }

  function ready(): { profile: Profile; baseUrl: string } {
    if (config.problem || !config.profile || !config.baseUrl) throw new TrackerError("notConfigured", null, config.problem ?? "not configured");
    return { profile: config.profile, baseUrl: config.baseUrl };
  }

  function rawTracker(hostId: string, signal?: AbortSignal, statuses?: Map<string, StatusInfo>): Tracker {
    const { profile, baseUrl } = ready();
    return new Tracker(profile, baseUrl, (input) => host.call("request", input, { hostId, timeoutMs: CALL_TIMEOUT_MS, ...(signal ? { signal } : {}) }), statuses, hostId);
  }

  async function statusesOn(hostId: string, signal?: AbortSignal): Promise<Map<string, StatusInfo>> {
    const cached = statusCache.get(hostId);
    if (cached && Date.now() - cached.at < STATUS_TTL_MS) return cached.map;
    const tracker = rawTracker(hostId, signal);
    if (!tracker.has("statuses")) return new Map();
    try {
      const map = await tracker.statuses();
      statusCache.set(hostId, { at: Date.now(), map });
      return map;
    } catch (error) {
      bb.log.info(`statuses: ${error instanceof Error ? error.message : String(error)}`);
      return new Map();
    }
  }

  async function trackerOn(hostId: string, signal?: AbortSignal): Promise<Tracker> {
    return rawTracker(hostId, signal, await statusesOn(hostId, signal));
  }

  async function meOn(hostId: string, tracker: Tracker): Promise<Person | null> {
    const cached = meCache.get(hostId);
    if (cached && Date.now() - cached.at < ME_TTL_MS) return cached.me;
    try {
      const me = await tracker.myself();
      meCache.set(hostId, { at: Date.now(), me });
      return me;
    } catch {
      return null;
    }
  }

  /**
   * Statuses for a board, its menus and the agent guide: the configured ones in their order,
   * then any other status a card is in. A tracker's whole list joins only when it is short:
   * some list every status of every workflow, hundreds of them.
   */
  function statusViews(map: ReadonlyMap<string, StatusInfo>, issues: readonly Issue[] = [], onlyColumns = false): StatusView[] {
    const out = new Map<string, StatusView>();
    for (const status of config.profile?.statuses ?? []) {
      if (onlyColumns && status.show !== "always") continue;
      out.set(status.key, { key: status.key, name: status.name ?? map.get(status.key)?.name ?? status.key, category: categoryOf(status.category ?? map.get(status.key)?.category) });
    }
    if (onlyColumns) return [...out.values()];
    for (const issue of issues) {
      if (!out.has(issue.status)) out.set(issue.status, { key: issue.status, name: issue.statusName ?? map.get(issue.status)?.name ?? issue.status, category: issue.category });
    }
    if (map.size <= MAX_LISTED_STATUSES) for (const [key, info] of map) if (!out.has(key)) out.set(key, { key, name: info.name, category: categoryOf(info.category) });
    return [...out.values()];
  }

  /** Looks up names for person ids the tracker gave without one; remembered for a while. */
  async function resolveNames(tracker: Tracker, ids: readonly (string | null)[]): Promise<void> {
    const now = Date.now();
    const missing = [...new Set(ids.filter((id): id is string => id !== null))].filter((id) => {
      const known = names.get(id);
      return !known || now - known.at > PEOPLE_TTL_MS;
    });
    if (!tracker.has("user") || missing.length === 0) return;
    await mapLimit(missing.slice(0, 80), 6, async (id) => {
      try {
        const person = await tracker.user(id);
        if (person) names.set(id, { at: Date.now(), name: person.name });
      } catch {
        // A person the tracker does not show stays an id.
      }
    });
  }

  /** Fills in assignee and author names the tracker gave only as ids. */
  async function nameIssues(tracker: Tracker, issues: Issue[]): Promise<void> {
    const now = Date.now();
    for (const issue of issues) {
      if (issue.assignee && issue.assigneeName) names.set(issue.assignee, { at: now, name: issue.assigneeName });
      if (issue.author && issue.authorName) names.set(issue.author, { at: now, name: issue.authorName });
    }
    await resolveNames(tracker, issues.flatMap((issue) => [issue.assigneeName ? null : issue.assignee, issue.authorName ? null : issue.author]));
    for (const issue of issues) {
      if (issue.assignee && !issue.assigneeName) issue.assigneeName = names.get(issue.assignee)?.name ?? null;
      if (issue.author && !issue.authorName) issue.authorName = names.get(issue.author)?.name ?? null;
    }
  }

  function peopleMap(prefs: Prefs | null): Map<string, string> {
    const out = new Map<string, string>();
    for (const [id, entry] of names) out.set(id, entry.name);
    for (const person of prefs?.people ?? []) out.set(person.id, person.name);
    return out;
  }

  // ---------- Preferences ----------

  async function loadPrefs(): Promise<Prefs> {
    const parsed = prefsSchema.safeParse((await kv.get("prefs")) ?? {});
    return parsed.success ? parsed.data : prefsSchema.parse({});
  }
  async function savePrefs(next: Prefs): Promise<Prefs> {
    const checked = prefsSchema.parse(next);
    await kv.set("prefs", checked);
    return checked;
  }

  function templatesFor(prefs: Prefs) {
    return mergeTemplates(config.templates.templates, prefs.templates);
  }

  // ---------- Who may receive tracker data ----------

  const execKey = (threadId: string) => `exec:${threadId}`;
  const taintKey = (threadId: string) => `taint:${threadId}`;

  async function isTainted(threadId: string | null | undefined): Promise<boolean> {
    if (!threadId) return false;
    return ((await kv.get(taintKey(threadId))) ?? null) !== null;
  }
  /** Whether this thread or any thread it was forked from holds tracker data. */
  async function lineTainted(thread: { id: string; sourceThreadId?: string | null }): Promise<boolean> {
    if (await isTainted(thread.id)) return true;
    const seen = new Set([thread.id]);
    let next = thread.sourceThreadId ?? null;
    while (next) {
      if (seen.has(next)) return false;
      if (seen.size >= MAX_FORK_DEPTH) return true;
      seen.add(next);
      if (await isTainted(next)) return true;
      next = await bb.sdk.threads.get({ threadId: next }).then((parent) => parent.sourceThreadId ?? null, () => null);
    }
    return false;
  }
  const markTainted = (threadId: string) => kv.set(taintKey(threadId), { at: Date.now() });

  function mentionsTasks(blocks: readonly unknown[]): boolean {
    return blocks.some((block) => {
      const mentions = (block as { mentions?: readonly { resource?: { kind?: string; pluginId?: string } }[] }).mentions ?? [];
      return mentions.some((mention) => mention.resource?.kind === "plugin" && mention.resource.pluginId === bb.pluginId);
    });
  }

  bb.experimental_hooks.on("message.dispatch", async (ctx) => {
    const { providerId, model } = ctx.requestedExecution;
    const thread = ctx.thread;
    const mentioned = mentionsTasks(ctx.input.blocks);
    const tainted = mentioned || (await lineTainted(thread));
    if (tainted && !policy.allows(providerId, model)) {
      return {
        action: "reject",
        message: mentioned
          ? `Tasks from ${config.name} can go only to the allowed models. Switch to one of them, or remove the task mentions.`
          : `This thread contains ${config.name} tasks, so only the allowed models can continue it. Switch back to one of them, or start a new thread.`,
      };
    }
    if (tainted && !(await isTainted(thread.id))) await markTainted(thread.id);
    // Tool calls check the model of the turn that is running, not the one the thread started with.
    await kv.set(execKey(thread.id), { providerId, model, at: Date.now() } satisfies Execution);
    return { action: "proceed" };
  });

  bb.events.on("thread.deleted", async ({ thread }) => {
    await kv.delete(execKey(thread.id));
    if (await lineTainted(thread)) await markTainted(thread.id);
  });

  async function modelAllowed(threadId: string): Promise<string | null> {
    const execution = await kv.get<Execution>(execKey(threadId));
    if (execution && policy.allows(execution.providerId, execution.model)) return null;
    const who = execution ? `${execution.providerId} ${execution.model ?? "(default model)"}` : "this agent";
    return `${config.name} is not available to ${who}. Only the allowed models can use it.`;
  }

  bb.agents.configure((ctx) => {
    if (!policy.allows(ctx.provider.id, ctx.provider.model)) return { tools: [], skills: [] };
    return {
      tools: TOOL_NAMES,
      skills: [SKILL],
      instructions: `${config.name} (task tracker): read issues with ${TOOL_SEARCH} and ${TOOL_GET}; call ${TOOL_GUIDE} once before the first change in a thread. Change issues only with ${TOOL_PROPOSE}: the user confirms each change in the chat. If these tools are not listed directly, find them with your tool search before saying they are missing.`,
    };
  });

  // ---------- Agent tools ----------

  const toolError = (text: string) => ({ content: [{ type: "text" as const, text }], isError: true });
  const toolText = (text: string) => ({ content: [{ type: "text" as const, text }], isError: false });

  async function agentTracker(threadId: string, signal: AbortSignal): Promise<{ tracker: Tracker; hostId: string } | string> {
    const refused = await modelAllowed(threadId);
    if (refused) return refused;
    if (config.problem) return `Error: ${config.name} is not configured: ${config.problem}.`;
    const hostId = await threadHost(threadId);
    if (!hostId) return `This thread has no machine to reach ${config.name} from yet.`;
    // Marked before the call: the thread holds tracker data from here on.
    await markTainted(threadId);
    return { tracker: await trackerOn(hostId, signal), hostId };
  }

  function guideText(prefs: Prefs, statuses: StatusView[]): string {
    const profile = config.profile;
    const templates = templatesFor(prefs);
    const lines = [
      `# ${config.name}`,
      "",
      config.guide.trim(),
      "",
      "## Statuses",
      ...statuses.map((status) => `- ${status.key}: ${status.name} (${status.category})`),
      "",
      "## Types",
      ...(profile?.types.length ? profile.types.map((type) => `- ${type.key}${type.name ? `: ${type.name}` : ""}`) : ["- (any type key the tracker accepts)"]),
      "",
      "## Priorities",
      ...(profile?.priorities.length ? profile.priorities.map((priority) => `- ${priority.key}${priority.name ? `: ${priority.name}` : ""}`) : ["- (any priority key the tracker accepts)"]),
      "",
      "## Templates for child issues",
      "A child made from a template is titled `<prefix> <parent title without its own prefix>`.",
      ...templates.map(
        (template) =>
          `- ${template.id}: ${template.title}; prefix "${template.prefix}"; type ${template.type || "(default)"}; under ${template.under}; labels ${template.labels.join(", ") || "none"}; assignee ${template.assignee || "nobody"}${template.own ? " (the user's own)" : ""}`,
      ),
      ...config.templates.bundles.map((bundle) => `- bundle ${bundle.id}: ${bundle.title} = ${bundle.items.map((item) => `${item.template}${item.children.length ? `(${item.children.join(", ")})` : ""}`).join(", ")}`),
      "",
      "## Searching",
      `- Queue: ${profile?.queries.queue ?? "-"}`,
      profile?.queries.children ? `- Children: ${profile.queries.children}` : "- Children: read the parent's queue and follow parent links",
      "- tracker_search takes an issue key (that issue and everything under it), a queue key, or a query in the tracker's language.",
    ];
    return lines.filter((line, index, all) => !(line === "" && all[index - 1] === "")).join("\n").trim();
  }

  bb.agents.registerTool({
    name: TOOL_GUIDE,
    description: "How this tracker works: statuses, types, priorities, child-issue templates and the query language. Call once before proposing changes.",
    presentation: { label: { pending: "Reading the tracker guide", completed: "Read the tracker guide" } },
    parameters: z.object({}),
    execute: async (_input, ctx) => {
      const got = await agentTracker(ctx.threadId, ctx.signal);
      if (typeof got === "string") return toolError(got);
      const statuses = statusViews(await statusesOn(got.hostId, ctx.signal));
      return toolText(guideText(await loadPrefs(), statuses));
    },
  });

  bb.agents.registerTool({
    name: TOOL_SEARCH,
    description: "Find tracker issues: an issue key (the issue and everything nested under it), a queue key, or a query in the tracker's query language. Returns one line per issue.",
    presentation: { label: { pending: "Searching the tracker", completed: "Searched the tracker" } },
    parameters: z.object({
      source: z.string().min(1).max(2000).describe("An issue key like ABC-12, a queue key like ABC, or a tracker query"),
      limit: z.number().int().min(1).max(500).optional().describe("At most this many issues; default 200"),
    }),
    execute: async ({ source, limit }, ctx) => {
      const got = await agentTracker(ctx.threadId, ctx.signal);
      if (typeof got === "string") return toolError(got);
      const parsed = parseSource(source, true);
      if (!parsed) return toolError("Error: give an issue key, a queue key or a query.");
      try {
        const board = await loadBoard(got.tracker, parsed, limit ?? 200);
        await nameIssues(got.tracker, board.issues);
        const note = board.truncated ? `\n[Only the first ${board.issues.length} issues; narrow the search.]` : "";
        return toolText(`${board.issues.length} issues\n${board.issues.map(issueLine).join("\n")}${note}`);
      } catch (error) {
        return toolError(failureText(config.name, error));
      }
    },
  });

  bb.agents.registerTool({
    name: TOOL_GET,
    description: "Read tracker issues in full by key: fields, description and, when the tracker gives them, comments.",
    presentation: { label: { pending: "Reading tracker issues", completed: "Read tracker issues" } },
    parameters: z.object({
      keys: z.array(z.string().min(1).max(60)).min(1).max(LIMITS.readKeys),
      comments: z.boolean().optional().describe("Also read comments; default false"),
    }),
    execute: async ({ keys, comments }, ctx) => {
      const got = await agentTracker(ctx.threadId, ctx.signal);
      if (typeof got === "string") return toolError(got);
      const { tracker } = got;
      const results = await mapLimit(keys, 6, async (key) => {
        try {
          const issue = await tracker.issue(key.toUpperCase());
          await nameIssues(tracker, [issue]);
          let text = issueLine(issue);
          if (issue.description) text += `\ndescription:\n${short(issue.description, 6000)}`;
          if (comments && tracker.has("comments")) {
            const list = await tracker.comments(issue).catch(() => null);
            if (list) await resolveNames(tracker, list.map((comment) => (comment.authorName ? null : comment.author)));
            if (list) text += `\ncomments (${list.length}):\n${list.slice(-20).map((comment) => `- ${comment.authorName ?? (comment.author ? names.get(comment.author)?.name : null) ?? comment.author ?? "?"}${comment.created ? ` ${comment.created}` : ""}: ${short(comment.text, 1000)}`).join("\n")}`;
          }
          return text;
        } catch (error) {
          return `${key}: ${failureText(config.name, error)}`;
        }
      });
      return toolText(results.join("\n\n"));
    },
  });

  bb.agents.registerTool({
    name: TOOL_PEOPLE,
    description: "Find people in the tracker by name or login, to get the id an assignee change needs. `@me` is the user themselves.",
    presentation: { label: { pending: "Looking up people", completed: "Looked up people" } },
    parameters: z.object({ text: z.string().min(1).max(200) }),
    execute: async ({ text }, ctx) => {
      const got = await agentTracker(ctx.threadId, ctx.signal);
      if (typeof got === "string") return toolError(got);
      const prefs = await loadPrefs();
      const lower = text.toLowerCase();
      const local = prefs.people.filter((person) => person.name.toLowerCase().includes(lower) || person.id.toLowerCase() === lower);
      let remote: Person[] = [];
      if (got.tracker.has("users")) {
        try {
          remote = await got.tracker.users(text);
        } catch (error) {
          if (local.length === 0) return toolError(failureText(config.name, error));
        }
      }
      const all = [...local, ...remote.filter((person) => !local.some((known) => known.id === person.id))];
      const me = await meOn(got.hostId, got.tracker);
      const head = me ? `@me is ${me.name} (${me.id})\n` : "";
      return toolText(all.length ? `${head}${all.map((person) => `- ${person.name}: ${person.id}`).join("\n")}` : `${head}Nobody found.`);
    },
  });

  const approvalSchema = z.object({ approve: z.array(z.string().max(10)).max(LIMITS.changes) }).strict();

  /** The person's approved ids, if they approved anything. */
  function approvedIds(value: unknown, planned: readonly PlannedChange[]): Set<string> {
    const parsed = approvalSchema.safeParse(value);
    if (!parsed.success) return new Set();
    const ok = new Set(planned.filter((item) => item.ok).map((item) => item.id));
    return new Set(parsed.data.approve.filter((id) => ok.has(id)));
  }

  function resultText(planned: readonly PlannedChange[], approved: ReadonlySet<string>, results: readonly ChangeResult[]): string {
    const byId = new Map(results.map((result) => [result.id, result]));
    return planned
      .map((item) => {
        const line = describe(item);
        if (!item.ok) return `- skipped (${SKIP_TEXT[item.skip ?? "same"]}): ${line}`;
        if (!approved.has(item.id)) return `- not approved by the user: ${line}`;
        const result = byId.get(item.id);
        if (!result) return `- not applied: ${line}`;
        if (result.ok) return `- done${item.change.kind === "create" && result.key ? ` (${result.key})` : ""}: ${line}`;
        return `- failed (${result.code}${result.detail ? `: ${result.detail}` : ""}): ${line}`;
      })
      .join("\n");
  }

  async function resolveMe(changes: Change[], hostId: string, tracker: Tracker): Promise<Change[]> {
    if (!changes.some((change) => change.kind === "assignee" && change.to === "@me")) return changes;
    const me = await meOn(hostId, tracker);
    return changes.map((change) => (change.kind === "assignee" && change.to === "@me" && me ? { ...change, to: me.id } : change));
  }

  bb.agents.registerTool({
    name: TOOL_PROPOSE,
    description:
      "Propose changes to tracker issues: status, assignee, priority, labels, parent, title, description, a comment, or new issues (also from templates). The user sees every change in a confirmation form in this chat and approves or rejects each one; only approved changes are applied, and the result comes back to you. Nothing changes without that confirmation. Put related changes in one call.",
    presentation: { label: { pending: "Proposing tracker changes", completed: "Proposed tracker changes" } },
    parameters: z.object({
      summary: z.string().min(1).max(300).describe("One sentence for the user: what you propose and why"),
      changes: z.array(changeSchema).min(1).max(LIMITS.changes),
    }),
    execute: async ({ summary, changes }, ctx) => {
      const got = await agentTracker(ctx.threadId, ctx.signal);
      if (typeof got === "string") return toolError(got);
      const { tracker, hostId } = got;
      let planned: PlannedChange[];
      const prefs = await loadPrefs();
      try {
        const statuses = await statusesOn(hostId, ctx.signal);
        planned = await plan({ tracker, people: peopleMap(prefs), statuses: new Map([...statuses].map(([key, info]) => [key, info.name])) }, await resolveMe(changes as Change[], hostId, tracker));
      } catch (error) {
        return toolError(failureText(config.name, error));
      }
      const applicable = planned.filter((item) => item.ok);
      if (applicable.length === 0) return toolText(`Nothing to change; no form was shown.\n${resultText(planned, new Set(), [])}`);
      const result = await bb.ui.requestInput(
        {
          threadId: ctx.threadId,
          rendererId: CONFIRM_RENDERER,
          title: `Confirm ${config.name} changes`,
          payload: { tracker: config.name, summary, items: planned.map((item) => ({ ...item, line: describe(item) })) } as never,
          timeoutMs: CONFIRM_TIMEOUT_MS,
          presentation: { label: { pending: "Waiting for your confirmation", completed: "Tracker changes confirmed" } },
          describeSubmission: (value) => {
            const n = approvedIds(value, planned).size;
            return { title: n === 0 ? "Tracker changes rejected" : `Approved ${n} of ${applicable.length} tracker changes` };
          },
        },
        { signal: ctx.signal },
      );
      if (result.outcome === "cancelled") {
        return toolText(result.reason === "user" ? "The user rejected the changes. Nothing was changed." : `The confirmation ended (${result.reason}). Nothing was changed.`);
      }
      const approved = approvedIds(result.value, planned);
      if (approved.size === 0) return toolText("The user approved none of the changes. Nothing was changed.");
      const me = await meOn(hostId, tracker);
      const results = await apply({ tracker, me, signal: ctx.signal }, planned, approved);
      publishChanged(planned, results);
      return toolText(`Applied ${results.filter((item) => item.ok).length} of ${approved.size} approved changes:\n${resultText(planned, approved, results)}`);
    },
  });

  function publishChanged(planned: readonly PlannedChange[], results: readonly ChangeResult[]): void {
    const keys = new Set<string>();
    const byId = new Map(planned.map((item) => [item.id, item]));
    for (const result of results) {
      if (!result.ok) continue;
      if (result.key) keys.add(result.key);
      const change = byId.get(result.id)?.change;
      if (change && change.kind !== "create") keys.add(change.key);
      if (change?.kind === "parent" && change.to) keys.add(change.to);
    }
    if (keys.size > 0) bb.realtime.publish(CHANGED_CHANNEL, { keys: [...keys] });
  }

  // ---------- "@" mentions of tasks in the composer ----------

  bb.ui.registerMentionProvider({
    id: MENTION_PROVIDER,
    label: "Tracker tasks",
    search: async (ctx) => {
      if (config.problem) return [];
      const text = ctx.query.trim();
      if (text.length < 2) return [];
      try {
        const tracker = rawTracker(await panelHost());
        const key = findKey(text);
        if (key || KEY_PATTERN.test(text)) {
          const issue = await tracker.issue((key ?? text).toUpperCase());
          return [{ id: issue.key, title: `${issue.key} ${short(issue.summary, 80)}`, subtitle: issue.statusName ?? issue.status }];
        }
        const query = config.profile?.queries.text;
        if (!query) return [];
        const { issues } = await tracker.search(query.replaceAll("{text}", text.replace(/["\\]/g, " ")), 8);
        return issues.map((issue) => ({ id: issue.key, title: `${issue.key} ${short(issue.summary, 80)}`, subtitle: issue.statusName ?? issue.status }));
      } catch {
        return [];
      }
    },
    resolve: async (itemId) => {
      if (!KEY_PATTERN.test(itemId)) throw new Error("Not a task key");
      // Only the key and the title travel with the message; the agent reads the rest with the tools.
      try {
        const issue = await rawTracker(await panelHost()).issue(itemId);
        return { context: `Tracker task ${issue.key}: "${short(issue.summary, 200)}" (${issue.statusName ?? issue.status}). Read it with ${TOOL_GET} before acting.` };
      } catch {
        return { context: `Tracker task ${itemId}. Read it with ${TOOL_GET} before acting.` };
      }
    },
  });

  // ---------- The panel ----------

  type RpcHandlers = Parameters<typeof bb.rpc.register<typeof rpcContract>>[1];
  type Handler = (input: unknown, context: Parameters<RpcHandlers["config"]>[1]) => unknown;
  const ownCallers = (handlers: RpcHandlers): RpcHandlers =>
    Object.fromEntries(
      Object.entries(handlers as Record<string, Handler>).map(([name, handler]) => [
        name,
        (async (input, context) => {
          if (context.experimental_caller.kind !== "client") {
            throw new experimental_PluginRpcRefusal({ code: "forbidden", message: "The tracker board does not answer other plugins." });
          }
          try {
            return await handler(input, context);
          } catch (error) {
            const hosts = error instanceof TrackerError && error.machine ? await liveHosts().catch(() => []) : [];
            throw panelError(error, (id) => hosts.find((candidate) => candidate.id === id)?.name ?? id);
          }
        }) satisfies Handler,
      ]),
    ) as unknown as RpcHandlers;

  async function checkOn(hostId: string): Promise<{ ok: boolean; code: FailureCode | "badAnswer" | "notConfigured" | null; me: Person | null }> {
    let outcome: { ok: boolean; code: FailureCode | "badAnswer" | "notConfigured" | null; status: number | null; me: Person | null };
    try {
      const me = await rawTracker(hostId).myself();
      meCache.set(hostId, { at: Date.now(), me });
      outcome = { ok: true, code: null, status: null, me };
    } catch (error) {
      if (!(error instanceof TrackerError)) throw error;
      outcome = { ok: false, code: error.code, status: error.status, me: null };
    }
    const code = outcome.code === "badAnswer" || outcome.code === "notConfigured" ? null : outcome.code;
    await host.call("recordCheck", { ok: outcome.ok, code, status: outcome.status }, { hostId, timeoutMs: 30_000 }).catch(() => undefined);
    return { ok: outcome.ok, code: outcome.code, me: outcome.me };
  }

  function sourceTitle(source: Source, root: Issue | null): string {
    switch (source.kind) {
      case "issue":
        return root ? `${root.key} ${splitPrefix(root.summary).rest}` : source.key;
      case "queue":
        return source.queue;
      case "query":
        return short(source.query, 120);
      case "mine":
        return "mine";
    }
  }

  const handlers: RpcHandlers = {
    config: async () => {
      const prefs = await loadPrefs();
      const profile = config.profile;
      const has = (name: keyof Profile["requests"]) => profile?.requests[name] !== undefined;
      const uses = (name: keyof Profile["requests"], variable: string) => JSON.stringify(profile?.requests[name] ?? {}).includes(`{${variable}}`);
      const view: ConfigView = {
        name: config.name,
        problem: config.problem,
        address: config.baseUrl,
        webUrl: profile?.webUrl ?? null,
        keyHelp: profile?.keyHelp ?? null,
        statuses: statusViews(new Map(), [], true),
        types: (profile?.types ?? []).map((type) => ({ key: type.key, name: type.name ?? type.key })),
        priorities: (profile?.priorities ?? []).map((priority) => ({ key: priority.key, name: priority.name ?? priority.key })),
        templates: templatesFor(prefs),
        bundles: config.templates.bundles,
        composition: compositionOf(config.templates),
        allowQuery: config.allowQuery,
        can: {
          create: has("create"),
          status: has("transition") || uses("update", "status"),
          assign: has("assign") || uses("update", "assignee"),
          priority: uses("update", "priority"),
          labels: uses("update", "labels") || uses("update", "labelsAdd"),
          parent: has("setParent") || uses("update", "parent"),
          summary: uses("update", "summary"),
          comments: has("comments"),
          addComment: has("addComment"),
          people: has("users"),
          components: has("issueComponents"),
          mine: Boolean(profile?.queries.mine),
        },
        agentsAllowed: policy.rules.length > 0,
      };
      return view;
    },
    machines: async () => {
      const hosts = await liveHosts();
      let current: string | null = null;
      try {
        current = await panelHost();
      } catch {
        current = null;
      }
      return { machines: hosts.map((candidate) => ({ id: candidate.id, name: candidate.name, connected: candidate.status === "connected" })), current };
    },
    setMachine: async ({ hostId }) => {
      if (!(await liveHosts()).some((candidate) => candidate.id === hostId)) throw new Error("No such machine");
      await kv.set("ui:host", hostId);
      return null;
    },
    keyStatus: async () => {
      const hostId = await panelHost();
      const status: KeyStatus = await host.call("status", { baseUrl: config.baseUrl }, { hostId, timeoutMs: 60_000 });
      return { ...status, hostId };
    },
    saveKey: async ({ key }) => {
      const { baseUrl } = ready();
      const hostId = await panelHost();
      await host.call("saveKey", { baseUrl, key }, { hostId, timeoutMs: 60_000 });
      meCache.delete(hostId);
      statusCache.delete(hostId);
      return checkOn(hostId);
    },
    checkKey: async () => checkOn(await panelHost()),
    forgetKey: async () => {
      const hostId = await panelHost();
      meCache.delete(hostId);
      return host.call("forget", { baseUrl: config.baseUrl }, { hostId, timeoutMs: 60_000 });
    },
    prefs: () => loadPrefs(),
    setPrefs: async (partial) => savePrefs({ ...(await loadPrefs()), ...partial } as Prefs),
    importPrefs: async ({ file }) => savePrefs(fromExport(await loadPrefs(), file)),
    board: async ({ source }) => {
      if (source.kind === "query" && !config.allowQuery) throw new Error("tracker-board:noQuery");
      const hostId = await panelHost();
      const tracker = await trackerOn(hostId);
      const statuses = await statusesOn(hostId);
      const board: Board = await loadBoard(tracker, source);
      const parents = await loadParents(tracker, board.issues);
      await nameIssues(tracker, board.issues);
      const me = await meOn(hostId, tracker);
      const title = sourceTitle(source, board.root);
      const prefs = await loadPrefs();
      const recent = [{ source, title }, ...prefs.recent.filter((item) => sourceKey(item.source) !== sourceKey(source))].slice(0, LIMITS.recent);
      await savePrefs({ ...prefs, source, recent });
      const people = new Map<string, string>();
      for (const issue of board.issues) if (issue.assignee) people.set(issue.assignee, issue.assigneeName ?? issue.assignee);
      const view: BoardView = {
        source,
        title,
        root: board.root,
        issues: board.issues,
        parents,
        truncated: board.truncated,
        loadedAt: Date.now(),
        statuses: statusViews(statuses, board.issues),
        people: [...people].map(([id, name]) => ({ id, name })),
        me,
      };
      return view;
    },
    issue: async ({ key }) => {
      const hostId = await panelHost();
      const tracker = await trackerOn(hostId);
      const issue = await tracker.issue(key.toUpperCase());
      const [comments, components, children, parents] = await Promise.all([
        tracker.has("comments") ? tracker.comments(issue).catch(() => null) : Promise.resolve(null),
        tracker.has("issueComponents") ? tracker.components(issue).catch(() => null) : Promise.resolve(null),
        config.profile?.queries.children
          ? tracker.search(config.profile.queries.children.replaceAll("{keys}", issue.key).replaceAll("{key}", issue.key), 200).then((page) => page.issues.filter((child) => child.parent === issue.key || !child.parent), () => null)
          : Promise.resolve(null),
        loadParents(tracker, [issue]),
      ]);
      const named = [issue, ...(children ?? [])];
      await nameIssues(tracker, named);
      if (comments) {
        await resolveNames(tracker, comments.map((comment) => (comment.authorName ? null : comment.author)));
        for (const comment of comments) if (comment.author && !comment.authorName) comment.authorName = names.get(comment.author)?.name ?? null;
      }
      const view: IssueView = { issue, comments, components, children, parents };
      return view;
    },
    find: async ({ text }) => {
      const trimmed = text.trim();
      if (trimmed.length < 2) return { issues: [] };
      const tracker = await trackerOn(await panelHost());
      const key = findKey(trimmed);
      if (key) {
        try {
          return { issues: [await tracker.issue(key)] };
        } catch (error) {
          if (error instanceof TrackerError && error.code === "notFound") return { issues: [] };
          throw error;
        }
      }
      const query = config.profile?.queries.text;
      if (!query) return { issues: [] };
      const { issues } = await tracker.search(query.replaceAll("{text}", trimmed.replace(/["\\]/g, " ")), 20);
      return { issues };
    },
    people: async ({ text }) => {
      const prefs = await loadPrefs();
      const lower = text.trim().toLowerCase();
      const local = prefs.people.filter((person) => lower === "" || person.name.toLowerCase().includes(lower));
      if (lower.length < 2) return local;
      const tracker = await trackerOn(await panelHost());
      if (!tracker.has("users")) return local;
      const remote = await tracker.users(text.trim());
      return [...local, ...remote.filter((person) => !local.some((known) => known.id === person.id))].slice(0, 50);
    },
    preview: async ({ changes }) => {
      const hostId = await panelHost();
      const tracker = await trackerOn(hostId);
      const statuses = await statusesOn(hostId);
      return plan({ tracker, people: peopleMap(await loadPrefs()), statuses: new Map([...statuses].map(([key, info]) => [key, info.name])) }, await resolveMe(changes as Change[], hostId, tracker));
    },
    apply: async ({ changes, approve }) => {
      const hostId = await panelHost();
      const tracker = await trackerOn(hostId);
      const statuses = await statusesOn(hostId);
      const planned = await plan(
        { tracker, people: peopleMap(await loadPrefs()), statuses: new Map([...statuses].map(([key, info]) => [key, info.name])) },
        await resolveMe(changes as Change[], hostId, tracker),
      );
      const me = await meOn(hostId, tracker);
      const results = await apply({ tracker, me }, planned, new Set(approve));
      publishChanged(planned, results);
      return { planned, results };
    },
    chat: async () => {
      let threadId = (await kv.get<string>("chat:thread")) ?? null;
      if (threadId) {
        const alive = await bb.sdk.threads.get({ threadId }).then(
          (thread) => !(thread as { archivedAt?: unknown }).archivedAt,
          () => false,
        );
        if (!alive) {
          threadId = null;
          await kv.delete("chat:thread");
        }
      }
      const projects = await bb.sdk.projects.list({ includePersonal: true }).catch(() => []);
      const personal = (projects as { id: string; kind?: string }[]).find((project) => project.kind === "personal") ?? null;
      let hostId: string | null = null;
      try {
        hostId = await panelHost();
      } catch {
        hostId = null;
      }
      return { threadId, projectId: personal?.id ?? null, hostId };
    },
    startChat: async ({ request }) => {
      const thread = await bb.sdk.threads.spawn(request as unknown as Parameters<typeof bb.sdk.threads.spawn>[0]);
      await kv.set("chat:thread", thread.id);
      return { threadId: thread.id };
    },
    setChat: async ({ threadId }) => {
      if (threadId === null) await kv.delete("chat:thread");
      else {
        await bb.sdk.threads.get({ threadId });
        await kv.set("chat:thread", threadId);
      }
      return null;
    },
  };
  bb.rpc.register(rpcContract, ownCallers(handlers));

  // ---------- Onboarding step for a build's setup page ----------

  /** Recent host answers, by machine: a setup page asks again every few seconds. */
  const setupAnswers = new Map<string, { at: number; status: Promise<KeyStatus> }>();

  async function setupOn(machine: string, lang: SetupLang) {
    const found = (await liveHosts()).find((candidate) => candidate.id === machine);
    if (!found || found.status !== "connected") return setupStep("problem", "offline", lang);
    let cached = setupAnswers.get(machine);
    if (!cached || Date.now() - cached.at > 15_000) {
      const status = host.call("status", { baseUrl: config.baseUrl }, { hostId: machine, timeoutMs: 10_000 });
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
        if (config.problem || !config.baseUrl) return setupStep("problem", "notConfigured", lang);
        if (requested) return setupOn(requested, lang);
        try {
          return await setupOn(await panelHost(), lang);
        } catch {
          return setupStep("problem", "noMachine", lang);
        }
      },
    },
    { experimental_discoverable: true, experimental_description: "Tracker API key state for a bb build's onboarding page." },
  );
}
