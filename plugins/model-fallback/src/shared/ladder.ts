// Fallback ladders. One ladder per line:
//
//   <provider-id> <model> > <model> > <model>
//
// for example `acp-opencode corp/coder > corp/daily-thinking > corp/fast`.
// When a turn on a model fails or hangs, the thread continues on the model
// that follows it in the first ladder that names it. The last model of a
// ladder has no fallback. Every model of a ladder must be allowed by the
// allowedModels policy: a ladder can never lead outside it.

import type { Policy } from "./policy";

export interface Ladder {
  readonly provider: string;
  readonly models: readonly string[];
}

export class LadderError extends Error {}

const TOKEN = /^[A-Za-z0-9._:@/-]+$/;
export const MAX_LADDERS = 20;
export const MAX_LADDER_LENGTH = 10;

export function parseLadders(text: string): Ladder[] {
  const ladders: Ladder[] = [];
  for (const [index, raw] of text.split(/\r?\n/).entries()) {
    const line = raw.replace(/#.*$/, "").trim();
    if (line === "") continue;
    const space = line.search(/\s/);
    if (space < 0) throw new LadderError(`Line ${index + 1}: expected "<provider-id> <model> > <model>", got "${line}"`);
    const provider = line.slice(0, space);
    const models = line
      .slice(space)
      .split(">")
      .map((part) => part.trim());
    if (!TOKEN.test(provider)) throw new LadderError(`Line ${index + 1}: unexpected characters in "${provider}"`);
    if (models.length < 2 || models.some((model) => model === "")) {
      throw new LadderError(`Line ${index + 1}: a ladder needs at least two models separated by ">"`);
    }
    for (const model of models) {
      if (!TOKEN.test(model)) throw new LadderError(`Line ${index + 1}: unexpected characters in "${model}"`);
    }
    if (new Set(models).size !== models.length) throw new LadderError(`Line ${index + 1}: a model appears twice`);
    if (models.length > MAX_LADDER_LENGTH) throw new LadderError(`Line ${index + 1}: at most ${MAX_LADDER_LENGTH} models`);
    ladders.push({ provider, models });
    if (ladders.length > MAX_LADDERS) throw new LadderError(`At most ${MAX_LADDERS} ladders`);
  }
  return ladders;
}

/** Ladder models that the policy does not allow, as `provider model` strings. */
export function disallowedModels(ladders: readonly Ladder[], policy: Policy): string[] {
  const out: string[] = [];
  for (const ladder of ladders) {
    for (const model of ladder.models) {
      if (!policy.allows(ladder.provider, model)) out.push(`${ladder.provider} ${model}`);
    }
  }
  return out;
}

/**
 * The model to continue on after `model` failed, or null when there is none.
 * The first ladder of the provider that names the model decides. A fallback
 * the policy does not allow is never returned, even if a ladder lists it.
 */
export function nextModel(
  ladders: readonly Ladder[],
  policy: Policy,
  provider: string,
  model: string,
): string | null {
  const ladder = ladders.find((candidate) => candidate.provider === provider && candidate.models.includes(model));
  if (!ladder) return null;
  for (const candidate of ladder.models.slice(ladder.models.indexOf(model) + 1)) {
    if (policy.allows(provider, candidate)) return candidate;
  }
  return null;
}

/** Whether any ladder covers this provider and model at all. */
export function inLadder(ladders: readonly Ladder[], provider: string, model: string): boolean {
  return ladders.some((ladder) => ladder.provider === provider && ladder.models.includes(model));
}
