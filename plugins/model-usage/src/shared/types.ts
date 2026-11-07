// Shapes the server hands to the panel. No imports on purpose: the panel bundle
// may take values from here without pulling the SDK in.

export type WindowKind = "five-hour" | "daily" | "weekly" | "custom";

export interface LimitWindow {
  kind: WindowKind;
  /** The source's own label, used when `kind` is "custom". */
  label: string;
  /** Model family the window applies to, or null for all models. */
  model: string | null;
  usedPercent: number;
  resetsAt: string | null;
  cost: { usedUsdCents: number; limitUsdCents: number } | null;
}

export type LimitStatus = "ok" | "not_installed" | "unauthenticated" | "expired" | "error" | "unknown";

export interface LimitAccount {
  /** `<source plugin>:<resource>`, stable between refreshes. */
  id: string;
  providerId: string;
  providerName: string;
  /** Machine the account belongs to; null for shared (pooled) accounts. */
  hostId: string | null;
  hostName: string | null;
  /** Name of the shared pool, for shared accounts. */
  poolName: string | null;
  accountEmail: string | null;
  planLabel: string | null;
  status: LimitStatus;
  message: string | null;
  windows: LimitWindow[];
  /** Last successful measurement, epoch ms. */
  observedAt: number | null;
  /** The last refresh failed: the figures are the last ones that came in. */
  stale: boolean;
  /** Figures from the local limits file while the provider refuses. */
  backup: { fetchedAt: string } | null;
}

export interface MachineInfo {
  id: string;
  name: string;
  status: "connected" | "disconnected";
  /** The machine bb's server runs on. */
  primary: boolean;
}

export interface LimitsSnapshot {
  accounts: LimitAccount[];
  machines: MachineInfo[];
  /** When the snapshot was put together, epoch ms. */
  updatedAt: number;
}

export type TokenWindow = "5h" | "24h" | "7d";
export const TOKEN_WINDOWS: readonly TokenWindow[] = ["5h", "24h", "7d"];

export interface TokenTotals {
  requests: number;
  /** Prompt tokens not served from cache. */
  input: number;
  /** Generated tokens, reasoning included. */
  output: number;
  cacheRead: number;
  cacheWrite: number;
  /** input + output + cacheRead + cacheWrite. */
  total: number;
}

export interface ModelUsage {
  /** As the tool names it: `claude-opus-5-5`, `gpt-5-codex`. */
  id: string;
  windows: Record<TokenWindow, TokenTotals>;
}

export type TokenSource = "claude-code" | "opencode";

export interface ModelGroup {
  /** `<source>:<machine>:<provider or "corporate">`. */
  key: string;
  source: TokenSource;
  /** OpenCode provider id (`opencode`, `anthropic`, …); "claude-code" for Claude Code. */
  providerId: string;
  /** Matches the corporate model list from the plugin settings. */
  corporate: boolean;
  hostId: string;
  hostName: string;
  online: boolean;
  /** When the figures were read, epoch ms; older than now when the machine is offline. */
  collectedAt: number | null;
  /** Why the figures could not be read this time, if they could not. */
  problem: "not_found" | "error" | "offline" | null;
  models: ModelUsage[];
}

export interface TokensSnapshot {
  groups: ModelGroup[];
  /** Label for corporate groups from the settings; empty for the default. */
  corporateLabel: string;
  /** The settings hide everything but corporate models. */
  corporateOnly: boolean;
  /** Claude Code transcripts are still being read for the first time. */
  claudeScanning: boolean;
  updatedAt: number;
}

export function emptyTotals(): TokenTotals {
  return { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 };
}

export function addTotals(a: TokenTotals, b: TokenTotals): TokenTotals {
  return {
    requests: a.requests + b.requests,
    input: a.input + b.input,
    output: a.output + b.output,
    cacheRead: a.cacheRead + b.cacheRead,
    cacheWrite: a.cacheWrite + b.cacheWrite,
    total: a.total + b.total,
  };
}
