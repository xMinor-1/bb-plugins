// Meetings without Exchange: the requests that write to the calendar, the
// free/busy answer, a calendar item read whole, and the system window that
// confirms a meeting change — it must name the time, what changes and everyone
// who gets mail.
import { describe, expect, it } from "vitest";
import { meetingText, type MeetingSummary } from "../src/host/confirm";
import { spanText, fixedOffset, freeStretches } from "../src/host/calendar";
import { formatProposal, revisionOf, type ProposalEntry } from "../src/host/meetings";
import { parseAvailability, parseCalendarItem } from "../src/host/ews/parse";
import { cancelMeeting, createMeeting, deleteAppointment, getRecurringMaster, getUserAvailability, respondToMeeting, updateMeeting } from "../src/host/ews/soap";

const MSK = fixedOffset(180);
const bob = { name: "Bob Builder", email: "bob@example.test" };
const carol = { name: null, email: "carol@example.test" };

describe("the requests that write to the calendar", () => {
  it("creates a meeting with its fields in schema order and sends invitations only when someone is invited", () => {
    const request = createMeeting({ subject: "Plan", start: "2026-11-10T10:00:00.000Z", end: "2026-11-10T11:00:00.000Z", location: "Room 4", body: "Agenda", required: [bob], optional: [carol], rooms: [] });
    expect(request).toContain('<m:CreateItem SendMeetingInvitations="SendToAllAndSaveCopy">');
    expect(request).toContain('<t:DistinguishedFolderId Id="calendar"/>');
    const order = ["<t:Subject>", "<t:Body ", "<t:Start>", "<t:End>", "<t:Location>", "<t:RequiredAttendees>", "<t:OptionalAttendees>"].map((tag) => request.indexOf(tag));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(request).toContain("<t:Attendee><t:Mailbox><t:Name>Bob Builder</t:Name><t:EmailAddress>bob@example.test</t:EmailAddress></t:Mailbox></t:Attendee>");
    const alone = createMeeting({ subject: "Focus", start: "2026-11-10T10:00:00.000Z", end: "2026-11-10T11:00:00.000Z", location: null, body: null, required: [], optional: [], rooms: [] });
    expect(alone).toContain('SendMeetingInvitations="SendToNone"');
    expect(alone).not.toMatch(/Attendees|<t:Body|<t:Location/);
  });

  it("changes only what changes, at the change key the person saw, refusing to overwrite a newer version", () => {
    const request = updateMeeting({ id: "AAMk1", changeKey: "CK1" }, { start: "2026-11-10T12:00:00.000Z", end: "2026-11-10T13:00:00.000Z", location: null, optional: [] }, { notify: true });
    expect(request).toContain('<m:UpdateItem ConflictResolution="NeverOverwrite" SendMeetingInvitationsOrCancellations="SendToAllAndSaveCopy">');
    expect(request).toContain('<t:ItemId Id="AAMk1" ChangeKey="CK1"/>');
    expect(request).toContain('<t:SetItemField><t:FieldURI FieldURI="calendar:Start"/><t:CalendarItem><t:Start>2026-11-10T12:00:00.000Z</t:Start></t:CalendarItem></t:SetItemField>');
    expect(request).toContain('<t:DeleteItemField><t:FieldURI FieldURI="calendar:Location"/></t:DeleteItemField>');
    expect(request).toContain('<t:DeleteItemField><t:FieldURI FieldURI="calendar:OptionalAttendees"/></t:DeleteItemField>');
    expect(request).not.toMatch(/item:Subject|RequiredAttendees/);
    expect(() => updateMeeting({ id: "AAMk1" }, { subject: "x" }, { notify: true })).toThrow(/change key/);
    expect(() => updateMeeting({ id: "AAMk1", changeKey: "CK" }, {}, { notify: true })).toThrow(/Nothing/);
  });

  it("cancels, answers and deletes with the change key; asks the series of an occurrence", () => {
    const cancel = cancelMeeting({ id: "AAMk1", changeKey: "CK1" }, "Sorry & see you");
    expect(cancel).toContain('<m:CreateItem MessageDisposition="SendAndSaveCopy"><m:Items><t:CancelCalendarItem><t:ReferenceItemId Id="AAMk1" ChangeKey="CK1"/>');
    expect(cancel).toContain('<t:NewBodyContent BodyType="Text">Sorry &amp; see you</t:NewBodyContent>');
    for (const [response, tag] of [["accept", "AcceptItem"], ["tentative", "TentativelyAcceptItem"], ["decline", "DeclineItem"]] as const) {
      const answer = respondToMeeting({ id: "AAMk2", changeKey: "CK2" }, response, "Да");
      expect(answer).toContain(`<t:${tag}><t:Body BodyType="Text">&#x414;&#x430;</t:Body><t:ReferenceItemId Id="AAMk2" ChangeKey="CK2"/></t:${tag}>`);
    }
    expect(() => respondToMeeting({ id: "AAMk2" }, "accept", null)).toThrow(/change key/);
    expect(() => cancelMeeting({ id: "AAMk2" }, null)).toThrow(/change key/);
    expect(deleteAppointment({ id: "AAMk3", changeKey: "CK3" })).toContain('SendMeetingCancellations="SendToNone"');
    expect(getRecurringMaster({ id: "AAMk4" })).toContain('<t:RecurringMasterItemId OccurrenceId="AAMk4"/>');
  });

  it("asks free/busy in UTC for the FreeBusy view only: no subjects of other people", () => {
    const request = getUserAvailability({ emails: ["bob@example.test", "carol@example.test"], start: "2026-11-09T21:00:00.000Z", end: "2026-11-10T21:00:00.000Z" });
    expect(request).toContain("<t:RequestedView>FreeBusy</t:RequestedView>");
    expect(request).toContain("<t:StartTime>2026-11-09T21:00:00</t:StartTime><t:EndTime>2026-11-10T21:00:00</t:EndTime>");
    expect(request.match(/<t:MailboxData>/g)).toHaveLength(2);
    expect(request).toContain("<t:TimeZone><t:Bias>0</t:Bias>");
  });
});

