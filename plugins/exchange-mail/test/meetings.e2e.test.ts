// Meetings against the EWS stub (test/stub/ews_stub.py) through the system
// curl: an agent proposes, the person confirms in the system window (a
// stand-in that answers as told), and only then does Exchange change. Every
// way the confirmed version could differ from what is written is tried here.
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import type { MeetingInput } from "../contract";
import type { ConfirmOutcome, MeetingSummary, SendSummary } from "../src/host/confirm";
import { openFileSecretStore } from "../src/host/secret-store";
import { MailService } from "../src/host/service";

const STUB = process.env.EWS_STUB_URL;
if (!STUB) throw new Error("Set EWS_STUB_URL (test/stub/run.sh prints it)");
const EWS = `${STUB}/EWS/Exchange.asmx`;
const PASSWORD = 'S3cret pass "quoted" \\ ok';
const THREAD = "thr_meetings";

let dir: string;
let service: MailService;
let asked: (SendSummary | MeetingSummary)[];
let answer: () => Promise<ConfirmOutcome>;

type StubEvent = { id: string; subject: string; start: string; end: string; location: string; cancelled: boolean; response: string; kind: string; body: string; attendees: string[] };
async function state(): Promise<{
  requests: string[];
  meetingMail: { kind: string; subject: string; to: string[]; note?: string }[];
  availability: { emails: string[]; start: string; end: string }[];
  calendar: StubEvent[];
  masters: { id: string; subject: string; start: string; end: string }[];
}> {
  return (await fetch(`${STUB}/__state`)).json() as never;
}
const writes = async () => (await state()).requests.filter((op) => op === "CreateItem" || op === "UpdateItem" || op === "DeleteItem");

beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "exchange-mail-meetings-"));
});
afterAll(async () => {
  service?.close();
  await rm(dir, { recursive: true, force: true });
});
beforeEach(async () => {
  await fetch(`${STUB}/__reset`, { method: "POST" });
  service?.close();
  const data = await mkdtemp(join(dir, "case-"));
  asked = [];
  answer = async () => ({ ok: true });
  service = new MailService({
    dataDir: data,
    secrets: openFileSecretStore(join(data, "secrets")),
    utcOffsetMinutes: 180,
    allowLocalHttp: true,
    now: () => Date.UTC(2026, 9, 31, 9, 0),
    confirm: {
      confirm: (summary) => {
        asked.push(summary);
        return answer();
      },
    },
  });
  await service.saveConnection({ url: EWS, auth: "password", user: "STUB\\alice", password: PASSWORD });
});

/** The [id] calendar_events gives an event, found by its subject. */
async function eventIdOf(subject: string, from = "2026-11-02", to = "2026-11-20"): Promise<string> {
  const { text } = await service.tool({ tool: "events", from, to });
  const line = text.split("\n").find((l) => l.includes(` ${subject}`));
  const id = /\[(e[a-z0-9]{12})\]/.exec(line ?? "")?.[1];
  if (!id) throw new Error(`no [id] for ${subject} in:\n${text}`);
  return id;
}

async function propose(proposal: MeetingInput) {
  const out = await service.tool({ tool: "meeting", threadId: THREAD, proposal });
  if (out.isError) throw new Error(out.text);
  const view = await service.meeting(out.meetingId!, THREAD);
  return { out, view: view! };
}

