// Rule-based understanding of a dictated or typed phrase, Russian and English.
// It is the fallback when no language model is configured, and it is what the
// tests pin down. The model path (server.ts) returns the same ParseResult.
import { addDays, isValidDate, nextWeekday, type LocalNow } from "./dates";
import type { Action, Card, Draft, Due, Importance, Kind, ParseResult, Span } from "./model";

type SpanKind = Span["kind"];
interface Hit {
  start: number;
  end: number;
  kind: SpanKind;
}

const L = "\\p{L}\\p{N}";
/** A whole-word regex: JS \b does not understand Cyrillic. */
function word(source: string): RegExp {
  return new RegExp(`(?<![${L}])(?:${source})(?![${L}])`, "giu");
}
function matches(text: string, re: RegExp): RegExpExecArray[] {
  re.lastIndex = 0;
  return [...text.matchAll(re)];
}
function hitOf(m: RegExpExecArray, kind: SpanKind): Hit {
  return { start: m.index!, end: m.index! + m[0].length, kind };
}

// ---------- dates and times ----------

const RU_WEEKDAYS: [RegExp, number][] = [
  [/^понедельник/u, 0], [/^вторник/u, 1], [/^сред/u, 2], [/^четверг/u, 3],
  [/^пятниц/u, 4], [/^суббот/u, 5], [/^воскресень/u, 6],
];
const EN_WEEKDAYS = ["monday", "tuesday", "wednesday", "thursday", "friday", "saturday", "sunday"];
const RU_MONTHS = ["январ", "феврал", "март", "апрел", "ма[яй]", "июн", "июл", "август", "сентябр", "октябр", "ноябр", "декабр"];
const EN_MONTHS = ["jan", "feb", "mar", "apr", "may", "jun", "jul", "aug", "sep", "oct", "nov", "dec"];
const MONTH_WORD = `(?:${RU_MONTHS.join("|")})\\p{L}*|(?:${EN_MONTHS.join("|")})\\p{L}*`;

const RE_TODAY = word("сегодня|today|tonight");
const RE_TOMORROW = word("завтра|tomorrow");
const RE_AFTER_TOMORROW = word("послезавтра|day after tomorrow");
const RE_IN_DAYS = word("через\\s+(\\d{1,2})\\s+(?:дн\\p{L}*|день)|in\\s+(\\d{1,2})\\s+days?");
const RE_IN_WEEK = word("через\\s+неделю|in\\s+a\\s+week|next\\s+week|на\\s+следующей\\s+неделе");
const RE_RU_WEEKDAY = word(
  "(?:(?:в|во|до|к|на|по)\\s+)?(?:(?:эту|этот|это|следующ\\p{L}*)\\s+)?(понедельник\\p{L}*|вторник\\p{L}*|сред[ауы]|четверг\\p{L}*|пятниц[аеуы]|суббот[аеуы]|воскресень[еяю])",
);
const RE_EN_WEEKDAY = word(`(?:(?:on|by|next|this|until)\\s+)?(${EN_WEEKDAYS.join("|")})`);
const RE_RU_DATE = word(`(?:(?:до|к|на)\\s+)?(\\d{1,2})\\s+(${RU_MONTHS.join("|")})\\p{L}*`);
const RE_EN_DATE = word(`(?:(?:on|by)\\s+)?(?:(${EN_MONTHS.join("|")})\\p{L}*\\s+(\\d{1,2})|(\\d{1,2})\\s+(${EN_MONTHS.join("|")})\\p{L}*)`);
const RE_NUM_DATE = word("(?:(?:до|к|на|on|by)\\s+)?(\\d{1,2})[./](\\d{1,2})(?:[./](\\d{2,4}))?");
const RE_SOMEDAY = word("когда-нибудь|когда нибудь|потом|без срока|someday|some day|eventually|no rush");

