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
  "(?:(?:в|во|до|к|на|по)\\s+)?(?:(?:эту|этот|это|следующ\\p{L}*|будущ\\p{L}*|ближайш\\p{L}*)\\s+)?(понедельник\\p{L}*|вторник\\p{L}*|сред[ауы]|четверг\\p{L}*|пятниц[аеуы]|суббот[аеуы]|воскресень[еяю])",
);
const RE_EN_WEEKDAY = word(`(?:(?:on|by|next|this|until)\\s+)?(${EN_WEEKDAYS.join("|")})`);
const RE_RU_DATE = word(`(?:(?:до|к|на)\\s+)?(\\d{1,2})\\s+(${RU_MONTHS.join("|")})\\p{L}*`);
const RE_EN_DATE = word(`(?:(?:on|by)\\s+)?(?:(${EN_MONTHS.join("|")})\\p{L}*\\s+(\\d{1,2})|(\\d{1,2})\\s+(${EN_MONTHS.join("|")})\\p{L}*)`);
const RE_NUM_DATE = word("(?:(?:до|к|на|on|by)\\s+)?(\\d{1,2})[./](\\d{1,2})(?:[./](\\d{2,4}))?");
const RE_SOMEDAY = word("когда-нибудь|когда нибудь|потом|без срока|someday|some day|eventually|no rush");

