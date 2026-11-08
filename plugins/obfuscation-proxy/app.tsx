// Obfuscation Proxy — the masking state of a thread, above its message box.
//
// The segment shows plainly whether masking is on for the thread's external
// model, with a switch at the row's end. Expanded, it lists the thread's
// model requests: when, which model, how they left and what was masked.
import { useCallback, useEffect, useRef, useState } from "react";
import {
  definePluginApp,
  useComposers,
  useRealtime,
  useRpc,
  useSettings,
  type ExperimentalThreadContextSegmentInput,
  type ExperimentalThreadContextSegmentProps,
} from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "./server";
import { intlLocale, useLang, useMessages } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { messages } from "./src/messages";
import {
  isExternalModel,
  parsePrefixes,
  PROXY_CHANGED,
  ROUTED_PROVIDERS,
  THREAD_CHANGED,
  type FeedEntry,
  type ThreadStatus,
} from "./src/shared";

// ---------- Data ----------

/** The provider and model picked in this thread's composer right now. */
function useThreadSelection(threadId: string): { providerId: string; model: string | null } | null {
  const composers = useComposers();
  const composer = composers.find((item) => item.scope.kind === "thread" && item.scope.threadId === threadId);
  const providerId = composer?.selection?.providerId;
  if (providerId === undefined) return null;
  return { providerId, model: composer?.selection?.model ?? null };
}

function useCorporatePrefixes(): string[] {
  return parsePrefixes(useSettings().values?.corporateModels);
}

/** Calls `load` on mount, on the thread's realtime signals and keeps only the latest answer. */
function useThreadQuery<T>(threadId: string, load: () => Promise<T>, enabled = true) {
  const [data, setData] = useState<T | null>(null);
  const latest = useRef(0);
  const refetch = useCallback(() => {
    if (!enabled) return;
    const call = ++latest.current;
    load().then(
      (result) => {
        if (call === latest.current) setData(result);
      },
      () => {},
    );
  }, [load, enabled]);
  useEffect(() => {
    refetch();
  }, [refetch]);
  useRealtime(THREAD_CHANGED, (payload) => {
    if ((payload as { threadId?: unknown } | null)?.threadId === threadId) refetch();
  });
  useRealtime(PROXY_CHANGED, refetch);
  return { data, refetch };
}

function useThreadStatus(threadId: string) {
  const rpc = useRpc<RpcContract>();
  const lang = useLang();
  const load = useCallback(() => rpc.call("thread_status", { threadId, lang }), [rpc, threadId, lang]);
  return useThreadQuery<ThreadStatus>(threadId, load);
}

function useFeed(threadId: string, enabled: boolean) {
  const rpc = useRpc<RpcContract>();
  const lang = useLang();
  const load = useCallback(
    () => rpc.call("thread_feed", { threadId, limit: 50, lang }).then((result) => result.entries),
    [rpc, threadId, lang],
  );
  return useThreadQuery<FeedEntry[]>(threadId, load, enabled);
}

// ---------- Segment ----------

function useVisible({ threadId }: ExperimentalThreadContextSegmentInput): boolean {
  const selection = useThreadSelection(threadId);
  const corporate = useCorporatePrefixes();
  if (selection === null) return false;
  return isExternalModel(selection.providerId, selection.model, corporate);
}

function useRouted(threadId: string): boolean {
  const selection = useThreadSelection(threadId);
  return selection !== null && ROUTED_PROVIDERS.includes(selection.providerId);
}

type Tone = "ok" | "warn" | "danger" | "muted";

const DOT: Record<Tone, string> = {
  ok: "bg-emerald-500",
  warn: "bg-amber-500",
  danger: "bg-red-500",
  muted: "bg-muted-foreground/50",
};

function describe(status: ThreadStatus | null, routed: boolean, t: (typeof messages)["en"]) {
  if (!routed) return { tone: "muted" as Tone, label: t.unsupported, detail: null };
  if (status === null) return { tone: "muted" as Tone, label: t.title, detail: null };
  if (!status.masking) return { tone: "danger" as Tone, label: t.off, detail: null };
  const { proxy, totals } = status;
  if (proxy.state === "installing") return { tone: "warn" as Tone, label: t.on, detail: t.installing };
  if (proxy.state === "starting") return { tone: "warn" as Tone, label: t.on, detail: t.starting };
  if (proxy.state === "not-configured") return { tone: "danger" as Tone, label: t.on, detail: t.notConfigured };
  if (proxy.state === "failed" && proxy.problem === "download")
    return { tone: "danger" as Tone, label: t.on, detail: t.downloadFailed };
  if (proxy.state !== "running") return { tone: "danger" as Tone, label: t.on, detail: t.down };
  const detail = totals.requests === 0 ? t.noRequests : t.counts(totals.requests, totals.masked);
  return { tone: "ok" as Tone, label: t.on, detail };
}

function Summary({ threadId, isExpanded, onToggle }: ExperimentalThreadContextSegmentProps) {
  const t = useMessages(messages);
  const routed = useRouted(threadId);
  const { data: status } = useThreadStatus(threadId);
  const { tone, label, detail } = describe(status, routed, t);
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={isExpanded}
      className={cn(
        "flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-xs transition-colors hover:bg-state-hover",
        tone === "danger" ? "text-red-600 dark:text-red-400" : "text-muted-foreground",
      )}
    >
      <span aria-hidden className={cn("size-2 shrink-0 rounded-full", DOT[tone])} />
      <span className={cn("shrink-0", tone === "danger" && "font-medium")}>{label}</span>
      {detail !== null && <span className="min-w-0 truncate">— {detail}</span>}
    </button>
  );
}

