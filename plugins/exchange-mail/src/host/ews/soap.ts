// EWS SOAP requests. Only the operations the plugin needs: list and search a
// folder, read a message and its conversation, download an attachment, save a
// draft (new, reply, reply all, forward), send a saved draft, delete a draft,
// read folder counters, look people up in the address book, read the calendar
// (the user's own, or another person's they were given, read only),
// and — once the person confirmed — create, change, cancel and answer meetings.
//
// Every request is plain ASCII: characters outside it become XML character
// references, so no code page between Node, curl and Exchange can mangle them.

export type FolderName = "inbox" | "sentitems" | "drafts" | "deleteditems" | "calendar";

export interface ItemRef {
  readonly id: string;
  readonly changeKey?: string | null;
}

export interface Address {
  readonly name: string | null;
  readonly email: string;
}

const NS =
  'xmlns:soap="http://schemas.xmlsoap.org/soap/envelope/" ' +
  'xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types" ' +
  'xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages"';

/** Escapes text for XML and turns everything outside printable ASCII into character references. */
export function xml(value: string): string {
  let out = "";
  for (const char of value) {
    const code = char.codePointAt(0)!;
    if (char === "&") out += "&amp;";
    else if (char === "<") out += "&lt;";
    else if (char === ">") out += "&gt;";
    else if (char === '"') out += "&quot;";
    else if (char === "'") out += "&apos;";
    else if (code === 0x09 || code === 0x0a || code === 0x0d) out += code === 0x0a ? "\n" : `&#x${code.toString(16)};`;
    else if (code < 0x20 || (code >= 0x7f && code <= 0x9f) || code === 0xfffe || code === 0xffff) continue; // not allowed in XML 1.0
    else if (code > 0x7e) out += `&#x${code.toString(16)};`;
    else out += char;
  }
  return out;
}

export function envelope(body: string): string {
  return (
    `<?xml version="1.0" encoding="utf-8"?>\n` +
    `<soap:Envelope ${NS}><soap:Header><t:RequestServerVersion Version="Exchange2013_SP1"/></soap:Header>` +
    `<soap:Body>${body}</soap:Body></soap:Envelope>`
  );
}

const field = (uri: string) => `<t:FieldURI FieldURI="${uri}"/>`;
const itemId = (ref: ItemRef, tag = "t:ItemId") =>
  `<${tag} Id="${xml(ref.id)}"${ref.changeKey ? ` ChangeKey="${xml(ref.changeKey)}"` : ""}/>`;
const folderId = (folder: FolderName) => `<t:DistinguishedFolderId Id="${folder}"/>`;

const SUMMARY_FIELDS = [
  "item:Subject",
  "item:ConversationId",
  "message:From",
  "item:DateTimeReceived",
  "message:IsRead",
  "item:HasAttachments",
  "item:Preview",
  "item:DisplayTo",
];

export interface FindOptions {
  readonly folder: FolderName;
  readonly offset: number;
  readonly limit: number;
  readonly unreadOnly?: boolean;
  /** Advanced Query Syntax, as in the Outlook search box. */
  readonly query?: string;
  /** Only the messages of this conversation. */
  readonly conversationId?: string;
}

export function findItems(options: FindOptions): string {
  const restriction = options.conversationId
    ? `<m:Restriction><t:IsEqualTo>${field("item:ConversationId")}<t:FieldURIOrConstant><t:Constant Value="${xml(options.conversationId)}"/></t:FieldURIOrConstant></t:IsEqualTo></m:Restriction>`
    : options.unreadOnly && !options.query
      ? `<m:Restriction><t:IsEqualTo>${field("message:IsRead")}<t:FieldURIOrConstant><t:Constant Value="false"/></t:FieldURIOrConstant></t:IsEqualTo></m:Restriction>`
      : "";
  return envelope(
    `<m:FindItem Traversal="Shallow">` +
      `<m:ItemShape><t:BaseShape>IdOnly</t:BaseShape><t:AdditionalProperties>${SUMMARY_FIELDS.map(field).join("")}</t:AdditionalProperties></m:ItemShape>` +
      `<m:IndexedPageItemView MaxEntriesReturned="${options.limit}" Offset="${options.offset}" BasePoint="Beginning"/>` +
      restriction +
      `<m:SortOrder><t:FieldOrder Order="Descending">${field("item:DateTimeReceived")}</t:FieldOrder></m:SortOrder>` +
      `<m:ParentFolderIds>${folderId(options.folder)}</m:ParentFolderIds>` +
      (options.query ? `<m:QueryString>${xml(options.query)}</m:QueryString>` : "") +
      `</m:FindItem>`,
  );
}

