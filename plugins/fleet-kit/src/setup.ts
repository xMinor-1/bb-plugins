// The "First run" page's data: the build's onboarding steps and whether each
// one is done.
//
// A secret step is done once the secret is in the credential store; the page
// asks for it itself. A plugin step asks the plugin: every plugin with a setup
// step answers the RPC method `setupStatus`
//   input  { lang?: "en" | "ru", hostId?: string }
//   output { state: "done" | "todo" | "problem", summary: string, path?: string }
// from what it has saved, without network calls. A plugin without the method
// gets a "Mark as done" button instead. Passwords and tokens never pass
// through Fleet Kit: the person types them in the plugin's own form.
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { AccountStep, BranchSetup, InstallProgress, Setup, SetupMark, SetupStep, SyncReport } from "../contract.js";
import { accountVersion, type AccountResults, type AccountValue } from "./account.js";
import type { OnboardingStep } from "./manifest.js";
import { branchDefault, chosenBranch, noBranchState, picked, pluginWanted, type Branches, type BranchState } from "./branches.js";

type Sdk = BbPluginApi["sdk"];

/** What the last sync with a valid manifest left for the page. */
export interface StoredOnboarding {
  steps: OnboardingStep[];
  /** Plugins the manifest lists as planned: their steps wait for them. */
  planned: string[];
  /** The build's branches; absent when it has none (or was saved by an older Fleet Kit). */
  branches?: Branches | null;
  /** The name of each plugin the page shows; absent when saved by an older Fleet Kit. */
  titles?: Record<string, string>;
}

export const SETUP_METHOD = "setupStatus";
/** A plugin call gives up after this. */
export const PLUGIN_SETUP_MS = 8_000;
/** The page waits this long; a slower plugin's step shows as "checking" and its answer arrives later. */
export const PLUGIN_WAIT_MS = 1_500;
/** A plugin's answer serves this long, so the page asking again does not call the plugin again. */
export const PLUGIN_FRESH_MS = 4_000;

const PAGE_PATH = /^\/plugins\/[a-z0-9][a-z0-9-]*(\/[A-Za-z0-9._~-]+)*$/;

/** A plugin's answer. Unknown fields are dropped: a newer plugin may say more. */
export const pluginSetupSchema = z.object({
  state: z.enum(["done", "todo", "problem"]),
  summary: z.string().max(200),
  path: z.string().max(300).optional(),
});

/** What a plugin said about its step. */
export type PluginAnswer =
  | { kind: "answer"; state: "done" | "todo" | "problem"; summary: string | null; path: string | null }
  /** The plugin has no setupStatus: the person marks the step. */
  | { kind: "manual" }
  /** The call failed or timed out. */
  | { kind: "error" };

export interface AskerOptions {
  waitMs?: number;
  timeoutMs?: number;
  freshMs?: number;
}

interface AskEntry {
  at: number;
  answer: PluginAnswer | null;
  pending: Promise<PluginAnswer> | null;
  /** The page stopped waiting for the pending call: tell it when the answer comes. */
  late: boolean;
}

/**
 * Asks plugins for their step: at most one call per plugin and language at a
 * time, and the page never waits for the slowest plugin. A call slower than
 * `waitMs` goes on in the background; `onLate` then tells the page to ask
 * again, and the answer serves for `freshMs`.
 */
export class SetupAsker {
  readonly #entries = new Map<string, AskEntry>();
  readonly #wait: number;
  readonly #timeout: number;
  readonly #fresh: number;

  constructor(
    private readonly callRpc: Sdk["plugins"]["callRpc"],
    private readonly onLate: () => void,
    options: AskerOptions = {},
  ) {
    this.#wait = options.waitMs ?? PLUGIN_WAIT_MS;
    this.#timeout = options.timeoutMs ?? PLUGIN_SETUP_MS;
    this.#fresh = options.freshMs ?? PLUGIN_FRESH_MS;
  }

  /** The plugin's latest answer in any language, without asking. */
  known(pluginId: string): PluginAnswer | null {
    let latest: AskEntry | null = null;
    for (const [key, entry] of this.#entries) {
      if (key.startsWith(`${pluginId}\n`) && entry.answer !== null && (latest === null || entry.at > latest.at)) latest = entry;
    }
    return latest?.answer ?? null;
  }