const RE_CLOCK = word("(?:(?:в|к|на|до|at|by)\\s+)?(\\d{1,2})[:.](\\d{2})(?:\\s*(am|pm))?");
const RE_HOUR = new RegExp(
  `(?<![${L}])(?:в|к|на|до|at|by)\\s+(\\d{1,2})(?:\\s*(утра|дня|вечера|ночи|час\\p{L}*|am|pm|o'clock))?(?![${L}:.\\d])(?!\\s*(?:${MONTH_WORD}|[./]\\d))`,
  "giu",
);
const RE_HOUR_AMPM = word("(\\d{1,2})\\s*(am|pm)");
const RE_NOON = word("в\\s+полдень|at\\s+noon|noon");
const RU_ORDINALS = [
  "первого", "второго", "третьего", "четв[её]ртого", "пятого", "шестого",
  "седьмого", "восьмого", "девятого", "десятого", "одиннадцатого", "двенадцатого",
];
/** "в полвосьмого", "в половине восьмого": 7:30. */
const RE_HALF = word(`(?:(?:в|к|до)\\s+)?(?:пол\\s*|половин[еуа]\\s+)(${RU_ORDINALS.join("|")})`);
const RU_HOUR_WORDS = [
  "час", "два", "три", "четыре", "пять", "шесть", "семь", "восемь", "девять", "десять", "одиннадцать", "двенадцать",
];
/** "в семь вечера", "в десять утра": a spelled-out hour needs a part of the day after it. */
const RE_HOUR_WORD = word(`(?:в|к|на|до)\\s+(${RU_HOUR_WORDS.join("|")})\\s+(утра|дня|вечера|ночи)`);
/** "утром", "вечером": today if nothing else names the day, and a hint for bare hours. */
const RE_DAYPART = word("утром|с\\s+утра|дн[её]м|вечером|ночью|in\\s+the\\s+(?:morning|afternoon|evening)|this\\s+(?:morning|afternoon|evening)");

function monthIndex(token: string, list: string[]): number {
  const t = token.toLowerCase();
  return list.findIndex((stem) => new RegExp(`^${stem}`, "u").test(t));
}

function dateFromParts(now: LocalNow, day: number, month: number, year?: number): string | null {
  const [ty] = now.date.split("-").map(Number);
  let y = year ?? ty!;
  if (y < 100) y += 2000;
  const pad = (n: number) => String(n).padStart(2, "0");
  let date = `${y}-${pad(month + 1)}-${pad(day)}`;
  if (!isValidDate(date)) return null;
  if (year === undefined && date < now.date) date = `${y + 1}-${pad(month + 1)}-${pad(day)}`;
  return isValidDate(date) ? date : null;
}

interface WhenResult {
  date: string | null;
  time: string | null;
  /** The phrase explicitly said "no date". */
  someday: boolean;
  hits: Hit[];
}

