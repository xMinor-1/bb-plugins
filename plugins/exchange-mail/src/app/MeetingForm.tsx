// The calendar's form for a new meeting, a change or a cancellation of one the
// person organizes, and an answer to an invitation. It only prepares a
// proposal on the machine with the mailbox; the card it hands back is where
// the person confirms, in a system window, like every other change.
import { useEffect, useState } from "react";
import type { CalendarEvent, MeetingDetails, MeetingInput, MeetingProposal, MeetingResponse } from "../../contract";
import { Button } from "@/components/ui/button";
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from "@/components/ui/dialog";
import { Input } from "@/components/ui/input";
import { useMessages } from "@/lib/i18n";
import { recipientText, splitRecipients } from "../shared/recipients";
import { textareaClass } from "./DraftCard";
import { meetingTexts } from "./meeting-messages";
import { RecipientsInput } from "./RecipientsInput";
import { Notice, errorText } from "./ui";
import { useExplain } from "./errors";
import type { Rpc } from "./rpc";

export type FormMode = { action: "create"; day: Date } | { action: "update" | "cancel" | "respond"; event: CalendarEvent };

const two = (n: number) => String(n).padStart(2, "0");
/** yyyy-mm-dd and hh:mm of a moment in the browser's time zone, for date and time inputs. */
export const dateInput = (d: Date) => `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())}`;
export const timeInput = (d: Date) => `${two(d.getHours())}:${two(d.getMinutes())}`;
/** A local date and time from the inputs, as ISO with the browser's zone: the host reads it exactly. */
export function zonedIso(date: string, time: string): string | null {
  const local = new Date(`${date}T${time}:00`);
  if (Number.isNaN(local.getTime())) return null;
  return local.toISOString();
}

/** RPC input must be JSON: fields left undefined are dropped. */
const defined = <T extends object>(value: T): T => Object.fromEntries(Object.entries(value).filter(([, v]) => v !== undefined)) as T;
const list = (text: string) => splitRecipients(text).filter((entry) => entry.trim());
const listText = (people: readonly { name: string | null; email: string }[]) => people.filter((a) => a.email).map(recipientText).join(", ");