  /** The answer, the previous one while a new call is slow, or null: still checking. */
  async ask(pluginId: string, lang: "en" | "ru"): Promise<PluginAnswer | null> {
    const key = `${pluginId}\n${lang}`;
    let entry = this.#entries.get(key);
    if (entry === undefined) {
      entry = { at: 0, answer: null, pending: null, late: false };
      this.#entries.set(key, entry);
    }
    if (entry.answer !== null && entry.pending === null && Date.now() - entry.at < this.#fresh) return entry.answer;
    if (entry.pending === null) {
      const current = entry;
      current.pending = this.#call(pluginId, lang).then((answer) => {
        current.answer = answer;
        current.at = Date.now();
        current.pending = null;
        if (current.late) {
          current.late = false;
          this.onLate();
        }
        return answer;
      });
    }
    let timer: NodeJS.Timeout | undefined;
    const settled = await Promise.race([
      entry.pending,
      new Promise<null>((resolve) => {
        timer = setTimeout(() => resolve(null), this.#wait);
      }),
    ]);
    clearTimeout(timer);
    if (settled !== null) return settled;
    entry.late = true;
    return entry.answer;
  }

  async #call(pluginId: string, lang: "en" | "ru"): Promise<PluginAnswer> {
    try {
      const answer = await this.callRpc({
        pluginId,
        method: SETUP_METHOD,
        input: { lang },
        outputSchema: pluginSetupSchema,
        signal: AbortSignal.timeout(this.#timeout),
      });
      const path = answer.path !== undefined && PAGE_PATH.test(answer.path) ? answer.path : null;
      return { kind: "answer", state: answer.state, summary: answer.summary.trim() || null, path };
    } catch (error) {
      return noSuchMethod(error) ? { kind: "manual" } : { kind: "error" };
    }
  }
}

export interface SetupDeps {
  listPlugins: () => Promise<{ id: string; enabled: boolean }[]>;
  ask: (pluginId: string, lang: "en" | "ru") => Promise<PluginAnswer | null>;
  /** The machine's manifestUrl is set. */
  manifestSet: boolean;
  onboarding: StoredOnboarding | null;
  marks: Record<string, SetupMark>;
  secrets: { name: string; hint: string | null }[];
  secretSet: (name: string) => Promise<boolean>;
  secretStore: string;
  lastSync: SyncReport | null;
  lang: "en" | "ru";
  /** The person's choice and what the sync applied; known from the start of the first sync. */
  branchState?: BranchState;
  /** What the running sync installs: a plugin waiting its turn reads as queued, not as installing. */
  installs?: InstallProgress | null;
  /** An account step's saved login and password (null: none) and what each plugin made of them. */
  account?: (stepId: string) => Promise<{ value: AccountValue | null; results: AccountResults }>;
  /** bb's primary host: where a plugin's sign-in window opens. */
  hostId?: string | null;
}

/** The branch part of the page: what the build offers and what this machine gets. */
export function branchSetup(onboarding: StoredOnboarding, state: BranchState): BranchSetup | null {
  const branches = onboarding.branches ?? undefined;
  if (branches === undefined) return null;
  const branch = chosenBranch(branches, state.choice);
  const planned = new Set(onboarding.planned);
  const wanted = (id: string) => pluginWanted(branches, state, id);
  return {
    list: branches.list.map((entry) => ({
      id: entry.id,
      title: entry.title,
      hint: entry.hint ?? null,
      defaults: Object.fromEntries(branches.optional.filter((plugin) => !planned.has(plugin.id)).map((plugin) => [plugin.id, branchDefault(entry, plugin.id)])),
    })),
    chosen: branch?.id ?? null,
    dropped: picked(state.choice) && branch === null,
    waiting: branches.optional.some((entry) => wanted(entry.id) === "wait"),
    plugins: branches.optional.map((entry) => ({
      id: entry.id,
      title: entry.title,
      hint: entry.hint ?? null,
      on: wanted(entry.id) === "on",
      waiting: wanted(entry.id) === "wait",
      recommended: branchDefault(branch, entry.id),
      own: state.choice?.plugins[entry.id] !== undefined,
      planned: planned.has(entry.id),
    })),
  };
}

