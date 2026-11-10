// A meeting proposal waiting for the person: what the meeting will be, what
// changes, and everyone who gets mail about it. Confirm names the revision
// shown here; if the proposal or the meeting changed meanwhile (an agent
// replaced it, someone edited the meeting in Outlook) nothing is written and
// the card says so. The button only starts: the machine with the mailbox asks
// once more in a system window, and only that answer writes to the calendar.
import { useCallback, useEffect, useRef, useState, type ReactNode } from "react";
import { useRealtime } from "@get-bb/plugin-sdk/app";
import type { MailAddress, MeetingFields, MeetingProposal, MeetingResult } from "../../contract";
import { Button } from "@/components/ui/button";
import { intlLocale, useLang, useMessages } from "@/lib/i18n";
import { ConfirmDialog } from "./ConfirmDialog";
import { formatAddress } from "./DraftCard";
import { meetingTexts } from "./meeting-messages";
import { Notice, errorText } from "./ui";
import { useExplain } from "./errors";
import type { Rpc } from "./rpc";
import { wallTime } from "../shared/zone";
import { TimeZoneContext, intlZone, useTimeZone, zoneText } from "./time-zone";

type Texts = (typeof meetingTexts)["en"];
export type MeetingTarget = { hostId: string } | { threadId: string };
type Outcome = { tone: "ok" | "error" | "warn"; text: (t: Texts) => string } | null;

const names = (list: readonly MailAddress[]) => list.map(formatAddress).join(", ");

function notDone(t: Texts, result: Exclude<MeetingResult, { status: "done" }>): string {
  if (result.status === "changed") return t.changed;
  if (result.status === "gone") return t.gonePending;
  return { cancelled: t.cancelled, timeout: t.timeout, unavailable: t.unavailable, busy: t.busy }[result.reason];
}

/** "Tue, 10 Nov, 14:00–15:00 (Europe/Moscow, UTC+3)" in the plugin's time zone. */
export function useSpan() {
  const lang = useLang();
  const zone = useTimeZone();
  const locale = intlLocale(lang);
  return useCallback(
    (fields: Pick<MeetingFields, "start" | "end">) => {
      const start = new Date(fields.start);
      const end = new Date(fields.end);
      const timeZone = intlZone(zone);
      const day = new Intl.DateTimeFormat(locale, { weekday: "short", day: "numeric", month: "short", year: "numeric", timeZone });
      const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", timeZone });
      const a = wallTime(start.getTime(), zone);
      const b = wallTime(end.getTime(), zone);
      const sameDay = a.year === b.year && a.month === b.month && a.day === b.day;
      return `${day.format(start)}, ${time.format(start)}–${sameDay ? "" : `${day.format(end)}, `}${time.format(end)} (${zoneText(zone, start.getTime())})`;
    },
    [locale, zone],
  );
}

