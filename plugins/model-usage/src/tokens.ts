// Tokens per model for the last five hours, day and week, from both tools:
// Claude Code's session logs on the server's machine and OpenCode's database
// on every machine bb reaches. Pure functions: the server feeds them what it
// collected, tests feed them fixtures.
import type { OpencodeRow } from "./opencode/reader";
import {
  TOKEN_WINDOWS,
  addTotals,
  emptyTotals,
  type ModelGroup,
  type ModelUsage,
  type TokenTotals,
  type TokenWindow,
} from "./shared/types";

/**
 * Parses the corporate model setting: `provider/model` prefixes separated by
 * commas, spaces or new lines; a trailing `*` is allowed and means the same.
 */
export function parsePrefixes(text: string): string[] {
  return text
    .split(/[\s,]+/)
    .map((part) => part.trim().replace(/\*+$/, "").toLowerCase())
    .filter((part) => part.length > 0);
}

export function isCorporate(providerId: string, modelId: string, prefixes: string[]): boolean {
  if (prefixes.length === 0) return false;
  const full = `${providerId}/${modelId}`.toLowerCase();
  return prefixes.some((prefix) => full.startsWith(prefix));
}

/** One model's figures from Claude Code's logs, per window. */
export interface ClaudeModelTotals {
  model: string;
  calls: number;
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
}

export function claudeTotals(t: Omit<ClaudeModelTotals, "model">): TokenTotals {
  return {
    requests: t.calls,
    input: t.input,
    output: t.output,
    cacheRead: t.cacheRead,
    cacheWrite: t.cacheCreation,
    total: t.input + t.output + t.cacheRead + t.cacheCreation,
  };
}

function opencodeTotals(row: OpencodeRow): TokenTotals {
  // Claude Code counts thinking inside output; OpenCode keeps it apart. Folded
  // in here, the two columns mean the same thing.
  const output = row.output + row.reasoning;
  return {
    requests: row.requests,
    input: row.input,
    output,
    cacheRead: row.cacheRead,
    cacheWrite: row.cacheWrite,
    total: row.input + output + row.cacheRead + row.cacheWrite,
  };
}

function blankWindows(): Record<TokenWindow, TokenTotals> {
  return { "5h": emptyTotals(), "24h": emptyTotals(), "7d": emptyTotals() };
}

const groupTotal = (models: ModelUsage[]) => models.reduce((sum, m) => sum + m.windows["7d"].total, 0);

function sortModels(models: ModelUsage[]): ModelUsage[] {
  return models
    .filter((m) => m.windows["7d"].total > 0 || m.windows["7d"].requests > 0)
    .sort((a, b) => b.windows["7d"].total - a.windows["7d"].total || a.id.localeCompare(b.id));
}

/** Claude Code's models on the server's machine, one group. */
export function claudeGroup(args: {
  hostId: string;
  hostName: string;
  perWindow: Record<TokenWindow, ClaudeModelTotals[]>;
  collectedAt: number;
  prefixes: string[];
}): ModelGroup | null {
  const byModel = new Map<string, ModelUsage>();
  for (const window of TOKEN_WINDOWS) {
    for (const row of args.perWindow[window]) {
      if (!row.model || row.model === "<synthetic>") continue;
      const entry = byModel.get(row.model) ?? { id: row.model, windows: blankWindows() };
      entry.windows[window] = addTotals(entry.windows[window], claudeTotals(row));
      byModel.set(row.model, entry);
    }
  }
  const models = sortModels([...byModel.values()]);
  if (models.length === 0) return null;
  return {
    key: `claude-code:${args.hostId}:claude-code`,
    source: "claude-code",
    providerId: "claude-code",
    corporate: models.every((m) => isCorporate("claude-code", m.id, args.prefixes)),
    hostId: args.hostId,
    hostName: args.hostName,
    online: true,
    collectedAt: args.collectedAt,
    problem: null,
    models,
  };
}

/**
 * OpenCode's models on one machine, a group per provider; models matching
 * the corporate prefixes form one group of their own. Buckets add up into
 * windows: the day includes the five hours, the week includes the day.
 */
export function opencodeGroups(args: {
  hostId: string;
  hostName: string;
  online: boolean;
  rows: OpencodeRow[];
  collectedAt: number | null;
  problem: ModelGroup["problem"];
  prefixes: string[];
}): ModelGroup[] {
  const groups = new Map<string, { providerId: string; corporate: boolean; models: Map<string, ModelUsage> }>();
  for (const row of args.rows) {
    const corporate = isCorporate(row.providerId, row.modelId, args.prefixes);
    const groupKey = corporate ? "corporate" : row.providerId;
    const group = groups.get(groupKey) ?? { providerId: corporate ? "corporate" : row.providerId, corporate, models: new Map() };
    groups.set(groupKey, group);
    const modelKey = corporate ? `${row.providerId}/${row.modelId}` : row.modelId;
    const model = group.models.get(modelKey) ?? { id: modelKey, windows: blankWindows() };
    group.models.set(modelKey, model);
    const totals = opencodeTotals(row);
    // Bucket 0 is in all three windows, bucket 1 in the day and week, bucket 2 in the week only.
    for (const window of TOKEN_WINDOWS.slice(row.bucket === 0 ? 0 : row.bucket === 1 ? 1 : 2)) {
      model.windows[window] = addTotals(model.windows[window], totals);
    }
  }
  const out: ModelGroup[] = [];
  for (const [groupKey, group] of groups) {
    // A corporate provider's models keep their bare ids when they all share it.
    let models = [...group.models.values()];
    if (group.corporate) {
      const providers = new Set(models.map((m) => m.id.split("/")[0]));
      if (providers.size === 1) models = models.map((m) => ({ ...m, id: m.id.slice(m.id.indexOf("/") + 1) }));
    }
    models = sortModels(models);
    if (models.length === 0) continue;
    out.push({
      key: `opencode:${args.hostId}:${groupKey}`,
      source: "opencode",
      providerId: group.providerId,
      corporate: group.corporate,
      hostId: args.hostId,
      hostName: args.hostName,
      online: args.online,
      collectedAt: args.collectedAt,
      problem: args.problem,
      models,
    });
  }
  if (out.length === 0 && args.problem && args.problem !== "not_found") {
    out.push({
      key: `opencode:${args.hostId}:none`,
      source: "opencode",
      providerId: "opencode",
      corporate: false,
      hostId: args.hostId,
      hostName: args.hostName,
      online: args.online,
      collectedAt: args.collectedAt,
      problem: args.problem,
      models: [],
    });
  }
  return out.sort((a, b) => Number(b.corporate) - Number(a.corporate) || groupTotal(b.models) - groupTotal(a.models));
}

/** Display order: Claude Code, then corporate models, then the rest by the week's tokens. */
export function arrangeGroups(groups: ModelGroup[], corporateOnly: boolean): ModelGroup[] {
  const rank = (g: ModelGroup) => (g.source === "claude-code" ? 0 : g.corporate ? 1 : 2);
  return groups
    .filter((g) => !corporateOnly || g.corporate)
    .sort((a, b) => rank(a) - rank(b) || groupTotal(b.models) - groupTotal(a.models));
}