describe("a new meeting", () => {
  it("is only a proposal until the person confirms, then exactly that meeting is created and the invitations go out", async () => {
    const { out, view } = await propose({
      action: "create",
      subject: "Roadmap review",
      start: "2026-11-10T13:00",
      end: "2026-11-10T14:00",
      location: "Room 4",
      body: "Let us agree on Q1.",
      required: ["Bob Builder <bob@example.test>", "carol@example.test"],
      optional: ["dave@example.test"],
    });
    expect(out.text).toMatch(/^Proposed a new meeting "Roadmap review", Tue 2026-11-10 13:00–14:00 \(UTC\+3\)\. 3 people get an invitation\./);
    expect(out.text).toContain(`::meeting-proposal{id="${out.meetingId}"}`);
    // The tool reads nothing and writes nothing.
    expect(await writes()).toEqual([]);
    expect(view).toMatchObject({ action: "create", source: "agent", threadId: THREAD, after: { start: "2026-11-10T10:00:00.000Z", end: "2026-11-10T11:00:00.000Z", location: "Room 4" } });
    expect(view.notify.map((a) => a.email)).toEqual(["bob@example.test", "carol@example.test", "dave@example.test"]);

    expect(await service.confirmMeeting(view.id, view.revision, undefined, { threadId: THREAD })).toMatchObject({ status: "done" });
    expect(asked).toHaveLength(1);
    expect(asked[0]).toMatchObject({ meeting: "create", subject: "Roadmap review", when: "Tue 2026-11-10 13:00–14:00 (UTC+3)", location: "Room 4", body: "Let us agree on Q1." });
    expect((asked[0] as MeetingSummary).notify.map((a) => a.email)).toEqual(["bob@example.test", "carol@example.test", "dave@example.test"]);
    const after = await state();
    const created = after.calendar.find((e) => e.subject === "Roadmap review")!;
    expect(created).toMatchObject({ start: "2026-11-10T10:00:00Z", end: "2026-11-10T11:00:00Z", location: "Room 4", body: "Let us agree on Q1." });
    expect(after.meetingMail).toEqual([{ kind: "invite", subject: "Roadmap review", to: ["bob@example.test", "carol@example.test", "dave@example.test"] }]);
    // Confirmed once: the proposal is gone.
    expect(await service.meeting(view.id)).toBeNull();
    expect(await service.confirmMeeting(view.id, view.revision)).toMatchObject({ status: "gone" });
  });

  it("writes nothing when the window is refused, and keeps the proposal", async () => {
    const { view } = await propose({ action: "create", subject: "Maybe", start: "2026-11-10T16:00", end: "2026-11-10T16:30", required: ["bob@example.test"] });
    answer = async () => ({ ok: false, reason: "cancelled", message: "no" });
    expect(await service.confirmMeeting(view.id, view.revision)).toMatchObject({ status: "cancelled", reason: "cancelled", message: expect.stringContaining("Nothing changed") });
    expect(await writes()).toEqual([]);
    expect(await service.meeting(view.id)).not.toBeNull();
  });

  it("does not confirm a version the person did not see: a replaced proposal has a new revision", async () => {
    const first = await propose({ action: "create", subject: "Sync", start: "2026-11-10T16:00", end: "2026-11-10T16:30", required: ["bob@example.test"] });
    const second = await propose({ action: "create", subject: "Sync", start: "2026-11-10T16:00", end: "2026-11-10T16:30", required: ["mallory@example.test"], replaces: first.view.id });
    expect(second.view.id).toBe(first.view.id);
    expect(second.out.text).toMatch(/^Replaced the proposal with/);
    expect(await service.confirmMeeting(first.view.id, first.view.revision)).toMatchObject({ status: "changed" });
    expect(asked).toHaveLength(0);
    expect(await writes()).toEqual([]);
  });

  it("is created once when two cards confirm it at the same time", async () => {
    const { view } = await propose({ action: "create", subject: "Once", start: "2026-11-10T16:00", end: "2026-11-10T16:30", required: ["bob@example.test"] });
    const results = await Promise.all([service.confirmMeeting(view.id, view.revision), service.confirmMeeting(view.id, view.revision)]);
    expect(results.map((r) => r.status).sort()).toEqual(["cancelled", "done"]);
    const after = await state();
    expect(after.calendar.filter((e) => e.subject === "Once")).toHaveLength(1);
    expect(after.meetingMail).toHaveLength(1);
    expect(await service.confirmMeeting(view.id, view.revision)).toMatchObject({ status: "gone" });
  });

  it("writes nothing when an agent replaces the proposal while the window is open, and keeps the replacement", async () => {
    const { view } = await propose({ action: "create", subject: "First", start: "2026-11-10T16:00", end: "2026-11-10T16:30", required: ["bob@example.test"] });
    answer = async () => {
      await propose({ action: "create", subject: "Second", start: "2026-11-10T16:00", end: "2026-11-10T16:30", required: ["mallory@example.test"], replaces: view.id });
      return { ok: true };
    };
    expect(await service.confirmMeeting(view.id, view.revision)).toMatchObject({ status: "changed" });
    expect(await writes()).toEqual([]);
    expect((await service.meeting(view.id))!.after!.subject).toBe("Second");
  });

  it("is shown only in its own thread", async () => {
    const { view } = await propose({ action: "create", subject: "Sync", start: "2026-11-10T16:00", end: "2026-11-10T16:30" });
    expect(await service.meeting(view.id, "thr_other")).toBeNull();
    expect(await service.confirmMeeting(view.id, view.revision, undefined, { threadId: "thr_other" })).toMatchObject({ status: "gone" });
    expect(await writes()).toEqual([]);
  });

  it("makes an appointment without attendees and sends nothing; one in the past is refused", async () => {
    const { view } = await propose({ action: "create", subject: "Focus", start: "2026-11-11T09:00", end: "2026-11-11T11:00" });
    expect(view.notify).toEqual([]);
    expect(await service.confirmMeeting(view.id, view.revision)).toMatchObject({ status: "done" });
    expect((await state()).meetingMail).toEqual([]);
    const late = await service.tool({ tool: "meeting", threadId: THREAD, proposal: { action: "create", subject: "Late", start: "2026-10-30T09:00", end: "2026-10-30T10:00" } });
    expect(late).toMatchObject({ isError: true, text: expect.stringContaining("already over") });
  });
});

