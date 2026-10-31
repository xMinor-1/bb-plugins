// Copied from plugins/qlik-sense/src/shared/provider-policy.ts (commit c0399a0). Keep both copies and their tests in sync.
// Same logic; only user-facing messages are worded for Fleet Kit.
// Pure proof over OpenCode v2's EFFECTIVE, ordered provider policy statements.
// Never pass an individual user/project config here: managed policy precedence
// must already have been resolved by OpenCode itself. The host adapter is pending.
import { parseAllowedProviders } from "./settings.js";

export type ProviderPolicyDecision =
  | { state: "unrestricted"; warning: string }
  | { state: "verified" }
  | { state: "blocked"; reason: string };

/** A conservative proof: require deny-all, then allow only literal approved IDs.
 * Unknown policy shapes or wildcard allows are refused, even if more complex
 * reasoning could prove them safe. No model call or credential access is needed.
 */
export function verifyEffectiveProviderPolicy(allowedProviders: string, effectivePolicies: unknown): ProviderPolicyDecision {
  let allowed: string[];
  try { allowed = parseAllowedProviders(allowedProviders); } catch {
    return { state: "blocked", reason: "The allowed provider setting is invalid." };
  }
  if (allowed.length === 0) return {
    state: "unrestricted",
    warning: "Provider restrictions are off: every model available in OpenCode can be used.",
  };
  if (!Array.isArray(effectivePolicies) || effectivePolicies.length > 10_000) return {
    state: "blocked", reason: "OpenCode's effective provider policy could not be verified.",
  };
  const rules: { effect: "allow" | "deny"; resource: string }[] = [];
  for (const rule of effectivePolicies) {
    if (!rule || typeof rule !== "object" || typeof rule.action !== "string" ||
        typeof rule.resource !== "string" || !["allow", "deny"].includes(rule.effect)) return {
      state: "blocked", reason: "OpenCode returned an unsupported effective policy statement.",
    };
    if (rule.action === "provider.use") rules.push({ effect: rule.effect, resource: rule.resource });
  }
  let denyAll = -1;
  rules.forEach((rule, index) => { if (rule.effect === "deny" && rule.resource === "*") denyAll = index; });
  if (denyAll < 0) return {
    state: "blocked", reason: "OpenCode must deny all providers before allowing the approved provider IDs.",
  };
  for (const rule of rules.slice(denyAll + 1)) {
    if (rule.effect === "allow" && (!/^[A-Za-z0-9_-]+$/.test(rule.resource) || !allowed.includes(rule.resource))) return {
      state: "blocked", reason: "OpenCode policy allows providers outside the approved list, or uses an unverifiable wildcard allow.",
    };
  }
  return { state: "verified" };
}