function Action({ threadId }: ExperimentalThreadContextSegmentProps) {
  const t = useMessages(messages);
  const rpc = useRpc<RpcContract>();
  const lang = useLang();
  const routed = useRouted(threadId);
  const { data: status, refetch } = useThreadStatus(threadId);
  const [busy, setBusy] = useState(false);
  if (!routed || status === null) return null;
  const on = status.masking;
  const toggle = () => {
    setBusy(true);
    rpc
      .call("thread_set_masking", { threadId, masking: !on, lang })
      .then(refetch, refetch)
      .finally(() => setBusy(false));
  };
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={on ? t.turnOff : t.turnOn}
      title={on ? t.turnOff : t.turnOn}
      disabled={busy}
      onClick={toggle}
      className={cn(
        "relative inline-flex h-4 w-7 shrink-0 items-center rounded-full transition-colors disabled:opacity-60",
        on ? "bg-emerald-500" : "bg-red-500",
      )}
    >
      <span
        aria-hidden
        className={cn(
          "inline-block size-3 rounded-full bg-white shadow transition-transform",
          on ? "translate-x-3.5" : "translate-x-0.5",
        )}
      />
    </button>
  );
}

function formatTime(at: number, locale: string): string {
  return new Intl.DateTimeFormat(locale, { hour: "2-digit", minute: "2-digit", second: "2-digit" }).format(at);
}

function maskedText(entry: FeedEntry, t: (typeof messages)["en"]): string {
  if (entry.via !== "proxy") return "";
  if (entry.masked === null) return t.maskedUnknown;
  const parts = Object.entries(entry.masked)
    .filter(([, count]) => count > 0)
    .sort((a, b) => b[1] - a[1])
    .map(([category, count]) => `${t.category(category)} ${count}`);
  return parts.length === 0 ? t.maskedNone : parts.join(", ");
}

function FeedRow({ entry }: { entry: FeedEntry }) {
  const t = useMessages(messages);
  const locale = intlLocale(useLang());
  const failed = entry.error !== null || (entry.status !== null && entry.status >= 400);
  const via = entry.via === "proxy" ? t.viaProxy : entry.via === "direct" ? t.viaDirect : t.viaBlocked;
  const seconds =
    entry.durationMs === null
      ? "…"
      : t.seconds(new Intl.NumberFormat(locale, { maximumFractionDigits: 1 }).format(entry.durationMs / 1000));
  const what = entry.path.endsWith("/count_tokens") ? t.countTokens : (entry.model ?? "—");
  const masked = maskedText(entry, t);
  return (
    <li className="flex flex-wrap items-baseline gap-x-2 gap-y-0.5 py-1 text-xs" title={entry.error ?? undefined}>
      <span className="shrink-0 tabular-nums text-muted-foreground">{formatTime(entry.at, locale)}</span>
      <span className="min-w-0 truncate">{what}</span>
      <span
        className={cn(
          "shrink-0",
          entry.via === "proxy" ? "text-emerald-600 dark:text-emerald-400" : "text-red-600 dark:text-red-400",
        )}
      >
        {via}
      </span>
      {masked !== "" && <span className="min-w-0 text-muted-foreground">{masked}</span>}
      <span className="ml-auto flex shrink-0 gap-2 tabular-nums">
        <span className={failed ? "text-red-600 dark:text-red-400" : "text-muted-foreground"}>{entry.status ?? "…"}</span>
        <span className="text-muted-foreground">{seconds}</span>
      </span>
    </li>
  );
}

function proxyLine(status: ThreadStatus, t: (typeof messages)["en"]): string {
  if (!status.masking) return t.offHint;
  const { state, message, problem } = status.proxy;
  if (state === "running") return t.proxyRunning;
  if (state === "installing") return t.proxyInstalling;
  if (state === "starting") return t.proxyStarting;
  if (state === "not-configured") return problem === "no-file" ? t.proxyNoFile(message ?? "") : t.proxyNoSource;
  if (problem === "download") return t.proxyDownloadFailed(message ?? state);
  return t.proxyDown(message ?? state);
}

function Details({ threadId, isExpanded }: ExperimentalThreadContextSegmentProps) {
  const t = useMessages(messages);
  const routed = useRouted(threadId);
  const { data: status } = useThreadStatus(threadId);
  const { data: entries } = useFeed(threadId, isExpanded && routed);
  if (!isExpanded || !routed || status === null) return null;
  return (
    <div className="flex max-h-72 flex-col gap-1 overflow-y-auto px-1 pb-2 pt-1">
      <p className={cn("text-xs", status.masking && status.proxy.state === "running" ? "text-muted-foreground" : "text-red-600 dark:text-red-400")}>
        {proxyLine(status, t)}
      </p>
      {entries !== null && entries.length === 0 ? (
        <div className="text-xs text-muted-foreground">
          <p>{t.empty}</p>
          <p className="mt-0.5">{t.emptyHint}</p>
        </div>
      ) : (
        <ul className="divide-y divide-border">
          {(entries ?? []).map((entry) => (
            <FeedRow key={entry.id} entry={entry} />
          ))}
        </ul>
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.experimental_threadContextSegment({
    id: "masking",
    title: "Masking",
    group: "0_masking",
    summary: Summary,
    action: Action,
    details: Details,
    useVisible,
  });
});
