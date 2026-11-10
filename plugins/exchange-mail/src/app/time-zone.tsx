// The zone the panel shows the calendar in and reads typed times in: the
// plugin's setting (Moscow by default), which the server hands over with the
// machines and with each meeting card. null: the browser's own zone.
import { createContext, useContext } from "react";
import { fromWallTime, offsetLabel, wallTime } from "../shared/zone";

export const TimeZoneContext = createContext<string | null>(null);
export const useTimeZone = () => useContext(TimeZoneContext);

/** For Intl.DateTimeFormat: undefined is the browser's zone. */
export const intlZone = (zone: string | null) => zone ?? undefined;

/** "Europe/Moscow, UTC+3", or "UTC+3" for the browser's zone. */
export function zoneText(zone: string | null, ms: number): string {
  return zone ? `${zone.replace(/_/g, " ")}, ${offsetLabel(zone, ms)}` : offsetLabel(null, ms);
}

/** Midnight of the day holding a moment, in the zone. */
export function startOfDay(ms: number, zone: string | null): Date {
  const t = wallTime(ms, zone);
  return new Date(fromWallTime(t.year, t.month, t.day, 0, 0, zone));
}

/** Midnight `days` days after the day holding `date`, in the zone. */
export function addDays(date: Date, days: number, zone: string | null): Date {
  const t = wallTime(date.getTime(), zone);
  return new Date(fromWallTime(t.year, t.month, t.day + days, 0, 0, zone));
}

/** A moment at a wall-clock time on the day holding `date`. */
export function atTime(date: Date, hour: number, minute: number, zone: string | null): Date {
  const t = wallTime(date.getTime(), zone);
  return new Date(fromWallTime(t.year, t.month, t.day, hour, minute, zone));
}
