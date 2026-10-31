import { describe, expect, it } from "vitest";

import { parsePhrase } from "../src/parse";

// Saturday, 31 October 2026, 13:40.
const now = { date: "2026-10-31", time: "13:40" };
const cards = [
  { id: "a", num: 12, title: "Смотреть презентацию", done: false },
  { id: "b", num: 112, title: "Забрать посылку", done: false },
  { id: "c", num: 7, title: "Отправить отчёт", done: true },
];
const parse = (text: string) => parsePhrase({ text, now, cards });

describe("stickers by number", () => {
  it.each([
    ["подвинь стикер 112 в закрыто", "done", "b"],
    ["Закрой задачу 12", "done", "a"],
    ["отметь #112", "done", "b"],
    ["удали номер 12", "delete", "a"],
    ["верни стикер 7", "undone", "c"],
    ["сделай стикер 12 важным", "importance", "a"],
    ["move card 112 to done", "done", "b"],
  ])("%s", (text, action, targetId) => {
    expect(parse(text)).toMatchObject({ type: "command", action, targetId });
  });

  it("a sticker number is not a time", () => {
    expect(parse("перенеси стикер 12 на завтра")).toMatchObject({
      type: "command",
      action: "move",
      targetId: "a",
      due: { date: "2026-11-01", time: null },
    });
    expect(parse("перенеси стикер 12 на понедельник в 10")).toMatchObject({ due: { date: "2026-11-02", time: "10:00" } });
  });

  it("opens a sticker", () => {
    expect(parse("открой стикер 112")).toMatchObject({ type: "command", action: "open", targetId: "b" });
  });

  it("an unknown number falls back to words", () => {
    expect(parse("закрой стикер 999 презентация")).toMatchObject({ type: "command", targetId: "a" });
  });

  it("a new task that mentions a number keeps it in the title", () => {
    const r = parse("Купить 2 билета на концерт");
    expect(r.type === "create" && r.draft.title).toBe("Купить 2 билета на концерт");
  });
});
