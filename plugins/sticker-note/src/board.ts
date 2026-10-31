// Board layout rules shared by the server and the app. No zod here: the app
// imports this file, and the validator stays out of the frontend bundle.
import { daysBetween, minutesOf, type LocalNow } from "./dates";
import type { Card, Column, Importance } from "./model";

export const COLUMNS: readonly Column[] = ["today", "soon", "later", "done"];

const RANK: Record<Importance, number> = { high: 0, normal: 1, low: 2 };

/** Where a card sits on the board, from its due date relative to the user's today. */
export function columnOf(card: Pick<Card, "done" | "due">, today: string): Column {
  if (card.done) return "done";
  if (card.due === null) return "later";
  if (card.due.date <= today) return "today";
  return daysBetween(today, card.due.date) <= 7 ? "soon" : "later";
}

/** Minutes past due, or 0 when the card is not overdue yet. */
export function overdueMinutes(card: Pick<Card, "done" | "due">, now: LocalNow): number {
  if (card.done || card.due === null) return 0;
  const days = daysBetween(card.due.date, now.date);
  if (days < 0) return 0;
  if (days === 0) {
    if (card.due.time === null) return 0;
    return Math.max(0, minutesOf(now.time) - minutesOf(card.due.time));
  }
  // A past day: count from the due time, or from the end of that day.
  const dueMinute = card.due.time === null ? 24 * 60 : minutesOf(card.due.time);
  return days * 24 * 60 + minutesOf(now.time) - dueMinute;
}

function byImportance(a: Card, b: Card): number {
  return RANK[a.importance] - RANK[b.importance] || a.createdAt.localeCompare(b.createdAt);
}

function byDue(a: Card, b: Card): number {
  const ad = a.due!, bd = b.due!;
  return (
    ad.date.localeCompare(bd.date) ||
    (ad.time ?? "99").localeCompare(bd.time ?? "99") ||
    byImportance(a, b)
  );
}

export interface TodayLayout {
  /** Cards with a time, earliest first; past days come before today. */
  timed: Card[];
  /** Index in `timed` where the "now" line goes. */
  nowIndex: number;
  /** Cards for today without a time, important first. */
  untimed: Card[];
}

export function layoutToday(cards: Card[], now: LocalNow): TodayLayout {
  // A card from a past day without a time is still overdue: it leads the timed list.
  const timed = cards.filter((c) => c.due && (c.due.time !== null || c.due.date < now.date)).sort(byDue);
  const untimed = cards.filter((c) => !timed.includes(c)).sort(byImportance);
  let nowIndex = timed.findIndex((c) => c.due!.date === now.date && c.due!.time !== null && c.due!.time >= now.time);
  if (nowIndex === -1) nowIndex = timed.length;
  return { timed, nowIndex, untimed };
}

export function sortColumn(column: Exclude<Column, "today">, cards: Card[]): Card[] {
  if (column === "done") return [...cards].sort((a, b) => (b.doneAt ?? "").localeCompare(a.doneAt ?? ""));
  const dated = cards.filter((c) => c.due !== null).sort(byDue);
  const undated = cards.filter((c) => c.due === null).sort(byImportance);
  return [...dated, ...undated];
}

export interface TodayStats {
  /** Open cards in Today, overdue ones included. */
  count: number;
  overdue: number;
}

export function todayStats(cards: Card[], now: LocalNow): TodayStats {
  let count = 0;
  let overdue = 0;
  for (const card of cards) {
    if (columnOf(card, now.date) !== "today") continue;
    count++;
    if (overdueMinutes(card, now) > 0) overdue++;
  }
  return { count, overdue };
}
