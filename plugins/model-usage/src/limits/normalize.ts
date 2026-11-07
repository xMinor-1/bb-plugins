// Plan names and account de-duplication, as bb's builtin Provider usage does
// them, so both panels label and merge accounts the same way. Adapted from
// plugins/provider-usage/usage-normalization.ts in github.com/get-bb/bb,
// MIT License, Copyright (c) 2026 Michael Yong. See THIRD_PARTY_NOTICES.md.

const PLAN_NAMES: Record<string, string> = {
  free: "Free",
  go: "Go",
  plus: "Plus",
  pro: "Pro",
  max: "Max",
  ultra: "Ultra",
  team: "Team",
  business: "Business",
  enterprise: "Enterprise",
  education: "Education",
  edu: "Education",
};

/** "Max (20x)" from a structured plan; the source's own label otherwise. */
export function planLabel(
  plan: { id: string; multiplier: number | null } | null,
  fallback: string | null,
): string | null {
  const name = plan ? PLAN_NAMES[plan.id] : undefined;
  if (!name) return fallback;
  return plan?.multiplier == null ? name : `${name} (${plan.multiplier}x)`;
}

type Identity = {
  providerId: string;
  accountKey?: string | null;
  scope: { kind: "shared" | "host" };
};

/**
 * Keeps one resource per known account within a location: the same login seen
 * by two sources is one account. Unknown identities (null key) are never
 * merged — two rows without a key may be two different people.
 */
export function selectUsageResources<T>(
  resources: readonly T[],
  identify: (resource: T) => Identity,
): T[] {
  const result: T[] = [];
  const known = new Map<string, number>();
  for (const resource of resources) {
    const identity = identify(resource);
    if (!identity.accountKey) {
      result.push(resource);
      continue;
    }
    const key = JSON.stringify([identity.providerId, identity.accountKey]);
    const index = known.get(key);
    if (index === undefined) {
      known.set(key, result.length);
      result.push(resource);
    } else if (identity.scope.kind === "shared" && identify(result[index]!).scope.kind !== "shared") {
      result[index] = resource;
    }
  }
  return result;
}