const MESSAGE_FIELDS = [
  "item:Subject",
  "item:ConversationId",
  "message:From",
  "message:ToRecipients",
  "message:CcRecipients",
  "message:BccRecipients",
  "item:DateTimeReceived",
  "item:DateTimeSent",
  "message:IsRead",
  "item:HasAttachments",
  "item:Attachments",
  "item:Body",
  "item:IsDraft",
  "message:InternetMessageId",
];

/**
 * PR_NATIVE_BODY_INFO: how the body is stored (1 text, 2 RTF, 3 HTML). The body
 * is asked for as text, so this is the only way to know it goes out formatted.
 */
export const NATIVE_BODY_TAG = "0x1016";
const nativeBody = `<t:ExtendedFieldURI PropertyTag="${NATIVE_BODY_TAG}" PropertyType="Integer"/>`;

/**
 * A whole message. By default its body comes as plain text converted by
 * Exchange (drafts, the send window, agents). With `html`, for reading in the
 * panel, the body comes as HTML and the plain text as TextBody next to it.
 */
export function getItem(ref: ItemRef, options: { html?: boolean } = {}): string {
  const fields = options.html ? [...MESSAGE_FIELDS, "item:TextBody"] : MESSAGE_FIELDS;
  return envelope(
    `<m:GetItem><m:ItemShape><t:BaseShape>IdOnly</t:BaseShape><t:BodyType>${options.html ? "HTML" : "Text"}</t:BodyType>` +
      `<t:AdditionalProperties>${fields.map(field).join("")}${nativeBody}</t:AdditionalProperties></m:ItemShape>` +
      `<m:ItemIds>${itemId({ id: ref.id })}</m:ItemIds></m:GetItem>`,
  );
}

/** One file attachment with its content. */
export function getAttachment(attachmentId: string): string {
  return envelope(`<m:GetAttachment><m:AttachmentIds><t:AttachmentId Id="${xml(attachmentId)}"/></m:AttachmentIds></m:GetAttachment>`);
}

/** Just the current id and change key, before acting on an item. */
export function getItemId(ref: ItemRef): string {
  return envelope(
    `<m:GetItem><m:ItemShape><t:BaseShape>IdOnly</t:BaseShape></m:ItemShape><m:ItemIds>${itemId({ id: ref.id })}</m:ItemIds></m:GetItem>`,
  );
}

const mailboxes = (tag: string, list: readonly Address[] | undefined) =>
  list && list.length
    ? `<t:${tag}>${list
        .map((a) => `<t:Mailbox>${a.name ? `<t:Name>${xml(a.name)}</t:Name>` : ""}<t:EmailAddress>${xml(a.email)}</t:EmailAddress></t:Mailbox>`)
        .join("")}</t:${tag}>`
    : "";

export type DraftKind = "new" | "reply" | "replyAll" | "forward";

export interface DraftInput {
  readonly kind: DraftKind;
  /** The message answered or forwarded; required for replies and forwards. */
  readonly reference?: ItemRef;
  /** Replies: omitted keeps the recipients Exchange chooses. */
  readonly to?: readonly Address[];
  readonly cc?: readonly Address[];
  /** Replies: omitted keeps Exchange's "RE: …". */
  readonly subject?: string;
  /** The text written above the quoted message (replies) or the whole body (new). */
  readonly body: string;
}

