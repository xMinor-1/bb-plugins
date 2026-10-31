// One sentence about what the board just did: "Закрыто: «…»", "Перенесено на
// пн, 2 ноября, 13:00: «…»". It is shown under the dictation bar.
import type { Lang } from "@/lib/i18n";

import { columnOf } from "../src/board";
import type { Action, Card, Due } from "../src/model";
import { columnName, shorten, whenText, type Messages } from "./format";

export interface LogLine {
  text: string;
  tone: "ok" | "ask";
  undoToken: string | null;
  /** Distinguishes two equal lines so the entrance animation replays. */
  at: number;
}

/** whenText for the middle of a sentence: "перенесено на завтра, 10:00". */
export function whenInline(m: Messages, due: Due, today: string, lang: Lang): string {
  const text = whenText(m, due, today, lang);
  if (lang === "ru" || /^(Today|Tomorrow)/.test(text)) return text.charAt(0).toLowerCase() + text.slice(1);
  return text;
}

const TITLE_MAX = 60;

/** "#12 «Смотреть презентацию»": the number and the quoted title. */
export function cardRef(card: Pick<Card, "num" | "title">, lang: Lang, max = TITLE_MAX): string {
  const title = shorten(card.title, max);
  return `#${card.num} ${lang === "ru" ? `«${title}»` : `“${title}”`}`;
}

export function addedText(m: Messages, card: Card, today: string, lang: Lang): string {
  const column = columnOf(card, today);
  const when = card.due
    ? column === "today"
      ? card.due.time
      : whenInline(m, card.due, today, lang)
    : null;
  return m.logAdded(columnName(m, column), when, cardRef(card, lang));
}

/**
 * `after` is the card once changed (for "delete", as it was), or every card a
 * command touched: "Закрыто: #6 «…», #1 «…»".
 */
export function commandText(m: Messages, action: Action, touched: Card | Card[], today: string, lang: Lang): string {
  const list = Array.isArray(touched) ? touched : [touched];
  const after = list[0]!;
  const title = list.map((card) => cardRef(card, lang, list.length > 1 ? 30 : TITLE_MAX)).join(", ");
  switch (action) {
    case "done":
      return m.logDone(title);
    case "undone":
      return m.logReopened(title);
    case "move":
      return after.due ? m.logMoved(whenInline(m, after.due, today, lang), title) : m.logMovedColumn(m.colLater, title);
    case "importance":
      return after.importance === "high" ? m.logHigh(title) : after.importance === "low" ? m.logLow(title) : m.logNormal(title);
    case "delete":
      return m.logDeleted(title);
    case "open":
      return m.logOpened(title);
  }
}

export function whichText(m: Messages, cards: Pick<Card, "num" | "title">[], lang: Lang): string {
  const quoted = cards.map((card) => cardRef(card, lang, 30));
  const list = quoted.length > 1 ? `${quoted.slice(0, -1).join(", ")} ${m.or} ${quoted[quoted.length - 1]}` : quoted[0] ?? "";
  return m.logWhich(list);
}
