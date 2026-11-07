// `::tracker-changes{id="u_…"}` in an agent's reply: what the agent changed without a
// form, with Undo where a change can go back. The id is untrusted text from the
// message; the card shows only a batch the plugin keeps for this very thread.
import type { PluginMessageDirectiveProps } from "@get-bb/plugin-sdk/app";
import { useRpc } from "@get-bb/plugin-sdk/app";
import { useEffect, useState } from "react";
import { useMessages } from "@/lib/i18n";
import type { AppliedItemView, AppliedView, rpcContract } from "../server/rpc-contract";
import { changeText } from "./ConfirmForm";
import { messages, type Messages } from "./messages";
import { Icons } from "./parts";
import { errorCode, errorText } from "./store";
import { Spinner } from "./ui";

const ID = /^u_[0-9a-f]{12}$/;

function itemState(t: Messages, item: AppliedItemView, undone: boolean): { text: string; tone: "ok" | "muted" | "bad" } | null {
  if (!item.ok) return { text: t.notApplied, tone: "bad" };
  if (item.undo === "undone") return { text: t.undoneMark, tone: "ok" };
  if (item.undo === "changedSince") return { text: t.changedSince, tone: "muted" };
  if (item.undo === "failed") return { text: t.undoFailed, tone: "bad" };
  // A comment or a new task stays: say so before anyone presses Undo, and after.
  if (!item.canUndo && (!undone || item.undo === null)) return { text: t.cannotUndo, tone: "muted" };
  return null;
}

export function ChangesCardView({ t, view, busy, error, onUndo }: { t: Messages; view: AppliedView; busy: boolean; error: string | null; onUndo: () => void }) {
  const done = view.items.filter((item) => item.ok);
  const failed = view.items.length - done.length;
  const undone = view.undoneAt !== null;
  const back = view.items.filter((item) => item.undo === "undone").length;
  const canUndo = view.items.some((item) => item.canUndo);
  return (
    <div className="tb-root tb-ach" role="group" aria-label={t.agentChanged(done.length, view.tracker)}>
      <div className="tb-ach-h">
        <span className={`tb-ach-ic${undone ? " tb-ach-ic-back" : ""}`}>{undone ? <Icons.refresh /> : <Icons.check />}</span>
        <b>{undone ? t.undoneSummary(back, done.length) : t.agentChanged(done.length, view.tracker)}</b>
        {!undone && failed > 0 ? <span className="tb-ach-bad">{t.notAppliedN(failed)}</span> : null}
        <span className="tb-grow" />
        {canUndo ? (
          <button className="tb-btn" type="button" onClick={onUndo} disabled={busy}>
            {busy ? <Spinner /> : null}
            {t.undo}
          </button>
        ) : null}
      </div>
      <ul className="tb-ach-list">
        {view.items.map((item) => {
          const state = itemState(t, item, undone);
          const key = item.planned.key ?? item.key;
          return (
            <li key={item.planned.id} className={`tb-ach-it${item.ok ? "" : " tb-ach-it-bad"}${item.undo === "undone" ? " tb-ach-it-back" : ""}`}>
              <span className="tb-ach-t">
                {key ? <span className="tb-k">{key}</span> : null}
                <span className="tb-t">{item.planned.title}</span>
              </span>
              <span className="tb-ach-d">{changeText(t, item.planned)}</span>
              {state ? <span className={`tb-ach-st tb-ach-st-${state.tone}`}>{state.text}</span> : null}
            </li>
          );
        })}
      </ul>
      {error ? <div className="tb-ach-err">{error}</div> : null}
    </div>
  );
}

export function ChangesDirective({ attributes, message }: PluginMessageDirectiveProps) {
  const rpc = useRpc<typeof rpcContract>();
  const t = useMessages(messages);
  const id = attributes.id ?? "";
  const valid = ID.test(id);
  const [view, setView] = useState<AppliedView | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const say = (cause: unknown) => setError(errorCode(cause) === "notFound" ? t.changesGone : errorText(t, cause));
  useEffect(() => {
    if (!valid) return;
    let live = true;
    rpc.call("appliedChanges", { id, threadId: message.threadId }).then(
      (next) => live && setView(next),
      (cause) => live && say(cause),
    );
    return () => {
      live = false;
    };
  }, [rpc, id, message.threadId, valid]);
  if (!valid) return <div className="tb-root tb-ach tb-ach-note">{t.changesBroken}</div>;
  if (!view) return <div className="tb-root tb-ach tb-ach-note">{error ?? <Spinner label={t.loading} />}</div>;
  const undo = async () => {
    setBusy(true);
    setError(null);
    try {
      setView(await rpc.call("undoApplied", { id, threadId: message.threadId }));
    } catch (cause) {
      say(cause);
    } finally {
      setBusy(false);
    }
  };
  return <ChangesCardView t={t} view={view} busy={busy} error={error} onUndo={() => void undo()} />;
}
