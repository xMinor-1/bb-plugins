// Constants and types shared by the server and the app. No imports: the app
// bundle may take values from here without pulling the SDK in.

/** Realtime channel: a thread's masking state or feed changed. Payload `{ threadId }`. */
export const THREAD_CHANGED = "thread-changed";
/** Realtime channel: the proxy process changed state. Payload `{ state }`. */
export const PROXY_CHANGED = "proxy-changed";

/** Providers whose model traffic this plugin routes through itself. */
export const ROUTED_PROVIDERS: readonly string[] = ["claude-code"];

/** Headers the agent sends on every request (set through the provider env). */
export const THREAD_HEADER = "x-masking-thread";
export const KEY_HEADER = "x-masking-key";

export type ProxyState = "starting" | "running" | "failed" | "not-configured" | "stopped";

export interface ProxyStatus {
  state: ProxyState;
  /** English detail for failures; the app shows it as is. */
  message: string | null;
  since: number;
}

/** How a request left the machine. */
export type Via = "proxy" | "direct" | "blocked";

export interface FeedEntry {
  id: string;
  at: number;
  path: string;
  model: string | null;
  via: Via;
  status: number | null;
  durationMs: number | null;
  /** Masked values per category, null until the proxy reports them. */
  masked: Record<string, number> | null;
  maskedTotal: number;
  error: string | null;
}

export interface ThreadTotals {
  /** Model requests (token counting is tallied separately). */
  requests: number;
  /** Token counting requests: they carry the same text, so they are masked too. */
  tokenCounts: number;
  masked: number;
  direct: number;
  errors: number;
  lastAt: number | null;
}

export interface ThreadStatus {
  threadId: string;
  masking: boolean;
  /** True when someone switched it for this thread; false means the default. */
  explicit: boolean;
  proxy: ProxyStatus;
  totals: ThreadTotals;
}

/** Token counting requests Claude Code sends in bursts; kept out of the feed list. */
export function isTokenCount(path: string): boolean {
  return path.endsWith("/count_tokens");
}

/** Sum of masked values in a per-category map. */
export function sumMasked(masked: Record<string, number> | null): number {
  if (masked === null) return 0;
  let total = 0;
  for (const value of Object.values(masked)) if (Number.isFinite(value) && value > 0) total += value;
  return total;
}

/** Comma- or newline-separated model prefixes from a setting. */
export function parsePrefixes(value: unknown): string[] {
  if (typeof value !== "string") return [];
  return value
    .split(/[,\n]/u)
    .map((part) => part.trim())
    .filter((part) => part !== "");
}

/**
 * Whether a thread's model sends data outside the user's network, so the
 * masking state must be visible. `corporate` are model prefixes an admin
 * declared as in-network.
 */
export function isExternalModel(providerId: string, model: string | null, corporate: readonly string[]): boolean {
  const name = model ?? "";
  if (corporate.some((prefix) => name.startsWith(prefix))) return false;
  if (ROUTED_PROVIDERS.includes(providerId)) return true;
  // Other agents count as external only once an admin listed what is corporate.
  return corporate.length > 0 && name !== "";
}
