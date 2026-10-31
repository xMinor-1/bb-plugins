// A draft waiting for the person: who it goes to, what it says, and the Send
// button. Send names the version shown here; if the draft changed meanwhile
// (an agent revised it, someone edited it in Outlook) nothing is sent and the
// new version is shown instead. The button only starts sending: the machine
// that holds the mailbox asks once more in a system window, and only that
// answer sends.
import { useCallback, useEffect, useRef, useState } from "react";
import { useBbNavigate, useRealtime } from "@get-bb/plugin-sdk/app";
import type { BodyFormat, Draft, MailAddress, SendResult } from "../../contract";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { intlLocale, useLang, useMessages } from "@/lib/i18n";
import { messages } from "../messages";
import { ConfirmDialog } from "./ConfirmDialog";
import { arrived } from "./draft-sync";
import { RecipientsInput } from "./RecipientsInput";
import { recipientText, splitRecipients } from "../shared/recipients";
import { Notice, errorText } from "./ui";
import { useExplain } from "./errors";
import type { Rpc } from "./rpc";

type Texts = (typeof messages)["en"];

export type DraftTarget = { hostId: string } | { threadId: string };

export const formatAddress = (a: MailAddress) => recipientText(a);
const formatList = (list: readonly MailAddress[]) => list.map(formatAddress).join(", ");
const splitList = splitRecipients;

export const textareaClass =
  "block w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm leading-relaxed outline-none focus-visible:ring-1 focus-visible:ring-ring";

/** Kept as a function of the texts, so a notice follows a language switch. */
type Outcome = { tone: "ok" | "error" | "warn"; text: (t: Texts) => string } | null;

const FORMAT: Record<BodyFormat, "formatText" | "formatHtml" | "formatRtf" | "formatUnknown"> = {
  text: "formatText",
  html: "formatHtml",
  rtf: "formatRtf",
  unknown: "formatUnknown",
};

function size(t: Texts, bytes: number | null): string {
  if (bytes === null) return "";
  if (bytes < 1024) return ` (${t.bytes(bytes)})`;
  if (bytes < 1048576) return ` (${t.kilobytes(Math.round(bytes / 1024))})`;
  return ` (${t.megabytes((bytes / 1048576).toFixed(1))})`;
}

/** Why nothing was sent, in the panel's language. The server's own message stays for agents and logs. */
function notSent(t: Texts, result: Exclude<SendResult, { status: "sent" }>): string {
  if (result.status === "changed") return t.outcomeChanged;
  if (result.status === "gone") return t.outcomeGone;
  return { cancelled: t.outcomeCancelled, timeout: t.outcomeTimeout, unavailable: t.outcomeUnavailable, busy: t.outcomeBusy }[result.reason];
}

/** Everything that goes: the card and the confirmation show the same list. */
function Envelope({ draft }: { draft: Draft }) {
  const t = useMessages(messages);
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
      <dt className="text-muted-foreground">{t.to}</dt>
      <dd className="break-words">{formatList(draft.to) || <span className="text-destructive">{t.nobody}</span>}</dd>
      {draft.cc.length ? (
        <>
          <dt className="text-muted-foreground">{t.cc}</dt>
          <dd className="break-words">{formatList(draft.cc)}</dd>
        </>
      ) : null}
      {draft.bcc.length ? (
        <>
          <dt className="text-muted-foreground">{t.bcc}</dt>
          <dd className="break-words font-medium">{formatList(draft.bcc)}</dd>
        </>
      ) : null}
      <dt className="text-muted-foreground">{t.subject}</dt>
      <dd className="break-words">{draft.subject || t.noSubject}</dd>
      <dt className="text-muted-foreground">{t.attachments}</dt>
      <dd className="break-words">{draft.attachments.length ? draft.attachments.map((a) => `${a.name}${size(t, a.size)}`).join(", ") : t.none}</dd>
      <dt className="text-muted-foreground">{t.format}</dt>
      <dd className="break-words">{t[FORMAT[draft.bodyFormat]]}</dd>
    </dl>
  );
}

