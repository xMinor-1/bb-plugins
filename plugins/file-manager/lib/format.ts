// lib/format.ts — display formatting for sizes, dates, speed and ETA.
//
// Pure functions, no React, no locale assumptions beyond `Intl` defaults for
// the absolute date forms. Binary multiples with short labels ("1 KB" =
// 1024 B) match the rest of bb (`plugins/tasks/views/detail/meta.tsx`).

const UNITS = ["B", "KB", "MB", "GB", "TB", "PB"] as const;
const STEP = 1024;

/** Placeholder for values that are unknown rather than zero. */
export const UNKNOWN = "—";

function isFiniteNumber(value: unknown): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function trimZero(text: string): string {
  return text.endsWith(".0") ? text.slice(0, -2) : text;
}

/**
 * "0 B", "1023 B", "1 KB", "1.5 KB", "12.3 MB", "234 MB", "5 GB".
 * Non-finite or negative input renders as {@link UNKNOWN}.
 */
export function formatBytes(bytes: number): string {
  if (!isFiniteNumber(bytes) || bytes < 0) return UNKNOWN;
  if (bytes < STEP) return `${Math.round(bytes)} B`;

  let value = bytes;
  let unit = 0;
  while (value >= STEP && unit < UNITS.length - 1) {
    value /= STEP;
    unit += 1;
  }
  const decimals = value >= 100 ? 0 : 1;
  return `${trimZero(value.toFixed(decimals))} ${UNITS[unit]}`;
}

/** Exact byte count with thousands separators, for tooltips: "1 048 576 bytes". */
export function formatExactBytes(bytes: number): string {
  if (!isFiniteNumber(bytes) || bytes < 0) return UNKNOWN;
  return `${Math.round(bytes).toLocaleString()} bytes`;
}

/** "12.3 MB/s"; 0 or unknown renders as {@link UNKNOWN}. */
export function formatSpeed(bytesPerSecond: number): string {
  if (!isFiniteNumber(bytesPerSecond) || bytesPerSecond <= 0) return UNKNOWN;
  return `${formatBytes(bytesPerSecond)}/s`;
}

/** "0%", "42%", "100%" from a 0..1 ratio. */
export function formatPercent(ratio: number): string {
  if (!isFiniteNumber(ratio)) return UNKNOWN;
  const clamped = Math.min(1, Math.max(0, ratio));
  return `${Math.round(clamped * 100)}%`;
}

/** Progress ratio guarding against a zero-byte total. */
export function progressRatio(sentBytes: number, totalBytes: number): number {
  if (!isFiniteNumber(sentBytes) || !isFiniteNumber(totalBytes) || totalBytes <= 0) return 0;
  return Math.min(1, Math.max(0, sentBytes / totalBytes));
}

const SECOND = 1000;
const MINUTE = 60 * SECOND;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;

/**
 * Compact duration: "0s", "45s", "2m 5s", "3h 10m", "2d 4h".
 * Null / non-finite / negative input renders as {@link UNKNOWN}.
 */
export function formatDuration(ms: number | null): string {
  if (ms === null || !isFiniteNumber(ms) || ms < 0) return UNKNOWN;

  // Decompose from rounded seconds so a value like 59.7 s reads "1m" instead
  // of "60s", and 59 m 59.9 s reads "1h" instead of "60m".
  const seconds = Math.round(ms / SECOND);
  if (seconds < 60) return `${seconds}s`;

  const minutes = Math.floor(seconds / 60);
  const remainderSeconds = seconds % 60;
  if (minutes < 60) {
    return remainderSeconds === 0 ? `${minutes}m` : `${minutes}m ${remainderSeconds}s`;
  }

  const totalMinutes = Math.round(seconds / 60);
  const hours = Math.floor(totalMinutes / 60);
  const remainderMinutes = totalMinutes % 60;
  if (hours < 24) {
    return remainderMinutes === 0 ? `${hours}h` : `${hours}h ${remainderMinutes}m`;
  }

  const totalHours = Math.round(totalMinutes / 60);
  const days = Math.floor(totalHours / 24);
  const remainderHours = totalHours % 24;
  return remainderHours === 0 ? `${days}d` : `${days}d ${remainderHours}h`;
}

/** "2m 5s left"; unknown ETA renders as "" so callers can skip the node. */
export function formatEta(etaMs: number | null): string {
  if (etaMs === null || !isFiniteNumber(etaMs) || etaMs < 0) return "";
  return `${formatDuration(etaMs)} left`;
}

/** ETA from a live rate; null when the rate is not yet known. */
export function etaFromRate(
  remainingBytes: number,
  bytesPerSecond: number,
): number | null {
  if (!isFiniteNumber(remainingBytes) || remainingBytes <= 0) return 0;
  if (!isFiniteNumber(bytesPerSecond) || bytesPerSecond <= 0) return null;
  return (remainingBytes / bytesPerSecond) * SECOND;
}

/** "just now", "5m ago", "3h ago", "6d ago", then an absolute date. */
export function formatRelativeTime(timestampMs: number, nowMs: number = Date.now()): string {
  if (!isFiniteNumber(timestampMs)) return UNKNOWN;
  const delta = nowMs - timestampMs;
  if (delta < 0) return formatDate(timestampMs);
  if (delta < MINUTE) return "just now";
  if (delta < HOUR) return `${Math.floor(delta / MINUTE)}m ago`;
  if (delta < DAY) return `${Math.floor(delta / HOUR)}h ago`;
  if (delta < 7 * DAY) return `${Math.floor(delta / DAY)}d ago`;
  return formatDate(timestampMs);
}

/** "12 Mar" this year, "12 Mar 2023" otherwise. */
export function formatDate(timestampMs: number, nowMs: number = Date.now()): string {
  if (!isFiniteNumber(timestampMs)) return UNKNOWN;
  const date = new Date(timestampMs);
  if (Number.isNaN(date.valueOf())) return UNKNOWN;
  const sameYear = date.getFullYear() === new Date(nowMs).getFullYear();
  return date.toLocaleDateString(undefined, {
    day: "numeric",
    month: "short",
    ...(sameYear ? {} : { year: "numeric" }),
  });
}

/** Full local timestamp for tooltips. */
export function formatDateTime(timestampMs: number): string {
  if (!isFiniteNumber(timestampMs)) return UNKNOWN;
  const date = new Date(timestampMs);
  if (Number.isNaN(date.valueOf())) return UNKNOWN;
  return date.toLocaleString(undefined, {
    year: "numeric",
    month: "short",
    day: "numeric",
    hour: "2-digit",
    minute: "2-digit",
  });
}

/**
 * The "Modified" column: today's files show the time, this week shows a
 * relative age, older entries show the date.
 */
export function formatModified(timestampMs: number, nowMs: number = Date.now()): string {
  if (!isFiniteNumber(timestampMs)) return UNKNOWN;
  const date = new Date(timestampMs);
  if (Number.isNaN(date.valueOf())) return UNKNOWN;
  const now = new Date(nowMs);
  const sameDay =
    date.getFullYear() === now.getFullYear() &&
    date.getMonth() === now.getMonth() &&
    date.getDate() === now.getDate();
  if (sameDay) {
    return date.toLocaleTimeString(undefined, { hour: "2-digit", minute: "2-digit" });
  }
  return formatDate(timestampMs, nowMs);
}

/** "1 item" / "3 items" — plural defaults to `${singular}s`. */
export function formatCount(count: number, singular: string, plural = `${singular}s`): string {
  return `${count} ${count === 1 ? singular : plural}`;
}
