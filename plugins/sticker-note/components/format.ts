// Display text for dates, columns and links.
import type { Lang } from "@/lib/i18n";

import { addDays, fullDay, localNow, shortDay, type LocalNow } from "../src/dates";
import type { messages } from "../src/messages";
import type { AgentState } from "../src/agent-state";
import type { Column, Due, Importance } from "../src/model";

export type Messages = (typeof messages)["en"];

export function columnName(m: Messages, column: Column): string {
  return { today: m.colToday, soon: m.colSoon, later: m.colLater, done: m.colDone }[column];
}

export function importanceName(m: Messages, importance: Importance): string {
  return { high: m.impHigh, normal: m.impNormal, low: m.impLow }[importance];
}

/** "Today, 16:00", "Tomorrow", "Wed, Nov 4, 12:00". */
export function whenText(m: Messages, due: Due, today: string, lang: Lang): string {
  if (due.date === today) return m.chipToday(due.time);
  if (due.date === addDays(today, 1)) return m.tomorrow(due.time);
  return m.dayAt(fullDay(due.date, lang), due.time);
}

/** "Tomorrow, 09:30", "Wed 12:00" within a week, "Dec 12" further out. */
export function shortWhen(m: Messages, due: Due, today: string, lang: Lang): string {
  if (due.date === addDays(today, 1)) return m.tomorrow(due.time);
  const day = shortDay(due.date, today, lang);
  return due.time ? `${day} ${due.time}` : day;
}

export function doneText(m: Messages, doneAt: string | null, now: LocalNow, lang: Lang): string | null {
  if (!doneAt) return null;
  const at = new Date(doneAt);
  if (Number.isNaN(at.getTime())) return null;
  const local = localNow(at);
  return local.date === now.date ? m.doneAt(local.time) : m.doneOn(fullDay(local.date, lang));
}

export function linkHref(link: string): string {
  return /^[a-z][a-z0-9+.-]*:/i.test(link) ? link : `https://${link}`;
}

/** "youtube.com/watch" — host and the start of the path. */
export function linkLabel(link: string): string {
  try {
    const url = new URL(linkHref(link));
    const path = url.pathname === "/" ? "" : url.pathname;
    return shorten(`${url.hostname.replace(/^www\./, "")}${path}`, 32);
  } catch {
    return shorten(link, 32);
  }
}

export function shorten(text: string, max = 34): string {
  return text.length > max ? `${text.slice(0, max - 1).trimEnd()}…` : text;
}

/** "Агент работает", "Агент ответил", …: the agent chip on a card and the state in an open one. */
export function agentLabel(m: Messages, state: AgentState): string {
  switch (state) {
    case "waiting":
      return m.agentWaiting;
    case "answered":
      return m.agentAnswered;
    case "working":
      return m.agentWorking;
    case "failed":
      return m.agentFailed;
    case "seen":
      return m.chatTag;
    case "linked":
      return m.agentLinked;
  }
}
