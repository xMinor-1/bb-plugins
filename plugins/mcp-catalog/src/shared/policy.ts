// Copied from plugins/exchange-mail/src/shared/policy.ts (commit ccc161e). Keep the copies in step.
// Which agents may read mail. A rule is one line, `<provider-id> <model-glob>`,
// for example `acp-opencode corp/*`. `*` matches any run of characters; a
// rule must name a model glob explicitly, so allowing a provider never silently
// allows every model it can route to.

export interface PolicyRule {
  readonly provider: string;
  readonly model: string;
}

export interface Policy {
  readonly rules: readonly PolicyRule[];
  allows(providerId: string | null | undefined, model: string | null | undefined): boolean;
}

const TOKEN = /^[A-Za-z0-9._:@/*-]+$/;

export class PolicyError extends Error {}

export function parseRules(text: string): PolicyRule[] {
  const rules: PolicyRule[] = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const parts = line.split(/\s+/);
    const [provider, model] = parts;
    if (parts.length !== 2 || provider === undefined || model === undefined) {
      throw new PolicyError(`Line ${index + 1}: expected "<provider-id> <model-glob>", got "${line}"`);
    }
    if (!TOKEN.test(provider) || provider.includes("*") || !TOKEN.test(model)) {
      throw new PolicyError(`Line ${index + 1}: unexpected characters in "${line}"`);
    }
    if (!rules.some((rule) => rule.provider === provider && rule.model === model)) {
      rules.push({ provider, model });
    }
  }
  return rules;
}

export function formatRules(rules: readonly PolicyRule[]): string {
  return rules.map((rule) => `${rule.provider} ${rule.model}`).join("\n");
}

function globToRegExp(glob: string): RegExp {
  const body = glob
    .split("*")
    .map((part) => part.replace(/[.+?^${}()|[\]\\]/g, "\\$&"))
    .join(".*");
  return new RegExp(`^${body}$`);
}

export function createPolicy(rules: readonly PolicyRule[]): Policy {
  const compiled = rules.map((rule) => ({ provider: rule.provider, model: globToRegExp(rule.model) }));
  return {
    rules,
    allows(providerId, model) {
      if (!providerId || !model) return false;
      return compiled.some((rule) => rule.provider === providerId && rule.model.test(model));
    },
  };
}

/** A policy that allows nothing: the state before anyone chose agents. */
export const DENY_ALL: Policy = createPolicy([]);
