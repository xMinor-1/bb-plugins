// Model Fallback — what the plugin does to a thread, shown in the thread.
//
// A row above the message box (thread context segment) shows a coming switch
// with its countdown, Switch now and Cancel; after a switch, which model took
// over and why, with Return. Expanded, it lists the thread's switches and its
// ladder. A small label sits above the message the plugin sent, so nobody
// takes it for the person's own words.
import { useEffect, useState } from "react";
import {
  definePluginApp,
  useComposers,
  useRpc,
  type ExperimentalMessageMetadataProps,
  type ExperimentalThreadContextSegmentInput,
  type ExperimentalThreadContextSegmentProps,
} from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "./server";
import { intlLocale, useLang, useMessages } from "@/lib/i18n";
import { messages } from "./src/app/messages";
import { useThreadView } from "./src/app/thread-view";
import { SENT_MATCH_MS, type LogEntry, type ThreadView } from "./src/shared/state";

type Texts = (typeof messages)["en"];

const cn = (...parts: Array<string | false | null | undefined>) => parts.filter(Boolean).join(" ");
type Tone = "amber" | "blue" | "red" | "muted";

const DOT: Record<Tone, string> = {
  amber: "bg-amber-500",
  blue: "bg-sky-500",
  red: "bg-red-500",
  muted: "bg-muted-foreground/50",
};

function useNow(active: boolean): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => setNow(Date.now()), 1000);
    return () => clearInterval(timer);
  }, [active]);
  return now;
}

function clock(ms: number): string {
  const seconds = Math.max(0, Math.ceil(ms / 1000));
  return `${Math.floor(seconds / 60)}:${String(seconds % 60).padStart(2, "0")}`;
}

/** What the row says right now, or null when there is nothing to say. */
function describe(view: ThreadView | null, serverNow: number, t: Texts): { tone: Tone; text: string } | null {
  if (view === null) return null;
  const { pending, active, notice } = view.state;
  if (pending) {
    const from = pending.from.name;
    const to = pending.to.name;
    const reason = t.reason(pending.reason);
    if (pending.dueAt === null) return { tone: "muted", text: t.cancelled(from) };
    const left = pending.dueAt - serverNow;
    return { tone: "amber", text: left > 0 ? t.pending(from, reason, to, clock(left)) : t.pendingNow(from, reason, to) };
  }
  if (notice?.kind === "no-fallback") return { tone: "red", text: t.noFallback(notice.model.name, t.reason(notice.reason)) };
  if (active) return { tone: "blue", text: t.active(active.current.name, active.original.name, t.reason(active.reason)) };
  if (notice?.kind === "not-switched") return { tone: "muted", text: t.notSwitched(notice.model.name, t.why(notice.why)) };
  return null;
}

function useVisible({ threadId }: ExperimentalThreadContextSegmentInput): boolean {
  const { view } = useThreadView(threadId);
  if (view === null) return false;
  const { pending, active, notice } = view.state;
  return pending !== null || active !== null || notice !== null;
}

function Summary({ threadId, isExpanded, onToggle }: ExperimentalThreadContextSegmentProps) {
  const t = useMessages(messages);
  const { view, offset } = useThreadView(threadId);
  const counting = view?.state.pending?.dueAt != null;
  const now = useNow(counting);
  const line = describe(view, now + offset, t);
  if (line === null) return null;
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={isExpanded}
      title={line.text}
      className={cn(
        "flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-left text-xs transition-colors hover:bg-state-hover",
        line.tone === "red" ? "text-red-600 dark:text-red-400" : "text-muted-foreground",
      )}
    >
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", DOT[line.tone])} />
      <span className="min-w-0 truncate tabular-nums">{line.text}</span>
    </button>
  );
}

function SegmentButton({ label, primary, onClick }: { label: string; primary?: boolean; onClick: () => Promise<unknown> }) {
  const t = useMessages(messages);
  const [busy, setBusy] = useState(false);
  const [failed, setFailed] = useState(false);
  return (
    <button
      type="button"
      disabled={busy}
      title={failed ? t.actionFailed : label}
      onClick={() => {
        setBusy(true);
        setFailed(false);
        onClick()
          .catch(() => setFailed(true))
          .finally(() => setBusy(false));
      }}
      className={cn(
        "inline-flex h-6 max-w-[16rem] shrink-0 items-center truncate rounded-md border px-2 text-xs transition-colors disabled:opacity-60",
        primary
          ? "border-foreground bg-foreground text-background hover:opacity-90"
          : "border-border bg-background text-foreground hover:bg-state-hover",
        failed && "border-red-500 text-red-600 dark:text-red-400",
      )}
    >
      {failed ? t.actionFailed : label}
    </button>
  );
}