/** The details: the card and its dialog show the same. */
export function MeetingSummary({ proposal }: { proposal: MeetingProposal }) {
  const t = useMessages(meetingTexts);
  const span = useSpan();
  const now = (proposal.after ?? proposal.before)!;
  const was = proposal.action === "update" ? proposal.before : null;
  const Was = ({ show, value }: { show: boolean; value: string }) =>
    show ? (
      <span className="block text-xs text-muted-foreground">
        {t.was}: <span className="line-through">{value}</span>
      </span>
    ) : null;
  const added = proposal.action === "update" && proposal.before && proposal.after ? missing(everyone(proposal.after), everyone(proposal.before)) : [];
  const row = (label: string, value: ReactNode) => (
    <>
      <dt className="text-muted-foreground">{label}</dt>
      <dd className="min-w-0 break-words">{value}</dd>
    </>
  );
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
      {proposal.scope !== "single" ? row("", <span className="font-medium">{proposal.scope === "series" ? t.scopeSeries : t.scopeOccurrence}</span>) : null}
      {proposal.response ? row(t.answer, <span className="font-medium">{t.response(proposal.response)}</span>) : null}
      {row(
        t.subject,
        <>
          {now.subject || "—"}
          <Was show={Boolean(was && was.subject !== now.subject)} value={was?.subject || "—"} />
        </>,
      )}
      {row(
        t.when,
        <>
          {span(now)}
          <Was show={Boolean(was && (was.start !== now.start || was.end !== now.end))} value={was ? span(was) : ""} />
        </>,
      )}
      {row(
        t.where,
        <>
          {now.location || <span className="text-muted-foreground">{t.nowhere}</span>}
          <Was show={Boolean(was && was.location !== now.location)} value={was?.location || t.nowhere} />
        </>,
      )}
      {proposal.organizer && proposal.action === "respond" ? row(t.organizer, formatAddress(proposal.organizer)) : null}
      {proposal.action !== "respond" ? row(t.required, names(now.required) || <span className="text-muted-foreground">{t.nobody}</span>) : null}
      {proposal.action !== "respond" && now.optional.length ? row(t.optional, names(now.optional)) : null}
      {proposal.action !== "respond" && now.rooms.length ? row(t.rooms, names(now.rooms)) : null}
      {added.length ? row(t.added, <span className="font-medium">{names(added)}</span>) : null}
      {proposal.removed.length ? row(t.removed, <span className="font-medium">{`${names(proposal.removed)} (${t.removedHint})`}</span>) : null}
      {row(
        t.notify(proposal.action),
        proposal.notify.length ? `${t.count(proposal.notify.length)}: ${names(proposal.notify)}` : <span className="text-muted-foreground">{t.nobodyNotified}</span>,
      )}
      {proposal.note ? row(t.note, <span className="whitespace-pre-wrap">{proposal.note}</span>) : null}
    </dl>
  );
}

const key = (a: MailAddress) => a.email.toLowerCase() || `name:${a.name ?? ""}`;
const everyone = (f: MeetingFields) => [...f.required, ...f.optional, ...f.rooms];
const missing = (a: readonly MailAddress[], b: readonly MailAddress[]) => {
  const there = new Set(b.map(key));
  return a.filter((x) => !there.has(key(x)));
};

