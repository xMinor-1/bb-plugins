// @vitest-environment jsdom
//
// The Calendar page: a week from Monday in the browser's time zone, every
// occurrence on its day, what changed marked, and the week switched.
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import type { CalendarEvent } from "../contract";
import type { rpcContract } from "../server";

await loadPluginApp(() => import("../app"));
const { CalendarWeek, eventsOfDay, weekStart } = await import("../src/app/CalendarWeek");
const { useRpc } = await import("@get-bb/plugin-sdk/app");
const { setLang } = await import("../lib/i18n");

afterEach(() => {
  cleanup();
  act(() => setLang(null));
});

// Local times, so the test reads the same in any time zone.
const local = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).toISOString();
const NOW = new Date(2026, 10, 4, 12, 0);

function event(patch: Partial<CalendarEvent> & { subject: string; start: string; end: string }): CalendarEvent {
  return { id: `e${patch.subject.toLowerCase().replace(/[^a-z]/g, "").padEnd(12, "x").slice(0, 12)}`, allDay: false, location: null, organizer: null, attendees: "", myResponse: "accepted", showAs: "busy", kind: "single", cancelled: false, private: false, ...patch };
}

const EVENTS = [
  event({ subject: "Stand-up", start: local(2, 10), end: local(2, 10, 15), kind: "occurrence", location: "Room 2", organizer: { name: "Bob Builder", email: "" }, attendees: "Alice; Bob" }),
  event({ subject: "Stand-up moved", start: local(4, 11), end: local(4, 11, 15), kind: "exception" }),
  event({ subject: "Vendor call", start: local(4, 16), end: local(4, 16, 30), cancelled: true }),
  event({ subject: "Birthday", start: local(5, 0), end: local(6, 0), allDay: true, showAs: "free" }),
  event({ subject: "Interview", start: local(5, 12), end: local(5, 13), myResponse: "none", showAs: "tentative" }),
  event({ subject: "All-hands", start: local(5, 17), end: local(5, 18), myResponse: "declined" }),
  event({ subject: "Doctor", start: local(3, 13), end: local(3, 14), private: true }),
  event({ subject: "Release", start: local(6, 22), end: local(7, 1) }),
];

function renderWeek(answer: (input: { start: string; end: string }) => { events: CalendarEvent[]; more: boolean } | Promise<never> = () => ({ events: EVENTS, more: false })) {
  const asked: { hostId: string; start: string; end: string }[] = [];
  const handlers = {
    calendar: (input: { hostId: string; start: string; end: string }) => {
      asked.push(input);
      return answer(input);
    },
  } as unknown as PluginRpcTestHandlers<typeof rpcContract>;
  function Harness() {
    return <CalendarWeek rpc={useRpc<typeof rpcContract>()} hostId="host_1" now={() => NOW} />;
  }
  renderSlot({ component: Harness }, {}, { rpc: handlers });
  return asked;
}

const day = (label: RegExp) => screen.getByRole("heading", { name: label }).closest("li") as HTMLElement;