export function parseWhen(text: string, now: LocalNow): WhenResult {
  const hits: Hit[] = [];
  // Assigned inside closures below: widen so the checks after them type-check.
  let date = null as string | null;
  let time = null as string | null;
  let someday = false;
  const take = (m: RegExpExecArray | undefined, value: string | null) => {
    if (!m || value === null) return false;
    hits.push(hitOf(m, "when"));
    if (date === null) date = value;
    return true;
  };

  // Longer phrases first so "послезавтра" never reads as "завтра".
  take(matches(text, RE_AFTER_TOMORROW)[0], addDays(now.date, 2)) ||
    take(matches(text, RE_TOMORROW)[0], addDays(now.date, 1)) ||
    take(matches(text, RE_TODAY)[0], now.date);
  for (const m of matches(text, RE_IN_DAYS)) take(m, addDays(now.date, Number(m[1] ?? m[2])));
  for (const m of matches(text, RE_IN_WEEK)) take(m, addDays(now.date, 7));
  for (const m of matches(text, RE_RU_WEEKDAY)) {
    const token = m[1]!.toLowerCase();
    const idx = RU_WEEKDAYS.find(([re]) => re.test(token))?.[1];
    if (idx !== undefined) take(m, nextWeekday(now.date, idx));
  }
  for (const m of matches(text, RE_EN_WEEKDAY)) take(m, nextWeekday(now.date, EN_WEEKDAYS.indexOf(m[1]!.toLowerCase())));
  for (const m of matches(text, RE_RU_DATE)) take(m, dateFromParts(now, Number(m[1]), monthIndex(m[2]!, RU_MONTHS)));
  for (const m of matches(text, RE_EN_DATE)) {
    const month = monthIndex(m[1] ?? m[4]!, EN_MONTHS);
    take(m, dateFromParts(now, Number(m[2] ?? m[3]), month));
  }
  for (const m of matches(text, RE_NUM_DATE)) {
    take(m, dateFromParts(now, Number(m[1]), Number(m[2]) - 1, m[3] === undefined ? undefined : Number(m[3])));
  }
  const somedayMatch = matches(text, RE_SOMEDAY)[0];
  if (somedayMatch && date === null) {
    someday = true;
    hits.push(hitOf(somedayMatch, "when"));
  }

  const setTime = (m: RegExpExecArray, h: number, min: number) => {
    if (time !== null || h > 23 || min > 59) return;
    // "12.01" already read as a date is not 12:01.
    if (hits.some((x) => m.index! < x.end && m.index! + m[0].length > x.start)) return;
    time = `${String(h).padStart(2, "0")}:${String(min).padStart(2, "0")}`;
    hits.push(hitOf(m, "when"));
  };
  const dayPartMatch = matches(text, RE_DAYPART)[0];
  const dayPart = dayPartMatch?.[0].toLowerCase();
  const evening = dayPart !== undefined && /вечер|ночь|evening|afternoon|дн/u.test(dayPart);
  const morning = dayPart !== undefined && /утр|morning/u.test(dayPart);
  /** A bare hour: "вечером в 7" is 19:00, "утром в 7" is 7:00, "в 3" alone is 15:00. */
  const bareHour = (h: number) => {
    if (morning) return h;
    if (evening) return h < 12 ? h + 12 : h;
    return h >= 1 && h <= 7 ? h + 12 : h;
  };
  const ampm = (h: number, marker: string | undefined) => {
    const mk = marker?.toLowerCase();
    if (mk === "pm" || mk === "вечера" || (mk === "дня" && h < 12) || (mk === "ночи" && h === 12)) return h === 12 ? 12 : h + 12;
    if ((mk === "am" || mk === "ночи") && h === 12) return 0;
    return h;
  };
  for (const m of matches(text, RE_CLOCK)) {
    const h = Number(m[1]);
    setTime(m, m[3] ? ampm(h, m[3]) : evening && h < 12 ? h + 12 : h, Number(m[2]));
  }
  for (const m of matches(text, RE_HALF)) {
    const n = RU_ORDINALS.findIndex((o) => new RegExp(`^${o}$`, "u").test(m[1]!.toLowerCase())) + 1;
    setTime(m, bareHour(n === 1 ? 12 : n - 1), 30);
  }
  for (const m of matches(text, RE_HOUR_WORD)) {
    const h = RU_HOUR_WORDS.indexOf(m[1]!.toLowerCase()) + 1;
    setTime(m, ampm(h, m[2]), 0);
  }
  for (const m of matches(text, RE_NOON)) setTime(m, 12, 0);
  for (const m of matches(text, RE_HOUR_AMPM)) setTime(m, ampm(Number(m[1]), m[2]), 0);
  for (const m of matches(text, RE_HOUR)) {
    let h = Number(m[1]);
    const marker = m[2]?.toLowerCase();
    if (marker && !marker.startsWith("час") && marker !== "o'clock") h = ampm(h, marker);
    else h = bareHour(h);
    setTime(m, h, 0);
  }
  if (dayPartMatch && !someday) {
    hits.push(hitOf(dayPartMatch, "when"));
    if (date === null && time === null) date = now.date;
  }
  if (time !== null && date === null && !someday) {
    date = time >= now.time ? now.date : addDays(now.date, 1);
  }
  return { date, time, someday, hits };
}

// ---------- importance, kind, links ----------

const RE_LOW = word("неважн\\p{L}*|не\\s+важно|не\\s+срочно|несрочн\\p{L}*|low\\s+priority|not\\s+urgent|когда\\s+будет\\s+время");
const RE_HIGH = word("срочн\\p{L}*|важн\\p{L}*|urgent\\p{L}*|important|asap|приоритетн\\p{L}*|горит");
const RE_WORK = word(
  "почт\\p{L}*|письм\\p{L}*|e-?mail\\p{L}*|mail|вики|wiki|трекер\\p{L}*|jira|созвон\\p{L}*|встреч\\p{L}*|ретро|prd|рабоч\\p{L}*|по\\s+работе|коллег\\p{L}*|meeting|work",
);
const RE_URL = /https?:\/\/[^\s,;]+|(?<![\p{L}\p{N}@.-])(?:[a-z0-9-]+\.)+(?:ru|com|org|net|io|dev|app|me|ai|co|рф|su|info|pro)(?:\/[^\s,;]*)?/giu;

function importanceOf(text: string): { importance: Importance; hits: Hit[] } {
  const low = matches(text, RE_LOW);
  if (low.length) return { importance: "low", hits: low.map((m) => hitOf(m, "importance")) };
  const high = matches(text, RE_HIGH);
  if (high.length) return { importance: "high", hits: high.map((m) => hitOf(m, "importance")) };
  return { importance: "normal", hits: [] };
}

function kindOf(text: string): { kind: Kind; hits: Hit[] } {
  const work = matches(text, RE_WORK);
  return work.length ? { kind: "work", hits: work.map((m) => hitOf(m, "work")) } : { kind: "personal", hits: [] };
}

