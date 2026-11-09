// @vitest-environment jsdom
//
// The meeting card in a thread and the meeting form in the calendar. The card
// confirms exactly the revision it shows; a different version arriving while
// the dialog is open closes it with a note. The form only prepares a
// proposal: the card it hands back is where the person confirms.
import { act, cleanup, fireEvent, screen, waitFor, within } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import type { PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";
import type { CalendarEvent, MeetingProposal } from "../contract";
import type { rpcContract } from "../server";

const app = await loadPluginApp(() => import("../app"));
const { CalendarWeek } = await import("../src/app/CalendarWeek");
const { useRpc } = await import("@get-bb/plugin-sdk/app");
const { meetingTexts } = await import("../src/app/meeting-messages");
const { setLang } = await import("../lib/i18n");
const directive = app.messageDirectives.find((entry) => entry.id === "meeting-proposal")!;
const t = meetingTexts.en;

afterEach(() => {
  cleanup();
  act(() => setLang(null));
});

const ID = "p_0123456789ab";
const local = (day: number, hour: number, minute = 0) => new Date(2026, 10, day, hour, minute).toISOString();
const bob = { name: "Bob Builder", email: "bob@example.test" };
const carol = { name: null, email: "carol@example.test" };

function proposal(revision: string, patch: Partial<MeetingProposal> = {}): MeetingProposal {
  const before = { subject: "Release night", start: local(6, 22), end: local(7, 1), location: "Online", required: [bob, carol], optional: [], rooms: [] };
  return {
    id: ID,
    action: "update",
    source: "agent",
    threadId: "thr_1",
    createdAt: 1,
    scope: "single",
    eventId: "e000000000001",
    before,
    after: { ...before, start: local(6, 20), end: local(6, 23), required: [bob, { name: "Dave", email: "dave@example.test" }] },
    body: null,
    organizer: null,
    response: null,
    note: null,
    notify: [bob, { name: "Dave", email: "dave@example.test" }],
    removed: [carol],
    revision,
    ...patch,
  };
}

const props = { attributes: { id: ID }, source: `::meeting-proposal{id="${ID}"}`, message: { id: "m_1", threadId: "thr_1", turnId: null, projectId: null }, openWorkspaceFile: null } satisfies PluginMessageDirectiveProps;
const dialog = () => screen.queryByRole("dialog");

function card(answers: { meeting: () => MeetingProposal | null; confirm?: (input: { id: string; revision: string; threadId?: string; lang?: string }) => unknown }) {
  const confirmed: { id: string; revision: string; threadId?: string; lang?: string }[] = [];
  const handlers = {
    meeting: () => ({ proposal: answers.meeting(), hostId: "host_1" }),
    confirmMeeting: (input: { id: string; revision: string; threadId?: string; lang?: string }) => {
      confirmed.push(input);
      return answers.confirm ? answers.confirm(input) : { status: "done", at: Date.UTC(2026, 10, 1, 10) };
    },
  } as unknown as PluginRpcTestHandlers<typeof rpcContract>;
  const slot = renderSlot(directive, props, { rpc: handlers });
  return { slot, confirmed };
}

describe("the meeting card in a thread", () => {
  it("shows what changes and who gets mail, and confirms the revision it shows, for this thread", async () => {
    const { confirmed } = card({ meeting: () => proposal("R1") });
    await screen.findByText(`${t.kind("update")} — ${t.notDone}`);
    expect(screen.getByText(/Dave <dave@example.test>$/, { selector: "span" })).toBeTruthy();
    expect(screen.getByText(`carol@example.test (${t.removedHint})`)).toBeTruthy();
    expect(screen.getByText(`2 people: Bob Builder <bob@example.test>, Dave <dave@example.test>`)).toBeTruthy();
    // What the time was, struck through.
    expect(document.querySelector(".line-through")).not.toBeNull();
    fireEvent.click(screen.getByRole("button", { name: t.confirm }));
    const open = await screen.findByRole("dialog");
    expect(within(open).getByText(t.confirmTitle("update"))).toBeTruthy();
    fireEvent.click(within(open).getByRole("button", { name: t.continue }));
    await screen.findByText(/^The meeting is changed/);
    expect(confirmed).toEqual([{ threadId: "thr_1", id: ID, revision: "R1", lang: "en" }]);
  });

  it("closes the dialog with a note when another version arrives while it is open, and does not confirm it", async () => {
    let current = proposal("R1");
    const { slot, confirmed } = card({ meeting: () => current });
    await screen.findByText(`${t.kind("update")} — ${t.notDone}`);
    fireEvent.click(screen.getByRole("button", { name: t.confirm }));
    await waitFor(() => expect(dialog()).not.toBeNull());
    current = proposal("R2", { notify: [{ name: "Mallory", email: "mallory@example.test" }] });
    await slot.behavior.emitRealtime("meetings-changed", { id: ID });
    await waitFor(() => expect(dialog()).toBeNull());
    expect(screen.getByText(t.changedWhileConfirming)).toBeTruthy();
    expect(screen.getByText(/mallory@example.test/)).toBeTruthy();
    expect(confirmed).toEqual([]);
  });

  it("says nothing changed when the window was refused, in Russian too", async () => {
    act(() => setLang("ru"));
    card({ meeting: () => proposal("R1", { action: "cancel", after: null, removed: [], note: "Перенесём" }), confirm: () => ({ status: "cancelled", reason: "cancelled", message: "x" }) });
    await screen.findByText(`${meetingTexts.ru.kind("cancel")} — ${meetingTexts.ru.notDone}`);
    fireEvent.click(screen.getByRole("button", { name: meetingTexts.ru.confirm }));
    fireEvent.click(within(await screen.findByRole("dialog")).getByRole("button", { name: meetingTexts.ru.continue }));
    expect(await screen.findByText(meetingTexts.ru.cancelled)).toBeTruthy();
  });

  it("refuses an id that is not a proposal's", async () => {
    renderSlot(directive, { ...props, attributes: { id: "../../etc" } }, { rpc: {} as never });
    expect(screen.getByText(t.brokenLink)).toBeTruthy();
  });
});

const NOW = new Date(2026, 10, 4, 12, 0);
function ev(patch: Partial<CalendarEvent> & { subject: string; start: string; end: string }): CalendarEvent {
  return { id: "e000000000001", allDay: false, location: null, organizer: null, attendees: "", myResponse: "accepted", showAs: "busy", kind: "single", cancelled: false, private: false, ...patch };
}

describe("the calendar's meeting actions", () => {
  function week(events: CalendarEvent[]) {
    const proposed: unknown[] = [];
    const handlers = {
      calendar: () => ({ events, more: false }),
      proposeMeeting: (input: { proposal: unknown }) => {
        proposed.push(input);
        return proposal("R1", { id: ID, action: "create", source: "person", threadId: null, before: null, removed: [] });
      },
      meeting: () => ({ proposal: proposal("R1", { action: "create", source: "person", threadId: null, before: null, removed: [] }), hostId: "host_1" }),
      findPeople: () => ({ people: [], more: false }),
      meetingDetails: ({ eventId }: { eventId: string }) => ({
        eventId, subject: "Mine", start: local(4, 10), end: local(4, 11), location: null, required: [bob, { name: "Old Colleague", email: "" }], optional: [], rooms: [],
        body: "Hi", organizer: null, isOrganizer: true, myResponse: "organizer", kind: "single", isMeeting: true, cancelled: false, private: false,
      }),
    } as unknown as PluginRpcTestHandlers<typeof rpcContract>;
    function Harness() {
      return <CalendarWeek rpc={useRpc<typeof rpcContract>()} hostId="host_1" now={() => NOW} />;
    }
    renderSlot({ component: Harness }, {}, { rpc: handlers });
    return proposed;
  }

  it("prepares a new meeting from the form and shows its card above the week, nothing confirmed yet", async () => {
    const proposed = week([]);
    fireEvent.click(await screen.findByRole("button", { name: t.newMeeting }));
    const form = await screen.findByRole("dialog");
    fireEvent.change(within(form).getByLabelText(t.subject), { target: { value: "Roadmap" } });
    fireEvent.change(within(form).getByLabelText(t.startTime), { target: { value: "13:00" } });
    fireEvent.change(within(form).getByLabelText(t.endTime), { target: { value: "14:30" } });
    fireEvent.click(within(form).getByRole("button", { name: t.prepare }));
    await waitFor(() => expect(proposed).toHaveLength(1));
    expect(proposed[0]).toEqual({
      hostId: "host_1",
      proposal: { action: "create", subject: "Roadmap", start: local(4, 13), end: local(4, 14, 30), required: [], optional: [] },
    });
    expect(await screen.findByText(`${t.kind("create")} — ${t.notDone}`)).toBeTruthy();
    expect(screen.getByRole("button", { name: t.confirm })).toBeTruthy();
  });

  it("refuses an end before the start without asking the machine", async () => {
    const proposed = week([]);
    fireEvent.click(await screen.findByRole("button", { name: t.newMeeting }));
    const form = await screen.findByRole("dialog");
    fireEvent.change(within(form).getByLabelText(t.subject), { target: { value: "X" } });
    fireEvent.change(within(form).getByLabelText(t.endTime), { target: { value: "09:00" } });
    fireEvent.click(within(form).getByRole("button", { name: t.prepare }));
    expect(await within(form).findByText(t.endBeforeStart)).toBeTruthy();
    expect(proposed).toEqual([]);
  });

  it("offers change and cancel on the person's own meeting, an answer on an invitation, and asks the scope of a series", async () => {
    const proposed = week([
      ev({ id: "e00000000000a", subject: "Mine", start: local(4, 10), end: local(4, 11), myResponse: "organizer" }),
      ev({ id: "e00000000000b", subject: "Theirs", start: local(5, 10), end: local(5, 11), myResponse: "none", kind: "occurrence" }),
    ]);
    fireEvent.click(await screen.findByRole("button", { name: /Mine/ }));
    expect(screen.getByRole("button", { name: t.editMeeting })).toBeTruthy();
    expect(screen.getByRole("button", { name: t.cancelMeeting })).toBeTruthy();
    expect(screen.queryByRole("button", { name: t.respond })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: /Theirs/ }));
    fireEvent.click(screen.getByRole("button", { name: t.respond }));
    const form = await screen.findByRole("dialog");
    fireEvent.click(within(form).getByLabelText(t.series));
    fireEvent.click(within(form).getByLabelText(t.response("tentative")));
    fireEvent.change(within(form).getByLabelText(t.noteLabel), { target: { value: "Maybe" } });
    fireEvent.click(within(form).getByRole("button", { name: t.prepare }));
    await waitFor(() => expect(proposed).toHaveLength(1));
    expect(proposed[0]).toEqual({ hostId: "host_1", proposal: { action: "respond", event: "e00000000000b", scope: "series", response: "tentative", note: "Maybe" } });
  });

  it("starts a change from the meeting as Exchange holds it and sends only what the person changed", async () => {
    const proposed = week([ev({ id: "e00000000000a", subject: "Mine", start: local(4, 10), end: local(4, 11), myResponse: "organizer" })]);
    fireEvent.click(await screen.findByRole("button", { name: /Mine/ }));
    fireEvent.click(screen.getByRole("button", { name: t.editMeeting }));
    const form = await screen.findByRole("dialog");
    await waitFor(() => expect((within(form).getByLabelText(t.body) as HTMLTextAreaElement).value).toBe("Hi"));
    fireEvent.change(within(form).getByLabelText(t.startTime), { target: { value: "12:00" } });
    fireEvent.change(within(form).getByLabelText(t.endTime), { target: { value: "13:00" } });
    fireEvent.click(within(form).getByRole("button", { name: t.prepare }));
    await waitFor(() => expect(proposed).toHaveLength(1));
    expect(proposed[0]).toEqual({ hostId: "host_1", proposal: { action: "update", event: "e00000000000a", start: local(4, 12), end: local(4, 13), subject: "Mine", location: "", body: "Hi" } });
  });

  it("keeps the times of a meeting past midnight when only its subject changes", async () => {
    const proposed = week([ev({ id: "e00000000000a", subject: "Mine", start: local(4, 22), end: local(5, 1), myResponse: "organizer" })]);
    // It shows on both days; either opens it.
    fireEvent.click((await screen.findAllByRole("button", { name: /Mine/ }))[0]!);
    fireEvent.click(screen.getByRole("button", { name: t.editMeeting }));
    const form = await screen.findByRole("dialog");
    await waitFor(() => expect((within(form).getByLabelText(t.body) as HTMLTextAreaElement).value).toBe("Hi"));
    expect(within(form).getByLabelText(t.endDate)).toBeTruthy();
    fireEvent.change(within(form).getByLabelText(t.subject), { target: { value: "Mine, renamed" } });
    fireEvent.click(within(form).getByRole("button", { name: t.prepare }));
    await waitFor(() => expect(proposed).toHaveLength(1));
    expect(proposed[0]).toEqual({ hostId: "host_1", proposal: { action: "update", event: "e00000000000a", subject: "Mine, renamed", location: "", body: "Hi" } });
  });

  it("does not let the form drop an attendee it cannot write back", async () => {
    const proposed = week([ev({ id: "e00000000000a", subject: "Mine", start: local(4, 10), end: local(4, 11), myResponse: "organizer" })]);
    fireEvent.click(await screen.findByRole("button", { name: /Mine/ }));
    fireEvent.click(screen.getByRole("button", { name: t.editMeeting }));
    const form = await screen.findByRole("dialog");
    const attendees = (await within(form).findAllByRole("combobox"))[0] ?? within(form).getAllByRole("textbox").find((box) => (box as HTMLInputElement).value.includes("bob@"))!;
    await waitFor(() => expect((attendees as HTMLInputElement).value).toContain("bob@example.test"));
    fireEvent.change(attendees, { target: { value: "dave@example.test" } });
    fireEvent.click(within(form).getByRole("button", { name: t.prepare }));
    expect(await within(form).findByText(t.attendeesInOutlook)).toBeTruthy();
    expect(proposed).toEqual([]);
  });
});