describe("the week", () => {
  it("starts on Monday at local midnight", () => {
    expect(weekStart(new Date(2026, 10, 4, 12)).getTime()).toBe(new Date(2026, 10, 2).getTime());
    expect(weekStart(new Date(2026, 10, 8, 23, 59)).getTime()).toBe(new Date(2026, 10, 2).getTime());
    expect(weekStart(new Date(2026, 10, 9, 0, 0)).getTime()).toBe(new Date(2026, 10, 9).getTime());
  });

  it("puts an event on every day it touches, all-day ones first", () => {
    const thursday = eventsOfDay(EVENTS, new Date(2026, 10, 5));
    expect(thursday.map((e) => e.subject)).toEqual(["Birthday", "Interview", "All-hands"]);
    expect(eventsOfDay(EVENTS, new Date(2026, 10, 7)).map((e) => e.subject)).toEqual(["Release"]);
    expect(eventsOfDay(EVENTS, new Date(2026, 10, 6)).map((e) => e.subject)).toEqual(["Release"]);
  });

  it("keeps an all-day event on its own dates when the mailbox's time zone is not the browser's", () => {
    const days = (e: CalendarEvent) => [2, 3, 4, 5, 6, 7, 8].filter((d) => eventsOfDay([e], new Date(2026, 10, d)).length > 0);
    // The mailbox three hours west of the browser: its midnight is 03:00 here.
    expect(days(event({ subject: "West", start: local(5, 3), end: local(6, 3), allDay: true }))).toEqual([5]);
    // Three hours east: 21:00 the evening before.
    expect(days(event({ subject: "East", start: local(4, 21), end: local(5, 21), allDay: true }))).toEqual([5]);
    expect(days(event({ subject: "Two days", start: local(5, 2), end: local(7, 2), allDay: true }))).toEqual([5, 6]);
    // A meeting with times keeps every day it takes.
    expect(days(event({ subject: "Night", start: local(5, 21), end: local(6, 3) }))).toEqual([5, 6]);
  });

  it("asks for this week and shows each day with its events and what changed", async () => {
    const asked = renderWeek();
    await screen.findByText("Vendor call");
    expect(asked).toEqual([{ hostId: "host_1", start: new Date(2026, 10, 2).toISOString(), end: new Date(2026, 10, 9).toISOString() }]);
    expect(screen.getByText("8 events")).toBeTruthy();
    const wednesday = day(/Wed/);
    expect(wednesday.getAttribute("aria-current")).toBe("date");
    expect(within(wednesday).getByText("recurring, moved")).toBeTruthy();
    expect(within(wednesday).getByText("Vendor call").className).toContain("line-through");
    expect(within(wednesday).getByText("cancelled")).toBeTruthy();
    const thursday = day(/Thu/);
    expect(within(thursday).getByText("all day")).toBeTruthy();
    expect(within(thursday).getByText("free")).toBeTruthy();
    expect(within(thursday).getByText("tentative, not answered")).toBeTruthy();
    expect(within(thursday).getByText("you declined")).toBeTruthy();
    expect(within(day(/Tue/)).getByText("private")).toBeTruthy();
    expect(within(day(/Sat/)).getByText("Release")).toBeTruthy();
    expect(within(day(/Sun/)).getByText("Nothing planned")).toBeTruthy();
  });

  it("shows who organizes and who is invited on a click", async () => {
    renderWeek();
    const card = (await screen.findByText("Stand-up")).closest("button")!;
    expect(screen.queryByText("Organizer")).toBeNull();
    fireEvent.click(card);
    expect(card.getAttribute("aria-expanded")).toBe("true");
    expect(screen.getByText("Bob Builder")).toBeTruthy();
    expect(screen.getByText("Alice; Bob")).toBeTruthy();
  });

  it("goes to the next and previous weeks and back to today", async () => {
    const asked = renderWeek();
    await screen.findByText("Vendor call");
    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    await waitFor(() => expect(asked).toHaveLength(2));
    expect(asked[1]!.start).toBe(new Date(2026, 10, 9).toISOString());
    fireEvent.click(screen.getByRole("button", { name: "Previous week" }));
    fireEvent.click(screen.getByRole("button", { name: "Previous week" }));
    await waitFor(() => expect(asked.at(-1)!.start).toBe(new Date(2026, 9, 26).toISOString()));
    fireEvent.click(screen.getByRole("button", { name: "Today" }));
    await waitFor(() => expect(asked.at(-1)!.start).toBe(new Date(2026, 10, 2).toISOString()));
  });

  it("shows only the week asked last, however late the answers come", async () => {
    const pending: { start: string; resolve: (value: { events: CalendarEvent[]; more: boolean }) => void }[] = [];
    renderWeek((input) => new Promise((resolve) => pending.push({ start: input.start, resolve })) as never);
    await waitFor(() => expect(pending).toHaveLength(1));
    fireEvent.click(screen.getByRole("button", { name: "Refresh" }));
    fireEvent.click(screen.getByRole("button", { name: "Next week" }));
    await waitFor(() => expect(pending).toHaveLength(3));
    await act(async () => pending[2]!.resolve({ events: [event({ subject: "Next Monday", start: local(9, 9), end: local(9, 10) })], more: false }));
    await act(async () => pending[1]!.resolve({ events: EVENTS, more: true }));
    await act(async () => pending[0]!.resolve({ events: EVENTS, more: false }));
    expect(screen.getByText("Next Monday")).toBeTruthy();
    expect(screen.queryByText("Vendor call")).toBeNull();
    expect(screen.queryByText(/more events than shown/)).toBeNull();
  });

  it("says when the week has more than it shows, and shows a failure", async () => {
    renderWeek(() => ({ events: EVENTS.slice(0, 1), more: true }));
    expect(await screen.findByText(/This week has more events than shown here/)).toBeTruthy();
    cleanup();
    renderWeek(() => Promise.reject(new Error("[mail:unreachable] Exchange did not answer.")));
    expect(await screen.findByText(/did not answer|not reachable|could not reach/i)).toBeTruthy();
  });

  it("speaks Russian", async () => {
    act(() => setLang("ru"));
    renderWeek();
    await screen.findByText("Vendor call");
    expect(screen.getByText("8 событий")).toBeTruthy();
    expect(screen.getByText("повторяется, перенесена")).toBeTruthy();
    expect(screen.getByText("вы отказались")).toBeTruthy();
    expect(screen.getByRole("button", { name: "Следующая неделя" })).toBeTruthy();
    expect(screen.getByText(/Только просмотр/)).toBeTruthy();
  });
});