/** Saves a draft in the Drafts folder; nothing is sent. */
export function createDraft(input: DraftInput): string {
  const save = `<m:SavedItemFolderId>${folderId("drafts")}</m:SavedItemFolderId>`;
  if (input.kind === "new") {
    return envelope(
      `<m:CreateItem MessageDisposition="SaveOnly">${save}<m:Items><t:Message>` +
        `<t:Subject>${xml(input.subject ?? "")}</t:Subject>` +
        `<t:Body BodyType="Text">${xml(input.body)}</t:Body>` +
        mailboxes("ToRecipients", input.to) +
        mailboxes("CcRecipients", input.cc) +
        `</t:Message></m:Items></m:CreateItem>`,
    );
  }
  if (!input.reference) throw new Error("A reply or a forward needs the message it answers");
  const tag = input.kind === "reply" ? "ReplyToItem" : input.kind === "replyAll" ? "ReplyAllToItem" : "ForwardItem";
  return envelope(
    `<m:CreateItem MessageDisposition="SaveOnly">${save}<m:Items><t:${tag}>` +
      (input.subject !== undefined ? `<t:Subject>${xml(input.subject)}</t:Subject>` : "") +
      mailboxes("ToRecipients", input.to) +
      mailboxes("CcRecipients", input.cc) +
      itemId(input.reference, "t:ReferenceItemId") +
      `<t:NewBodyContent BodyType="Text">${xml(input.body)}</t:NewBodyContent>` +
      `</t:${tag}></m:Items></m:CreateItem>`,
  );
}

/** Sends a saved draft exactly at the given change key and keeps a copy in Sent Items. */
export function sendItem(ref: ItemRef): string {
  if (!ref.changeKey) throw new Error("Sending needs the change key the person saw");
  return envelope(
    `<m:SendItem SaveItemToFolder="true"><m:ItemIds>${itemId(ref)}</m:ItemIds>` +
      `<m:SavedItemFolderId>${folderId("sentitems")}</m:SavedItemFolderId></m:SendItem>`,
  );
}

export function deleteItem(ref: ItemRef): string {
  return envelope(`<m:DeleteItem DeleteType="MoveToDeletedItems"><m:ItemIds>${itemId({ id: ref.id })}</m:ItemIds></m:DeleteItem>`);
}

export function markRead(ref: ItemRef, isRead: boolean): string {
  return envelope(
    `<m:UpdateItem ConflictResolution="AlwaysOverwrite" MessageDisposition="SaveOnly" SuppressReadReceipts="true"><m:ItemChanges><t:ItemChange>` +
      itemId({ id: ref.id }) +
      `<t:Updates><t:SetItemField>${field("message:IsRead")}<t:Message><t:IsRead>${isRead}</t:IsRead></t:Message></t:SetItemField></t:Updates>` +
      `</t:ItemChange></m:ItemChanges></m:UpdateItem>`,
  );
}

export function getFolder(folder: FolderName): string {
  return envelope(
    `<m:GetFolder><m:FolderShape><t:BaseShape>Default</t:BaseShape></m:FolderShape><m:FolderIds>${folderId(folder)}</m:FolderIds></m:GetFolder>`,
  );
}

/**
 * People whose name or address starts like the query, as the To box of Outlook
 * finds them: the organization's address book first, then the person's own
 * contacts, with job title and department. Exchange returns at most 100.
 *
 * No ContactDataShape: its Default set has no department or office, and
 * AllProperties adds every person's directory photo. Without the attribute
 * Exchange returns the full contact data it always has, job title, department
 * and office included.
 */
export function resolveNames(query: string): string {
  return envelope(
    `<m:ResolveNames ReturnFullContactData="true" SearchScope="ActiveDirectoryContacts">` +
      `<m:UnresolvedEntry>${xml(query)}</m:UnresolvedEntry></m:ResolveNames>`,
  );
}

const CALENDAR_FIELDS = [
  "item:Subject",
  "item:Sensitivity",
  "item:DisplayTo",
  "item:DisplayCc",
  "calendar:Start",
  "calendar:End",
  "calendar:IsAllDayEvent",
  "calendar:Location",
  "calendar:Organizer",
  "calendar:MyResponseType",
  "calendar:LegacyFreeBusyStatus",
  "calendar:CalendarItemType",
  "calendar:IsCancelled",
  "calendar:IsMeeting",
  "calendar:IsRecurring",
];