const envelope = (body: string) =>
  `<?xml version="1.0"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types">${body}</s:Body></s:Envelope>`;

describe("reading Exchange's answers", () => {
  it("reads free/busy per person in order, times without a zone as UTC, and a person Exchange does not know", () => {
    const answer = parseAvailability(
      envelope(
        "<m:GetUserAvailabilityResponse><m:FreeBusyResponseArray>" +
          '<m:FreeBusyResponse><m:ResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode></m:ResponseMessage><m:FreeBusyView><t:CalendarEventArray>' +
          "<t:CalendarEvent><t:StartTime>2026-11-10T07:00:00</t:StartTime><t:EndTime>2026-11-10T09:00:00</t:EndTime><t:BusyType>Busy</t:BusyType></t:CalendarEvent>" +
          "</t:CalendarEventArray></m:FreeBusyView></m:FreeBusyResponse>" +
          '<m:FreeBusyResponse><m:ResponseMessage ResponseClass="Error"><m:MessageText>No mailbox</m:MessageText><m:ResponseCode>ErrorMailRecipientNotFound</m:ResponseCode></m:ResponseMessage></m:FreeBusyResponse>' +
          "</m:FreeBusyResponseArray></m:GetUserAvailabilityResponse>",
      ),
      3,
    );
    expect(answer).toEqual([
      { ok: true, busy: [{ start: "2026-11-10T07:00:00.000Z", end: "2026-11-10T09:00:00.000Z", type: "Busy" }] },
      { ok: false, code: "ErrorMailRecipientNotFound", message: "No mailbox" },
      { ok: false, code: "BadResponse", message: expect.any(String) },
    ]);
  });

  it("reads a calendar item with its attendees by address; one with an X.500 address only keeps its name", () => {
    const item = parseCalendarItem(
      envelope(
        '<m:GetItemResponse><m:ResponseMessages><m:GetItemResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode><m:Items><t:CalendarItem>' +
          '<t:ItemId Id="AAMk1" ChangeKey="CK1"/><t:Subject>Plan</t:Subject><t:Body BodyType="Text">Line one&#xD;\nLine two</t:Body><t:Start>2026-11-10T10:00:00Z</t:Start><t:End>2026-11-10T11:00:00Z</t:End>' +
          "<t:MyResponseType>Organizer</t:MyResponseType>" +
          "<t:RequiredAttendees><t:Attendee><t:Mailbox><t:Name>Bob Builder</t:Name><t:EmailAddress>bob@example.test</t:EmailAddress></t:Mailbox></t:Attendee>" +
          "<t:Attendee><t:Mailbox><t:Name>Old Colleague</t:Name><t:EmailAddress>/o=Example/cn=old</t:EmailAddress></t:Mailbox></t:Attendee></t:RequiredAttendees>" +
          "<t:Resources><t:Attendee><t:Mailbox><t:Name>Room 7</t:Name><t:EmailAddress>room7@example.test</t:EmailAddress></t:Mailbox></t:Attendee></t:Resources>" +
          "</t:CalendarItem></m:Items></m:GetItemResponseMessage></m:ResponseMessages></m:GetItemResponse>",
      ),
    );
    expect(item.item).toEqual({ id: "AAMk1", changeKey: "CK1" });
    expect(item.required).toEqual([bob, { name: "Old Colleague", email: "" }]);
    expect(item.optional).toEqual([]);
    expect(item.rooms).toEqual([{ name: "Room 7", email: "room7@example.test" }]);
    expect(item.body).toBe("Line one\nLine two");
  });
});

