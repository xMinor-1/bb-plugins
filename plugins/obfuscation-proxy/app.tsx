// Obfuscation Proxy — the masking state of a thread, above its message box.
//
// The segment shows in every thread. For an external model the plugin routes,
// it says whether masking is on, with a switch at the row's end; expanded, it
// lists the thread's model requests: when, which model, how they left and what
// was masked. For an in-network model or an agent the plugin does not route yet,
// it stays muted with the reason and a disabled switch.
import { useCallback, useEffect, useRef, useState } from "react";
import { createPortal } from "react-dom";
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
import { usePortalScopeProps } from "@/lib/portal-scope";
import { cn } from "@/lib/utils";
import { messages } from "./src/messages";
import {
  parsePrefixes,
  segmentLed,
  segmentMode,
  PROXY_CHANGED,
  THREAD_CHANGED,
  type FeedEntry,
  type Led,
  type SegmentMode,
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

/** What the segment shows for this thread's model; null while the composer has no selection. */
function useMode(threadId: string): SegmentMode | null {
  const selection = useThreadSelection(threadId);
  const corporate = parsePrefixes(useSettings().values?.corporateModels);
  if (selection === null) return null;
  return segmentMode(selection.providerId, selection.model, corporate);
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

function useThreadStatus(threadId: string, enabled: boolean) {
  const rpc = useRpc<RpcContract>();
  const lang = useLang();
  const load = useCallback(() => rpc.call("thread_status", { threadId, lang }), [rpc, threadId, lang]);
  return useThreadQuery<ThreadStatus>(threadId, load, enabled);
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
  const hidden = useSettings().values?.hideSegment === true;
  const mode = useMode(threadId);
  return !hidden && mode !== null;
}

function useRouted(threadId: string): boolean {
  return useMode(threadId) === "routed";
}


/** The LED colors: a lit core with a soft halo, the same in light and dark themes. */
const LED_STYLE: Record<Led, React.CSSProperties> = {
  on: {
    background: "radial-gradient(circle at 35% 30%, #a7f3d0 0%, #34d399 35%, #059669 100%)",
    boxShadow: "0 0 0 1px rgb(5 150 105 / 0.35), 0 0 6px 1px rgb(16 185 129 / 0.55)",
  },
  off: {
    background: "radial-gradient(circle at 35% 30%, #fde68a 0%, #f59e0b 45%, #b45309 100%)",
    boxShadow: "0 0 0 1px rgb(180 83 9 / 0.35), 0 0 4px rgb(245 158 11 / 0.35)",
  },
  problem: {
    background: "radial-gradient(circle at 35% 30%, #fecaca 0%, #ef4444 45%, #b91c1c 100%)",
    boxShadow: "0 0 0 1px rgb(185 28 28 / 0.35), 0 0 6px 1px rgb(239 68 68 / 0.5)",
  },
  idle: {
    background: "radial-gradient(circle at 35% 30%, rgb(255 255 255 / 0.35) 0%, transparent 60%), rgb(148 163 184 / 0.55)",
    boxShadow: "inset 0 0 0 1px rgb(100 116 139 / 0.35)",
  },
  loading: {
    background: "rgb(148 163 184 / 0.35)",
    boxShadow: "inset 0 0 0 1px rgb(100 116 139 / 0.25)",
  },
};

function LedDot({ led }: { led: Led }) {
  return (
    <span
      aria-hidden
      data-led={led}
      className={cn("inline-block size-2 shrink-0 rounded-full", led === "loading" && "animate-pulse")}
      style={LED_STYLE[led]}
    />
  );
}

/** What the current state means, for the tooltip. */
function tipLines(mode: SegmentMode, status: ThreadStatus | null, t: (typeof messages)["en"]): string[] {
  if (mode === "in-network") return [t.tipInNetwork];
  if (mode === "unavailable") return [t.tipUnavailable];
  if (status === null) return [];
  if (!status.masking) return [t.tipOff];
  if (status.proxy.state !== "running") return [proxyLine(status, t)];
  const { totals } = status;
  return [t.tipOn, totals.requests === 0 ? t.noRequests : t.counts(totals.requests, totals.masked)];
}

const TIP_DELAY_MS = 500;

/** A tooltip that opens after a short hover or on keyboard focus, portaled above the anchor. */
function useDelayedTip() {
  const anchor = useRef<HTMLElement | null>(null);
  const timer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const [box, setBox] = useState<DOMRect | null>(null);
  const clear = () => {
    if (timer.current !== null) clearTimeout(timer.current);
    timer.current = null;
  };
  const show = (delay: number) => {
    clear();
    timer.current = setTimeout(() => {
      if (anchor.current !== null) setBox(anchor.current.getBoundingClientRect());
    }, delay);
  };
  const hide = () => {
    clear();
    setBox(null);
  };
  useEffect(() => clear, []);
  const handlers = {
    onPointerEnter: (event: React.PointerEvent) => {
      if (event.pointerType === "mouse") show(TIP_DELAY_MS);
    },
    onPointerLeave: hide,
    onFocus: () => show(0),
    onBlur: hide,
    onPointerDown: hide,
  };
  return { anchor, box, handlers };
}

function Tip({ box, lines }: { box: DOMRect; lines: string[] }) {
  const scope = usePortalScopeProps();
  const ref = useRef<HTMLDivElement | null>(null);
  const [shift, setShift] = useState(0);
  useEffect(() => {
    const node = ref.current;
    if (node === null) return;
    const rect = node.getBoundingClientRect();
    const overRight = rect.right - (window.innerWidth - 8);
    const overLeft = 8 - rect.left;
    setShift(overRight > 0 ? -overRight : overLeft > 0 ? overLeft : 0);
  }, [box]);
  return createPortal(
    <div
      {...scope}
      ref={ref}
      role="tooltip"
      data-masking-tip=""
      style={{ position: "fixed", left: box.left + shift, bottom: window.innerHeight - box.top + 6, zIndex: 60 }}
      className="pointer-events-none max-w-72 rounded-md border border-border bg-popover px-2 py-1 text-xs text-popover-foreground shadow-md"
    >
      {lines.map((line) => (
        <p key={line}>{line}</p>
      ))}
    </div>,
    document.body,
  );
}

function Summary({ threadId, isExpanded, onToggle }: ExperimentalThreadContextSegmentProps) {
  const t = useMessages(messages);
  const mode = useMode(threadId) ?? "unavailable";
  const routed = mode === "routed";
  const { data: status } = useThreadStatus(threadId, routed);
  const led = segmentLed(mode, status);
  const lines = tipLines(mode, status, t);
  const { anchor, box, handlers } = useDelayedTip();
  const tip = box !== null && lines.length > 0 ? <Tip box={box} lines={lines} /> : null;
  const label = (
    <>
      <LedDot led={led} />
      <span className="shrink-0">{t.title}</span>
    </>
  );
  if (!routed) {
    return (
      <span
        ref={anchor}
        tabIndex={0}
        data-masking-state={mode}
        aria-label={`${t.title}: ${lines.join(" ")}`}
        className="flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-xs text-muted-foreground/70 outline-none focus-visible:ring-1 focus-visible:ring-ring"
        {...handlers}
      >
        {label}
        {tip}
      </span>
    );
  }
  return (
    <button
      ref={(node) => {
        anchor.current = node;
      }}
      type="button"
      onClick={onToggle}
      aria-expanded={isExpanded}
      aria-label={lines.length > 0 ? `${t.title}: ${lines.join(" ")}` : t.title}
      data-masking-state={led}
      className={cn(
        "flex min-w-0 items-center gap-1.5 rounded-md px-1 py-0.5 text-xs transition-colors hover:bg-state-hover",
        led === "problem" ? "text-red-600 dark:text-red-400" : "text-muted-foreground",
      )}
      {...handlers}
    >
      {label}
      {tip}
    </button>
  );
}

function Action({ threadId }: ExperimentalThreadContextSegmentProps) {
  const t = useMessages(messages);
  const rpc = useRpc<RpcContract>();
  const lang = useLang();
  const routed = useRouted(threadId);
  const { data: status, refetch } = useThreadStatus(threadId, routed);
  const [busy, setBusy] = useState(false);
  if (!routed) return null;
  if (status === null) return null;
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
        on ? "bg-emerald-500" : "bg-amber-500",
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
  const { data: status } = useThreadStatus(threadId, routed);
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
