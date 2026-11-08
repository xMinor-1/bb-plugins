// Fleet Kit backend: keeps this bb in line with a build manifest.
//
// A background service reads the manifest on start and every
// `syncIntervalMinutes`, then installs, updates and removes plugins, holds
// bb settings, and merges the build's OpenCode block into opencode.json.
// The panel (app.tsx) and `bb fleet-kit` show the result and run a sync on
// demand. Secrets are stored in the operating system's credential store.
import { PluginCliError, cliCommand, defineCli, experimental_PluginRpcRefusal, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import { rpcContract, STATUS_CHANNEL, type Notice, type OpenCodeStatus, type Setup, type SetupMark, type Status, type SyncReport } from "./contract.js";
import { checkSecretValue, openSecretStore, SECRET_NAME, type SecretStore, type SecretStorePreference } from "./src/secret-store.js";
import { emptyManaged, runSync, SELF_ID, type FleetKitSettings, type ManagedState } from "./src/sync.js";
import type { Manifest } from "./src/manifest.js";
import { maskManifestUrl, parseManifestLocation } from "./src/fetch-manifest.js";
import { opencodeConfigDirSchema, opencodeInstallDirSchema } from "./src/shared/settings.js";
import { resolveOpenCodeLocation } from "./src/host/opencode-location.js";
import { lockState, resetStuckLock } from "./src/host/lock-state.js";
import { collectSetup, markProblem, SetupAsker, type StoredOnboarding } from "./src/setup.js";
import { createChoiceQueue } from "./src/choice-store.js";
import { chooseBranch, noBranchState, togglePlugin, turnsOff, type BranchChoice, type BranchState } from "./src/branches.js";
import { agentBuildOf, consentKey, emptyAgentBuild, normalizeAgentBuild, normalizeChoice, ownAgentsOn, skillInstructions, skillsFor, SKILL_TOOL, type AgentBuild, type OwnAgentsChoice } from "./src/own-agents.js";
import { oneAtATime, systemConfirmWindow, type ConfirmWindow, type WindowText } from "./src/host/confirm-window.js";
import type { OwnAgentsOutcome } from "./contract.js";
import { readBranding } from "./src/app/branding.js";

export { rpcContract };

const START_DELAY_MS = 15_000;
/** The page, its banner and the sidebar badge ask at once; one answer serves them all. */
const SETUP_FRESH_MS = 3_000;
/** An OpenCode install that failed on the network or a bad file goes again this soon, not at the next scheduled sync. */
const RETRY_MS = 3 * 60_000;

interface StoredSecrets {
  list: { name: string; title: string; hint: string | null }[];
}

/** The CLI's note after a First run step. */
function setupNote(step: Setup["steps"][number], shown: string): string {
  if (shown === "skipped") return "";
  if (step.state === "checking") return "the plugin has not answered yet; run the command again in a few seconds";
  if (step.summary !== null) return step.summary;
  if (step.reason === "manual") {
    return step.state === "done" ? "marked done by hand" : "the plugin cannot report its state; mark it on the First run page";
  }
  return step.reason ?? "";
}

/** The window's fixed words; the warning itself is the build's (manifest `ownAgents.warning`). */
function ownAgentsWindow(lang: "en" | "ru", warning: string, agents: string): WindowText {
  return lang === "ru"
    ? {
        title: "Fleet Kit: включить своих агентов?",
        message: `${warning}\n\nВключить: ${agents}.\nВыключить можно в любой момент в панели Fleet Kit.`,
        yes: "Включить",
        no: "Отмена",
      }
    : {
        title: "Fleet Kit: turn on your own agents?",
        message: `${warning}\n\nTurns on: ${agents}.\nYou can turn them off at any time in the Fleet Kit panel.`,
        yes: "Turn on",
        no: "Cancel",
      };
}

export interface PluginOptions {
  /** The system window that confirms "Own agents"; tests pass their own. */
  confirmWindow?: ConfirmWindow;
  /** The clock for the pause after a refused window; tests pass their own. */
  now?: () => number;
}

/** After a Cancel or an unanswered window, the next one waits this long: a script cannot keep the window up until someone clicks. */
export const OWN_AGENTS_PAUSE_MS = 10 * 60_000;

interface OwnAgentsRefusals {
  count: number;
  /** When the last window was cancelled or left unanswered, ms. */
  lastAt: number | null;
}

export default async function plugin(bb: BbPluginApi, options: PluginOptions = {}) {
  const settings = bb.settings.define({
    manifestUrl: {
      type: "string",
      label: "Manifest address (https:// URL, file:// URL or absolute path)",
      default: "",
      experimental_schema: z.string().max(2000),
    },
    manifestToken: {
      type: "string",
      label: "Token for a private manifest URL (sent as a bearer token)",
      secret: true,
    },
    syncIntervalMinutes: {
      type: "number",
      label: "Minutes between syncs",
      default: 30,
      experimental_schema: z.number().int().min(5).max(1440),
    },
    opencodeConfigDir: {
      type: "string",
      label: "OpenCode configuration directory (empty: OpenCode's default)",
      default: "",
      experimental_schema: opencodeConfigDirSchema,
    },
    opencodeInstallDir: {
      type: "string",
      label: "Folder for OpenCode installed by Fleet Kit (empty: use the OpenCode found on PATH)",
      default: "",
      experimental_schema: opencodeInstallDirSchema,
    },
    appsInstallDir: {
      type: "string",
      label: "Folder for programs plugins need, such as an office suite (empty: next to the OpenCode folder)",
      default: "",
      experimental_schema: opencodeInstallDirSchema,
    },
    secretStore: {
      type: "select",
      label: "Where secrets are stored",
      options: ["auto", "file"],
      experimental_optionLabels: { auto: "Operating system credential store", file: "Private file (0600)" },
      default: "auto",
    },
    paused: { type: "boolean", label: "Pause syncing", default: false },
    allowDevSources: {
      type: "boolean",
      label: "Development only: allow path:, npm: and local git plugin sources and http://localhost gateways",
      default: false,
    },
  });

  const kv = bb.storage.kv;
  let store: SecretStore = openSecretStore((await settings.get()).secretStore as SecretStorePreference);
  let syncing: Promise<void> | null = null;
  let rerun: SyncReport["trigger"] | null = null;
  let wake: (() => void) | null = null;
  let nextSyncAt: string | null = null;
  /** When the last sync started; the schedule counts from it. */
  let lastSyncAt = 0;
  /** When this process started Fleet Kit's own update; a sync meanwhile does not start another. */
  let selfUpdateStartedAt: number | undefined;
  const controller = new AbortController();
  let retryTimer: ReturnType<typeof setTimeout> | null = null;
  bb.onDispose(() => {
    controller.abort();
    if (retryTimer !== null) clearTimeout(retryTimer);
  });

  async function readSettings(): Promise<FleetKitSettings & { secretStore: SecretStorePreference }> {
    const value = await settings.get();
    return {
      manifestUrl: value.manifestUrl,
      manifestToken: typeof value.manifestToken === "string" && value.manifestToken !== "" ? value.manifestToken : undefined,
      syncIntervalMinutes: value.syncIntervalMinutes,
      opencodeConfigDir: value.opencodeConfigDir.trim(),
      opencodeInstallDir: value.opencodeInstallDir.trim(),
      appsInstallDir: value.appsInstallDir.trim(),
      allowDevSources: value.allowDevSources,
      paused: value.paused,
      secretStore: value.secretStore as SecretStorePreference,
    };
  }

  /** The person's branch: kept on this machine, never replaced by a manifest update. */
  const readChoice = async () => (await kv.get<BranchChoice>("branchChoice")) ?? null;
  /** Where the sync left this machine, saved as soon as a sync has read the manifest. */
  const readBranchState = async (): Promise<BranchState> => {
    const saved = (await kv.get<Omit<BranchState, "choice">>("branchSync")) ?? null;
    return { ...noBranchState(), ...(saved ?? {}), choice: await readChoice() };
  };

  /** What configure() reads on every thread start: it must answer synchronously, so it reads these copies. */
  // Unreadable or malformed storage counts as no offer and no yes: own agents stay off.
  let agentBuild: AgentBuild = emptyAgentBuild();
  let ownChoice: OwnAgentsChoice | null = null;
  try {
    agentBuild = normalizeAgentBuild(await kv.get<unknown>("agentBuild"));
  } catch (error) {
    bb.log.warn(`Fleet Kit could not read the saved agent configuration; own agents stay off: ${error instanceof Error ? error.message : String(error)}`);
  }
  try {
    ownChoice = normalizeChoice(await kv.get<unknown>("ownAgents"));
  } catch (error) {
    bb.log.warn(`Fleet Kit could not read the own agents switch; it counts as off: ${error instanceof Error ? error.message : String(error)}`);
  }
  const now = options.now ?? Date.now;
  const readRefusals = async (): Promise<OwnAgentsRefusals> => {
    try {
      const saved = await kv.get<OwnAgentsRefusals>("ownAgentsRefusals");
      return { count: typeof saved?.count === "number" ? saved.count : 0, lastAt: typeof saved?.lastAt === "number" ? saved.lastAt : null };
    } catch {
      return { count: 0, lastAt: null };
    }
  };
  const confirmWindow = oneAtATime(options.confirmWindow ?? systemConfirmWindow());
  /** The agent of each thread configure() answered for: build_skill gives a thread only its own skills. */
  const threadAgents = new Map<string, string>();

  const setupAnswers = new Map<"en" | "ru", { at: number; answer: Promise<Setup> }>();

  function publish() {
    setupAnswers.clear();
    bb.realtime.publish(STATUS_CHANNEL, { at: Date.now() });
  }

  // A plugin that answers after the page stopped waiting: the page asks again and gets the answer.
  const asker = new SetupAsker((args) => bb.sdk.plugins.callRpc(args), () => publish());

  async function setup(lang: "en" | "ru"): Promise<Setup> {
    const cached = setupAnswers.get(lang);
    if (cached && Date.now() - cached.at < SETUP_FRESH_MS) return cached.answer;
    const answer = (async () => ({
      ...(await collectSetup({
        listPlugins: async () => (await bb.sdk.plugins.list()).plugins,
        ask: (pluginId, language) => asker.ask(pluginId, language),
        manifestSet: (await settings.get()).manifestUrl.trim() !== "",
        onboarding: (await kv.get<StoredOnboarding>("onboarding")) ?? null,
        marks: (await kv.get<Record<string, SetupMark>>("setupMarks")) ?? {},
        secrets: ((await kv.get<StoredSecrets>("secrets")) ?? { list: [] }).list,
        secretSet: (name) => store.has(name),
        secretStore: store.label,
        lastSync: (await kv.get<SyncReport>("lastSync")) ?? null,
        lang,
        branchState: await readBranchState(),
      })),
      opencodeInstall: (await kv.get<OpenCodeStatus>("opencode"))?.install ?? null,
    }))();
    setupAnswers.set(lang, { at: Date.now(), answer });
    answer.catch(() => setupAnswers.delete(lang));
    return answer;
  }

  async function secretsStatus(): Promise<Status["secrets"]> {
    const stored = (await kv.get<StoredSecrets>("secrets")) ?? { list: [] };
    const result: Status["secrets"] = [];
    for (const secret of stored.list) {
      let set = false;
      try {
        set = await store.has(secret.name);
      } catch {
        set = false;
      }
      result.push({ ...secret, set });
    }
    return result;
  }

  async function status(): Promise<Status> {
    const current = await readSettings();
    let manifestUrl = current.manifestUrl;
    try {
      if (manifestUrl !== "") manifestUrl = parseManifestLocation(manifestUrl).display;
    } catch {
      // Show the value without credentials; the sync reports why it is invalid.
      manifestUrl = maskManifestUrl(manifestUrl);
    }
    const opencode = (await kv.get<OpenCodeStatus>("opencode")) ?? null;
    if (opencode?.configFile) opencode.lock = await lockState(opencode.configFile).catch(() => null);
    return {
      manifestUrl,
      configured: current.manifestUrl.trim() !== "",
      paused: current.paused,
      syncing: syncing !== null,
      intervalMinutes: current.syncIntervalMinutes,
      nextSyncAt: current.paused ? null : nextSyncAt,
      lastSync: (await kv.get<SyncReport>("lastSync")) ?? null,
      secretStore: store.label,
      secrets: await secretsStatus(),
      opencode,
      notices: (await kv.get<Notice[]>("notices")) ?? [],
      ownAgents: await ownAgentsStatus(),
    };
  }

  async function ownAgentsStatus(): Promise<Status["ownAgents"]> {
    const own = agentBuild.own;
    if (own === null) return null;
    const refusals = await readRefusals();
    const retryAt = refusals.lastAt !== null && now() - refusals.lastAt < OWN_AGENTS_PAUSE_MS ? new Date(refusals.lastAt + OWN_AGENTS_PAUSE_MS).toISOString() : null;
    let names = new Map<string, string>();
    try {
      names = new Map((await bb.sdk.providers.catalog()).map((entry) => [entry.id, entry.displayName]));
    } catch {
      // The ids are shown instead.
    }
    return {
      title: own.title ?? null,
      warning: own.warning,
      providers: own.providers.map((id) => ({ id, name: names.get(id) ?? id })),
      delegate: own.delegate ?? null,
      on: ownAgentsOn(own, ownChoice),
      at: ownChoice?.at ?? null,
      refusals: refusals.count,
      retryAt,
    };
  }

  /** Save first, then believe it: a failed write leaves the switch as it was and says so. */
  async function saveChoice(next: OwnAgentsChoice | null) {
    try {
      await kv.set("ownAgents", next);
    } catch (error) {
      throw new experimental_PluginRpcRefusal({
        code: "conflict",
        message: `Fleet Kit could not save the choice, so nothing changed: ${error instanceof Error ? error.message : String(error)}`,
      });
    }
    ownChoice = next;
  }

  /**
   * Turn "Own agents" on or off. On takes a press in a system window: bb
   * shows the panel, the CLI and agents as the same caller, so an agent's
   * call alone never turns its own kind on. Off needs no window.
   */
  async function setOwnAgents(on: boolean, lang: "en" | "ru"): Promise<{ on: boolean; outcome: OwnAgentsOutcome }> {
    const own = agentBuild.own;
    if (own === null) return { on: false, outcome: "not-offered" };
    if (on && !ownAgentsOn(own, ownChoice)) {
      const refusals = await readRefusals();
      if (refusals.lastAt !== null && now() - refusals.lastAt < OWN_AGENTS_PAUSE_MS) return { on: false, outcome: "paused" };
      const names = (await ownAgentsStatus())?.providers.map((entry) => entry.name).join(", ") ?? own.providers.join(", ");
      const answer = await confirmWindow.confirm(ownAgentsWindow(lang, own.warning, names), controller.signal);
      if (!answer.ok) {
        if (answer.reason === "cancelled" || answer.reason === "timeout") {
          await kv.set("ownAgentsRefusals", { count: refusals.count + 1, lastAt: now() } satisfies OwnAgentsRefusals).catch(() => undefined);
          publish();
        }
        return { on: false, outcome: answer.reason };
      }
      // The yes holds for what the window showed: the warning and agents of this block.
      await saveChoice({ on: true, at: new Date(now()).toISOString(), key: consentKey(own) });
      publish();
      void requestSync("manual");
      return { on: true, outcome: "on" };
    }
    if (on === ownAgentsOn(own, ownChoice)) return { on, outcome: on ? "on" : "off" };
    await saveChoice({ on: false, at: new Date(now()).toISOString() });
    publish();
    void requestSync("manual");
    return { on, outcome: on ? "on" : "off" };
  }

  async function syncOnce(trigger: SyncReport["trigger"]): Promise<void> {
    lastSyncAt = Date.now();
    const current = await readSettings();
    if (current.manifestUrl.trim() === "") return;
    const managed = (await kv.get<ManagedState>("managed")) ?? emptyManaged();
    const environment: NodeJS.ProcessEnv = { ...process.env };
    if (current.opencodeConfigDir !== "") environment.OPENCODE_CONFIG_DIR = current.opencodeConfigDir;
    const outcome = await runSync(
      {
        sdk: bb.sdk,
        log: bb.log,
        settings: current,
        store,
        managed,
        signal: controller.signal,
        environment,
        bbConfigDir: process.env.OPENCODE_CONFIG_DIR,
        selfUpdateStartedAt,
        choice: await readChoice(),
        ownAgents: ownChoice,
        onOpenCode: async (value) => {
          await kv.set("opencode", value);
          publish();
        },
        onManifest: async (manifest, branches) => {
          await saveFromManifest(manifest);
          await kv.set("branchSync", { start: branches.start, applied: branches.applied });
          publish();
        },
      },
      trigger,
    );
    await kv.set("managed", outcome.managed);
    await kv.set("branchSync", { start: outcome.managed.branchStart ?? "all", applied: outcome.managed.branchApplied ?? {} });
    await kv.set("lastSync", outcome.report);
    if (outcome.opencode !== null || outcome.manifest !== null) await kv.set("opencode", outcome.opencode);
    if (outcome.manifest !== null) await saveFromManifest(outcome.manifest);
    if (outcome.notices.length > 0) {
      const notices = (await kv.get<Notice[]>("notices")) ?? [];
      // One notice per id: an agent turned on by hand again does not pile up notices.
      const fresh = outcome.notices.filter((notice) => !notices.some((existing) => existing.id === notice.id));
      await kv.set("notices", [...notices, ...fresh].slice(-20));
    }
    const errors = outcome.report.steps.filter((step) => step.outcome === "error").length;
    bb.log.info(`sync (${trigger}): ${outcome.report.outcome}, ${outcome.report.steps.length} steps, ${errors} errors`);
    if (retryTimer !== null) clearTimeout(retryTimer);
    retryTimer = null;
    if (outcome.retrySoon && !controller.signal.aborted) {
      retryTimer = setTimeout(() => void requestSync("schedule"), RETRY_MS);
      retryTimer.unref?.();
    }
    if (outcome.selfUpdate) {
      // Last: the update restarts Fleet Kit, and the new version syncs on start.
      try {
        await bb.sdk.plugins.experimental_startUpdate({ pluginId: SELF_ID });
        selfUpdateStartedAt = Date.now();
      } catch (error) {
        bb.log.warn(`could not start the Fleet Kit update: ${error instanceof Error ? error.message : String(error)}`);
      }
    }
  }

  /** Single flight: a request during a sync runs one more sync after it. */
  function requestSync(trigger: SyncReport["trigger"]): Promise<void> {
    if (syncing !== null) {
      rerun = trigger;
      return syncing;
    }
    syncing = (async () => {
      let next: SyncReport["trigger"] | null = trigger;
      try {
        while (next !== null && !controller.signal.aborted) {
          rerun = null;
          publish();
          try {
            await syncOnce(next);
          } catch (error) {
            bb.log.error(`sync failed: ${error instanceof Error ? error.message : String(error)}`);
          }
          next = rerun;
        }
      } finally {
        syncing = null;
        publish();
      }
    })();
    return syncing;
  }

  settings.onChange((next, previous) => {
    if (next.secretStore !== previous.secretStore) store = openSecretStore(next.secretStore as SecretStorePreference);
    const relevant =
      next.manifestUrl !== previous.manifestUrl ||
      next.opencodeConfigDir !== previous.opencodeConfigDir ||
      next.opencodeInstallDir !== previous.opencodeInstallDir ||
      next.syncIntervalMinutes !== previous.syncIntervalMinutes ||
      next.paused !== previous.paused ||
      next.secretStore !== previous.secretStore ||
      next.allowDevSources !== previous.allowDevSources;
    if (!relevant) return;
    if (!next.paused) void requestSync("settings");
    // Only reschedule: the loop waits for this sync instead of starting another.
    wake?.();
    publish();
  });

  bb.background.service("sync", {
    async start(signal) {
      const sleep = (ms: number) =>
        new Promise<void>((resolve) => {
          const timer = setTimeout(done, ms);
          function done() {
            clearTimeout(timer);
            signal.removeEventListener("abort", done);
            wake = null;
            resolve();
          }
          wake = done;
          signal.addEventListener("abort", done, { once: true });
        });
      await sleep(START_DELAY_MS);
      let trigger: SyncReport["trigger"] = "start";
      while (!signal.aborted) {
        const current = await readSettings();
        const interval = current.syncIntervalMinutes * 60_000;
        if (current.paused) {
          trigger = "schedule";
          nextSyncAt = null;
          await sleep(interval);
          continue;
        }
        if (syncing !== null) await syncing;
        else if (trigger === "start" || Date.now() - lastSyncAt >= interval) await requestSync(trigger);
        trigger = "schedule";
        const delay = Math.max(1_000, interval - (Date.now() - lastSyncAt));
        nextSyncAt = new Date(Date.now() + delay).toISOString();
        await sleep(delay);
      }
    },
  });

  // OpenCode launched by this bb reads Fleet Kit's directory when one is set,
  // so another bb on the same machine keeps its own OpenCode configuration.
  bb.providers.experimental_contributeEnv("acp-opencode", async () => {
    const { opencodeConfigDir } = await readSettings();
    if (opencodeConfigDir === "") return [];
    return [{ name: "OPENCODE_CONFIG_DIR", value: opencodeConfigDir, reason: "Fleet Kit keeps this bb's OpenCode configuration in its own directory" }];
  });

  async function saveFromManifest(manifest: Manifest) {
    await kv.set("secrets", {
      list: manifest.secrets.map((secret) => ({ name: secret.name, title: secret.title, hint: secret.hint ?? null })),
    } satisfies StoredSecrets);
    await kv.set("onboarding", {
      steps: manifest.onboarding ?? [],
      planned: manifest.plugins.filter((entry) => entry.status === "planned").map((entry) => entry.id),
      branches: manifest.branches ?? null,
    } satisfies StoredOnboarding);
    agentBuild = agentBuildOf(manifest);
    await kv.set("agentBuild", agentBuild);
    // A build that stops offering own agents takes the yes back: offered again, it takes a new window.
    if (agentBuild.own === null && ownChoice !== null) {
      await kv.set("ownAgents", null);
      ownChoice = null;
    }
    // Before the sync removes a plugin the branding replaces: the page asks for it on its next check.
    await kv.set("branding", { appName: manifest.branding?.appName ?? "", logoSvg: manifest.branding?.logoSvg ?? "" });
  }

  // The build's name and logo for the page's content script (app.tsx). Not a secret: the page shows them.
  bb.http.route("GET", "/branding", async (context) => context.json(readBranding((await kv.get<Record<string, unknown>>("branding")) ?? {})));

  // The build's skills, each to the agents of its audience; the person's own agents only once turned on.
  bb.agents.configure((ctx) => {
    threadAgents.delete(ctx.thread.id);
    threadAgents.set(ctx.thread.id, ctx.provider.id);
    if (threadAgents.size > 2000) threadAgents.delete(threadAgents.keys().next().value!);
    const skills = skillsFor(agentBuild, ownChoice, ctx.provider.id);
    const instructions = skillInstructions(skills);
    return { tools: skills.length > 0 ? [SKILL_TOOL] : [], skills: ["fleet-kit"], ...(instructions !== undefined ? { instructions } : {}) };
  });

  bb.agents.registerTool({
    name: SKILL_TOOL,
    description: "Read one of this build's skills in full: the instructions for a task the build's skill list describes.",
    presentation: { label: { pending: "Reading a build skill", completed: "Read a build skill" } },
    parameters: z.object({ name: z.string().min(1).max(64).describe("The skill's name from the Build skills list in your instructions") }),
    execute: async ({ name }, ctx) => {
      const provider = threadAgents.get(ctx.threadId);
      const skills = provider === undefined ? [] : skillsFor(agentBuild, ownChoice, provider);
      const skill = skills.find((entry) => entry.name === name);
      if (skill === undefined) {
        const known = skills.map((entry) => entry.name).join(", ");
        return { content: [{ type: "text" as const, text: known ? `No build skill named ${name}. This agent has: ${known}.` : "This agent has no build skills." }], isError: true };
      }
      return { content: [{ type: "text" as const, text: skill.body }] };
    },
  });

  async function storedBranches() {
    const branches = (await kv.get<StoredOnboarding>("onboarding"))?.branches ?? null;
    if (branches === null) throw new Error("The build has no branches.");
    return branches;
  }

  /** Choice changes one at a time: two quick clicks, or a branch and a switch at once, never overwrite each other. */
  const changeChoice = createChoiceQueue(
    { read: readChoice, write: (choice) => kv.set("branchChoice", choice) },
    () => {
      publish();
      void requestSync("manual");
    },
  );

  /** Pick a branch. One that would turn plugins off is saved only once the person confirms the list. */
  function pickBranch(branch: string, confirmed: boolean) {
    return changeChoice<{ chosen: string | null; turnsOff: string[] }>(async (current) => {
      const branches = await storedBranches();
      const state = { ...(await readBranchState()), choice: current };
      const off = turnsOff(branches, state, branch);
      if (off.length > 0 && !confirmed) return { save: null, result: { chosen: null, turnsOff: off } };
      return { save: chooseBranch(branches, current, branch), result: { chosen: branch, turnsOff: off } };
    });
  }

  function switchPlugin(id: string, on: boolean) {
    return changeChoice(async (current) => ({ save: togglePlugin(await storedBranches(), current, id, on), result: on }));
  }

  const refuse = (error: unknown): never => {
    throw new experimental_PluginRpcRefusal({ code: "invalid", message: error instanceof Error ? error.message : String(error) });
  };

  async function setSecret(name: string, value: string) {
    const known = ((await kv.get<StoredSecrets>("secrets")) ?? { list: [] }).list.some((secret) => secret.name === name);
    if (!known) throw new Error(`The build does not declare a secret named ${name}.`);
    await store.set(name, checkSecretValue(value));
    publish();
    void requestSync("manual");
  }

  async function clearSecret(name: string) {
    const removed = await store.delete(name);
    publish();
    return removed;
  }

  bb.rpc.register(rpcContract, {
    status: () => status(),
    sync_now: async () => {
      const started = syncing === null;
      void requestSync("manual");
      return { started };
    },
    secret_set: async ({ name, value }) => {
      await setSecret(name, value);
      return { set: true };
    },
    secret_clear: async ({ name }) => ({ removed: await clearSecret(name) }),
    notice_dismiss: async ({ id }) => {
      const notices = (await kv.get<Notice[]>("notices")) ?? [];
      const remaining = notices.filter((notice) => notice.id !== id);
      await kv.set("notices", remaining);
      publish();
      return { dismissed: remaining.length !== notices.length };
    },
    lock_reset: async () => {
      const current = await readSettings();
      const location = resolveOpenCodeLocation({ opencodeConfigDir: current.opencodeConfigDir, environment: process.env });
      const reset = await resetStuckLock(location.configFile);
      if (reset) void requestSync("manual");
      publish();
      return { reset };
    },
    setup_status: ({ lang }) => setup(lang),
    branch_choose: async ({ branch, confirmed }) => {
      try {
        return await pickBranch(branch, confirmed === true);
      } catch (error) {
        return refuse(error);
      }
    },
    branch_toggle: async ({ id, on }) => {
      await switchPlugin(id, on).catch(refuse);
      return { on };
    },
    own_agents_set: ({ on, lang }) => setOwnAgents(on, lang ?? "en"),
    setup_mark: async ({ id, mark }) => {
      const onboarding = (await kv.get<StoredOnboarding>("onboarding")) ?? null;
      const step = onboarding?.steps.find((candidate) => candidate.id === id);
      // Only a plugin without setupStatus is marked done by hand.
      const answer = mark === "done" && step?.plugin !== undefined ? (asker.known(step.plugin) ?? (await asker.ask(step.plugin, "en"))) : null;
      const problem = markProblem(step, mark, answer);
      if (problem !== null) throw new experimental_PluginRpcRefusal({ code: "invalid", message: problem });
      const marks = { ...((await kv.get<Record<string, SetupMark>>("setupMarks")) ?? {}) };
      if (mark === null) delete marks[id];
      else marks[id] = mark;
      await kv.set("setupMarks", marks);
      publish();
      return { marked: true };
    },
  });

  const summary = (report: SyncReport | null) => {
    if (report === null) return "No sync yet.";
    const lines = [
      `${report.build ? `${report.build.name} ${report.build.version}` : "No valid manifest"}: ${report.outcome} (${report.trigger}, ${report.finishedAt})`,
    ];
    for (const step of report.steps) {
      if (step.outcome === "ok" || step.outcome === "skipped") continue;
      lines.push(`  ${step.outcome.padEnd(7)} ${step.area}/${step.item}: ${step.message}`);
    }
    return lines.join("\n");
  };

  bb.cli.register(
    defineCli({
      name: "fleet-kit",
      summary: "Show and run Fleet Kit's build sync, and store build secrets",
      commands: {
        status: cliCommand({
          summary: "Show the build version, the last sync, OpenCode protection and secrets",
          options: { json: { type: "boolean", description: "Print JSON" } },
          async run(input) {
            const value = await status();
            if (input.options.json) return { exitCode: 0, stdout: JSON.stringify(value, null, 2) };
            const lines = [
              `Manifest: ${value.configured ? value.manifestUrl : "not set (bb plugin config fleet-kit set manifestUrl <address>)"}`,
              `Syncing: ${value.paused ? "paused" : `every ${value.intervalMinutes} min`}${value.syncing ? " (running now)" : ""}`,
              summary(value.lastSync),
            ];
            if (value.opencode) {
              lines.push(
                `OpenCode: ${value.opencode.installed ? value.opencode.version : "not installed"}; models: ${value.opencode.models.state} (${value.opencode.protection})`,
              );
              if (value.opencode.install && value.opencode.install.state !== "ready") lines.push(value.opencode.install.message);
            }
            for (const secret of value.secrets) lines.push(`Secret ${secret.name}: ${secret.set ? "set" : "not set"} (${value.secretStore})`);
            return { exitCode: 0, stdout: lines.join("\n") };
          },
        }),
        setup: cliCommand({
          summary: "Show the First run steps and which are done",
          options: { json: { type: "boolean", description: "Print JSON" } },
          async run(input) {
            const value = await setup("en");
            if (input.options.json) return { exitCode: 0, stdout: JSON.stringify(value, null, 2) };
            if (!value.configured) return { exitCode: 0, stdout: "No build read yet: the steps appear after the first sync." };
            const lines = value.steps.map((step) => {
              const state = step.optional && step.mark === "skipped" && step.state !== "done" ? "skipped" : step.state;
              const why = setupNote(step, state);
              return `  ${state.padEnd(10)} ${step.id}: ${step.title}${why ? ` (${why})` : ""}`;
            });
            lines.unshift(value.complete ? "First run: all set." : `First run: ${value.remaining} ${value.remaining === 1 ? "step" : "steps"} left.`);
            return { exitCode: 0, stdout: lines.join("\n") };
          },
        }),
        branch: cliCommand({
          summary: "Show the build's branches and which optional plugins this machine gets",
          options: { json: { type: "boolean", description: "Print JSON" } },
          async run(input) {
            const value = (await setup("en")).branches ?? null;
            if (input.options.json) return { exitCode: 0, stdout: JSON.stringify(value, null, 2) };
            if (value === null) return { exitCode: 0, stdout: "This build has no branches." };
            const lines = [`Branch: ${value.chosen ?? (value.waiting ? "not picked; optional plugins wait for it" : "not picked; everything stays installed")}`];
            for (const branch of value.list) lines.push(`  ${branch.id === value.chosen ? "*" : " "} ${branch.id}: ${branch.title}`);
            for (const plugin of value.plugins) {
              lines.push(`  ${(plugin.on ? "on" : "off").padEnd(4)} ${plugin.id}: ${plugin.title}${plugin.own ? " (your switch)" : ""}${plugin.planned ? " (not built yet)" : ""}`);
            }
            return { exitCode: 0, stdout: lines.join("\n") };
          },
        }),
        "branch choose": cliCommand({
          summary: "Pick a branch; switches of plugins that differ between branches start over from its defaults",
          positionals: [{ name: "branch", description: "Branch id", required: true }],
          options: { yes: { type: "boolean", description: "Confirm turning off the plugins the branch leaves out" } },
          async run(input) {
            let answer: { chosen: string | null; turnsOff: string[] };
            try {
              answer = await pickBranch(input.positionals.branch, input.options.yes === true);
            } catch (error) {
              throw new PluginCliError(error instanceof Error ? error.message : String(error), { code: "no_such_branch" });
            }
            if (answer.chosen === null) {
              return { exitCode: 1, stdout: `Not picked: this turns off ${answer.turnsOff.join(", ")}. Run again with --yes to confirm.` };
            }
            return { exitCode: 0, stdout: `Branch ${input.positionals.branch} picked; syncing.` };
          },
        }),
        "branch plugin": cliCommand({
          summary: "Turn an optional plugin on or off: bb fleet-kit branch plugin <id> on|off",
          positionals: [
            { name: "id", description: "Plugin id", required: true },
            { name: "state", description: "on or off", required: true },
          ],
          async run(input) {
            const state = input.positionals.state;
            if (state !== "on" && state !== "off") throw new PluginCliError("use on or off", { code: "invalid_state" });
            try {
              await switchPlugin(input.positionals.id, state === "on");
            } catch (error) {
              throw new PluginCliError(error instanceof Error ? error.message : String(error), { code: "not_switched" });
            }
            return { exitCode: 0, stdout: `${input.positionals.id} ${state}; syncing.` };
          },
        }),
        "own-agents": cliCommand({
          summary: "Show whether your own agents (such as Claude Code or Codex) are turned on, or turn them on or off: bb fleet-kit own-agents [on|off]",
          positionals: [{ name: "state", description: "on or off; empty shows the state" }],
          async run(input) {
            const state = input.positionals.state;
            if (state !== undefined && state !== "on" && state !== "off") throw new PluginCliError("use on or off", { code: "invalid_state" });
            if (state === undefined) {
              const value = await ownAgentsStatus();
              if (value === null || value === undefined) return { exitCode: 0, stdout: "This build does not offer your own agents." };
              const names = value.providers.map((entry) => entry.name).join(", ");
              return { exitCode: 0, stdout: `Own agents (${names}): ${value.on ? "on" : "off"}.\n\n${value.warning}` };
            }
            let answer: { on: boolean; outcome: OwnAgentsOutcome };
            try {
              answer = await setOwnAgents(state === "on", "en");
            } catch (error) {
              throw new PluginCliError(error instanceof Error ? error.message : String(error), { code: "not_saved" });
            }
            const text: Record<OwnAgentsOutcome, string> = {
              on: "Own agents are on; syncing.",
              off: "Own agents are off; syncing.",
              cancelled: "Not turned on: the system window was cancelled.",
              timeout: "Not turned on: nobody answered the system window.",
              unavailable: "Not turned on: this machine cannot show a system window to confirm it.",
              busy: "Not turned on: another confirmation window is open.",
              paused: "Not turned on: the last window was cancelled or left unanswered; try again in 10 minutes.",
              "not-offered": "This build does not offer your own agents.",
            };
            return { exitCode: answer.outcome === "on" || answer.outcome === "off" ? 0 : 1, stdout: text[answer.outcome] };
          },
        }),
        sync: cliCommand({
          summary: "Sync with the manifest now and wait for the result",
          options: { json: { type: "boolean", description: "Print the report as JSON" } },
          async run(input) {
            const current = await readSettings();
            if (current.manifestUrl.trim() === "") {
              throw new PluginCliError("manifestUrl is not set", {
                code: "not_configured",
                hint: "Run `bb plugin config fleet-kit set manifestUrl <address>`.",
              });
            }
            await requestSync("manual");
            const report = (await kv.get<SyncReport>("lastSync")) ?? null;
            if (input.options.json) return { exitCode: 0, stdout: JSON.stringify(report, null, 2) };
            return { exitCode: report?.outcome === "error" ? 1 : 0, stdout: summary(report) };
          },
        }),
        "secret set": cliCommand({
          summary: "Store a build secret in the credential store; pipe the value: bb fleet-kit secret set <name> --value-stdin < file",
          positionals: [{ name: "name", description: "Secret name from the manifest's secrets list", required: true }],
          options: {
            // bb's CLI turns --value-stdin into this option before the plugin
            // runs, so it cannot be removed; it is hidden and documented only
            // through --value-stdin.
            value: {
              type: "string",
              stdin: true,
              hidden: true,
              required: true,
              description: "Pipe the value with --value-stdin; never type it on the command line",
            },
          },
          async run(input) {
            const name = input.positionals.name;
            if (!SECRET_NAME.test(name)) throw new PluginCliError(`invalid secret name ${name}`, { code: "invalid_name" });
            try {
              await setSecret(name, input.options.value);
            } catch (error) {
              throw new PluginCliError(error instanceof Error ? error.message : String(error), { code: "secret_not_stored" });
            }
            return { exitCode: 0, stdout: `Stored ${name} in ${store.label}.` };
          },
        }),
        "secret clear": cliCommand({
          summary: "Delete a build secret from the credential store",
          positionals: [{ name: "name", description: "Secret name", required: true }],
          async run(input) {
            const removed = await clearSecret(input.positionals.name);
            return { exitCode: 0, stdout: removed ? `Deleted ${input.positionals.name}.` : `${input.positionals.name} was not set.` };
          },
        }),
      },
    }),
  );
}