describe("common free time", () => {
  it("leaves the stretches nobody is busy in", () => {
    const day = { start: Date.parse("2026-11-09T21:00:00Z"), end: Date.parse("2026-11-10T21:00:00Z") };
    const busy = [
      { start: Date.parse("2026-11-10T07:00:00Z"), end: Date.parse("2026-11-10T09:00:00Z") },
      { start: Date.parse("2026-11-10T08:30:00Z"), end: Date.parse("2026-11-10T10:00:00Z") },
    ];
    const [tuesday] = freeStretches(busy, day, { dayStart: 9 * 60, dayEnd: 18 * 60, minMinutes: 60, weekends: false, offset: MSK });
    expect(tuesday!.slots.map((slot) => [new Date(slot.start).toISOString(), new Date(slot.end).toISOString()])).toEqual([
      ["2026-11-10T06:00:00.000Z", "2026-11-10T07:00:00.000Z"],
      ["2026-11-10T10:00:00.000Z", "2026-11-10T15:00:00.000Z"],
    ]);
  });
});

const summary: MeetingSummary = {
  meeting: "update",
  mailbox: "STUB\\alice",
  scope: "series",
  subject: "Team sync",
  when: spanText(Date.parse("2026-11-12T13:00:00Z"), Date.parse("2026-11-12T13:30:00Z"), MSK),
  location: "Room 7",
  before: { when: spanText(Date.parse("2026-11-12T12:00:00Z"), Date.parse("2026-11-12T12:30:00Z"), MSK) },
  body: null,
  added: [{ name: "Dave", email: "dave@example.test" }],
  removed: [carol],
  notify: [bob, { name: "Dave", email: "dave@example.test" }],
  response: null,
  note: null,
};

