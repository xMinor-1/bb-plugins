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

export type ProxyState = "installing" | "starting" | "running" | "failed" | "not-configured" | "stopped";

export type Lang = "en" | "ru";

/** What stands in the way, for texts in the person's language. */
export type ProxyProblem = "no-source" | "no-file" | "download" | "start";

export interface ProxyStatus {
  state: ProxyState;
  /** English technical detail for failures (an HTTP code, a path, the proxy's last error). */
  message: string | null;
  problem: ProxyProblem | null;
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
 * What the masking segment shows for a thread's model:
 * - `routed`: an external model this plugin routes, with the switch and the feed;
 * - `in-network`: a model an admin declared as in-network (`corporate` prefixes), masking is not needed;
 * - `unavailable`: an agent this plugin does not route yet.
 */
export type SegmentMode = "routed" | "in-network" | "unavailable";

export function segmentMode(providerId: string, model: string | null, corporate: readonly string[]): SegmentMode {
  const name = model ?? "";
  if (name !== "" && corporate.some((prefix) => name.startsWith(prefix))) return "in-network";
  return ROUTED_PROVIDERS.includes(providerId) ? "routed" : "unavailable";
}

/** The light on the masking segment. */
export type Led = "on" | "off" | "problem" | "idle" | "loading";

/**
 * `idle` for in-network models and agents the plugin does not route; for a
 * routed thread `on` once the proxy runs, `problem` while masking is on and
 * the proxy is not running (messages wait), `off` when switched off.
 */
export function segmentLed(mode: SegmentMode, status: ThreadStatus | null): Led {
  if (mode !== "routed") return "idle";
  if (status === null) return "loading";
  if (!status.masking) return "off";
  return status.proxy.state === "running" ? "on" : "problem";
}