export function MeetingForm({ rpc, hostId, mode, onClose, onProposed }: { rpc: Rpc; hostId: string; mode: FormMode; onClose: () => void; onProposed: (proposal: MeetingProposal) => void }) {
  const t = useMessages(meetingTexts);
  const explain = useExplain();
  const action = mode.action;
  const event = mode.action === "create" ? null : mode.event;
  const recurring = event ? event.kind !== "single" : false;

  const first = mode.action === "create" ? new Date(mode.day.getFullYear(), mode.day.getMonth(), mode.day.getDate(), 10, 0) : new Date(mode.event.start);
  const last = mode.action === "create" ? new Date(first.getTime() + 60 * 60_000) : new Date(mode.event.end);
  const [details, setDetails] = useState<MeetingDetails | null>(null);
  const [subject, setSubject] = useState(event?.subject ?? "");
  const [date, setDate] = useState(dateInput(first));
  const [start, setStart] = useState(timeInput(first));
  const [end, setEnd] = useState(timeInput(last));
  // A meeting may run past midnight: its end keeps its own date.
  const [endDate, setEndDate] = useState(dateInput(last));
  const [required, setRequired] = useState("");
  const [optional, setOptional] = useState("");
  const [location, setLocation] = useState(event?.location ?? "");
  const [body, setBody] = useState("");
  const [note, setNote] = useState("");
  const [scope, setScope] = useState<"occurrence" | "series">("occurrence");
  const [response, setResponse] = useState<MeetingResponse>("accept");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  // A change starts from the meeting as Exchange holds it: attendees by address and its text.
  useEffect(() => {
    if (action !== "update" || !event) return;
    let live = true;
    rpc.call("meetingDetails", { hostId, eventId: event.id }).then(
      (found) => {
        if (!live) return;
        setDetails(found);
        setSubject(found.subject);
        setLocation(found.location ?? "");
        setRequired(listText(found.required));
        setOptional(listText(found.optional));
        setBody(found.body);
      },
      (cause) => live && setError(errorText(cause)),
    );
    return () => {
      live = false;
    };
  }, [rpc, hostId, action, event]);

  const submit = async () => {
    setError(null);
    let proposal: MeetingInput;
    const from = zonedIso(date, start);
    const to = zonedIso(endDate, end);
    if (action === "create" || action === "update") {
      if (!subject.trim()) return setError(t.needSubject);
      if (!from || !to || Date.parse(to) <= Date.parse(from)) return setError(t.endBeforeStart);
    }
    if (action === "create") {
      proposal = { action, subject: subject.trim(), start: from!, end: to!, location: location.trim() || undefined, body: body.trim() || undefined, required: list(required), optional: list(optional) };
    } else if (action === "update") {
      const listsChanged = details !== null && (required !== listText(details.required) || optional !== listText(details.optional));
      if (listsChanged && [...details.required, ...details.optional].some((a) => !a.email)) return setError(t.attendeesInOutlook);
      const timeChanged = from !== new Date(event!.start).toISOString() || to !== new Date(event!.end).toISOString();
      proposal = {
        action,
        event: event!.id,
        ...(recurring ? { scope } : {}),
        ...(timeChanged ? { start: from!, end: to! } : {}),
        subject: subject.trim(),
        location: location.trim(),
        body,
        // Attendees known only by an internal address stay off the form; the lists are sent only when the person changed them.
        ...(details && required !== listText(details.required) ? { required: list(required) } : {}),
        ...(details && optional !== listText(details.optional) ? { optional: list(optional) } : {}),
      };
    } else if (action === "cancel") {
      proposal = { action, event: event!.id, ...(recurring ? { scope } : {}), note: note.trim() || undefined };
    } else {
      proposal = { action, event: event!.id, ...(recurring ? { scope } : {}), response, note: note.trim() || undefined };
    }
    setBusy(true);
    try {
      onProposed(await rpc.call("proposeMeeting", { hostId, proposal: defined(proposal) }));
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  const loadingDetails = action === "update" && !details && !error;

  return (
    <Dialog open onOpenChange={(next) => !next && !busy && onClose()}>
      <DialogContent className="max-h-[90vh] overflow-y-auto">
        <DialogHeader>
          <DialogTitle>{t.formTitle(action)}</DialogTitle>
          <DialogDescription>{event && action !== "update" ? `${event.subject || "—"}` : t.formHint}</DialogDescription>
        </DialogHeader>
        <div className="space-y-3 text-sm">
          {recurring ? (
            <fieldset className="space-y-1">
              <legend className="text-muted-foreground">{t.scope}</legend>
              <label className="mr-4 inline-flex items-center gap-1.5">
                <input type="radio" name="scope" checked={scope === "occurrence"} onChange={() => setScope("occurrence")} />
                {t.occurrence}
              </label>
              <label className="inline-flex items-center gap-1.5">
                <input type="radio" name="scope" checked={scope === "series"} onChange={() => setScope("series")} />
                {t.series}
              </label>
              {action === "update" && scope === "series" ? <p className="text-xs text-muted-foreground">{t.seriesSameDay}</p> : null}
            </fieldset>
          ) : null}

          {action === "respond" ? (
            <fieldset className="space-y-1">
              <legend className="text-muted-foreground">{t.answer}</legend>
              {(["accept", "tentative", "decline"] as const).map((value) => (
                <label key={value} className="mr-4 inline-flex items-center gap-1.5">
                  <input type="radio" name="response" checked={response === value} onChange={() => setResponse(value)} />
                  {t.response(value)}
                </label>
              ))}
            </fieldset>
          ) : null}

          {loadingDetails ? <Notice tone="info">{t.loadingDetails}</Notice> : null}

          {(action === "create" || action === "update") && !loadingDetails ? (
            <>
              <label className="block space-y-1">
                <span className="text-muted-foreground">{t.subject}</span>
                <Input value={subject} onChange={(e) => setSubject(e.target.value)} maxLength={255} />
              </label>
              <div className="grid grid-cols-[minmax(0,1.4fr)_minmax(0,1fr)_minmax(0,1fr)] gap-2">
                <label className="block min-w-0 space-y-1">
                  <span className="text-muted-foreground">{t.date}</span>
                  <Input
                    type="date"
                    value={date}
                    onChange={(e) => {
                      // The end moves with the start day while both are on one day.
                      if (endDate === date) setEndDate(e.target.value);
                      setDate(e.target.value);
                    }}
                  />
                </label>
                <label className="block min-w-0 space-y-1">
                  <span className="text-muted-foreground">{t.startTime}</span>
                  <Input type="time" value={start} onChange={(e) => setStart(e.target.value)} />
                </label>
                <label className="block min-w-0 space-y-1">
                  <span className="text-muted-foreground">{t.endTime}</span>
                  <Input type="time" value={end} onChange={(e) => setEnd(e.target.value)} />
                </label>
              </div>
              {endDate !== date ? (
                <label className="block space-y-1">
                  <span className="text-muted-foreground">{t.endDate}</span>
                  <Input type="date" value={endDate} onChange={(e) => setEndDate(e.target.value)} />
                </label>
              ) : null}
              <RecipientsInput rpc={rpc} hostId={hostId} value={required} onChange={setRequired} label={t.requiredLabel} />
              <RecipientsInput rpc={rpc} hostId={hostId} value={optional} onChange={setOptional} label={t.optionalLabel} />
              <label className="block space-y-1">
                <span className="text-muted-foreground">{t.location}</span>
                <Input value={location} onChange={(e) => setLocation(e.target.value)} maxLength={255} />
              </label>
              <label className="block space-y-1">
                <span className="text-muted-foreground">{t.body}</span>
                <textarea className={textareaClass} rows={5} value={body} onChange={(e) => setBody(e.target.value)} />
              </label>
            </>
          ) : null}

          {action === "cancel" || action === "respond" ? (
            <label className="block space-y-1">
              <span className="text-muted-foreground">{t.noteLabel}</span>
              <textarea className={textareaClass} rows={3} value={note} onChange={(e) => setNote(e.target.value)} />
            </label>
          ) : null}

          {error ? <Notice tone="error">{explain(error)}</Notice> : null}
        </div>
        <DialogFooter>
          <Button variant="outline" onClick={onClose} disabled={busy}>
            {t.close}
          </Button>
          <Button onClick={() => void submit()} disabled={busy || loadingDetails}>
            {busy ? t.preparing : t.prepare}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
