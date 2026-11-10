// Time zones, for the host, the server and the panel alike: no imports, so the
// panel's bundle can take it (see src/shared/limits.ts).
//
// The calendar is shown and meetings are made in one named zone — Moscow
// unless the plugin's settings say otherwise — not in whatever zone the
// computer happens to be set to. `null` means "this computer's zone".

/** The zone the plugin uses unless its settings name another. */
export const DEFAULT_TIME_ZONE = "Europe/Moscow";
/** What the setting says to use the computer's own zone. */
export const SYSTEM_TIME_ZONE = "system";

const formatters = new Map<string, Intl.DateTimeFormat>();

function formatter(zone: string): Intl.DateTimeFormat | null {
  const known = formatters.get(zone);
  if (known) return known;
  try {
    const created = new Intl.DateTimeFormat("en-US", {
      timeZone: zone,
      hourCycle: "h23",
      year: "numeric",
      month: "numeric",
      day: "numeric",
      hour: "numeric",
      minute: "numeric",
      second: "numeric",
    });
    if (formatters.size > 50) formatters.clear();
    formatters.set(zone, created);
    return created;
  } catch {
    return null;
  }
}

/** An IANA zone name this runtime knows, such as Europe/Moscow. */
export function isTimeZone(name: string): boolean {
  return name.length > 0 && name.length <= 64 && /^[A-Za-z0-9_+\-/]+$/.test(name) && formatter(name) !== null;
}

/** The zone a setting names: an IANA name, or null for the computer's own zone (empty or "system"). Throws on anything else. */
export function zoneOfSetting(value: string): string | null {
  const name = value.trim();
  if (!name || name.toLowerCase() === SYSTEM_TIME_ZONE) return null;
  if (!isTimeZone(name)) throw new Error(`"${name}" is not a time zone: write an IANA name such as Europe/Moscow, or "system"`);
  return name;
}

/** Minutes east of UTC in `zone` at a moment; null zone: this computer's. */
export function offsetIn(zone: string | null, ms: number): number {
  if (zone === null) return -new Date(ms).getTimezoneOffset();
  const format = formatter(zone);
  if (!format) return -new Date(ms).getTimezoneOffset();
  const parts: Record<string, number> = {};
  for (const part of format.formatToParts(new Date(ms))) if (part.type !== "literal") parts[part.type] = Number(part.value);
  const wall = Date.UTC(parts.year!, parts.month! - 1, parts.day!, parts.hour === 24 ? 0 : parts.hour!, parts.minute!, parts.second!);
  // Whole minutes: the seconds of `ms` are not in the wall clock's minute.
  return Math.round((wall - Math.floor(ms / 1000) * 1000) / 60_000);
}

export interface WallTime {
  readonly year: number;
  /** 1–12. */
  readonly month: number;
  readonly day: number;
  readonly hour: number;
  readonly minute: number;
  /** 0 Sunday … 6 Saturday. */
  readonly weekday: number;
}

/** The wall clock in `zone` at a moment. */
export function wallTime(ms: number, zone: string | null): WallTime {
  const shifted = new Date(ms + offsetIn(zone, ms) * 60_000);
  return {
    year: shifted.getUTCFullYear(),
    month: shifted.getUTCMonth() + 1,
    day: shifted.getUTCDate(),
    hour: shifted.getUTCHours(),
    minute: shifted.getUTCMinutes(),
    weekday: shifted.getUTCDay(),
  };
}

/** The moment a wall-clock time in `zone` names. Days and months out of range roll over, as in Date.UTC. */
export function fromWallTime(year: number, month: number, day: number, hour: number, minute: number, zone: string | null): number {
  const wall = Date.UTC(year, month - 1, day, hour, minute);
  // Looked up twice, so a change of offset that day is respected.
  const guess = wall - offsetIn(zone, wall) * 60_000;
  return wall - offsetIn(zone, guess) * 60_000;
}

/** "UTC+3", "UTC-3:30". */
export function offsetLabel(zone: string | null, ms: number): string {
  const minutes = offsetIn(zone, ms);
  const abs = Math.abs(minutes);
  return `UTC${minutes >= 0 ? "+" : "-"}${Math.floor(abs / 60)}${abs % 60 ? `:${String(abs % 60).padStart(2, "0")}` : ""}`;
}