describe("a meeting the user organizes", () => {
  it("moves, gains and loses people; the window shows what was, and each side gets its mail", async () => {
    const event = await eventIdOf("Release night");
    const { out, view } = await propose({ action: "update", event, start: "2026-11-06T20:00", add: ["dave@example.test"], remove: ["carol@example.test"] });
    expect(out.text).toContain("2 people get the update, 1 taken off get a cancellation");
    expect(view.removed.map((a) => a.email)).toEqual(["carol@example.test"]);
    expect(await writes()).toEqual([]);

    expect(await service.confirmMeeting(view.id, view.revision)).toMatchObject({ status: "done" });
    const summary = asked[0] as MeetingSummary;
    expect(summary).toMatchObject({ meeting: "update", when: "Fri 2026-11-06 20:00–23:00 (UTC+3)", before: { when: "Fri 2026-11-06 22:00–Sat 2026-11-07 01:00 (UTC+3)" }, body: null });
    expect(summary.added.map((a) => a.email)).toEqual(["dave@example.test"]);
    const after = await state();
    expect(after.calendar.find((e) => e.subject === "Release night")).toMatchObject({ start: "2026-11-06T17:00:00Z", end: "2026-11-06T20:00:00Z", attendees: ["bob@example.test", "dave@example.test"] });
    expect(after.meetingMail).toEqual([
      { kind: "update", subject: "Release night", to: ["bob@example.test", "dave@example.test"] },
      { kind: "cancel", subject: "Release night", to: ["carol@example.test"] },
    ]);
  });

  it("writes nothing when the meeting changed in Outlook after the proposal, before or while the window was open", async () => {
    const event = await eventIdOf("Release night");
    const { view } = await propose({ action: "update", event, subject: "Release night (moved)" });
    const target = (await state()).calendar.find((e) => e.subject === "Release night")!;
    await fetch(`${STUB}/__touch?id=${encodeURIComponent(target.id)}`, { method: "POST" });
    expect(await service.confirmMeeting(view.id, view.revision)).toMatchObject({ status: "changed", message: expect.stringContaining("changed in Outlook") });
    expect(asked).toHaveLength(0);

    const again = await propose({ action: "update", event, subject: "Release night (moved)" });
    answer = async () => {
      await fetch(`${STUB}/__touch?id=${encodeURIComponent(target.id)}`, { method: "POST" });
      return { ok: true };
    };
    expect(await service.confirmMeeting(again.view.id, again.view.revision)).toMatchObject({ status: "changed" });
    expect((await state()).requests).not.toContain("UpdateItem");
  });

  it("shows in the window a person moved from required to optional", async () => {
    const event = await eventIdOf("Release night");
    const proposal = await service.proposeMeeting({ action: "update", event, required: ["bob@example.test"], optional: ["carol@example.test"] }, "person", null);
    expect(proposal.removed).toEqual([]);
    expect(await service.confirmMeeting(proposal.id, proposal.revision)).toMatchObject({ status: "done" });
    expect((asked[0] as MeetingSummary).lists).toEqual({ required: [{ name: null, email: "bob@example.test" }], optional: [{ name: null, email: "carol@example.test" }] });
  });

  it("says nothing changes, and refuses taking off someone who is not on it", async () => {
    const event = await eventIdOf("Release night");
    expect(await service.tool({ tool: "meeting", threadId: THREAD, proposal: { action: "update", event, location: "Online" } })).toMatchObject({ isError: true, text: expect.stringContaining("Nothing changes") });
    expect(await service.tool({ tool: "meeting", threadId: THREAD, proposal: { action: "update", event, remove: ["nobody@example.test"] } })).toMatchObject({
      isError: true,
      text: expect.stringContaining("nobody@example.test is not on this meeting"),
    });
  });

  it("is cancelled with a note to everyone on it", async () => {
    const event = await eventIdOf("Release night");
    const { view } = await propose({ action: "cancel", event, note: "Moved to next week." });
    expect(await service.confirmMeeting(view.id, view.revision)).toMatchObject({ status: "done" });
    expect(asked[0]).toMatchObject({ meeting: "cancel", note: "Moved to next week." });
    const after = await state();
    expect(after.meetingMail).toEqual([{ kind: "cancel", subject: "Release night", to: ["bob@example.test", "carol@example.test"], note: "Moved to next week." }]);
    expect(after.calendar.find((e) => e.subject === "Release night")!.cancelled).toBe(true);
  });

  it("asks one occurrence or the series of a recurring meeting, moves the whole series on its day, and not to another day", async () => {
    const event = await eventIdOf("Team sync", "2026-11-12", "2026-11-12");
    expect(await service.tool({ tool: "meeting", threadId: THREAD, proposal: { action: "update", event, start: "2026-11-12T16:00" } })).toMatchObject({
      isError: true,
      text: expect.stringContaining('set scope to "occurrence"'),
    });
    expect(await service.tool({ tool: "meeting", threadId: THREAD, proposal: { action: "update", event, scope: "series", start: "2026-11-13T15:00" } })).toMatchObject({
      isError: true,
      text: expect.stringContaining("another day"),
    });
    const { view } = await propose({ action: "update", event, scope: "series", start: "2026-11-12T16:00" });
    expect(view.scope).toBe("series");
    expect(await service.confirmMeeting(view.id, view.revision)).toMatchObject({ status: "done" });
    expect(asked[0]).toMatchObject({ scope: "series", when: "Thu 2026-11-12 16:00–16:30 (UTC+3)" });
    const after = await state();
    expect(after.masters[0]).toMatchObject({ start: "2026-11-05T13:00:00Z", end: "2026-11-05T13:30:00Z" });
    expect(after.calendar.filter((e) => e.subject === "Team sync").map((e) => e.start)).toEqual(["2026-11-05T13:00:00Z", "2026-11-12T13:00:00Z", "2026-11-19T13:00:00Z"]);
  });

  it("moves one occurrence only", async () => {
    const event = await eventIdOf("Team sync", "2026-11-12", "2026-11-12");
    const { view } = await propose({ action: "update", event, scope: "occurrence", start: "2026-11-12T17:00" });
    expect(await service.confirmMeeting(view.id, view.revision)).toMatchObject({ status: "done" });
    const syncs = (await state()).calendar.filter((e) => e.subject === "Team sync");
    expect(syncs.map((e) => [e.start, e.kind])).toEqual([
      ["2026-11-05T12:00:00Z", "Occurrence"],
      ["2026-11-12T14:00:00Z", "Exception"],
      ["2026-11-19T12:00:00Z", "Occurrence"],
    ]);
  });
});