const RE_CLOCK = word("(?:(?:в|к|на|до|at|by)\\s+)?(\\d{1,2})[:.](\\d{2})(?:\\s*(am|pm))?");
const PREP = "в|к|на|до|после|около|at|by";
/** "На 15 процентов", "на 10 минут", "в 2 раза": amounts, not times. */
const NOT_TIME_AFTER = `(?:процент|раз(?![${L}])|раза|штук|шт|человек|руб|тыс|доллар|евро|минут|мин(?![${L}])|секунд|дн|день|недел|месяц|лет|год|кг|км|percent|times|minutes?|days?|weeks?|people|pieces?)`;
/** "Умножить на 23", "увеличить на 15": arithmetic, not a time. */
const NOT_TIME_BEFORE = "(?<!(?:умнож|помнож|раздел|подел|увелич|уменьш|сократ|multipl|divid|increas|decreas|reduc)\\p{L}*\\s+)";
/** "в 16 часов 15 минут", "к 9 ч 30 мин". */
const RE_CLOCK_WORDS = word(
  `(?:(?:${PREP})\\s+)?(\\d{1,2})\\s*(?:час(?:а|ов)?|ч\\.?)\\s*(\\d{1,2})\\s*(?:минут\\p{L}*|мин\\.?)(?:\\s+(утра|дня|вечера|ночи))?`,
);
/** "в 16 15", "к 9 30 утра": a clock time said with a pause instead of a colon. Needs the preposition. */
const RE_CLOCK_SPACED = new RegExp(
  `(?<![${L}])${NOT_TIME_BEFORE}(?:${PREP})\\s+(\\d{1,2})\\s+(\\d{2})(?:\\s+минут\\p{L}*)?(?:\\s+(утра|дня|вечера|ночи|am|pm))?(?![${L}\\d])` +
    `(?!\\s*(?:${MONTH_WORD}|[./:]\\d|час|дн|недел|раз|штук|человек|руб))`,
  "giu",
);
const RE_HOUR = new RegExp(
  `(?<![${L}])${NOT_TIME_BEFORE}(?:в|к|на|до|at|by)\\s+(\\d{1,2})(?:\\s*(утра|дня|вечера|ночи|час\\p{L}*|am|pm|o'clock))?(?![${L}:.\\d])(?!\\s*(?:${MONTH_WORD}|[./]\\d|%|${NOT_TIME_AFTER}))`,
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
/** Spelled-out hours: "в час", "до часа дня", "к пяти", "до двух часов", "в семь вечера". */
const RU_HOURS: { nominative: string; oblique: string }[] = [
  { nominative: "час", oblique: "часа|часу" },
  { nominative: "два", oblique: "двух|двум" },
  { nominative: "три", oblique: "тр[её]х|тр[её]м" },
  { nominative: "четыре", oblique: "четыр[её]х|четыр[её]м" },
  { nominative: "пять", oblique: "пяти" },
  { nominative: "шесть", oblique: "шести" },
  { nominative: "семь", oblique: "семи" },
  { nominative: "восемь", oblique: "восьми" },
  { nominative: "девять", oblique: "девяти" },
  { nominative: "десять", oblique: "десяти" },
  { nominative: "одиннадцать", oblique: "одиннадцати" },
  { nominative: "двенадцать", oblique: "двенадцати" },
];
const RE_HOUR_WORD = word(
  `(?:в|к|на|до|после|около)\\s+(${RU_HOURS.map((h) => `${h.nominative}|${h.oblique}`).join("|")})` +
    `(?:\\s+(час\\p{L}*))?(?:\\s+(утра|дня|вечера|ночи))?` +
    // "в два раза", "до трёх дней" count things, they are not times.
    `(?!\\s+(?:раз|дн|недел|месяц|минут|штук|человек|задач|страниц|лет|год|процент|тысяч|рубл))`,
);
function hourOfWord(token: string): number {
  const lower = token.toLowerCase();
  return RU_HOURS.findIndex((h) => new RegExp(`^(?:${h.nominative}|${h.oblique})$`, "u").test(lower)) + 1;
}
/** Times of day people say instead of a clock: lunch is 13:00, the end of the day 18:00. */
const DAY_MARKS: [RegExp, number, number][] = [
  [word("после\\s+обеда|after\\s+lunch"), 14, 0],
  [word("(?:до|к|перед|в)\\s+обед\\p{L}*|(?:by|before|at)\\s+lunch(?:time)?"), 13, 0],
  [word("(?:до|к)\\s+концу?\\s+(?:рабочего\\s+)?дня|(?:до|к)\\s+вечер[ау]|by\\s+(?:the\\s+)?end\\s+of\\s+(?:the\\s+)?day|by\\s+eod"), 18, 0],
];
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
  for (const re of [RE_CLOCK_WORDS, RE_CLOCK_SPACED]) {
    for (const m of matches(text, re)) {
      const h = Number(m[1]);
      setTime(m, m[3] ? ampm(h, m[3]) : bareHour(h), Number(m[2]));
    }
  }
  for (const m of matches(text, RE_HALF)) {
    const n = RU_ORDINALS.findIndex((o) => new RegExp(`^${o}$`, "u").test(m[1]!.toLowerCase())) + 1;
    setTime(m, bareHour(n === 1 ? 12 : n - 1), 30);
  }
  for (const m of matches(text, RE_HOUR_WORD)) {
    const h = hourOfWord(m[1]!);
    const nominative = RU_HOURS[h - 1]!.nominative === m[1]!.toLowerCase();
    // "в два" alone is too often "в два раза"; "в час" and "до двух" are times.
    if (nominative && h !== 1 && !m[2] && !m[3]) continue;
    setTime(m, m[3] ? ampm(h, m[3]) : bareHour(h), 0);
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
  for (const [re, h, min] of DAY_MARKS) for (const m of matches(text, re)) setTime(m, h, min);
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
  { action: "done", re: word("отметь|отметить|отмечай|готово|сделал[аио]?|сделано|выполнил[аио]?|выполнено|закрой|закрыл[аио]?|закрыт\\p{L}*|вычеркни|mark\\s+(?:as\\s+)?done|done|completed?|finished|closed?") },
  { action: "move", re: word("перенеси|перенести|переложи|сдвинь|подвинь|передвинь|перемести|отложи|move|postpone|reschedule|push") },
  { action: "delete", re: word("удали|удалить|убери|убрать|сотри|delete|remove") },
];
/** "6", "6 и 1", "3, 5 и 8", "#6 and #1". */
const NUM_LIST = "\\d{1,5}(?:\\s*(?:,|и|and|&|а\\s+также)\\s*(?:[#№]\\s?)?\\d{1,5})*";
/** "Стикер 112", "задачи 6 и 1", "#112", "№ 112": cards by their numbers. */
const RE_CARD_NUM = word(
  `(?:стикер\\p{L}*|номер\\p{L}*|задач\\p{L}*|карточк\\p{L}*|sticker\\p{L}*|card\\p{L}*|task\\p{L}*|note\\p{L}*|number\\p{L}*)\\s*(?:№|#|номер\\p{L}*\\s+)?(${NUM_LIST})|[#№]\\s?(${NUM_LIST})`,
);
/**
 * "Закрой 6 и 1", "перенеси 3 на завтра", "закрыть аздачи 6 и 1": numbers right
 * after the verb, maybe behind a misspelled "задачи". They must end the phrase
 * or be followed by a preposition, so "убери 3 книги" stays a task.
 */
const RE_BARE_REF = new RegExp(
  `^\\s*([\\p{L}]+)\\s+(?:([\\p{L}]{4,})\\s+)?(?:[#№]\\s?)?(${NUM_LIST})` +
    `(?=\\s*$|\\s*[,.!?;]|\\s+(?:в|во|на|к|до|из|to|in|on|into|as)(?![${L}]))`,
  "iu",
);
const RE_COMMAND_VERB = /^(?:сделай|пометь|поставь|make|mark|открой|покажи|open|show)$/iu;
const CARD_NOUNS = ["задача", "задачи", "задачу", "стикер", "стикеры", "стикера", "карточка", "карточки", "карточку", "tasks", "cards", "stickers"];

/** Levenshtein distance, small words only. */
function distance(a: string, b: string): number {
  let prev = Array.from({ length: b.length + 1 }, (_, i) => i);
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row.push(Math.min(prev[j]! + 1, row[j - 1]! + 1, prev[j - 1]! + (a[i - 1] === b[j - 1] ? 0 : 1)));
    }
    prev = row;
  }
  return prev[b.length]!;
}
const isCardNoun = (w: string) => CARD_NOUNS.some((noun) => distance(w.toLowerCase(), noun) <= 2);
const isCommandVerb = (w: string) =>
  RE_COMMAND_VERB.test(w) || COMMANDS.some(({ action, re }) => action !== "importance" && matches(w, re).some((m) => m[0] === w));