/**
 * The calendar between two moments (ISO, UTC), as Outlook's calendar shows it:
 * a CalendarView expands recurring meetings into their occurrences, moved and
 * cancelled ones included. Read only. With `mailbox`, another person's
 * calendar, which Exchange gives only when its owner shared it with the user.
 */
export function calendarView(options: { start: string; end: string; max: number; mailbox?: string }): string {
  const folder = options.mailbox
    ? `<t:DistinguishedFolderId Id="calendar"><t:Mailbox><t:EmailAddress>${xml(options.mailbox)}</t:EmailAddress></t:Mailbox></t:DistinguishedFolderId>`
    : folderId("calendar");
  return envelope(
    `<m:FindItem Traversal="Shallow">` +
      `<m:ItemShape><t:BaseShape>IdOnly</t:BaseShape><t:AdditionalProperties>${CALENDAR_FIELDS.map(field).join("")}</t:AdditionalProperties></m:ItemShape>` +
      `<m:CalendarView MaxEntriesReturned="${options.max}" StartDate="${xml(options.start)}" EndDate="${xml(options.end)}"/>` +
      `<m:ParentFolderIds>${folder}</m:ParentFolderIds>` +
      `</m:FindItem>`,
  );
}

// ------------------------------------------------------------------ meetings
//
// Writing to the calendar. Each of these runs only after the person confirmed
// the exact change in a system window (src/host/service.ts, confirmMeeting).

const CALENDAR_ITEM_FIELDS = [...CALENDAR_FIELDS, "calendar:RequiredAttendees", "calendar:OptionalAttendees", "calendar:Resources", "item:Body"];

/** A calendar item as it is now, attendees and plain-text body included. */
export function getCalendarItem(ref: ItemRef): string {
  return envelope(
    `<m:GetItem><m:ItemShape><t:BaseShape>IdOnly</t:BaseShape><t:BodyType>Text</t:BodyType>` +
      `<t:AdditionalProperties>${CALENDAR_ITEM_FIELDS.map(field).join("")}</t:AdditionalProperties></m:ItemShape>` +
      `<m:ItemIds>${itemId({ id: ref.id })}</m:ItemIds></m:GetItem>`,
  );
}

/** The recurring master of an occurrence: the series itself. */
export function getRecurringMaster(occurrence: ItemRef): string {
  return envelope(
    `<m:GetItem><m:ItemShape><t:BaseShape>IdOnly</t:BaseShape><t:BodyType>Text</t:BodyType>` +
      `<t:AdditionalProperties>${CALENDAR_ITEM_FIELDS.map(field).join("")}</t:AdditionalProperties></m:ItemShape>` +
      `<m:ItemIds><t:RecurringMasterItemId OccurrenceId="${xml(occurrence.id)}"/></m:ItemIds></m:GetItem>`,
  );
}

const attendees = (tag: string, list: readonly Address[] | undefined) =>
  list && list.length
    ? `<t:${tag}>${list
        .map((a) => `<t:Attendee><t:Mailbox>${a.name ? `<t:Name>${xml(a.name)}</t:Name>` : ""}<t:EmailAddress>${xml(a.email)}</t:EmailAddress></t:Mailbox></t:Attendee>`)
        .join("")}</t:${tag}>`
    : "";

export interface MeetingFields {
  readonly subject: string;
  /** ISO, UTC. */
  readonly start: string;
  readonly end: string;
  readonly location: string | null;
  readonly body: string | null;
  readonly required: readonly Address[];
  readonly optional: readonly Address[];
  readonly rooms: readonly Address[];
}

const invites = (fields: { required: readonly Address[]; optional: readonly Address[]; rooms: readonly Address[] }) =>
  fields.required.length + fields.optional.length + fields.rooms.length > 0;

