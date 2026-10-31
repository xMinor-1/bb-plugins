import { describe, expect, it } from "vitest";

import { layoutToday, overdueMinutes, sortColumn, todayStats } from "../src/board";
import type { Card, Due, Importance } from "../src/model";

const now = { date: "2026-10-31", time: "13:40" };

function card(id: string, due: Due | null, extra: Partial<Card> = {}): Card {
  return {
    id,
    title: id,
    notes: [],
    links: [],
    importance: "normal" as Importance,
    kind: "personal",
    due,
    remind: false,
    done: false,
    doneAt: null,
    said: null,
    chats: [],
    createdAt: `2026-10-01T00:00:0${id.length}Z`,
    updatedAt: "2026-10-01T00:00:00Z",
    ...extra,
  };
}

describe("overdue", () => {
  it("counts minutes past a time today", () => {
    expect(overdueMinutes(card("a", { date: now.date, time: "12:10" }), now)).toBe(90);
    expect(overdueMinutes(card("a", { date: now.date, time: "15:00" }), now)).toBe(0);
    expect(overdueMinutes(card("a", { date: now.date, time: null }), now)).toBe(0);
  });
  it("counts a past day from its time or its end", () => {
    expect(overdueMinutes(card("a", { date: "2026-10-30", time: "20:00" }), now)).toBe(4 * 60 + 13 * 60 + 40);
    expect(overdueMinutes(card("a", { date: "2026-10-30", time: null }), now)).toBe(13 * 60 + 40);
  });
  it("ignores done cards and future dates", () => {
    expect(overdueMinutes(card("a", { date: "2026-10-30", time: null }, { done: true }), now)).toBe(0);
    expect(overdueMinutes(card("a", { date: "2026-11-01", time: "09:00" }), now)).toBe(0);
  });
});

describe("Today column", () => {
  it("orders by time, puts the now line before the first upcoming card, and lists untimed cards by importance", () => {
    const cards = [
      card("c19", { date: now.date, time: "19:30" }),
      card("c09", { date: now.date, time: "09:30" }),
      card("old", { date: "2026-10-29", time: null }),
      card("c15", { date: now.date, time: "15:00" }),
      card("free", { date: now.date, time: null }),
      card("urgent", { date: now.date, time: null }, { importance: "high" }),
    ];
    const { timed, nowIndex, untimed } = layoutToday(cards, now);
    expect(timed.map((c) => c.id)).toEqual(["old", "c09", "c15", "c19"]);
    expect(nowIndex).toBe(2);
    expect(untimed.map((c) => c.id)).toEqual(["urgent", "free"]);
  });
  it("puts the now line last when everything is past", () => {
    expect(layoutToday([card("a", { date: now.date, time: "08:00" })], now).nowIndex).toBe(1);
  });
});

describe("other columns", () => {
  it("lists dated cards by date, then undated ones by importance", () => {
    const sorted = sortColumn("later", [
      card("none-low", null, { importance: "low" }),
      card("dec", { date: "2026-12-12", time: null }),
      card("none-high", null, { importance: "high" }),
      card("nov", { date: "2026-11-20", time: null }),
    ]);
    expect(sorted.map((c) => c.id)).toEqual(["nov", "dec", "none-high", "none-low"]);
  });
  it("lists finished cards newest first", () => {
    const sorted = sortColumn("done", [
      card("a", null, { done: true, doneAt: "2026-10-30T10:00:00Z" }),
      card("b", null, { done: true, doneAt: "2026-10-31T09:00:00Z" }),
    ]);
    expect(sorted.map((c) => c.id)).toEqual(["b", "a"]);
  });
});

it("counts today's open cards and the overdue ones for the badge", () => {
  const stats = todayStats(
    [
      card("late", { date: now.date, time: "09:00" }),
      card("later", { date: now.date, time: "18:00" }),
      card("past-day", { date: "2026-10-28", time: null }),
      card("done", { date: now.date, time: "08:00" }, { done: true }),
      card("tomorrow", { date: "2026-11-01", time: null }),
    ],
    now,
  );
  expect(stats).toEqual({ count: 3, overdue: 2 });
});