function linksOf(text: string): { links: string[]; hits: Hit[] } {
  const found = matches(text, RE_URL).map((m) => {
    const raw = m[0].replace(/[.)]+$/u, "");
    return { m, raw };
  });
  return {
    links: found.map(({ raw }) => raw),
    hits: found.map(({ m, raw }) => ({ start: m.index!, end: m.index! + raw.length, kind: "link" as const })),
  };
}

// ---------- commands ----------

const COMMANDS: { action: Action; re: RegExp }[] = [
  { action: "importance", re: word("(сделай|пометь|поставь|отметь\\s+как|make|mark\\s+as|mark)\\s+((?:[\\p{L}\\p{N}]+\\s+){0,4}?)(важн\\p{L}*|срочн\\p{L}*|неважн\\p{L}*|несрочн\\p{L}*|important|urgent|low\\s+priority)") },
  { action: "undone", re: word("верни\\p{L}*|вернуть|не\\s+готово|undo|reopen|not\\s+done") },
  { action: "done", re: word("отметь|отметить|отмечай|готово|сделал[аио]?|сделано|выполнил[аио]?|выполнено|закрой|закрыл[аио]?|вычеркни|mark\\s+(?:as\\s+)?done|done|completed?|finished") },
  { action: "move", re: word("перенеси|перенести|переложи|сдвинь|отложи|move|postpone|reschedule|push") },
  { action: "delete", re: word("удали|удалить|убери|убрать|сотри|delete|remove") },
];
/** Phrases that start a new task even if a command word follows ("напомни отметить часы"). */
const RE_CREATE_LEAD = /^\s*(?:напомни\p{L}*|надо|нужно|не\s+забыть|не\s+забудь|добавь\s+задачу|запиши|remind\s+me|remember\s+to|i\s+need\s+to|todo)(?![\p{L}])/iu;

const STOP = new Set(
  stems(
    "отметь отметить отмечай готово сделал сделала сделано выполнил выполнено закрой закрыл вычеркни верни вернуть " +
      "перенеси перенести переложи сдвинь отложи удали удалить убери убрать сотри сделай пометь поставь " +
      "важной важным важное важная срочной срочным срочное неважной задачу задача задачи карточку карточка это этот эту " +
      "сегодня завтра послезавтра понедельник вторник среду среда четверг пятницу пятница субботу воскресенье " +
      "через неделю следующей утра вечера часов " +
      "mark done move delete remove make important urgent today tomorrow monday tuesday wednesday thursday friday saturday sunday " +
      "next week task please",
  ),
);

function stems(s: string): string[] {
  return (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 4).map((w) => w.slice(0, 5));
}

interface Target {
  ids: string[];
  hits: Hit[];
}

/** Everyday short words: in lowercase they never stand for an acronym ("что-то" is not "ТО"). */
const COMMON_SHORT = new Set(
  (
    "то что как так все всё мне мой моя она они оно его её ее их еще ещё уже вот там тут где кто для при про без над под " +
    "и а но да не ни же ли бы во со ко от из у о об в к с на по за до " +
    "the and for but not you all any can was one our out get has him his how its new now old see two way who did let put " +
    "say she too use to of in on at by it is be as or an if so up do go me my no we us"
  ).split(" "),
);

/** Short all-caps or numeric words in a title ("PRD", "ТО", "Q4") also identify a card. */
function shortTokens(title: string): string[] {
  return (title.match(/[\p{L}\p{N}]+/gu) ?? [])
    .filter((w) => w.length >= 2 && w.length < 4 && (/\p{N}/u.test(w) || w === w.toUpperCase()))
    .map((w) => w.toLowerCase());
}

function titleKeys(title: string): Set<string> {
  return new Set([...stems(title), ...shortTokens(title)]);
}

function findTarget(text: string, cards: Pick<Card, "id" | "title" | "done">[], includeDone: boolean, skip: Hit[]): Target {
  const pool = cards.filter((card) => card.done === includeDone);
  // Speech often lowercases acronyms: a short word counts when some card has it as one.
  const acronyms = new Set(pool.flatMap((card) => shortTokens(card.title)));
  const words = [...text.matchAll(/[\p{L}\p{N}]+/gu)]
    .filter((m) => !skip.some((h) => m.index! >= h.start && m.index! < h.end))
    .map((m) => {
      const lower = m[0].toLowerCase();
      const acronym = acronyms.has(lower) && (m[0] === m[0].toUpperCase() || !COMMON_SHORT.has(lower));
      const key = m[0].length >= 4 ? lower.slice(0, 5) : acronym ? lower : null;
      return { key, start: m.index!, end: m.index! + m[0].length };
    })
    .filter((w): w is { key: string; start: number; end: number } => w.key !== null && !STOP.has(w.key));
  if (words.length === 0) return { ids: [], hits: [] };
  let best = 0;
  let ids: string[] = [];
  let bestHits: Hit[] = [];
  for (const card of pool) {
    const own = titleKeys(card.title);
    const hit = words.filter((w) => own.has(w.key));
    if (hit.length === 0) continue;
    if (hit.length > best) {
      best = hit.length;
      ids = [card.id];
      bestHits = hit.map((w) => ({ start: w.start, end: w.end, kind: "target" as const }));
    } else if (hit.length === best) ids.push(card.id);
  }
  return { ids, hits: bestHits };
}