/** A new meeting in the calendar; invitations go to everyone on it, a copy stays in Sent Items. Without attendees it is an appointment and nothing is sent. */
export function createMeeting(fields: MeetingFields): string {
  const send = invites(fields) ? "SendToAllAndSaveCopy" : "SendToNone";
  return envelope(
    `<m:CreateItem SendMeetingInvitations="${send}"><m:SavedItemFolderId>${folderId("calendar")}</m:SavedItemFolderId><m:Items><t:CalendarItem>` +
      `<t:Subject>${xml(fields.subject)}</t:Subject>` +
      (fields.body ? `<t:Body BodyType="Text">${xml(fields.body)}</t:Body>` : "") +
      `<t:Start>${xml(fields.start)}</t:Start><t:End>${xml(fields.end)}</t:End>` +
      (fields.location ? `<t:Location>${xml(fields.location)}</t:Location>` : "") +
      attendees("RequiredAttendees", fields.required) +
      attendees("OptionalAttendees", fields.optional) +
      attendees("Resources", fields.rooms) +
      `</t:CalendarItem></m:Items></m:CreateItem>`,
  );
}

/** Only the fields that change; null clears a place or a list. */
export interface MeetingChanges {
  readonly subject?: string;
  readonly start?: string;
  readonly end?: string;
  readonly location?: string | null;
  readonly body?: string | null;
  readonly required?: readonly Address[];
  readonly optional?: readonly Address[];
  readonly rooms?: readonly Address[];
}

const set = (uri: string, inner: string) => `<t:SetItemField>${field(uri)}<t:CalendarItem>${inner}</t:CalendarItem></t:SetItemField>`;
const unset = (uri: string) => `<t:DeleteItemField>${field(uri)}</t:DeleteItemField>`;

/**
 * Changes a meeting or a whole series at exactly the change key the person
 * saw: with NeverOverwrite, Exchange refuses a change to an item that changed
 * since. Everyone on it gets the update; people taken off get a cancellation.
 */
export function updateMeeting(ref: ItemRef, changes: MeetingChanges, options: { notify: boolean }): string {
  if (!ref.changeKey) throw new Error("Changing a meeting needs the change key the person saw");
  const updates: string[] = [];
  if (changes.subject !== undefined) updates.push(set("item:Subject", `<t:Subject>${xml(changes.subject)}</t:Subject>`));
  if (changes.body !== undefined) updates.push(changes.body ? set("item:Body", `<t:Body BodyType="Text">${xml(changes.body)}</t:Body>`) : unset("item:Body"));
  if (changes.start !== undefined) updates.push(set("calendar:Start", `<t:Start>${xml(changes.start)}</t:Start>`));
  if (changes.end !== undefined) updates.push(set("calendar:End", `<t:End>${xml(changes.end)}</t:End>`));
  if (changes.location !== undefined) updates.push(changes.location ? set("calendar:Location", `<t:Location>${xml(changes.location)}</t:Location>`) : unset("calendar:Location"));
  const lists = [
    ["calendar:RequiredAttendees", "RequiredAttendees", changes.required],
    ["calendar:OptionalAttendees", "OptionalAttendees", changes.optional],
    ["calendar:Resources", "Resources", changes.rooms],
  ] as const;
  for (const [uri, tag, list] of lists) {
    if (list !== undefined) updates.push(list.length ? set(uri, attendees(tag, list)) : unset(uri));
  }
  if (updates.length === 0) throw new Error("Nothing to change");
  return envelope(
    `<m:UpdateItem ConflictResolution="NeverOverwrite" SendMeetingInvitationsOrCancellations="${options.notify ? "SendToAllAndSaveCopy" : "SendToNone"}">` +
      `<m:ItemChanges><t:ItemChange>${itemId(ref)}<t:Updates>${updates.join("")}</t:Updates></t:ItemChange></m:ItemChanges></m:UpdateItem>`,
  );
}

