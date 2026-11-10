// Other people's calendars and the plugin's time zone, without Exchange: the
// requests, the text agents get, and what the server passes to the host.
import { createFakePluginHost, makeMessageDispatchHookContext, makeThreadResponse } from "@get-bb/plugin-sdk/testing";
import { describe, expect, it } from "vitest";
import type { CalendarEvent } from "../contract";
import { toolInputSchema, hostContract } from "../contract";
import { busyKind, fixedOffset, formatAvailability, formatEvents, freeStretches, parseWhen, zoneLabel, zoneOffset, type PersonBusy } from "../src/host/calendar";
import { calendarView } from "../src/host/ews/soap";
import { DEFAULT_TIME_ZONE, fromWallTime, isTimeZone, offsetIn, offsetLabel, wallTime, zoneOfSetting } from "../src/shared/zone";
import { addDays, startOfDay } from "../src/app/time-zone";
import { weekStart } from "../src/app/CalendarWeek";
import { dateInput, timeInput, zonedIso } from "../src/app/MeetingForm";
import plugin from "../server";

const MOSCOW = zoneOffset("Europe/Moscow");

function event(patch: Partial<CalendarEvent> & { start: string; end: string }): CalendarEvent {
  return {
    id: "e000000000001",
    subject: "Meeting",
    allDay: false,
    location: null,
    organizer: null,
    attendees: "",
    myResponse: "accepted",
    showAs: "busy",
    kind: "single",
    cancelled: false,
    private: false,
    ...patch,
  };
}

describe("time zones", () => {
  it("knows IANA names and reads the setting: a name, or the computer's own zone", () => {
    expect(DEFAULT_TIME_ZONE).toBe("Europe/Moscow");
    expect(isTimeZone("Europe/Moscow")).toBe(true);
    expect(isTimeZone("Asia/Yekaterinburg")).toBe(true);
    expect(isTimeZone("Mars/Olympus")).toBe(false);
    expect(isTimeZone("")).toBe(false);
    expect(zoneOfSetting(" Europe/Berlin ")).toBe("Europe/Berlin");
    expect(zoneOfSetting("system")).toBeNull();
    expect(zoneOfSetting("")).toBeNull();
    expect(() => zoneOfSetting("UTC+3 please")).toThrow(/not a time zone/);
  });

  it("gives Moscow UTC+3 all year and Berlin its summer and winter time", () => {
    expect(offsetIn("Europe/Moscow", Date.UTC(2026, 0, 15, 12))).toBe(180);
    expect(offsetIn("Europe/Moscow", Date.UTC(2026, 6, 15, 12))).toBe(180);
    expect(offsetIn("Europe/Berlin", Date.UTC(2026, 0, 15, 12))).toBe(60);
    expect(offsetIn("Europe/Berlin", Date.UTC(2026, 6, 15, 12))).toBe(120);
    expect(offsetIn("Asia/Kolkata", Date.UTC(2026, 6, 15, 12, 0, 30))).toBe(330);
    expect(offsetLabel("Asia/Kolkata", 0)).toBe("UTC+5:30");
    expect(offsetLabel("America/Sao_Paulo", Date.UTC(2026, 6, 1))).toBe("UTC-3");
  });

  it("turns a wall-clock time into a moment and back, across a change of the clocks", () => {
    expect(new Date(fromWallTime(2026, 11, 12, 14, 0, "Europe/Moscow")).toISOString()).toBe("2026-11-12T11:00:00.000Z");
    // Berlin goes back an hour at 03:00 on 25 October 2026.
    expect(new Date(fromWallTime(2026, 10, 25, 0, 0, "Europe/Berlin")).toISOString()).toBe("2026-10-24T22:00:00.000Z");
    expect(new Date(fromWallTime(2026, 10, 25, 12, 0, "Europe/Berlin")).toISOString()).toBe("2026-10-25T11:00:00.000Z");
    expect(wallTime(Date.parse("2026-11-12T21:30:00Z"), "Europe/Moscow")).toMatchObject({ year: 2026, month: 11, day: 13, hour: 0, minute: 30, weekday: 5 });
  });

  it("reads agents' local times in Moscow and says the zone by name", () => {
    expect(new Date(parseWhen("2026-11-12T14:00", MOSCOW)).toISOString()).toBe("2026-11-12T11:00:00.000Z");
    expect(new Date(parseWhen("2026-11-12", MOSCOW)).toISOString()).toBe("2026-11-11T21:00:00.000Z");
    expect(zoneLabel(Date.UTC(2026, 10, 12), MOSCOW)).toBe("Europe/Moscow, UTC+3");
    expect(zoneLabel(Date.UTC(2026, 10, 12), fixedOffset(180))).toBe("UTC+3");
  });

  it("lays the panel's week out in the zone, not the browser's", () => {
    const zone = "Europe/Moscow";
    // 22:30 UTC on Sunday 8 November is already Monday 9 November in Moscow.
    const monday = weekStart(new Date(Date.UTC(2026, 10, 8, 22, 30)), zone);
    expect(monday.toISOString()).toBe("2026-11-08T21:00:00.000Z");
    expect(addDays(monday, 7, zone).toISOString()).toBe("2026-11-15T21:00:00.000Z");
    expect(startOfDay(Date.UTC(2026, 10, 12, 20, 59), zone).toISOString()).toBe("2026-11-11T21:00:00.000Z");
    const at = new Date("2026-11-12T11:00:00Z");
    expect(dateInput(at, zone)).toBe("2026-11-12");
    expect(timeInput(at, zone)).toBe("14:00");
    expect(zonedIso("2026-11-12", "14:00", zone)).toBe("2026-11-12T11:00:00.000Z");
    expect(zonedIso("2026-11-12", "14:00", "Asia/Yekaterinburg")).toBe("2026-11-12T09:00:00.000Z");
    expect(zonedIso("2026-02-30", "14:00", zone)).toBeNull();
    expect(zonedIso("2026-11-12", "", zone)).toBeNull();
  });
});