describe("someone else's invitation", () => {
  it("is answered with a note to the organizer; the user's own meeting and a change to another's are refused", async () => {
    const interview = await eventIdOf("Interview");
    const { out, view } = await propose({ action: "respond", event: interview, response: "accept", note: "I will be there." });
    expect(out.text).toContain("an answer to the invitation: accept");
    expect(view.notify.map((a) => a.email)).toEqual(["denis.orlov@example.test"]);
    expect(await service.confirmMeeting(view.id, view.revision)).toMatchObject({ status: "done" });
    expect(asked[0]).toMatchObject({ meeting: "respond", response: "accept", note: "I will be there." });
    const after = await state();
    expect(after.meetingMail).toEqual([{ kind: "accept", subject: "Interview", to: ["denis.orlov@example.test"], note: "I will be there." }]);
    expect(after.calendar.find((e) => e.subject === "Interview")!.response).toBe("Accept");

    const own = await eventIdOf("Release night");
    expect(await service.tool({ tool: "meeting", threadId: THREAD, proposal: { action: "respond", event: own, response: "decline" } })).toMatchObject({ isError: true, text: expect.stringContaining("organizes") });
    expect(await service.tool({ tool: "meeting", threadId: THREAD, proposal: { action: "cancel", event: interview } })).toMatchObject({ isError: true, text: expect.stringContaining("Someone else organizes") });
  });

  it("declines one occurrence of a series after the scope is named", async () => {
    const standUp = await eventIdOf("Daily stand-up", "2026-11-03", "2026-11-03");
    expect(await service.tool({ tool: "meeting", threadId: THREAD, proposal: { action: "respond", event: standUp, response: "decline" } })).toMatchObject({ isError: true });
    const { view } = await propose({ action: "respond", event: standUp, scope: "occurrence", response: "decline" });
    expect(await service.confirmMeeting(view.id, view.revision)).toMatchObject({ status: "done" });
    expect((await state()).meetingMail).toEqual([{ kind: "decline", subject: "Daily stand-up", to: [expect.stringContaining("/o=ExampleOrg")], note: "" }]);
  });
});

