// Meeting proposals on the machine with the mailbox. An agent or the panel
// asks for a meeting, a change, a cancellation or an answer; the host works out
// exactly what Exchange would be told and who would get mail, keeps that as a
// proposal with a revision, and writes nothing. Only confirmMeeting in
// service.ts writes, after the person confirmed that revision in a system
// window.
import { createHash } from "node:crypto";
import type { MailAddress, MeetingAction, MeetingFields, MeetingProposal, MeetingResponse, MeetingScope } from "../../contract.js";
import type { MeetingChanges } from "./ews/soap.js";
import { spanText, type Offset } from "./calendar.js";

export interface ProposalEntry {
  id: string;
  action: MeetingAction;
  source: "agent" | "person";
  threadId: string | null;
  createdAt: number;
  scope: MeetingScope;
  eventId: string | null;
  /** The item written to: the meeting, the one occurrence, or the series' master — at the change key read when proposing. */
  target: { itemId: string; changeKey: string } | null;
  before: MeetingFields | null;
  after: MeetingFields | null;
  body: string | null;
  organizer: MailAddress | null;
  response: MeetingResponse | null;
  note: string | null;
  notify: MailAddress[];
  removed: MailAddress[];
  /** update: the fields UpdateItem sets, for the item written to (the master's times for a series). */
  changes: MeetingChanges | null;
  revision: string;
}

/** The revision covers everything the proposal would do, the target's change key included. */
export function revisionOf(entry: Omit<ProposalEntry, "revision" | "createdAt">): string {
  const { id, action, source, threadId, scope, eventId, target, before, after, body, organizer, response, note, notify, removed, changes } = entry;
  const canonical = JSON.stringify({ id, action, source, threadId, scope, eventId, target, before, after, body, organizer, response, note, notify, removed, changes });
  return createHash("sha256").update(canonical).digest("hex").slice(0, 32);
}

export function proposalView(entry: ProposalEntry): MeetingProposal {
  return {
    id: entry.id,
    action: entry.action,
    source: entry.source,
    threadId: entry.threadId,
    createdAt: entry.createdAt,
    scope: entry.scope,
    eventId: entry.eventId,
    before: entry.before,
    after: entry.after,
    body: entry.body,
    organizer: entry.organizer,
    response: entry.response,
    note: entry.note,
    notify: entry.notify,
    removed: entry.removed,
    revision: entry.revision,
  };
}

const key = (a: MailAddress) => a.email.toLowerCase() || `name:${(a.name ?? "").toLowerCase()}`;

/** Each address once, the first spelling kept. */
export function uniqueAddresses(list: readonly MailAddress[]): MailAddress[] {
  const seen = new Set<string>();
  return list.filter((a) => {
    const k = key(a);
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
}

export const everyone = (fields: MeetingFields | null): MailAddress[] => (fields ? uniqueAddresses([...fields.required, ...fields.optional, ...fields.rooms]) : []);

/** Who is in `a` and not in `b`. */
export function missingFrom(a: readonly MailAddress[], b: readonly MailAddress[]): MailAddress[] {
  const there = new Set(b.map(key));
  return a.filter((x) => !there.has(key(x)));
}

export const sameList = (a: readonly MailAddress[], b: readonly MailAddress[]) => a.length === b.length && missingFrom(a, b).length === 0 && missingFrom(b, a).length === 0;

const ACTION_TEXT: Record<MeetingAction, string> = { create: "a new meeting", update: "a change to the meeting", cancel: "cancelling the meeting", respond: "an answer to the invitation" };
const RESPONSE_TEXT: Record<MeetingResponse, string> = { accept: "accept", tentative: "accept tentatively", decline: "decline" };
const SCOPE_TEXT: Record<MeetingScope, string> = { single: "", occurrence: " (only this occurrence)", series: " (every occurrence of the series)" };

/** The tool's answer: what was proposed, how many get mail, and the card line. Names and addresses of attendees stay with the person. */
export function formatProposal(view: MeetingProposal, offset: Offset, replaced: boolean): string {
  const fields = view.after ?? view.before;
  const when = fields ? spanText(Date.parse(fields.start), Date.parse(fields.end), offset) : "";
  const subject = fields?.subject ? `"${fields.subject.length > 200 ? `${fields.subject.slice(0, 199)}…` : fields.subject}"` : "(no subject)";
  const what =
    view.action === "respond" && view.response
      ? `${ACTION_TEXT.respond}: ${RESPONSE_TEXT[view.response]} ${subject}, ${when}${SCOPE_TEXT[view.scope]}`
      : `${ACTION_TEXT[view.action]} ${subject}, ${when}${SCOPE_TEXT[view.scope]}`;
  const mail =
    view.notify.length === 0
      ? "Nobody else gets mail about it."
      : `${view.notify.length} ${view.notify.length === 1 ? "person gets" : "people get"} ${view.action === "respond" ? "the answer" : view.action === "cancel" ? "the cancellation" : view.action === "create" ? "an invitation" : "the update"}` +
        `${view.removed.length ? `, ${view.removed.length} taken off get a cancellation` : ""}.`;
  return (
    `${replaced ? "Replaced the proposal with" : "Proposed"} ${what}. ${mail} ` +
    "Nothing is in the calendar yet and no mail went out: the user reviews the card and confirms it in a system window. " +
    "Never say it is done. Put this line on its own line in your reply:\n" +
    `::meeting-proposal{id="${view.id}"}`
  );
}