const RE_OPEN = /^\s*(?:открой|открыть|покажи|open|show)(?![\p{L}])/iu;
/** "Закрой задачу…", "перенеси её…", "close the task…": the verb points at "the task" in context. */
const RE_GENERIC_OBJECT =
  /^\s*[\p{L}]+\s+(?:(?:эту|это|последн\p{L}*|текущ\p{L}*|мою|this|the|that|my)\s+)?(?:задач\p{L}*|стикер\p{L}*|карточк\p{L}*|е[её]|это|task|card|sticker|it|this)(?![\p{L}])/iu;
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
      "next week task please пожалуйста последнюю последняя текущую задачку this that",
  ),
);

function stems(s: string): string[] {
  return (s.toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? []).filter((w) => w.length >= 4).map((w) => w.slice(0, 5));
}

interface Target {
  ids: string[];
  hits: Hit[];
  /** The phrase had words that could name a card; false for "закрой задачу". */
  named: boolean;
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
  if (words.length === 0) return { ids: [], hits: [], named: false };
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
  return { ids, hits: bestHits, named: true };
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
  cards: (Pick<Card, "id" | "title" | "done"> & { num?: number })[];
  /** The card the user is dealing with: the open one, or the last one touched. */
  contextId?: string | null;
}

/** Cards named by number: "стикер 112", "задачи 6 и 1", "закрой 6 и 1". */
function numberRef(said: string, cards: ParseInput["cards"]): { ids: string[]; hit: Hit } | null {
  const resolve = (list: string) => {
    const ids = (list.match(/\d{1,5}/g) ?? [])
      .map((n) => cards.find((c) => c.num === Number(n))?.id)
      .filter((id): id is string => id !== undefined);
    return [...new Set(ids)];
  };
  for (const m of matches(said, RE_CARD_NUM)) {
    const ids = resolve((m[1] ?? m[2])!);
    if (ids.length) return { ids, hit: hitOf(m, "target") };
  }
  const bare = RE_BARE_REF.exec(said);
  if (bare && isCommandVerb(bare[1]!) && (bare[2] === undefined || isCardNoun(bare[2]))) {
    const ids = resolve(bare[3]!);
    const end = bare.index + bare[0].length;
    const verbEnd = bare[0].indexOf(bare[1]!) + bare[1]!.length;
    const start = bare[2] ? bare.index + bare[0].indexOf(bare[2], verbEnd) : end - bare[3]!.length;
    if (ids.length) return { ids, hit: { start, end, kind: "target" } };
  }
  return null;
}

/**
 * "Закрой презентацию и посылку": each part of a list names its own card. Null
 * unless every part that names something points at exactly one card and there
 * are at least two of them.
 */
function listTargets(text: string, cards: ParseInput["cards"], includeDone: boolean, skip: Hit[]): Target | null {
  const cuts = [...text.matchAll(/\s*(?:,|(?<![\p{L}])(?:и|and|а\s+также)(?![\p{L}]))\s*/giu)];
  if (cuts.length === 0) return null;
  const bounds = [0, ...cuts.flatMap((c) => [c.index!, c.index! + c[0].length]), text.length];
  const ids: string[] = [];
  const hits: Hit[] = [];
  for (let i = 0; i < bounds.length; i += 2) {
    const [from, to] = [bounds[i]!, bounds[i + 1]!];
    const part = " ".repeat(from) + text.slice(from, to) + " ".repeat(text.length - to);
    const found = findTarget(part, cards, includeDone, skip);
    if (!found.named) continue;
    if (found.ids.length !== 1) return null;
    if (!ids.includes(found.ids[0]!)) ids.push(found.ids[0]!);
    hits.push(...found.hits);
  }
  return ids.length >= 2 ? { ids, hits, named: true } : null;
}