describe("private events", () => {
  it("come to agents without an id, and agents cannot target them by the panel's id", async () => {
    const { text } = await service.tool({ tool: "events", from: "2026-11-03", to: "2026-11-03" });
    expect(text).toMatch(/- 13:00–14:00 \(private, busy\)/);
    const doctor = (await service.calendar("2026-11-02T21:00:00Z", "2026-11-03T21:00:00Z")).events.find((e) => e.private)!;
    expect(await service.tool({ tool: "meeting", threadId: THREAD, proposal: { action: "cancel", event: doctor.id } })).toMatchObject({ isError: true, text: expect.stringContaining("private") });
    // The person may: the panel proposes as the person.
    const mine = await service.proposeMeeting({ action: "cancel", event: doctor.id }, "person", null);
    expect(mine).toMatchObject({ action: "cancel", notify: [] });
    expect(await service.confirmMeeting(mine.id, mine.revision)).toMatchObject({ status: "done" });
    expect((await state()).requests).toContain("DeleteItem");
  });
});

describe("finding a time with other people", () => {
  it("joins the user's calendar with the others' free/busy and says whose is not known", async () => {
    const { text, isError } = await service.tool({ tool: "findTime", attendees: ["bob@example.test", "Кэрол <carol@example.test>", "ghost@nowhere.test"], from: "2026-11-10", to: "2026-11-10", minutes: 60 });
    expect(isError).toBe(false);
    expect(text).toContain("Tue 2026-11-10: 09:00–10:00, 13:00–14:00, 15:00–18:00");
    expect(text).toContain("No free/busy for ghost@nowhere.test");
    const asked = (await state()).availability[0]!;
    expect(asked).toEqual({ emails: ["bob@example.test", "carol@example.test", "ghost@nowhere.test"], start: "2026-11-09T21:00:00Z", end: "2026-11-10T21:00:00Z" });
    expect(await writes()).toEqual([]);
  });
});
