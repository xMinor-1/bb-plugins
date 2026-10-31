// A draft waiting for the person: who it goes to, what it says, and the Send
// button. Send names the version shown here; if the draft changed meanwhile
// (an agent revised it, someone edited it in Outlook) nothing is sent and the
// new version is shown instead. The button only starts sending: the machine
// that holds the mailbox asks once more in a system window, and only that
// answer sends.
import { useCallback, useEffect, useRef, useState } from "react";
import { useBbNavigate, useRealtime } from "@get-bb/plugin-sdk/app";
import type { BodyFormat, Draft, MailAddress } from "../../contract";
import { whileConfirming } from "./draft-sync";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "./ConfirmDialog";
import { Notice, errorText } from "./ui";
import type { Rpc } from "./rpc";

export type DraftTarget = { hostId: string } | { threadId: string };

export const formatAddress = (a: MailAddress) => (a.name && a.name !== a.email ? `${a.name} <${a.email}>` : a.email);
const formatList = (list: readonly MailAddress[]) => list.map(formatAddress).join(", ");
const splitList = (text: string) =>
  text
    .split(/[;,\n]/)
    .map((part) => part.trim())
    .filter(Boolean);

export const textareaClass =
  "block w-full rounded-md border border-input bg-transparent px-3 py-2 text-sm leading-relaxed outline-none focus-visible:ring-1 focus-visible:ring-ring";

type Outcome = { tone: "ok" | "error" | "warn"; text: string } | null;

const FORMAT: Record<BodyFormat, string> = {
  text: "Plain text",
  html: "HTML — goes out with the formatting Outlook shows",
  rtf: "Rich text (RTF) — goes out with formatting",
  unknown: "Unknown — Exchange did not say; it may go out as HTML",
};

const size = (bytes: number | null) => (bytes === null ? "" : bytes < 1024 ? ` (${bytes} B)` : bytes < 1048576 ? ` (${Math.round(bytes / 1024)} KB)` : ` (${(bytes / 1048576).toFixed(1)} MB)`);

/** Everything that goes: the card and the confirmation show the same list. */
function Envelope({ draft }: { draft: Draft }) {
  return (
    <dl className="grid grid-cols-[auto_1fr] gap-x-3 gap-y-1 text-sm">
      <dt className="text-muted-foreground">To</dt>
      <dd className="break-words">{formatList(draft.to) || <span className="text-destructive">nobody</span>}</dd>
      {draft.cc.length ? (
        <>
          <dt className="text-muted-foreground">Cc</dt>
          <dd className="break-words">{formatList(draft.cc)}</dd>
        </>
      ) : null}
      {draft.bcc.length ? (
        <>
          <dt className="text-muted-foreground">Bcc</dt>
          <dd className="break-words font-medium">{formatList(draft.bcc)}</dd>
        </>
      ) : null}
      <dt className="text-muted-foreground">Subject</dt>
      <dd className="break-words">{draft.subject || "(no subject)"}</dd>
      <dt className="text-muted-foreground">Attachments</dt>
      <dd className="break-words">{draft.attachments.length ? draft.attachments.map((a) => `${a.name}${size(a.size)}`).join(", ") : "none"}</dd>
      <dt className="text-muted-foreground">Format</dt>
      <dd className="break-words">{FORMAT[draft.bodyFormat]}</dd>
    </dl>
  );
}