// ---------- titles ----------

const RE_LEAD = /^\s*(?:напомни(?:те)?(?:\s+мне)?|надо|нужно|мне\s+нужно|не\s+забыть|не\s+забудь|добавь(?:\s+задачу)?|запиши|remind\s+me\s+to|remember\s+to|i\s+need\s+to|need\s+to|todo:?)(?![\p{L}])[\s,:—-]*/iu;

function titleFrom(text: string, remove: Hit[]): string {
  const sorted = [...remove].sort((a, b) => b.start - a.start);
  let out = text;
  for (const h of sorted) out = out.slice(0, h.start) + " " + out.slice(h.end);
  out = out
    .replace(RE_LEAD, "")
    .replace(/(?<![\p{L}])(?:это|it's|it is)\s*(?=[,.;!]|$)/giu, "")
    .replace(/\s+([,.;!?])/g, "$1")
    .replace(/([,.;])(?:\s*[,.;])+/g, "$1")
    .replace(/\s{2,}/g, " ")
    .replace(/^[\s,.;:—-]+|[\s,.;:—-]+$/g, "");
  return out.charAt(0).toUpperCase() + out.slice(1);
}

function toDue(when: WhenResult): Due | null {
  return when.date === null ? null : { date: when.date, time: when.time };
}

function sortHits(hits: Hit[]): Span[] {
  return hits
    .filter((h) => h.end > h.start)
    .sort((a, b) => a.start - b.start)
    .filter((h, i, all) => i === 0 || h.start >= all[i - 1]!.end);
}

// ---------- entry ----------

export interface ParseInput {
  text: string;
  now: LocalNow;
  cards: Pick<Card, "id" | "title" | "done">[];
}

export function parsePhrase({ text, now, cards }: ParseInput): ParseResult {
  const when = parseWhen(text, now);
  const imp = importanceOf(text);
  const kind = kindOf(text);
  const links = linksOf(text);

  if (!RE_CREATE_LEAD.test(text)) {
    for (const { action, re } of COMMANDS) {
      const m = matches(text, re)[0];
      if (!m) continue;
      // "Сделай <задачу> срочной": the verb and the word of importance are the
      // command, the words between them name the task.
      const actionHits: Hit[] =
        action === "importance"
          ? [
              { start: m.index!, end: m.index! + m[1]!.length, kind: "action" },
              { start: m.index! + m[0].length - m[3]!.length, end: m.index! + m[0].length, kind: "importance" },
            ]
          : [hitOf(m, "action")];
      const target = findTarget(text, cards, action === "undone", [...actionHits, ...when.hits, ...imp.hits]);
      const spans = sortHits([...actionHits, ...target.hits, ...(action === "move" ? when.hits : [])]);
      if (target.ids.length === 1) {
        const base = { type: "command" as const, action, targetId: target.ids[0]!, spans };
        if (action === "move") return { ...base, due: when.someday ? null : toDue(when) ?? { date: addDays(now.date, 1), time: null } };
        if (action === "importance") return { ...base, importance: /неважн|несрочн|low/iu.test(m[3] ?? "") ? "low" : "high" };
        return base;
      }
      if (target.ids.length > 1) return { type: "ambiguous", action, candidateIds: target.ids.slice(0, 3), spans };
      // A command word with no task to point at: short phrases are failed
      // commands, longer ones are probably a new task ("отменить подписку").
      if (text.trim().split(/\s+/).length <= 4) return { type: "notFound", action, spans };
      break;
    }
  }

  const draft: Draft = {
    title: titleFrom(text, [...when.hits, ...imp.hits, ...links.hits]) || text.trim(),
    due: toDue(when),
    importance: when.someday && imp.importance === "normal" ? "low" : imp.importance,
    kind: kind.kind,
    links: links.links,
  };
  return { type: "create", draft, spans: sortHits([...when.hits, ...imp.hits, ...kind.hits, ...links.hits]) };
}
