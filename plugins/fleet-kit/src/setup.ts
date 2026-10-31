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
/** The setup page waits for every plugin at once; a slow one shows as not answering. */
export const PLUGIN_SETUP_MS = 8_000;

const PAGE_PATH = /^\/plugins\/[a-z0-9][a-z0-9-]*(\/[A-Za-z0-9._~-]+)*$/;

/** A plugin's answer. Unknown fields are dropped: a newer plugin may say more. */
export const pluginSetupSchema = z.object({
  state: z.enum(["done", "todo", "problem"]),
  summary: z.string().max(200),
  path: z.string().max(300).optional(),
});

export interface SetupDeps {
  sdk: Pick<Sdk, "plugins">;
  onboarding: StoredOnboarding | null;
  marks: Record<string, SetupMark>;
  secrets: { name: string; hint: string | null }[];
  secretSet: (name: string) => Promise<boolean>;
  secretStore: string;
  lastSync: SyncReport | null;
  lang: "en" | "ru";
  timeoutMs?: number;
}

/** The plugin has no `setupStatus` to ask. */
function noSuchMethod(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  return code === "unknown_method" || code === "not_found";
}

/** Counts towards "N steps left". */
export function stepLeft(step: SetupStep): boolean {
  if (step.state === "done" || step.state === "later") return false;
  return !(step.optional && step.mark === "skipped");
}

export async function collectSetup(deps: SetupDeps): Promise<Setup> {
  const secretStore = deps.secretStore;
  if (deps.onboarding === null) return { configured: false, steps: [], remaining: 0, complete: false, secretStore };
  const planned = new Set(deps.onboarding.planned);
  const asksPlugins = deps.onboarding.steps.some((step) => step.plugin !== undefined && !planned.has(step.plugin));
  let installed: Map<string, { enabled: boolean }> | null = null;
  if (asksPlugins) {
    try {
      installed = new Map((await deps.sdk.plugins.list()).plugins.map((plugin) => [plugin.id, plugin]));
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
    try {
      const answer = await deps.sdk.plugins.callRpc({
        pluginId: plugin,
        method: SETUP_METHOD,
        input: { lang: deps.lang },
        outputSchema: pluginSetupSchema,
        signal: AbortSignal.timeout(deps.timeoutMs ?? PLUGIN_SETUP_MS),
      });
      const path = answer.path !== undefined && PAGE_PATH.test(answer.path) ? answer.path : own.path;
      return { ...own, state: answer.state, summary: answer.summary.trim() || null, path };
    } catch (error) {
      if (noSuchMethod(error)) return { ...own, state: mark === "done" ? "done" : "todo", reason: "manual", manual: true };
      return { ...own, state: "problem", reason: "no-answer" };
    }
  };

  const steps = await Promise.all(deps.onboarding.steps.map(one));
  const remaining = steps.filter(stepLeft).length;
  return { configured: true, steps, remaining, complete: remaining === 0, secretStore };
}

/** Why a mark is refused, or null. */
export function markProblem(step: OnboardingStep | undefined, mark: SetupMark | null): string | null {
  if (step === undefined) return "The build has no such setup step.";
  if (mark === "skipped" && step.optional !== true) return "Only an optional step can be skipped.";
  if (mark === "done" && step.secret !== undefined) return "A secret step is done once the secret is saved.";
  return null;
}
