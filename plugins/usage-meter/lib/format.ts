// lib/format.ts — numbers and times as the Usage page prints them.
//
// Two locales, and the split is deliberate. Dates and clock times are en-GB:
// "21 Aug · 17:47" is the order bb writes them in everywhere else. Compact token
// counts are en-US, because en-GB abbreviates them the British way — "556.4m",
// "1.7bn" — and this page prints "2h 38m" two rows above, where a lower-case "m"
// already means minutes. Claude Code's own extension writes "1.6B" as well.
//
// No four-digit token count is spelled out in full: a page about millions of
// tokens is read by the shape of the number, not by its last digit.

/** 1 234 567 → "1.2M". Exact figures live in the tooltip, not in the column. */
const COMPACT = new Intl.NumberFormat("en-US", {
  notation: "compact",
  maximumFractionDigits: 1,
});

/** Full grouping, for tooltips where the exact figure is the point. */
const EXACT = new Intl.NumberFormat("en-GB");

const DATE_TIME = new Intl.DateTimeFormat("en-GB", {
  day: "numeric",
  month: "short",
  hour: "2-digit",
  minute: "2-digit",
});

const CLOCK = new Intl.DateTimeFormat("en-GB", {
  hour: "2-digit",
  minute: "2-digit",
});

const WEEKDAY = new Intl.DateTimeFormat("en-GB", {
  weekday: "short",
  day: "numeric",
});

export function compactNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return COMPACT.format(value);
}

export function exactNumber(value: number): string {
  if (!Number.isFinite(value)) return "—";
  return EXACT.format(Math.round(value));
}

/** A share in 0..1 as a whole percent; anything under half a percent as "<1%". */
export function sharePercent(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return "0%";
  const percent = share * 100;
  if (percent < 0.5) return "<1%";
  return `${Math.round(percent)}%`;
}

/** Bytes of an instruction file: kilobytes are the only unit that reads well here. */
export function kilobytes(bytes: number): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  if (bytes < 1024) return `${Math.round(bytes)} B`;
  const kb = bytes / 1024;
  return kb >= 100 ? `${Math.round(kb)} KB` : `${kb.toFixed(1)} KB`;
}

/** "3h 12m", "12m", "45s" — never "0h 0m 45s". */
export function duration(ms: number | null): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}m`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}h` : `${hours}h ${rest}m`;
}

/** "21 Aug, 14:05" in local time; an unparseable value shows as a dash. */
export function dateTime(iso: string | number | null): string {
  if (iso === null) return "—";
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return "—";
  return DATE_TIME.format(at).replace(",", " ·");
}

/** "14:05" in local time. */
export function clock(at: number | Date): string {
  return CLOCK.format(at);
}

/** "Thu 21" — the label a daily chart bar gets. */
export function weekday(at: number | Date): string {
  return WEEKDAY.format(at);
}

/**
 * A long name split into the part that may be dropped and the part that must
 * not be. Three sibling folders under .../personal-workspaces/ differ only by
 * their last segment, so cutting a path from the right — which is what an
 * ellipsis on the cell does — makes them read identically. The head is handed
 * over separately so the column can shrink it and keep the tail whole.
 *
 * The split point is the last "/" of a path or the last ":" of a namespaced
 * skill ("bb-global-skills:automations"); a name with neither is all tail.
 */
export function splitTail(value: string): { head: string; tail: string } {
  const at = Math.max(value.lastIndexOf("/"), value.lastIndexOf(":"));
  if (at <= 0 || at === value.length - 1) return { head: "", tail: value };
  return { head: value.slice(0, at), tail: value.slice(at) };
}

/** A transcript directory name back into the path it was made from. */
export function projectLabel(dir: string, fallbackLabel: string): string {
  if (fallbackLabel && fallbackLabel !== dir) return fallbackLabel;
  // Claude Code encodes "/home/coder/Work" as "-home-coder-Work"; a double dash
  // stands for a dash inside a real folder name, which cannot be undone here.
  return dir.startsWith("-") ? dir.replace(/^-/, "/").replace(/-/g, "/") : dir;
}
