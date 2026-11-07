// Numbers and times as the panel prints them, in the panel's language.
// Token counts are compact ("857.2M", "857,2 млн"): a page about millions of
// tokens is read by the shape of the number, not by its last digit.
import { intlLocale, type Lang } from "./i18n";

const cache = new Map<string, Intl.NumberFormat | Intl.DateTimeFormat>();
function fmt<T extends Intl.NumberFormat | Intl.DateTimeFormat>(key: string, make: () => T): T {
  let value = cache.get(key) as T | undefined;
  if (!value) {
    value = make();
    cache.set(key, value);
  }
  return value;
}

export function compactNumber(value: number, lang: Lang): string {
  if (!Number.isFinite(value)) return "—";
  return fmt(`c:${lang}`, () => new Intl.NumberFormat(intlLocale(lang), { notation: "compact", maximumFractionDigits: 1 })).format(value);
}

export function exactNumber(value: number, lang: Lang): string {
  if (!Number.isFinite(value)) return "—";
  return fmt(`e:${lang}`, () => new Intl.NumberFormat(intlLocale(lang))).format(Math.round(value));
}

/** 0..1 → "12%", with "<1%" for a sliver that would otherwise read as nothing. */
export function sharePercent(share: number): string {
  if (!Number.isFinite(share) || share <= 0) return "0%";
  const percent = share * 100;
  if (percent < 0.5) return "<1%";
  return `${Math.round(percent)}%`;
}

export function kilobytes(bytes: number, lang: Lang): string {
  if (!Number.isFinite(bytes) || bytes <= 0) return "—";
  const unit = lang === "ru" ? { b: "Б", kb: "КБ" } : { b: "B", kb: "KB" };
  if (bytes < 1024) return `${Math.round(bytes)} ${unit.b}`;
  const kb = bytes / 1024;
  return `${kb >= 100 ? Math.round(kb) : kb.toFixed(1)} ${unit.kb}`;
}

/** "45s", "12m", "2h 5m" — or "45 с", "12 мин", "2 ч 5 мин". */
export function duration(ms: number | null, lang: Lang): string {
  if (ms === null || !Number.isFinite(ms) || ms < 0) return "—";
  const u = lang === "ru" ? { s: " с", m: " мин", h: " ч" } : { s: "s", m: "m", h: "h" };
  const seconds = Math.round(ms / 1000);
  if (seconds < 60) return `${seconds}${u.s}`;
  const minutes = Math.round(seconds / 60);
  if (minutes < 60) return `${minutes}${u.m}`;
  const hours = Math.floor(minutes / 60);
  const rest = minutes % 60;
  return rest === 0 ? `${hours}${u.h}` : `${hours}${u.h} ${rest}${u.m}`;
}

/** Time left until a reset, short: "2h 41m", "4d 10h" / "2 ч 41 мин", "4 д 10 ч". */
export function countdown(resetsAt: string | null, lang: Lang, now = Date.now()): string | null {
  if (!resetsAt) return null;
  const at = Date.parse(resetsAt);
  if (!Number.isFinite(at)) return null;
  const left = at - now;
  const u = lang === "ru" ? { m: " мин", h: " ч", d: " д" } : { m: "m", h: "h", d: "d" };
  if (left <= 0) return lang === "ru" ? "сейчас" : "now";
  const minutes = Math.ceil(left / 60_000);
  if (minutes < 60) return `${minutes}${u.m}`;
  const hours = Math.floor(minutes / 60);
  if (hours < 24) return `${hours}${u.h} ${minutes % 60}${u.m}`;
  return `${Math.floor(hours / 24)}${u.d} ${hours % 24}${u.h}`;
}

/** "7 Nov, 23:38" / "7 нояб., 23:38". */
export function dateTime(value: string | number | null, lang: Lang): string {
  if (value === null) return "—";
  const at = new Date(value);
  if (Number.isNaN(at.getTime())) return "—";
  return fmt(`dt:${lang}`, () =>
    new Intl.DateTimeFormat(intlLocale(lang), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }),
  ).format(at);
}

export function clock(at: number | Date, lang: Lang): string {
  return fmt(`cl:${lang}`, () => new Intl.DateTimeFormat(intlLocale(lang), { hour: "2-digit", minute: "2-digit" })).format(at);
}

/** "Sat 21:00" for a reset within a week, the date otherwise. */
export function resetMoment(resetsAt: string, lang: Lang, now = Date.now()): string {
  const at = new Date(resetsAt);
  if (Number.isNaN(at.getTime())) return "—";
  const withinWeek = at.getTime() - now < 7 * 24 * 60 * 60_000;
  return fmt(`rm:${lang}:${withinWeek}`, () =>
    new Intl.DateTimeFormat(intlLocale(lang), withinWeek
      ? { weekday: "short", hour: "2-digit", minute: "2-digit" }
      : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }),
  ).format(at);
}

/** Splits "a/b/c" into a dimmed head and a tail that is never cut. */
export function splitTail(value: string): { head: string; tail: string } {
  const at = Math.max(value.lastIndexOf("/"), value.lastIndexOf(":"));
  if (at <= 0 || at === value.length - 1) return { head: "", tail: value };
  return { head: value.slice(0, at), tail: value.slice(at) };
}

/** A project folder as Claude Code stores it ("-home-me-Work") made readable. */
export function projectLabel(dir: string, fallbackLabel: string): string {
  if (fallbackLabel && fallbackLabel !== dir) return fallbackLabel;
  // A double dash stands for a dash inside a real folder name, which cannot be undone here.
  return dir.startsWith("-") ? dir.replace(/^-/, "/").replace(/-/g, "/") : dir;
}
