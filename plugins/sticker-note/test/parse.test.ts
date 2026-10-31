import { describe, expect, it } from "vitest";

import { parsePhrase, parseWhen } from "../src/parse";
import { columnOf } from "../src/model";

// Saturday, 31 October 2026, 13:40.
const now = { date: "2026-10-31", time: "13:40" };
const cards = [
  { id: "c1", title: "Ответить Дмитрию по ставкам на ноябрь", done: false },
  { id: "c3", title: "Забрать посылку в пункте выдачи", done: false },
  { id: "c5", title: "Позвонить в сервис насчёт ТО", done: false },
  { id: "c9", title: "Подать документы на загранпаспорт", done: false },
  { id: "c11", title: "Купить фильтры для пылесоса", done: false },
  { id: "c12", title: "Отправить отчёт по лидам за октябрь", done: true },
  { id: "c20", title: "Позвонить маме", done: false },
  { id: "c21", title: "Позвонить папе", done: false },
];
const parse = (text: string) => parsePhrase({ text, now, cards });
const spanTexts = (text: string, kind: string) => {
  const r = parse(text);
  return r.spans.filter((s) => s.kind === kind).map((s) => text.slice(s.start, s.end));
};

describe("when", () => {
  it.each([
    ["Сегодня в 16:00", "2026-10-31", "16:00"],
    ["завтра в 10", "2026-11-01", "10:00"],
    ["послезавтра", "2026-11-02", null],
    ["до пятницы", "2026-11-06", null],
    ["в понедельник в 9 утра", "2026-11-02", "09:00"],
    ["в среду, на 12", "2026-11-04", "12:00"],
    ["в 7 вечера", "2026-10-31", "19:00"],
    ["в 3", "2026-10-31", "15:00"],
    ["в 9", "2026-11-01", "09:00"],
    ["12 декабря", "2026-12-12", null],
    ["12.01", "2027-01-12", null],
    ["через 3 дня", "2026-11-03", null],
    ["через неделю", "2026-11-07", null],
    ["tomorrow at 5pm", "2026-11-01", "17:00"],
    ["on friday", "2026-11-06", null],
    ["вечером в полвосьмого", "2026-10-31", "19:30"],
    ["в половине девятого утра", "2026-11-01", "08:30"],
    ["в пол седьмого", "2026-10-31", "18:30"],
    ["утром в 7", "2026-11-01", "07:00"],
    ["вечером в 9", "2026-10-31", "21:00"],
    ["в пятницу вечером", "2026-11-06", null],
    ["вечером", "2026-10-31", null],
    ["в семь вечера", "2026-10-31", "19:00"],
    ["в десять утра", "2026-11-01", "10:00"],
    ["Dec 12", "2026-12-12", null],
  ])("%s", (text, date, time) => {
    const w = parseWhen(text, now);
    expect(w.date).toBe(date);
    expect(w.time).toBe(time);
  });

  it("someday means no date", () => {
    const w = parseWhen("когда-нибудь посмотреть доклад", now);
    expect(w).toMatchObject({ date: null, someday: true });
  });

  it("a day of month is not an hour", () => {
    expect(parseWhen("на 12 декабря", now)).toMatchObject({ date: "2026-12-12", time: null });
  });
});