export function DraftCard({ rpc, target, id, initial, onDone }: { rpc: Rpc; target: DraftTarget; id: string; initial?: Draft; onDone?: () => void }) {
  const navigate = useBbNavigate();
  const t = useMessages(messages);
  const explain = useExplain();
  const lang = useLang();
  const [draft, setDraft] = useState<Draft | null | undefined>(initial);
  const [hostId, setHostId] = useState<string | null>("hostId" in target ? target.hostId : null);
  const [error, setError] = useState<string | null>(null);
  const [outcome, setOutcome] = useState<Outcome>(null);
  const [confirming, setConfirming] = useState<null | "send" | "discard">(null);
  // Our own send or discard announces itself over realtime before its answer arrives; that echo must not reload the card.
  const acting = useRef(false);
  // Read inside the realtime handler, which may hold an older render's values.
  const shownRef = useRef<Draft | null | undefined>(initial);
  shownRef.current = draft;
  const confirmingRef = useRef(confirming);
  confirmingRef.current = confirming;
  // The ref changes with the state, not a render later: a load answering in between must see the dialog as it is.
  const open = (which: "send" | "discard") => {
    confirmingRef.current = which;
    setConfirming(which);
  };
  const close = useCallback(() => {
    confirmingRef.current = null;
    setConfirming(null);
  }, []);
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showQuote, setShowQuote] = useState(false);

  /**
   * Every version that reaches the card goes through here, read against the
   * dialog state at the moment it arrives — a load started before the dialog
   * opened cannot change what the dialog shows.
   */
  const take = useCallback((latest: Draft | null) => {
    // Sending right now: the host checks the version itself and answers "changed" if it moved.
    if (acting.current) return;
    const next = arrived(shownRef.current, confirmingRef.current !== null, latest);
    if (next.action === "keep") return;
    if (next.action === "reopen") {
      close();
      setOutcome({ tone: "warn", text: (tt) => (next.why === "changed" ? tt.changedWhileConfirming : tt.goneWhileConfirming) });
    }
    shownRef.current = next.draft;
    setDraft(next.draft);
  }, [close]);

  const load = useCallback(() => {
    rpc.call("draft", { ...target, id }).then(
      (result) => {
        setHostId(result.hostId);
        setError(null);
        take(result.draft);
      },
      (cause) => setError(errorText(cause)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc, id, take, "hostId" in target ? target.hostId : target.threadId]);

  useEffect(() => {
    if (initial === undefined) load();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [load]);
  // The list this card sits in reloaded with a newer version: same rules as a load.
  useEffect(() => {
    if (initial && shownRef.current && initial.revision !== shownRef.current.revision) take(initial);
  }, [initial, take]);
  useRealtime("drafts-changed", (payload) => {
    if ((payload as { id?: string } | null)?.id !== id || acting.current || outcome?.tone === "ok") return;
    load();
  });

  const subject = draft?.subject ?? "";
  const named = (tt: Texts, text: string) => (subject ? tt.named(subject, text) : text);

  const send = async () => {
    if (!draft) return;
    setBusy(true);
    acting.current = true;
    try {
      // The machine with the mailbox writes the system window in the panel's language.
      const result = await rpc.call("sendDraft", { ...target, id, revision: draft.revision, lang });
      close();
      if (result.status === "sent") {
        const at = result.at;
        setOutcome({ tone: "ok", text: (tt) => named(tt, tt.sentAt(new Date(at).toLocaleTimeString(intlLocale(lang)))) });
        onDone?.();
      } else {
        setOutcome({ tone: "warn", text: (tt) => notSent(tt, result) });
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
      await rpc.call("discardDraft", { ...target, id });
      close();
      setOutcome({ tone: "ok", text: (tt) => named(tt, tt.discarded) });
      onDone?.();
    } catch (cause) {
      const text = errorText(cause);
      setOutcome({ tone: "error", text: () => text });
    } finally {
      acting.current = false;
      setBusy(false);
    }
  };

  if (error) return <Notice tone="error">{t.draftError(id, explain(error))}</Notice>;
  if (outcome?.tone === "ok") return <Notice tone="ok">{outcome.text(t)}</Notice>;
  if (draft === undefined) return <Notice tone="info">{t.loadingDraft}</Notice>;
  if (draft === null) return <Notice tone="info">{t.draftGone(id)}</Notice>;

  const quote = draft.body.startsWith(draft.text) ? draft.body.slice(draft.text.length).trim() : "";
  const shown = quote ? draft.text : draft.body;
  const kind = { new: t.kindNew, reply: t.kindReply, replyAll: t.kindReplyAll, forward: t.kindForward }[draft.kind];

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-4 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium">
          {kind} — {t.notSent}
        </p>
        <p className="text-xs text-muted-foreground">
          {draft.source === "agent" ? t.byAgent : t.byYou}
          {draft.threadId && "hostId" in target ? (
            <>
              {" "}
              <button type="button" className="underline underline-offset-2" onClick={() => navigate.toThread(draft.threadId!)}>
                {t.inItsThread}
              </button>
            </>
          ) : null}
        </p>
      </div>

      {editing && hostId ? (
        <DraftEditor
          rpc={rpc}
          hostId={hostId}
          draft={draft}
          onSaved={(next) => {
            setDraft(next);
            setEditing(false);
          }}
          onCancel={() => setEditing(false)}
        />
      ) : (
        <>
          <Envelope draft={draft} />
          <div className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background p-3 leading-relaxed">{shown.trim() ? shown : <span className="text-muted-foreground">{t.noOwnText}</span>}</div>
          {quote ? (
            <div>
              <button type="button" className="text-xs text-muted-foreground underline underline-offset-2" onClick={() => setShowQuote((v) => !v)}>
                {showQuote ? t.hideQuote : t.showQuote}
              </button>
              {showQuote ? <div className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">{quote}</div> : null}
            </div>
          ) : null}
          {outcome ? <Notice tone={outcome.tone}>{explain(outcome.text(t))}</Notice> : null}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => open("send")} disabled={busy || draft.to.length === 0}>
              {t.sendButton}
            </Button>
            <Button variant="outline" onClick={() => setEditing(true)} disabled={busy || !hostId}>
              {t.edit}
            </Button>
            <Button variant="ghost" onClick={() => open("discard")} disabled={busy}>
              {t.discard}
            </Button>
          </div>
        </>
      )}

      <ConfirmDialog
        open={confirming === "send"}
        title={t.sendTitle}
        description={t.sendDescription}
        confirmLabel={t.continue}
        busyLabel={t.confirmInWindow}
        busy={busy}
        onConfirm={() => void send()}
        onCancel={close}
      >
        <Envelope draft={draft} />
        <p className="text-xs text-muted-foreground">{t.sendSummary(draft.to.length + draft.cc.length + draft.bcc.length, shown.trim().length, Boolean(quote))}</p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirming === "discard"}
        title={t.discardTitle}
        description={t.discardDescription}
        confirmLabel={t.discard}
        busyLabel={t.discarding}
        busy={busy}
        destructive
        onConfirm={() => void discard()}
        onCancel={close}
      />
    </div>
  );
}

function DraftEditor({ rpc, hostId, draft, onSaved, onCancel }: { rpc: Rpc; hostId: string; draft: Draft; onSaved: (draft: Draft) => void; onCancel: () => void }) {
  const t = useMessages(messages);
  const explain = useExplain();
  const [to, setTo] = useState(formatList(draft.to));
  const [cc, setCc] = useState(formatList(draft.cc));
  const [subject, setSubject] = useState(draft.subject);
  const [text, setText] = useState(draft.kind === "new" ? draft.body : draft.text);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const save = async () => {
    setSaving(true);
    setError(null);
    try {
      const toChanged = to !== formatList(draft.to);
      const ccChanged = cc !== formatList(draft.cc);
      const next = await rpc.call("saveDraft", {
        hostId,
        kind: draft.kind,
        ...(draft.replyTo ? { replyTo: draft.replyTo.ref } : {}),
        // Replies keep the recipients Exchange chose unless the person changed them.
        ...(draft.kind === "new" || draft.kind === "forward" || toChanged || ccChanged ? { to: splitList(to), cc: splitList(cc) } : {}),
        subject,
        body: text,
        replaces: draft.id,
      });
      onSaved(next);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="space-y-2">
      <RecipientsInput rpc={rpc} hostId={hostId} value={to} onChange={setTo} label={t.to} />
      <RecipientsInput rpc={rpc} hostId={hostId} value={cc} onChange={setCc} label={t.cc} />
      <label className="block space-y-1">
        <span className="text-muted-foreground">{t.subject}</span>
        <Input value={subject} onChange={(event) => setSubject(event.target.value)} />
      </label>
      <label className="block space-y-1">
        <span className="text-muted-foreground">{draft.kind === "new" ? t.textNew : t.textAbove}</span>
        <textarea className={textareaClass} rows={10} value={text} onChange={(event) => setText(event.target.value)} />
      </label>
      {error ? <Notice tone="error">{explain(error)}</Notice> : null}
      <div className="flex gap-2">
        <Button onClick={() => void save()} disabled={saving || text.trim() === ""}>
          {saving ? t.saving : t.saveDraft}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          {t.cancel}
        </Button>
      </div>
    </div>
  );
}