function Action({ threadId }: ExperimentalThreadContextSegmentProps) {
  const t = useMessages(messages);
  const rpc = useRpc<RpcContract>();
  const composer = useComposers().find((item) => item.scope.kind === "thread" && item.scope.threadId === threadId);
  const { view, reload } = useThreadView(threadId);
  if (view === null) return null;
  const { pending, active } = view.state;
  const call = (method: "thread_cancel" | "thread_switch_now" | "thread_return") => () =>
    rpc.call(method, { threadId }).finally(reload);
  if (pending) {
    if (pending.dueAt === null) {
      return <SegmentButton label={t.switchTo(pending.to.name)} onClick={call("thread_switch_now")} />;
    }
    return (
      <span className="flex shrink-0 gap-1.5">
        <SegmentButton label={t.now} onClick={call("thread_switch_now")} />
        <SegmentButton label={t.cancel} onClick={call("thread_cancel")} />
      </span>
    );
  }
  if (active) {
    // The thread's model changes on the server; the message box keeps its own pick, so set it too.
    const back = () =>
      call("thread_return")().then(() => composer?.setSelection({ model: active.original.id }).catch(() => undefined));
    return <SegmentButton label={t.back(active.original.name)} onClick={back} />;
  }
  return null;
}

function logText(entry: LogEntry, t: Texts): string {
  switch (entry.kind) {
    case "switched":
      return `${t.logSwitched(entry.from.name, entry.to.name)}: ${t.reason(entry.reason)}`;
    case "cancelled":
      return `${t.logCancelled(entry.from.name, entry.to.name)}: ${t.reason(entry.reason)}`;
    case "returned":
      return t.logReturned(entry.to.name);
    case "no-fallback":
      return `${t.logNoFallback(entry.model.name)}: ${t.reason(entry.reason)}`;
    case "not-switched":
      return t.notSwitched(entry.model.name, t.why(entry.why));
    case "recovered":
      return t.logRecovered(entry.model.name);
    case "failed":
      return `${t.logFailed(entry.from.name, entry.to.name)}: ${entry.error}`;
  }
}

function Details({ threadId, isExpanded }: ExperimentalThreadContextSegmentProps) {
  const t = useMessages(messages);
  const locale = intlLocale(useLang());
  const { view } = useThreadView(threadId);
  if (!isExpanded || view === null) return null;
  const time = new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit" });
  const log = [...view.state.log].reverse().slice(0, 10);
  return (
    <div className="flex max-h-60 flex-col gap-1 overflow-y-auto px-1 pb-2 pt-1 text-xs text-muted-foreground">
      {log.map((entry, index) => (
        <div key={`${entry.at}-${index}`} className="flex gap-2.5">
          <span className="shrink-0 tabular-nums opacity-70">{time.format(entry.at)}</span>
          <span className="min-w-0 break-words text-foreground/80">{logText(entry, t)}</span>
        </div>
      ))}
      {view.ladder !== null && (
        <p className="mt-1 opacity-70">{t.ladder(view.ladder.map((model) => model.name).join(" → "))}</p>
      )}
    </div>
  );
}

/** The label above a message the plugin sent into the thread. */
function SentLabel({ message }: ExperimentalMessageMetadataProps) {
  const t = useMessages(messages);
  const { view } = useThreadView(message.threadId);
  if (message.role !== "user" || view === null) return null;
  const sent = view.state.sent.find((item) => Math.abs(item.at - message.createdAt) <= SENT_MATCH_MS);
  if (!sent) return null;
  return (
    <span className="inline-flex items-center gap-1 text-[11.5px] text-sky-600 dark:text-sky-400">
      <svg aria-hidden width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2">
        <path d="M20 7H9a5 5 0 0 0 0 10h7" />
        <path d="M16 3l4 4-4 4" />
      </svg>
      {t.tag(sent.from.name, sent.to.name)}
    </span>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadContextSegment({
    id: "model-fallback",
    title: "Model fallback",
    group: "1_model_fallback",
    summary: Summary,
    action: Action,
    details: Details,
    useVisible,
  });
  app.slots.experimental_messageMetadata({ id: "model-fallback-sent", placement: "above", component: SentLabel });
});