export function MeetingCard({ rpc, target, id, onDone }: { rpc: Rpc; target: MeetingTarget; id: string; onDone?: () => void }) {
  const t = useMessages(meetingTexts);
  const lang = useLang();
  const explain = useExplain();
  const [proposal, setProposal] = useState<MeetingProposal | null | undefined>(undefined);
  /** The page's zone until the server names the plugin's: a card in a thread has no page around it. */
  const pageZone = useTimeZone();
  const [zone, setZone] = useState<string | null>(pageZone);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [confirming, setConfirming] = useState<null | "confirm" | "discard">(null);
  const [busy, setBusy] = useState(false);
  const [showText, setShowText] = useState(false);
  // Our own confirm announces itself over realtime before its answer arrives; that echo must not reload the card.
  const acting = useRef(false);
  const shownRef = useRef<MeetingProposal | null | undefined>(undefined);
  shownRef.current = proposal;
  const confirmingRef = useRef(confirming);
  confirmingRef.current = confirming;
  const open = (which: "confirm" | "discard") => {
    confirmingRef.current = which;
    setConfirming(which);
  };
  const close = useCallback(() => {
    confirmingRef.current = null;
    setConfirming(null);
  }, []);

  /** A version that arrives while a dialog is open must not change what the dialog shows: a different one closes it, with a note. */
  const take = useCallback(
    (latest: MeetingProposal | null) => {
      if (acting.current) return;
      if (confirmingRef.current !== null) {
        if (shownRef.current && latest && latest.revision === shownRef.current.revision) return;
        close();
        setOutcome({ tone: "warn", text: (tt) => (latest ? tt.changedWhileConfirming : tt.gonePending) });
      }
      shownRef.current = latest;
      setProposal(latest);
    },
    [close],
  );

  const targetKey = "hostId" in target ? target.hostId : target.threadId;
  const load = useCallback(() => {
    rpc.call("meeting", { ...target, id }).then(
      (result) => {
        setError(null);
        setZone(result.timeZone ?? null);
        take(result.proposal);
      },
      (cause) => setError(errorText(cause)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc, id, take, targetKey]);

  useEffect(() => load(), [load]);
  useRealtime("meetings-changed", (payload) => {
    if ((payload as { id?: string } | null)?.id !== id || acting.current || outcome?.tone === "ok") return;
    load();
  });

  const confirm = async () => {
    if (!proposal) return;
    setBusy(true);
    acting.current = true;
    try {
      // The machine with the mailbox writes the system window in the panel's language.
      const result = await rpc.call("confirmMeeting", { ...target, id, revision: proposal.revision, lang });
      close();
      if (result.status === "done") {
        const at = new Date(result.at).toLocaleTimeString(intlLocale(lang), { hour: "2-digit", minute: "2-digit" });
        const action = proposal.action;
        setOutcome({ tone: "ok", text: (tt) => tt.doneAt(tt.done(action), at) });
        onDone?.();
      } else {
        setOutcome({ tone: "warn", text: (tt) => notDone(tt, result) });
        if (result.status !== "cancelled") load();
      }
    } catch (cause) {
      const text = errorText(cause);
      setOutcome({ tone: "error", text: () => text });
    } finally {
      acting.current = false;
      setBusy(false);
    }
  };

  const discard = async () => {
    setBusy(true);
    acting.current = true;
    try {
      await rpc.call("discardMeeting", { ...target, id });
      close();
      setOutcome({ tone: "ok", text: (tt) => tt.discarded });
      onDone?.();
    } catch (cause) {
      const text = errorText(cause);
      setOutcome({ tone: "error", text: () => text });
    } finally {
      acting.current = false;
      setBusy(false);
    }
  };

  if (error) return <Notice tone="error">{t.loadError(id, explain(error))}</Notice>;
  if (outcome?.tone === "ok") return <Notice tone="ok">{outcome.text(t)}</Notice>;
  if (proposal === undefined) return <Notice tone="info">{t.loading}</Notice>;
  if (proposal === null) return <Notice tone="info">{outcome ? outcome.text(t) : t.gone(id)}</Notice>;

  const hasText = proposal.action === "create" || proposal.action === "update";

  return (
    <TimeZoneContext.Provider value={zone}>
      <div className="space-y-3 rounded-lg border border-border bg-card p-4 text-sm" data-meeting-proposal={proposal.id}>
        <div className="flex flex-wrap items-baseline justify-between gap-2">
          <p className="font-medium">
            {t.kind(proposal.action)} — {t.notDone}
          </p>
          <p className="text-xs text-muted-foreground">{proposal.source === "agent" ? t.byAgent : t.byYou}</p>
        </div>
        <MeetingSummary proposal={proposal} />
        {hasText ? (
          <div>
            <button type="button" className="text-xs text-muted-foreground underline underline-offset-2" onClick={() => setShowText((v) => !v)}>
              {t.text}: {proposal.body === null ? t.textKept : proposal.body ? (showText ? "▾" : "▸") : t.noText}
            </button>
            {showText && proposal.body ? <div className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background p-3">{proposal.body}</div> : null}
          </div>
        ) : null}
        {outcome ? <Notice tone={outcome.tone}>{explain(outcome.text(t))}</Notice> : null}
        <div className="flex flex-wrap gap-2">
          <Button onClick={() => open("confirm")} disabled={busy}>
            {t.confirm}
          </Button>
          <Button variant="ghost" onClick={() => open("discard")} disabled={busy}>
            {t.discard}
          </Button>
        </div>

        <ConfirmDialog
          open={confirming === "confirm"}
          title={t.confirmTitle(proposal.action)}
          description={t.confirmDescription}
          confirmLabel={t.continue}
          busyLabel={t.confirmInWindow}
          busy={busy}
          destructive={proposal.action === "cancel"}
          onConfirm={() => void confirm()}
          onCancel={close}
        >
          <MeetingSummary proposal={proposal} />
        </ConfirmDialog>
        <ConfirmDialog
          open={confirming === "discard"}
          title={t.discardTitle}
          description={t.discardDescription}
          confirmLabel={t.discard}
          busyLabel={t.discarding}
          busy={busy}
          onConfirm={() => void discard()}
          onCancel={close}
        />
      </div>
    </TimeZoneContext.Provider>
  );
}