/** Cancels a meeting the person organizes: everyone invited gets the cancellation with the note. */
export function cancelMeeting(ref: ItemRef, note: string | null): string {
  if (!ref.changeKey) throw new Error("Cancelling a meeting needs the change key the person saw");
  return envelope(
    `<m:CreateItem MessageDisposition="SendAndSaveCopy"><m:Items><t:CancelCalendarItem>` +
      itemId(ref, "t:ReferenceItemId") +
      (note ? `<t:NewBodyContent BodyType="Text">${xml(note)}</t:NewBodyContent>` : "") +
      `</t:CancelCalendarItem></m:Items></m:CreateItem>`,
  );
}

/** Removes an appointment nobody else is invited to: there is nobody to tell. */
export function deleteAppointment(ref: ItemRef): string {
  return envelope(
    `<m:DeleteItem DeleteType="MoveToDeletedItems" SendMeetingCancellations="SendToNone"><m:ItemIds>${itemId(ref)}</m:ItemIds></m:DeleteItem>`,
  );
}

export type MeetingResponse = "accept" | "tentative" | "decline";
const RESPONSE_TAG: Record<MeetingResponse, string> = { accept: "AcceptItem", tentative: "TentativelyAcceptItem", decline: "DeclineItem" };

/** Answers an invitation; the organizer gets the answer with the note. */
export function respondToMeeting(ref: ItemRef, response: MeetingResponse, note: string | null): string {
  if (!ref.changeKey) throw new Error("Answering an invitation needs the change key the person saw");
  const tag = RESPONSE_TAG[response];
  return envelope(
    `<m:CreateItem MessageDisposition="SendAndSaveCopy"><m:Items><t:${tag}>` +
      (note ? `<t:Body BodyType="Text">${xml(note)}</t:Body>` : "") +
      itemId(ref, "t:ReferenceItemId") +
      `</t:${tag}></m:Items></m:CreateItem>`,
  );
}

/** EWS time without a zone, read in the UTC zone the request names. */
const utcClock = (iso: string) => new Date(Date.parse(iso)).toISOString().slice(0, 19);
/**
 * UTC as EWS describes a zone: no offset, and no change of the clocks, since
 * both rules add nothing. The two rules must fall on different dates —
 * Exchange refuses a zone whose standard and daylight time start on the same
 * day with "The specified time zone isn't valid" (0.6.0 sent 1 January twice).
 */
const UTC_STANDARD = "<t:Bias>0</t:Bias><t:Time>02:00:00</t:Time><t:DayOrder>5</t:DayOrder><t:Month>10</t:Month><t:DayOfWeek>Sunday</t:DayOfWeek>";
const UTC_DAYLIGHT = "<t:Bias>0</t:Bias><t:Time>02:00:00</t:Time><t:DayOrder>5</t:DayOrder><t:Month>3</t:Month><t:DayOfWeek>Sunday</t:DayOfWeek>";

/**
 * Free/busy of other people, as Outlook's Scheduling Assistant sees it: busy
 * stretches only (the FreeBusy view), no subjects or places. Times in UTC.
 */
export function getUserAvailability(options: { emails: readonly string[]; start: string; end: string }): string {
  return envelope(
    `<m:GetUserAvailabilityRequest>` +
      `<t:TimeZone><t:Bias>0</t:Bias><t:StandardTime>${UTC_STANDARD}</t:StandardTime><t:DaylightTime>${UTC_DAYLIGHT}</t:DaylightTime></t:TimeZone>` +
      `<m:MailboxDataArray>${options.emails
        .map((email) => `<t:MailboxData><t:Email><t:Address>${xml(email)}</t:Address></t:Email><t:AttendeeType>Required</t:AttendeeType><t:ExcludeConflicts>false</t:ExcludeConflicts></t:MailboxData>`)
        .join("")}</m:MailboxDataArray>` +
      `<t:FreeBusyViewOptions><t:TimeWindow><t:StartTime>${utcClock(options.start)}</t:StartTime><t:EndTime>${utcClock(options.end)}</t:EndTime></t:TimeWindow>` +
      `<t:MergedFreeBusyIntervalInMinutes>15</t:MergedFreeBusyIntervalInMinutes><t:RequestedView>FreeBusy</t:RequestedView></t:FreeBusyViewOptions>` +
      `</m:GetUserAvailabilityRequest>`,
  );
}