describe("another person's calendar", () => {
  it("is read through the calendar folder of their mailbox, with a CalendarView", () => {
    const body = calendarView({ start: "2026-11-11T21:00:00.000Z", end: "2026-11-12T21:00:00.000Z", max: 500, mailbox: "ivanov@example.test" });
    expect(body).toContain(
      '<m:ParentFolderIds><t:DistinguishedFolderId Id="calendar"><t:Mailbox><t:EmailAddress>ivanov@example.test</t:EmailAddress></t:Mailbox></t:DistinguishedFolderId></m:ParentFolderIds>',
    );
    expect(calendarView({ start: "a", end: "b", max: 1, mailbox: 'x"<y@example.test' })).toContain("x&quot;&lt;y@example.test");
    expect(calendarView({ start: "a", end: "b", max: 1 })).toContain('<m:ParentFolderIds><t:DistinguishedFolderId Id="calendar"/></m:ParentFolderIds>');
  });

  it("comes to agents without [id]s and says it is read only", () => {
    const events = [
      event({ start: "2026-11-12T07:00:00.000Z", end: "2026-11-12T08:00:00.000Z", subject: "Contract review", location: "Room 5", myResponse: "organizer" }),
      event({ id: "e000000000002", start: "2026-11-12T10:00:00.000Z", end: "2026-11-12T11:00:00.000Z", subject: "Lunch with a client", private: true }),
    ];
    const range = { start: Date.parse("2026-11-11T21:00:00Z"), end: Date.parse("2026-11-12T21:00:00Z") };
    const text = formatEvents(events, range, false, MOSCOW, { kind: "other", email: "ivanov@example.test" });
    expect(text).toContain("Calendar of ivanov@example.test from Thu 2026-11-12 00:00 to Fri 2026-11-13 00:00 (times Europe/Moscow, UTC+3): 2 events.");
    expect(text).toContain("Read only");
    expect(text).toContain("- 10:00–11:00 Contract review — Room 5 (they organize it)");
    expect(text).toContain("- 13:00–14:00 (private, busy)");
    expect(text).not.toContain("Lunch");
    expect(text).not.toMatch(/\[e[a-z0-9]{12}\]/);
    expect(text).not.toContain("calendar_propose");
    expect(formatEvents([], range, false, MOSCOW, { kind: "other", email: "ivanov@example.test" })).toMatch(/^The calendar of ivanov@example.test has nothing/);
  });

  it("keeps [id]s on the user's own calendar", () => {
    const range = { start: Date.parse("2026-11-11T21:00:00Z"), end: Date.parse("2026-11-12T21:00:00Z") };
    expect(formatEvents([event({ start: "2026-11-12T07:00:00.000Z", end: "2026-11-12T08:00:00.000Z" })], range, false, MOSCOW)).toContain("[e000000000001] 10:00–11:00");
  });
});

