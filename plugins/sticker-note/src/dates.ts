// Calendar arithmetic on plain "YYYY-MM-DD" strings. Dates are the user's
// local calendar days (the browser sends its own "now"), so everything here
// runs in UTC to stay independent of the server's time zone.

export type Lang = "ru" | "en";

export interface LocalNow {
  /** Local calendar day, YYYY-MM-DD. */
  date: string;
  /** Local wall-clock time, HH:MM. */
  time: string;
}

const DAY_MS = 86_400_000;

function toUtc(date: string): number {
  const [y, m, d] = date.split("-").map(Number);
  return Date.UTC(y!, m! - 1, d!);
}

function fromUtc(ms: number): string {
  return new Date(ms).toISOString().slice(0, 10);
}

export function addDays(date: string, days: number): string {
  return fromUtc(toUtc(date) + days * DAY_MS);
}

export function daysBetween(from: string, to: string): number {
  return Math.round((toUtc(to) - toUtc(from)) / DAY_MS);
}

/** 0 = Monday … 6 = Sunday. */
export function weekday(date: string): number {
  return (new Date(toUtc(date)).getUTCDay() + 6) % 7;
}

/** The next given weekday strictly after `date`. */
export function nextWeekday(date: string, target: number): string {
  const diff = (target - weekday(date) + 7) % 7 || 7;
  return addDays(date, diff);
}

export function isValidDate(date: string): boolean {
  if (!/^\d{4}-\d{2}-\d{2}$/.test(date)) return false;
  return fromUtc(toUtc(date)) === date;
}

export function isValidTime(time: string): boolean {
  const match = /^(\d{2}):(\d{2})$/.exec(time);
  return match !== null && Number(match[1]) < 24 && Number(match[2]) < 60;
}

export function localNow(at: Date = new Date()): LocalNow {
  const pad = (n: number) => String(n).padStart(2, "0");
  return {
    date: `${at.getFullYear()}-${pad(at.getMonth() + 1)}-${pad(at.getDate())}`,
    time: `${pad(at.getHours())}:${pad(at.getMinutes())}`,
  };
}

export function minutesOf(time: string): number {
  const [h, m] = time.split(":").map(Number);
  return h! * 60 + m!;
}

const WEEKDAY_SHORT: Record<Lang, string[]> = {
  ru: ["Пн", "Вт", "Ср", "Чт", "Пт", "Сб", "Вс"],
  en: ["Mon", "Tue", "Wed", "Thu", "Fri", "Sat", "Sun"],
};
const MONTHS_GEN_RU = [
  "января", "февраля", "марта", "апреля", "мая", "июня",
  "июля", "августа", "сентября", "октября", "ноября", "декабря",
];
const MONTHS_SHORT_RU = [
  "янв", "фев", "мар", "апр", "мая", "июн", "июл", "авг", "сен", "окт", "ноя", "дек",
];
const MONTHS_EN = [
  "Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec",
];

function parts(date: string) {
  const [y, m, d] = date.split("-").map(Number);
  return { y: y!, m: m!, d: d! };
}

/** "Пн" / "Mon" within a week, "12 дек" / "Dec 12" further out. */
export function shortDay(date: string, today: string, lang: Lang): string {
  const diff = daysBetween(today, date);
  if (diff >= 0 && diff < 7) return WEEKDAY_SHORT[lang][weekday(date)]!;
  const { m, d } = parts(date);
  return lang === "ru" ? `${d} ${MONTHS_SHORT_RU[m - 1]}` : `${MONTHS_EN[m - 1]} ${d}`;
}

/** "Сб, 31 октября" / "Sat, Oct 31". */
export function fullDay(date: string, lang: Lang): string {
  const { m, d } = parts(date);
  const wd = WEEKDAY_SHORT[lang][weekday(date)];
  return lang === "ru" ? `${wd}, ${d} ${MONTHS_GEN_RU[m - 1]}` : `${wd}, ${MONTHS_EN[m - 1]} ${d}`;
}

export const RU_MONTH_STEMS = [
  "январ", "феврал", "март", "апрел", "ма", "июн",
  "июл", "август", "сентябр", "октябр", "ноябр", "декабр",
];
export const EN_MONTH_STEMS = [
  "jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec",
];