/**
 * The plugin has no `setupStatus` to ask. bb answers a missing method with
 * `unknown_method`; `not_found` and the rest come from a plugin that is not
 * there or failed, and are not a reason to let the person mark the step.
 */
function noSuchMethod(error: unknown): boolean {
  return (error as { code?: unknown } | null)?.code === "unknown_method";
}

/** Counts towards "N steps left". */
export function stepLeft(step: SetupStep): boolean {
  if (step.state === "done" || step.state === "later") return false;
  return !(step.optional && step.mark === "skipped");
}

export async function collectSetup(deps: SetupDeps): Promise<Setup> {
  const secretStore = deps.secretStore;
  const manifestSet = deps.manifestSet;
  if (deps.onboarding === null) return { configured: false, manifestSet, steps: [], remaining: 0, complete: false, secretStore, branches: null };
  const planned = new Set(deps.onboarding.planned);
  const state = deps.branchState ?? noBranchState();
  const branches = branchSetup(deps.onboarding, state);
  // A plugin left out of this machine's set has no step: it is not installed, or turned off, or waits for a branch.
  // Nor has a plugin the build has not shipped yet: the branch card names it as coming in a later version.
  const shown = deps.onboarding.steps.filter(
    (step) => step.plugin === undefined || (!planned.has(step.plugin) && pluginWanted(deps.onboarding!.branches ?? undefined, state, step.plugin) === "on"),
  );
  const wantedHere = (plugin: string) => !planned.has(plugin) && pluginWanted(deps.onboarding!.branches ?? undefined, state, plugin) === "on";
  const asksPlugins = shown.some((step) => (step.plugin !== undefined && !planned.has(step.plugin)) || step.account !== undefined);
  let installed: Map<string, { enabled: boolean }> | null = null;
  if (asksPlugins) {
    try {
      installed = new Map((await deps.listPlugins()).map((plugin) => [plugin.id, plugin]));
    } catch {
      // Unknown: ask the plugins anyway; one that is not there does not answer.
      installed = null;
    }
  }

  const one = async (step: OnboardingStep): Promise<SetupStep> => {
    const mark = deps.marks[step.id] ?? null;
    const base = { id: step.id, title: step.title, hint: step.hint ?? null, optional: step.optional === true, mark, summary: null, reason: null, manual: false };
    if (step.account !== undefined) {
      const account = await accountStep(step, deps, installed, wantedHere);
      return { ...base, kind: "account", target: step.id, state: accountState(account), path: null, account };
    }
    if (step.secret !== undefined) {
      const set = await deps.secretSet(step.secret).catch(() => false);
      const hint = step.hint ?? deps.secrets.find((secret) => secret.name === step.secret)?.hint ?? null;
      return { ...base, hint, kind: "secret", target: step.secret, state: set ? "done" : "todo", path: null };
    }
    const plugin = step.plugin!;
    const own = { ...base, kind: "plugin" as const, target: plugin, path: step.path ?? null };
    if (planned.has(plugin)) return { ...own, state: "later", path: null };
    const entry = installed?.get(plugin);
    if (installed !== null && (entry === undefined || !entry.enabled)) {
      // The sync installs and enables required plugins; until then there is nothing to ask.
      const failed = deps.lastSync?.steps.some((s) => s.area === "plugin" && s.item === plugin && s.outcome === "error") === true;
      if (failed) return { ...own, state: "problem", reason: "install-failed" };
      const queued = deps.installs?.finishedAt === null && deps.installs.queue.some((item) => item.id === plugin);
      return { ...own, state: queued ? "queued" : "installing" };
    }
    const answer = await deps.ask(plugin, deps.lang);
    if (answer === null) return { ...own, state: "checking" };
    if (answer.kind === "manual") return { ...own, state: mark === "done" ? "done" : "todo", reason: "manual", manual: true };
    if (answer.kind === "error") return { ...own, state: "problem", reason: "no-answer" };
    return { ...own, state: answer.state, summary: answer.summary, path: answer.path ?? own.path };
  };

  const steps = await Promise.all(shown.map(one));
  // Picking a branch is a step of its own only while plugins wait for it; elsewhere everything stays as it was.
  const remaining = steps.filter(stepLeft).length + (branches?.waiting ? 1 : 0);
  return { configured: true, manifestSet, steps, remaining, complete: remaining === 0, secretStore, branches };
}

