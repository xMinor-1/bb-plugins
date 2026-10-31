// Copied from plugins/qlik-sense/src/shared/available-models.ts (commit c0399a0). Keep both copies and their tests in sync.
// Same logic; only user-facing messages are worded for Fleet Kit.
// Primary fleet guard: check the result of OpenCode's own policy evaluation.
// The caller must run `opencode models` without a provider filter, against the
// ACP environment and project location. This checks configuration, not a running
// agent's state. Never log unparsed output.
import { parseAllowedProviders } from "./settings.js";
import type { ProviderPolicyDecision } from "./provider-policy.js";

export function verifyAvailableModels(allowedProviders: string, exitCode: number | null, stdout: unknown): ProviderPolicyDecision {
  let allowed: string[];
  try { allowed = parseAllowedProviders(allowedProviders); } catch {
    return { state: "blocked", reason: "The allowed provider setting is invalid." };
  }
  if (allowed.length === 0) return {
    state: "unrestricted",
    warning: "Provider restrictions are off: every model available in OpenCode can be used.",
  };
  if (exitCode !== 0 || typeof stdout !== "string" || stdout.length > 4 * 1024 * 1024) return {
    state: "blocked", reason: "OpenCode's available models could not be checked..",
  };
  const lines = stdout.trim().split(/\r?\n/);
  if (stdout.trim() === "" || lines.length > 50_000) return {
    state: "blocked", reason: "OpenCode returned no usable model list..",
  };
  for (const line of lines) {
    const model = /^([A-Za-z0-9_-]+)\/([^\s\x00-\x1f\x7f]+)$/.exec(line);
    if (!model) return {
      state: "blocked", reason: "OpenCode returned an unsupported model list format..",
    };
    if (!allowed.includes(model[1]!)) return {
      state: "blocked", reason: "OpenCode has models outside the approved provider list..",
    };
  }
  return { state: "verified" };
}