describe("other people's free/busy", () => {
  const range = { start: Date.parse("2026-11-11T21:00:00Z"), end: Date.parse("2026-11-12T21:00:00Z") };
  const options = { dayStart: 9 * 60, dayEnd: 18 * 60, minMinutes: 30, weekends: false, offset: MOSCOW };
  const people: PersonBusy[] = [
    { email: "ivanov@example.test", known: true, why: null, busy: [{ start: Date.parse("2026-11-12T07:00:00Z"), end: Date.parse("2026-11-12T09:00:00Z"), kind: "busy" }] },
    { email: "petrova@example.test", known: true, why: null, busy: [{ start: Date.parse("2026-11-12T11:00:00Z"), end: Date.parse("2026-11-12T12:00:00Z"), kind: "tentative" }] },
    { email: "nobody@example.test", known: false, why: "No mailbox with such guid.", busy: [] },
  ];

  it("lists each person's busy times and the hours all known ones are free, in Moscow", () => {
    const days = freeStretches(people.flatMap((p) => p.busy), range, options);
    const text = formatAvailability(days, range, options, people);
    expect(text).toContain("Free/busy of 3 people from Thu 2026-11-12 00:00 to Fri 2026-11-13 00:00 (times Europe/Moscow, UTC+3).");
    expect(text).toContain("The user's own calendar is not included");
    expect(text).toContain("ivanov@example.test:\n  Thu 2026-11-12\n  - 10:00–12:00 busy");
    expect(text).toContain("petrova@example.test:\n  Thu 2026-11-12\n  - 14:00–15:00 tentative");
    expect(text).toContain("nobody@example.test: free/busy not known (No mailbox with such guid.)");
    expect(text).toContain("Working hours 09:00–18:00 when all 2 are free, at least 30 min, weekdays only:\nThu 2026-11-12: 09:00–10:00, 12:00–14:00, 15:00–18:00");
    expect(text).toContain("These times ignore the person whose free/busy is not known.");
  });

  it("counts busy, tentative, away and elsewhere; not free or no data", () => {
    expect(["Busy", "Tentative", "OOF", "WorkingElsewhere", "Free", "NoData"].map(busyKind)).toEqual(["busy", "tentative", "away", "working elsewhere", null, null]);
  });

  it("says when nobody's free/busy is known, without common times", () => {
    const text = formatAvailability([], range, options, [people[2]!]);
    expect(text).not.toContain("Working hours");
  });
});