const titleOf = (onboarding: StoredOnboarding, plugin: string) =>
  onboarding.titles?.[plugin] ?? onboarding.branches?.optional.find((entry) => entry.id === plugin)?.title ?? plugin;

async function accountStep(
  step: OnboardingStep,
  deps: SetupDeps,
  installed: Map<string, { enabled: boolean }> | null,
  wanted: (plugin: string) => boolean,
): Promise<AccountStep> {
  const block = step.account!;
  const saved = (await deps.account?.(step.id).catch(() => null)) ?? { value: null, results: {} };
  const version = saved.value === null ? null : accountVersion(saved.value);
  const here = (plugin: string) => installed === null || installed.get(plugin)?.enabled === true;
  const plugins = await Promise.all(
    block.plugins
      .filter((entry) => entry.enabled !== false && wanted(entry.plugin))
      .map(async (entry): Promise<AccountStep["plugins"][number]> => {
        const line = { id: entry.plugin, title: titleOf(deps.onboarding!, entry.plugin), summary: null, reason: null, path: null };
        if (!here(entry.plugin)) return { ...line, state: "waiting" };
        const answer = await deps.ask(entry.plugin, deps.lang);
        const path = answer?.kind === "answer" ? answer.path : null;
        // Signed in already, by this step or by the computer's own sign-in.
        if (answer?.kind === "answer" && answer.state === "done") return { ...line, state: "done", summary: answer.summary, path };
        const result = saved.results[entry.plugin];
        if (version === null || result === undefined || result.version !== version) return { ...line, state: "todo", path };
        if (result.rejected) return { ...line, state: "problem", summary: result.summary, reason: "rejected", path };
        return { ...line, state: result.state, summary: result.summary, reason: result.reason ?? null, path };
      }),
  );
  const windows = await Promise.all(
    block.windows
      .filter((entry) => wanted(entry.plugin))
      .map(async (entry): Promise<AccountStep["windows"][number]> => {
        const line = { id: entry.plugin, title: titleOf(deps.onboarding!, entry.plugin), hint: entry.hint ?? null, method: entry.method, summary: null, path: null };
        if (!here(entry.plugin)) return { ...line, state: "waiting" };
        const answer = await deps.ask(entry.plugin, deps.lang);
        if (answer === null) return { ...line, state: "checking" };
        if (answer.kind !== "answer") return { ...line, state: "todo" };
        return { ...line, state: answer.state, summary: answer.summary, path: answer.path };
      }),
  );
  return { saved: saved.value !== null, loginHint: block.loginHint ?? null, passwordHint: block.passwordHint ?? null, plugins, windows, hostId: deps.hostId ?? null };
}

/**
 * The step is done once every plugin took the sign-in (a plugin with more to
 * do, such as picking reports, says so on its own step) and every window
 * sign-in is done. A plugin not installed yet keeps it open.
 */
export function accountState(account: AccountStep): SetupStep["state"] {
  const lines = [...account.plugins, ...account.windows];
  if (lines.some((line) => line.state === "problem")) return "problem";
  const passwordLeft = account.plugins.some((line) => line.state === "todo" && line.summary === null);
  if (!account.saved && passwordLeft) return "todo";
  if (lines.some((line) => line.state === "waiting")) return "installing";
  if (account.windows.some((line) => line.state === "todo" || line.state === "checking")) return "todo";
  if (passwordLeft) return "checking";
  return "done";
}

/** Why a mark is refused, or null. `answer`: what the step's plugin said last (null: not asked yet). */
export function markProblem(step: OnboardingStep | undefined, mark: SetupMark | null, answer: PluginAnswer | null = null): string | null {
  if (step === undefined) return "The build has no such setup step.";
  if (mark === "skipped" && step.optional !== true) return "Only an optional step can be skipped.";
  if (mark === "done" && step.secret !== undefined) return "A secret step is done once the secret is saved.";
  if (mark === "done" && step.account !== undefined) return "An account step is done once its plugins are signed in.";
  if (mark === "done" && answer?.kind !== "manual") {
    return answer?.kind === "answer"
      ? "This step's plugin reports its state itself."
      : "Fleet Kit could not ask the step's plugin yet; open First run again and retry.";
  }
  return null;
}
