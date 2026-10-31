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
import type { Setup, SetupMark, SetupStep, SyncReport } from "../contract.js";
import type { OnboardingStep } from "./manifest.js";

type Sdk = BbPluginApi["sdk"];

/** What the last sync with a valid manifest left for the page. */
export interface StoredOnboarding {
  steps: OnboardingStep[];
  /** Plugins the manifest lists as planned: their steps wait for them. */
  planned: string[];
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
  if (deps.onboarding === null) return { configured: false, manifestSet, steps: [], remaining: 0, complete: false, secretStore };
  const planned = new Set(deps.onboarding.planned);
  const asksPlugins = deps.onboarding.steps.some((step) => step.plugin !== undefined && !planned.has(step.plugin));
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
      return failed ? { ...own, state: "problem", reason: "install-failed" } : { ...own, state: "installing" };
    }
    const answer = await deps.ask(plugin, deps.lang);
    if (answer === null) return { ...own, state: "checking" };
    if (answer.kind === "manual") return { ...own, state: mark === "done" ? "done" : "todo", reason: "manual", manual: true };
    if (answer.kind === "error") return { ...own, state: "problem", reason: "no-answer" };
    return { ...own, state: answer.state, summary: answer.summary, path: answer.path ?? own.path };
  };

  const steps = await Promise.all(deps.onboarding.steps.map(one));
  const remaining = steps.filter(stepLeft).length;
  return { configured: true, manifestSet, steps, remaining, complete: remaining === 0, secretStore };
}

/** Why a mark is refused, or null. `answer`: what the step's plugin said last (null: not asked yet). */
export function markProblem(step: OnboardingStep | undefined, mark: SetupMark | null, answer: PluginAnswer | null = null): string | null {
  if (step === undefined) return "The build has no such setup step.";
  if (mark === "skipped" && step.optional !== true) return "Only an optional step can be skipped.";
  if (mark === "done" && step.secret !== undefined) return "A secret step is done once the secret is saved.";
  if (mark === "done" && answer?.kind !== "manual") {
    return answer?.kind === "answer"
      ? "This step's plugin reports its state itself."
      : "Fleet Kit could not ask the step's plugin yet; open First run again and retry.";
  }
  return null;
}
