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

  it.each([
    ["закрыть задачи 12 и 112", ["a", "b"]],
    ["закрой 12 и 112", ["a", "b"]],
    ["закрыть аздачи 12 и 112", ["a", "b"]],
    ["закрой стикеры 112, 12", ["b", "a"]],
    ["close cards 12 and 112", ["a", "b"]],
    ["закрой #12 и #112", ["a", "b"]],
  ])("several numbers: %s", (text, ids) => {
    expect(parse(text)).toMatchObject({ type: "command", action: "done", targetId: ids[0], targetIds: ids });
  });

  it("several numbers move together", () => {
    expect(parse("перенеси задачи 12 и 112 на завтра в 16 15")).toMatchObject({
      type: "command",
      action: "move",
      targetIds: ["a", "b"],
      due: { date: "2026-11-01", time: "16:15" },
    });
  });

  it("several titles in one command", () => {
    expect(parse("закрой презентацию и посылку")).toMatchObject({ type: "command", action: "done", targetIds: ["a", "b"] });
  });

  it("a bare number is not a card when a noun follows", () => {
    expect(parse("убери 12 книг с полки").type).not.toBe("command");
    expect(parse("Убрать 12 книг с полки")).toMatchObject({ type: "create" });
  });

  it("a new task that mentions a number keeps it in the title", () => {
    const r = parse("Купить 2 билета на концерт");
    expect(r.type === "create" && r.draft.title).toBe("Купить 2 билета на концерт");
  });
});