export function DraftCard({ rpc, target, id, initial, onDone }: { rpc: Rpc; target: DraftTarget; id: string; initial?: Draft; onDone?: () => void }) {
  const navigate = useBbNavigate();
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
  const [editing, setEditing] = useState(false);
  const [busy, setBusy] = useState(false);
  const [showQuote, setShowQuote] = useState(false);

  const load = useCallback(() => {
    rpc.call("draft", { ...target, id }).then(
      (result) => {
        setDraft(result.draft);
        setHostId(result.hostId);
        setError(null);
      },
      (cause) => setError(errorText(cause)),
    );
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rpc, id, "hostId" in target ? target.hostId : target.threadId]);

  useEffect(() => {
    if (initial === undefined) load();
  }, [load, initial]);
  useRealtime("drafts-changed", (payload) => {
    if ((payload as { id?: string } | null)?.id !== id || acting.current || outcome?.tone === "ok") return;
    if (!confirmingRef.current) {
      load();
      return;
    }
    // A dialog is open: what it shows must not change under the person's eyes.
    // If the draft moved on, the dialog closes and the new version is shown instead.
    const asked = confirmingRef.current;
    rpc.call("draft", { ...target, id }).then(
      (result) => {
        const next = whileConfirming(shownRef.current ?? null, result.draft);
        if (next.action === "keep" || confirmingRef.current !== asked || acting.current) return;
        setConfirming(null);
        setDraft(result.draft);
        setHostId(result.hostId);
        setOutcome({ tone: "warn", text: next.message });
      },
      () => undefined,
    );
  });

  const named = (text: string) => (draft?.subject ? `“${draft.subject}”: ${text}` : text);

  const send = async () => {
    if (!draft) return;
    setBusy(true);
    acting.current = true;
    try {
      const result = await rpc.call("sendDraft", { ...target, id, revision: draft.revision });
      setConfirming(null);
      if (result.status === "sent") {
        setOutcome({ tone: "ok", text: named(`sent at ${new Date(result.at).toLocaleTimeString()}.`) });
        onDone?.();
      } else {
        setOutcome({ tone: "warn", text: result.message });
        if (result.status !== "cancelled") load();
      }
    } catch (cause) {
      setOutcome({ tone: "error", text: errorText(cause) });
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
      setConfirming(null);
      setOutcome({ tone: "ok", text: named("discarded.") });
      onDone?.();
    } catch (cause) {
      setOutcome({ tone: "error", text: errorText(cause) });
    } finally {
      acting.current = false;
      setBusy(false);
    }
  };

  if (error) return <Notice tone="error">Draft {id}: {error}</Notice>;
  if (outcome?.tone === "ok") return <Notice tone="ok">{outcome.text}</Notice>;
  if (draft === undefined) return <Notice tone="info">Loading draft…</Notice>;
  if (draft === null) return <Notice tone="info">Draft {id} is no longer waiting: it was sent, discarded or deleted in Outlook.</Notice>;

  const quote = draft.body.startsWith(draft.text) ? draft.body.slice(draft.text.length).trim() : "";
  const shown = quote ? draft.text : draft.body;

  return (
    <div className="space-y-3 rounded-lg border border-border bg-card p-4 text-sm">
      <div className="flex flex-wrap items-baseline justify-between gap-2">
        <p className="font-medium">
          {draft.kind === "new" ? "New message" : draft.kind === "replyAll" ? "Reply to all" : "Reply"} — draft, not sent
        </p>
        <p className="text-xs text-muted-foreground">
          {draft.source === "agent" ? "Prepared by an agent" : "Your draft"}
          {draft.threadId && "hostId" in target ? (
            <>
              {" "}
              in{" "}
              <button type="button" className="underline underline-offset-2" onClick={() => navigate.toThread(draft.threadId!)}>
                its thread
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
          <div className="max-h-96 overflow-y-auto whitespace-pre-wrap break-words rounded-md border border-border bg-background p-3 leading-relaxed">{shown}</div>
          {quote ? (
            <div>
              <button type="button" className="text-xs text-muted-foreground underline underline-offset-2" onClick={() => setShowQuote((v) => !v)}>
                {showQuote ? "Hide the quoted message" : "Show the quoted message, sent below the text"}
              </button>
              {showQuote ? <div className="mt-2 max-h-72 overflow-y-auto whitespace-pre-wrap break-words text-xs text-muted-foreground">{quote}</div> : null}
            </div>
          ) : null}
          {outcome ? <Notice tone={outcome.tone}>{outcome.text}</Notice> : null}
          <div className="flex flex-wrap gap-2">
            <Button onClick={() => setConfirming("send")} disabled={busy || draft.to.length === 0}>
              Send…
            </Button>
            <Button variant="outline" onClick={() => setEditing(true)} disabled={busy || !hostId}>
              Edit
            </Button>
            <Button variant="ghost" onClick={() => setConfirming("discard")} disabled={busy}>
              Discard
            </Button>
          </div>
        </>
      )}

      <ConfirmDialog
        open={confirming === "send"}
        title="Send this message?"
        description="It goes out from your mailbox exactly as shown and cannot be called back. Your computer then asks once more in a system window: only Send there sends it."
        confirmLabel="Continue"
        busyLabel="Confirm in the system window…"
        busy={busy}
        onConfirm={() => void send()}
        onCancel={() => setConfirming(null)}
      >
        <Envelope draft={draft} />
        <p className="text-xs text-muted-foreground">
          {draft.to.length + draft.cc.length + draft.bcc.length} recipient{draft.to.length + draft.cc.length + draft.bcc.length === 1 ? "" : "s"},{" "}
          {shown.trim().length} characters of text
          {quote ? " plus the quoted message" : ""}.
        </p>
      </ConfirmDialog>
      <ConfirmDialog
        open={confirming === "discard"}
        title="Discard this draft?"
        description="It moves to Deleted Items in your mailbox and is not sent."
        confirmLabel="Discard"
        busyLabel="Discarding…"
        busy={busy}
        destructive
        onConfirm={() => void discard()}
        onCancel={() => setConfirming(null)}
      />
    </div>
  );
}

function DraftEditor({ rpc, hostId, draft, onSaved, onCancel }: { rpc: Rpc; hostId: string; draft: Draft; onSaved: (draft: Draft) => void; onCancel: () => void }) {
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
        ...(draft.kind === "new" || toChanged || ccChanged ? { to: splitList(to), cc: splitList(cc) } : {}),
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
      <label className="block space-y-1">
        <span className="text-muted-foreground">To</span>
        <Input value={to} onChange={(event) => setTo(event.target.value)} spellCheck={false} />
      </label>
      <label className="block space-y-1">
        <span className="text-muted-foreground">Cc</span>
        <Input value={cc} onChange={(event) => setCc(event.target.value)} spellCheck={false} />
      </label>
      <label className="block space-y-1">
        <span className="text-muted-foreground">Subject</span>
        <Input value={subject} onChange={(event) => setSubject(event.target.value)} />
      </label>
      <label className="block space-y-1">
        <span className="text-muted-foreground">{draft.kind === "new" ? "Text" : "Text above the quoted message"}</span>
        <textarea className={textareaClass} rows={10} value={text} onChange={(event) => setText(event.target.value)} />
      </label>
      {error ? <Notice tone="error">{error}</Notice> : null}
      <div className="flex gap-2">
        <Button onClick={() => void save()} disabled={saving || text.trim() === ""}>
          {saving ? "Saving…" : "Save draft"}
        </Button>
        <Button variant="ghost" onClick={onCancel} disabled={saving}>
          Cancel
        </Button>
      </div>
    </div>
  );
}