describe("the window that confirms a meeting change", () => {
  it("names the time with what it was, the series, everyone told and who is taken off", () => {
    const { title, message, send, cancel } = meetingText(summary);
    expect(title).toBe("Exchange Mail: change this meeting?");
    expect([send, cancel]).toEqual(["Change", "Back"]);
    expect(message).toContain("A change to your meeting (STUB\\alice).");
    expect(message).toContain("Every occurrence of the series.");
    expect(message).toContain("When: Thu 2026-11-12 16:00–16:30 (UTC+3)\n   was: Thu 2026-11-12 15:00–15:30 (UTC+3)");
    expect(message).toContain("Added (1): Dave <dave@example.test>");
    expect(message).toContain("Taken off (they get a cancellation) (1): carol@example.test");
    expect(message).toContain("The update goes to (2): Bob Builder <bob@example.test>, Dave <dave@example.test>");
    expect(message).toContain("Text of the invitation: stays as it is.");
  });

  it("lists every attendee list that changes, so a move from required to optional is seen", () => {
    const { message } = meetingText({ ...summary, added: [], removed: [], lists: { required: [bob], optional: [carol] } });
    expect(message).toContain("Attendees from now (1): Bob Builder <bob@example.test>");
    expect(message).toContain("Optional attendees from now (1): carol@example.test");
    expect(meetingText({ ...summary, lists: { rooms: [] } }, "ru").message).toContain("Переговорные теперь (0): никого");
  });

  it("speaks Russian, says when nobody gets mail, and shows only the start of a long text", () => {
    const ru = meetingText({ ...summary, meeting: "create", scope: "single", before: {}, added: [], removed: [], notify: [], body: "ж".repeat(1500) }, "ru");
    expect(ru.title).toBe("Exchange Mail: создать встречу?");
    expect(ru.send).toBe("Создать");
    expect(ru.message).toContain("Писем не будет");
    expect(ru.message).toContain("Здесь только начало: 700 из 1500 символов");
    for (const english of ["Subject", "When", "Where", "Text of", "Create the meeting"]) expect(ru.message).not.toContain(english);
  });

  it("lists at most 25 people and says how many more get mail", () => {
    const many = Array.from({ length: 40 }, (_, n) => ({ name: null, email: `p${n}@example.test` }));
    const { message } = meetingText({ ...summary, meeting: "cancel", scope: "single", before: {}, added: [], removed: [], notify: many, note: "Sorry" });
    expect(message).toContain("The cancellation goes to (40): p0@example.test");
    expect(message).toContain(", and 15 more");
    expect(message).toContain("Note (5):\nSorry");
    expect(message).toContain("It cannot be undone.");
  });
});

describe("a proposal", () => {
  const entry: Omit<ProposalEntry, "revision" | "createdAt"> = {
    id: "p_000000000001",
    action: "create",
    source: "agent",
    threadId: "thr_1",
    scope: "single",
    eventId: null,
    target: null,
    before: null,
    after: { subject: "Plan", start: "2026-11-10T10:00:00.000Z", end: "2026-11-10T11:00:00.000Z", location: null, required: [bob], optional: [], rooms: [] },
    body: null,
    organizer: null,
    response: null,
    note: null,
    notify: [bob],
    removed: [],
    changes: null,
  };

  it("gets a new revision from any change to what it would do", () => {
    const base = revisionOf(entry);
    expect(revisionOf({ ...entry })).toBe(base);
    expect(revisionOf({ ...entry, notify: [bob, carol] })).not.toBe(base);
    expect(revisionOf({ ...entry, after: { ...entry.after!, start: "2026-11-10T10:30:00.000Z" } })).not.toBe(base);
    expect(revisionOf({ ...entry, target: { itemId: "AAMk", changeKey: "CK2" } })).not.toBe(base);
  });

  it("tells the agent how many get mail, not who, and that nothing happened yet", () => {
    const text = formatProposal({ ...entry, createdAt: 1, revision: "R" }, MSK, false);
    expect(text).toContain('Proposed a new meeting "Plan", Tue 2026-11-10 13:00–14:00 (UTC+3). 1 person gets an invitation.');
    expect(text).toContain("Nothing is in the calendar yet");
    expect(text).toContain('::meeting-proposal{id="p_000000000001"}');
    expect(text).not.toContain("bob@example.test");
  });
});