export function parsePhrase({ text: said, now, cards, contextId = null }: ParseInput): ParseResult {
  // Cards named by number. The numbers are blanked out (offsets kept) so
  // "стикер 12 на завтра" never reads 12 as a time.
  const ref = numberRef(said, cards);
  const refHit = ref?.hit ?? null;
  const text = refHit ? said.slice(0, refHit.start) + " ".repeat(refHit.end - refHit.start) + said.slice(refHit.end) : said;
  if (ref && RE_OPEN.test(said)) {
    const id = ref.ids[0]!;
    return { type: "command", action: "open", targetId: id, targetIds: [id], spans: sortHits([hitOf(RE_OPEN.exec(said)!, "action"), refHit!]) };
  }
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
      const skip = [...actionHits, ...when.hits, ...imp.hits];
      const listed = ref ? null : listTargets(text, cards, action === "undone", skip);
      const target: Target = ref
        ? { ids: ref.ids, hits: [refHit!], named: true }
        : (listed ?? findTarget(text, cards, action === "undone", skip));
      // Several cards named on purpose ("задачи 6 и 1", "презентацию и посылку")
      // are all meant; a tie between titles is a question instead.
      const several = target.ids.length > 1 && (ref !== null || listed !== null);
      // A Russian imperative opening the phrase ("Закрой…", not "Закрыть…") is
      // always a command, never a new task.
      const leading = text.slice(0, actionHits[0]!.start).trim() === "";
      const verb = text.slice(actionHits[0]!.start, actionHits[0]!.end).split(/\s+/)[0] ?? "";
      const imperative = leading && /\p{Script=Cyrillic}/u.test(verb) && !/(?:ть|ти)$/iu.test(verb);
      const generic = leading && RE_GENERIC_OBJECT.test(text);
      // "Закрой задачу" points at the card in context, or the only candidate:
      // also when the rest of the phrase is an explanation that names nothing on the board.
      if (!target.named || (generic && target.ids.length === 0)) {
        const pool = cards.filter((c) => c.done === (action === "undone"));
        const implied = contextId && cards.some((c) => c.id === contextId) ? contextId : pool.length === 1 ? pool[0]!.id : null;
        if (implied) target.ids = [implied];
      }
      const spans = sortHits([...actionHits, ...target.hits, ...(action === "move" ? when.hits : [])]);
      if (target.ids.length === 1 || several) {
        const base = { type: "command" as const, action, targetId: target.ids[0]!, targetIds: target.ids, spans };
        if (action === "move") return { ...base, due: when.someday ? null : toDue(when) ?? { date: addDays(now.date, 1), time: null } };
        if (action === "importance") return { ...base, importance: /неважн|несрочн|low/iu.test(m[3] ?? "") ? "low" : "high" };
        return base;
      }
      if (target.ids.length > 1) return { type: "ambiguous", action, candidateIds: target.ids.slice(0, 3), spans };
      // A command word with no task to point at: short phrases are failed
      // commands, longer ones are probably a new task ("отменить подписку").
      if (!target.named || generic) return { type: "notFound", action, named: false, spans };
      if (imperative || text.trim().split(/\s+/).length <= 4) return { type: "notFound", action, named: true, spans };
      break;
    }
  }

  return { type: "create", ...draftFrom(said, when, imp, kind, links) };
}

function draftFrom(
  said: string,
  when: WhenResult,
  imp: ReturnType<typeof importanceOf>,
  kind: ReturnType<typeof kindOf>,
  links: ReturnType<typeof linksOf>,
): { draft: Draft; spans: Span[] } {
  const draft: Draft = {
    title: titleFrom(said, [...when.hits, ...imp.hits, ...links.hits]) || said.trim(),
    due: toDue(when),
    importance: when.someday && imp.importance === "normal" ? "low" : imp.importance,
    kind: kind.kind,
    links: links.links,
  };
  return { draft, spans: sortHits([...when.hits, ...imp.hits, ...kind.hits, ...links.hits]) };
}

/** A new card from a phrase, never a command: "сделай стикер: …" from an agent. */
export function draftOf(text: string, now: LocalNow): Draft {
  return draftFrom(text, parseWhen(text, now), importanceOf(text), kindOf(text), linksOf(text)).draft;
}

/** Links anywhere in a longer text, such as an agent's message. */
export function linksIn(text: string): string[] {
  return [...new Set(linksOf(text).links)];
}