describe("new tasks", () => {
  it("prototype phrase 1", () => {
    const r = parse("Сегодня в 16:00 отправить Ирине презентацию по тарифам, это важно");
    expect(r).toMatchObject({
      type: "create",
      draft: { title: "Отправить Ирине презентацию по тарифам", due: { date: "2026-10-31", time: "16:00" }, importance: "high" },
    });
  });

  it("prototype phrase 2 — work task", () => {
    const text = "До пятницы разобраться с письмом логистов про возвраты и набросать ответ, поищи в рабочей почте";
    const r = parse(text);
    expect(r.type).toBe("create");
    if (r.type !== "create") return;
    expect(r.draft.due).toEqual({ date: "2026-11-06", time: null });
    expect(r.draft.kind).toBe("work");
    expect(r.draft.title.startsWith("Разобраться с письмом логистов")).toBe(true);
    expect(spanTexts(text, "when")).toEqual(["До пятницы"]);
  });

  it("prototype phrase 3 — someday with a link", () => {
    const r = parse("Когда-нибудь посмотреть доклад про локальные модели, ссылка youtube.com/watch?v=k3");
    expect(r).toMatchObject({
      type: "create",
      draft: { title: "Посмотреть доклад про локальные модели, ссылка", due: null, importance: "low", links: ["youtube.com/watch?v=k3"] },
    });
  });

  it("spoken time of day leaves the title", () => {
    const r = parse("Вечером, в полвосьмого, забрать посылку в пункте выдачи");
    expect(r.type).toBe("create");
    if (r.type !== "create") return;
    expect(r.draft.title).toBe("Забрать посылку в пункте выдачи");
    expect(r.draft.due).toEqual({ date: "2026-10-31", time: "19:30" });
  });

  it("strips the lead-in", () => {
    const r = parse("Напомни мне завтра купить хлеб");
    expect(r).toMatchObject({ type: "create", draft: { title: "Купить хлеб", due: { date: "2026-11-01" } } });
  });

  it("'неважно' is low, not high", () => {
    const r = parse("купить лампочку, неважно");
    expect(r).toMatchObject({ type: "create", draft: { importance: "low" } });
  });

  it("a remind-me phrase with a command word stays a new task", () => {
    expect(parse("Напомни отметить часы в табеле в пятницу").type).toBe("create");
  });
});

describe("commands", () => {
  it("done by a word from the title", () => {
    expect(parse("Посылку забрал, отметь")).toMatchObject({ type: "command", action: "done", targetId: "c3" });
  });

  it("move with a new date and time", () => {
    const r = parse("Звонок в сервис перенеси на среду, на 12");
    expect(r).toMatchObject({ type: "command", action: "move", targetId: "c5", due: { date: "2026-11-04", time: "12:00" } });
  });

  it("move to someday clears the date", () => {
    expect(parse("пылесос отложи на потом")).toMatchObject({ type: "command", action: "move", targetId: "c11", due: null });
  });

  it("importance", () => {
    expect(parse("Сделай загранпаспорт срочным")).toMatchObject({ type: "command", action: "importance", targetId: "c9", importance: "high" });
    expect(parse("сделай фильтры для пылесоса неважной")).toMatchObject({ action: "importance", targetId: "c11", importance: "low" });
  });

  it("an acronym from the title finds its card, in any case", () => {
    const withPrd = [...cards, { id: "c8", title: "Прочитать PRD списания", done: false }];
    for (const text of ["отложи PRD на понедельник", "перенеси prd на понедельник"]) {
      expect(parsePhrase({ text, now, cards: withPrd })).toMatchObject({ type: "command", action: "move", targetId: "c8" });
    }
    expect(parsePhrase({ text: "перенеси ТО на среду", now, cards })).toMatchObject({ type: "command", targetId: "c5" });
  });

  it("delete", () => {
    expect(parse("удали фильтры")).toMatchObject({ type: "command", action: "delete", targetId: "c11" });
  });

  it("undone looks at finished tasks", () => {
    expect(parse("верни отчёт по лидам")).toMatchObject({ type: "command", action: "undone", targetId: "c12" });
  });

  it("two equally good matches ask which one", () => {
    expect(parse("отметь позвонить")).toMatchObject({ type: "ambiguous", candidateIds: ["c5", "c20", "c21"] });
    expect(parse("отметь позвонить маме")).toMatchObject({ type: "command", targetId: "c20" });
  });

  it("a short command that matches nothing is reported", () => {
    expect(parse("отметь что-то непонятное")).toMatchObject({ type: "notFound", action: "done" });
  });
});

describe("columns", () => {
  const today = "2026-10-31";
  it.each([
    [{ done: false, due: null }, "later"],
    [{ done: false, due: { date: "2026-10-30", time: null } }, "today"],
    [{ done: false, due: { date: "2026-10-31", time: "09:00" } }, "today"],
    [{ done: false, due: { date: "2026-11-07", time: null } }, "soon"],
    [{ done: false, due: { date: "2026-11-08", time: null } }, "later"],
    [{ done: true, due: { date: "2026-10-31", time: null } }, "done"],
  ] as const)("%j → %s", (card, col) => {
    expect(columnOf(card, today)).toBe(col);
  });
});