describe("the tools and the time zone setting", () => {
  const ALLOWED = { providerId: "acp-opencode", model: "corp/large" };

  async function setup(timeZone?: string) {
    const hostCalls: { method: string; input: unknown }[] = [];
    const { bb, harness } = createFakePluginHost({
      pluginId: "exchange-mail",
      settings: { allowedModels: "acp-opencode corp/*", ewsUrl: "", calendarPlugins: "", ...(timeZone === undefined ? {} : { timeZone }) },
      agentSkillIds: ["exchange-mail"],
      experimental_hostEntry: true,
      sdk: {
        threads: { get: async ({ threadId }: { threadId: string }) => makeThreadResponse({ id: threadId, environmentId: "env_mac", providerId: "acp-opencode", sourceThreadId: null }) },
        environments: { get: async () => ({ id: "env_mac", hostId: "host_mac" }) },
        hosts: { list: async () => [{ id: "host_mac", name: "Mac", status: "connected", lifecycle: { phase: "ready" } }] },
        system: { config: async () => ({ primaryHostId: "host_mac" }) },
      } as never,
      experimental_callHostRpc: async ({ method, input }) => {
        hostCalls.push({ method, input });
        if (method === "tool") return { text: "DATA", isError: false, draftId: null };
        if (method === "meeting") return null;
        if (method === "confirmMeeting") return { status: "done", at: 1 };
        return {};
      },
    });
    await plugin(bb);
    await harness.registrations.hooks["message.dispatch"]!(makeMessageDispatchHookContext({ thread: { id: "th_ok", sourceThreadId: null }, requestedExecution: ALLOWED }));
    const tool = (name: string, params: unknown) => harness.behavior.callAgentTool(name, params, { threadId: "th_ok" });
    return { bb, harness, hostCalls, tool };
  }

  it("send other people's free/busy and calendars to the host, read only, in Moscow by default", async () => {
    const s = await setup();
    await s.tool("calendar_availability", { people: ["Ivanov <ivanov@example.test>", "petrova@example.test"], from: "2026-11-12" });
    await s.tool("calendar_other_events", { person: "ivanov@example.test", from: "2026-11-11" });
    expect(s.hostCalls).toEqual([
      { method: "tool", input: { call: { tool: "availability", people: ["Ivanov <ivanov@example.test>", "petrova@example.test"], from: "2026-11-12" }, timeZone: "Europe/Moscow" } },
      { method: "tool", input: { call: { tool: "otherEvents", mailbox: "ivanov@example.test", from: "2026-11-11" }, timeZone: "Europe/Moscow" } },
    ]);
    for (const call of s.hostCalls) expect(hostContract.tool.input.safeParse(call.input).success).toBe(true);
  });

  it("have no way to write: neither tool takes an event or a change", () => {
    expect(toolInputSchema.safeParse({ tool: "otherEvents", mailbox: "ivanov@example.test", event: "e000000000001" }).success).toBe(false);
    expect(toolInputSchema.safeParse({ tool: "availability", people: ["ivanov@example.test"], subject: "x" }).success).toBe(false);
  });

  it("use the zone in the settings, or none for the computer's own", async () => {
    const yekaterinburg = await setup("Asia/Yekaterinburg");
    await yekaterinburg.tool("calendar_events", {});
    expect(yekaterinburg.hostCalls[0]!.input).toEqual({ call: { tool: "events" }, timeZone: "Asia/Yekaterinburg" });
    const system = await setup("system");
    await system.tool("calendar_events", {});
    expect(system.hostCalls[0]!.input).toEqual({ call: { tool: "events" } });
  });

  it("follow a change of the setting and give the zone to the panel", async () => {
    const s = await setup();
    expect(await s.harness.callRpc("machines", null)).toMatchObject({ timeZone: "Europe/Moscow" });
    await s.harness.behavior.setSettings({ timeZone: "Europe/Berlin" });
    expect(await s.harness.callRpc("machines", null)).toMatchObject({ timeZone: "Europe/Berlin" });
    await s.tool("calendar_free_time", {});
    expect(s.hostCalls.at(-1)!.input).toMatchObject({ timeZone: "Europe/Berlin" });
    // A meeting card in a thread gets the zone with the proposal, and the confirmation window is in it.
    expect(await s.harness.callRpc("meeting", { threadId: "th_ok", id: "p_000000000001" })).toMatchObject({ timeZone: "Europe/Berlin" });
    await s.harness.callRpc("confirmMeeting", { threadId: "th_ok", id: "p_000000000001", revision: "R1" });
    expect(s.hostCalls.at(-1)).toMatchObject({ method: "confirmMeeting", input: { timeZone: "Europe/Berlin" } });
    // The stand-in host's answer is no real proposal; only what was asked matters here.
    await s.harness.callRpc("proposeMeeting", { hostId: "host_mac", proposal: { action: "cancel", event: "e000000000001" } }).catch(() => undefined);
    expect(s.hostCalls.at(-1)).toMatchObject({ method: "proposeMeeting", input: { timeZone: "Europe/Berlin" } });
  });
});

describe("the free/busy request", () => {
  it("describes UTC with standard and daylight time on different dates: Exchange refuses the same date twice", async () => {
    const { getUserAvailability } = await import("../src/host/ews/soap");
    const body = getUserAvailability({ emails: ["ivanov@example.test"], start: "2026-11-11T21:00:00.000Z", end: "2026-11-12T21:00:00.000Z" });
    const rule = (tag: string) => new RegExp(`<t:${tag}>(.*?)</t:${tag}>`).exec(body)?.[1];
    expect(rule("StandardTime")).toBeTruthy();
    expect(rule("DaylightTime")).toBeTruthy();
    expect(rule("StandardTime")).not.toBe(rule("DaylightTime"));
    expect(body).toMatch(/^[\s\S]*<t:TimeZone><t:Bias>0<\/t:Bias>/);
    expect(body.match(/<t:Bias>0<\/t:Bias>/g)).toHaveLength(3);
  });
});
