// bb-plugin-automation-hub — frontend.
//
// Three places show the same live overview of bb's automations:
//   - the "Automation Hub" nav panel: every automation grouped by what it
//     needs from the person, with pause/resume, run now, run history and
//     "fix with an agent"; counts and a language switch in its title bar;
//   - a segment in the context row above every thread's composer: the counts,
//     and a menu with what failed, what runs now, what is next and shortcuts;
//   - a badge on the rail entry while something is failing.
// Commands in bb's palette, with default keys, open the hub, the menu in the
// current chat, a new automation, or turn the current chat into one.
import { useCallback, useEffect, useMemo, useRef, useState, useSyncExternalStore } from "react";
import type { ReactNode } from "react";
import {
  definePluginApp,
  useBbNavigate,
  useComposers,
  useRealtime,
  useRpc,
  type ExperimentalBadge,
  type PluginNavPanelProps,
} from "@get-bb/plugin-sdk/app";
import type { HubItem, HubRun, rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { LanguageSwitch, intlLocale, messagesNow, useLang, useMessages, type Lang } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { messages, type Messages } from "./src/messages";
import { describeCron, everyText, hoursText } from "./src/schedule";

const PANEL_PATH = "automation-hub";
const POLL_MS = 15_000;
const TOGGLE_MENU = "automation-hub:toggle-menu";
const MAKE_REGULAR = "automation-hub:make-regular";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type Nav = ReturnType<typeof useBbNavigate>;
type Overview = { items: HubItem[]; fetchedAt: number; templates: { title: string; description: string; prompt: string }[]; error: string | null };

// ---------- one shared overview for the page, the chat segment and the badge ----------

const store = (() => {
  let value: Overview | null = null;
  let failure: string | null = null;
  let rpc: Rpc | null = null;
  let timer: ReturnType<typeof setInterval> | null = null;
  let inflight: Promise<void> | null = null;
  const listeners = new Set<() => void>();
  const emit = () => listeners.forEach((l) => l());
  const refresh = (): Promise<void> => {
    if (!rpc) return Promise.resolve();
    if (inflight) return inflight;
    inflight = rpc
      .call("hub_overview", null)
      .then(
        (next) => {
          value = next;
          failure = null;
        },
        (error: unknown) => {
          failure = error instanceof Error ? error.message : String(error);
        },
      )
      .finally(() => {
        inflight = null;
        emit();
      });
    return inflight;
  };
  return {
    get: () => value,
    failure: () => failure,
    refresh,
    attach(next: Rpc) {
      rpc = next;
    },
    subscribe(listener: () => void) {
      listeners.add(listener);
      if (listeners.size === 1) {
        void refresh();
        timer = setInterval(() => {
          if (typeof document === "undefined" || document.visibilityState !== "hidden") void refresh();
        }, POLL_MS);
      }
      return () => {
        listeners.delete(listener);
        if (listeners.size === 0 && timer) {
          clearInterval(timer);
          timer = null;
        }
      };
    },
  };
})();

/** The last navigator a mounted component saw; commands run outside React. */
let lastNav: Nav | null = null;

function useOverview() {
  const rpc = useRpc<typeof rpcContract>();
  store.attach(rpc);
  lastNav = useBbNavigate();
  const value = useSyncExternalStore(store.subscribe, store.get, store.get);
  const failure = useSyncExternalStore(store.subscribe, store.failure, store.failure);
  useRealtime("hub-changed", () => void store.refresh());
  return { rpc, overview: value, failure, refresh: store.refresh };
}

// ---------- grouping and counts ----------

type GroupKey = "attention" | "watching" | "scheduled" | "paused" | "finished";
const GROUP_KEYS: GroupKey[] = ["attention", "watching", "scheduled", "paused", "finished"];

function groupOf(item: HubItem): GroupKey {
  if (item.status === "failed" || item.status === "auto-paused") return "attention";
  if (item.status === "finished") return "finished";
  if (!item.enabled) return "paused";
  return item.kind === "watch" ? "watching" : "scheduled";
}

function groupTitle(t: Messages, key: GroupKey): string {
  return { attention: t.groupsAttention, watching: t.groupsWatching, scheduled: t.groupsScheduled, paused: t.groupsPaused, finished: t.groupsFinished }[key];
}

function groupHint(t: Messages, key: GroupKey): string {
  return { attention: t.hintsAttention, watching: t.hintsWatching, scheduled: t.hintsScheduled, paused: t.hintsPaused, finished: t.hintsFinished }[key];
}

function counts(items: HubItem[]) {
  let active = 0;
  let watching = 0;
  let paused = 0;
  let attention = 0;
  let running = 0;
  for (const item of items) {
    const g = groupOf(item);
    if (g === "attention") attention++;
    if (g === "paused") paused++;
    if (g === "watching") watching++;
    if (item.enabled && g !== "attention") active++;
    if (item.status === "running") running++;
  }
  return { active, watching, paused, attention, running };
}

const byNext = (a: HubItem, b: HubItem) =>
  (a.nextRunAt ?? Number.MAX_SAFE_INTEGER) - (b.nextRunAt ?? Number.MAX_SAFE_INTEGER) || a.name.localeCompare(b.name);

// ---------- words ----------

function relative(at: number | null, now: number, lang: Lang): string {
  if (at === null) return "";
  const rtf = new Intl.RelativeTimeFormat(intlLocale(lang), { numeric: "auto" });
  const diff = at - now;
  const abs = Math.abs(diff);
  if (abs < 45_000) return rtf.format(0, "second");
  if (abs < 3_600_000) return rtf.format(Math.round(diff / 60_000), "minute");
  if (abs < 86_400_000) return rtf.format(Math.round(diff / 3_600_000), "hour");
  return rtf.format(Math.round(diff / 86_400_000), "day");
}

function clock(at: number, lang: Lang): string {
  return new Date(at).toLocaleString(intlLocale(lang), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" });
}

function scheduleText(item: HubItem, t: Messages, lang: Lang): string {
  if (item.kind === "once") return item.runAt ? `${t.once}, ${clock(item.runAt, lang)}` : t.once;
  if (item.kind === "watch" && item.everySeconds !== null) return everyText(item.everySeconds, lang);
  return item.cron ? describeCron(item.cron, lang) : "";
}

function activeHours(item: HubItem, lang: Lang): string | null {
  return item.kind === "watch" && item.cron ? hoursText(item.cron, lang) : null;
}

function statusText(item: HubItem, now: number, t: Messages, lang: Lang): string {
  switch (item.status) {
    case "running":
      return t.statusRunning;
    case "failed":
      return t.statusFailed(relative(item.lastRunAt, now, lang));
    case "auto-paused":
      return t.statusAutoPaused;
    case "paused":
      return t.statusPaused;
    case "finished":
      return t.statusFinished(relative(item.lastRunAt, now, lang));
    case "never":
      return item.nextRunAt ? t.statusFirstRun(relative(item.nextRunAt, now, lang)) : t.statusNotRunYet;
    default:
      return item.nextRunAt ? t.statusNext(relative(item.nextRunAt, now, lang)) : t.statusLast(relative(item.lastRunAt, now, lang));
  }
}

function duration(run: HubRun, t: Messages): string {
  if (run.finishedAt === null) return t.durationRunning;
  const s = Math.max(0, Math.round((run.finishedAt - run.startedAt) / 1000));
  return s < 60 ? t.durationSeconds(s) : t.durationMinutes(Math.floor(s / 60), s % 60);
}

function useNow(ms = 30_000) {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    const timer = setInterval(() => setNow(Date.now()), ms);
    return () => clearInterval(timer);
  }, [ms]);
  return now;
}

// ---------- keyboard shortcuts ----------

type ShortcutId = "openHub" | "menu" | "newAutomation" | "makeRegular";
const SHORTCUTS: Record<ShortcutId, { key: string; mod: true; alt: true }> = {
  openHub: { key: "a", mod: true, alt: true },
  menu: { key: "m", mod: true, alt: true },
  newAutomation: { key: "n", mod: true, alt: true },
  makeRegular: { key: "r", mod: true, alt: true },
};
const IS_MAC = typeof navigator !== "undefined" && /Mac|iPhone|iPad/.test(navigator.platform || navigator.userAgent);

function shortcutLabel(id: ShortcutId): string {
  const key = SHORTCUTS[id].key.toUpperCase();
  return IS_MAC ? `⌥⌘${key}` : `Ctrl+Alt+${key}`;
}

function Kbd({ id }: { id: ShortcutId }) {
  return (
    <kbd className="ml-auto hidden shrink-0 rounded border border-border px-1 font-sans text-[10px] text-muted-foreground sm:inline" aria-hidden>
      {shortcutLabel(id)}
    </kbd>
  );
}

// ---------- actions shared by the page, the menu and the commands ----------

function openFix(nav: Nav, item: HubItem, t: Messages) {
  nav.toCompose({ projectId: item.projectId, initialPrompt: t.promptsFix(item.name, item.id, item.projectName, item.lastError), focusPrompt: true });
}

function openNew(nav: Nav, t: Messages, projectId?: string) {
  nav.toCompose({ projectId, initialPrompt: t.promptsNewAutomation, focusPrompt: true });
}

function openHub(nav: Nav, subPath?: string) {
  nav.toPluginPanel(PANEL_PATH, subPath ? { subPath } : undefined);
}

// ---------- small pieces ----------

function Dot({ status }: { status: HubItem["status"] }) {
  const tone =
    status === "failed" || status === "auto-paused"
      ? "bg-destructive"
      : status === "running"
        ? "bg-sky-500 animate-pulse"
        : status === "paused" || status === "finished"
          ? "bg-muted-foreground/40"
          : status === "never"
            ? "border border-muted-foreground/60 bg-transparent"
            : "bg-emerald-500";
  return <span aria-hidden className={cn("inline-block size-2 shrink-0 rounded-full", tone)} />;
}

function Strip({ strip }: { strip: string }) {
  const t = useMessages(messages);
  const cells = strip.slice(-30).split("");
  const fired = cells.filter((c) => c === "h").length;
  return (
    <span className="flex items-center gap-[2px]" title={t.runsStripTitle(cells.length, fired)} data-strip>
      {cells.map((c, i) => (
        <span
          key={i}
          className={cn(
            "inline-block h-3 w-[3px] rounded-[1px]",
            c === "h" ? "bg-amber-500" : c === "e" ? "bg-destructive" : c === "r" ? "bg-sky-500" : "bg-muted-foreground/25",
          )}
        />
      ))}
    </span>
  );
}

function Toggle({ on, busy, onChange, label }: { on: boolean; busy: boolean; onChange: (next: boolean) => void; label: string }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={on}
      aria-label={label}
      title={label}
      disabled={busy}
      onClick={(event) => {
        event.stopPropagation();
        onChange(!on);
      }}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full transition-colors disabled:cursor-wait disabled:opacity-60",
        on ? "bg-foreground" : "bg-muted-foreground/30",
      )}
    >
      <span className={cn("inline-block size-4 rounded-full bg-background shadow transition-transform", on ? "translate-x-[18px]" : "translate-x-[2px]")} />
    </button>
  );
}

type ChipKey = "attention" | "running" | "active" | "watching" | "paused";

function Chip({ children, tone = "neutral", k, small, onClick }: { children: ReactNode; tone?: "neutral" | "critical" | "watch"; k: ChipKey; small?: boolean; onClick?: () => void }) {
  const className = cn(
    "inline-flex items-center gap-1 whitespace-nowrap rounded-full border",
    small ? "h-5 px-1.5 text-[11px]" : "h-6 px-2 text-xs",
    tone === "critical" ? "border-destructive/40 text-destructive" : tone === "watch" ? "border-amber-500/40 text-foreground" : "border-border text-muted-foreground",
    onClick && "cursor-pointer hover:bg-state-hover",
  );
  return onClick ? (
    <button type="button" data-k={k} className={className} onClick={onClick}>
      {children}
    </button>
  ) : (
    <span data-k={k} className={className}>
      {children}
    </span>
  );
}

/** The counts as chips; `onChip` makes them buttons, `compact` leaves out paused. */
function Counts({ items, small, compact, onChip }: { items: HubItem[]; small?: boolean; compact?: boolean; onChip?: (key: ChipKey) => void }) {
  const t = useMessages(messages);
  const c = counts(items);
  const click = (key: ChipKey) => (onChip ? () => onChip(key) : undefined);
  return (
    <>
      {c.attention > 0 ? (
        <Chip k="attention" tone="critical" small={small} onClick={click("attention")}>
          <Icon name="AlertTriangle" className="size-3" />
          {t.chipsAttention(c.attention)}
        </Chip>
      ) : null}
      {c.running > 0 ? (
        <Chip k="running" small={small} onClick={click("running")}>
          <span className="inline-block size-1.5 animate-pulse rounded-full bg-sky-500" />
          {t.chipsRunning(c.running)}
        </Chip>
      ) : null}
      <Chip k="active" small={small} onClick={click("active")}>
        {t.chipsActive(c.active)}
      </Chip>
      {c.watching > 0 ? (
        <Chip k="watching" tone="watch" small={small} onClick={click("watching")}>
          {t.chipsWatching(c.watching)}
        </Chip>
      ) : null}
      {!compact && c.paused > 0 ? (
        <Chip k="paused" small={small} onClick={click("paused")}>
          {t.chipsPaused(c.paused)}
        </Chip>
      ) : null}
    </>
  );
}

const chipGroup: Record<ChipKey, GroupKey> = { attention: "attention", running: "scheduled", active: "scheduled", watching: "watching", paused: "paused" };

// ---------- runs ----------

function Runs({ rpc, item }: { rpc: Rpc; item: HubItem }) {
  const nav = useBbNavigate();
  const t = useMessages(messages);
  const lang = useLang();
  const [runs, setRuns] = useState<HubRun[] | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [onlyFindings, setOnlyFindings] = useState(item.kind === "watch");
  const load = useCallback(() => {
    rpc.call("hub_runs", { projectId: item.projectId, automationId: item.id, limit: item.kind === "watch" ? 60 : 20 }).then(
      (r) => {
        setRuns(r.runs);
        setError(null);
      },
      (e: unknown) => setError(e instanceof Error ? e.message : String(e)),
    );
  }, [rpc, item.projectId, item.id, item.kind]);
  useEffect(load, [load, item.lastRunAt, item.status]);
  if (error) return <p className="text-xs text-destructive">{error}</p>;
  if (runs === null) return <p className="text-xs text-muted-foreground">{t.runsLoading}</p>;
  const shown = onlyFindings ? runs.filter((r) => r.status !== "succeeded" || (r.output ?? "").trim() !== "") : runs;
  const label = (run: HubRun) =>
    run.status === "succeeded" && (run.output ?? "").trim() !== "" && item.kind === "watch"
      ? t.runsFound
      : run.status === "succeeded"
        ? t.runsDone
        : run.status === "failed"
          ? t.runsFailed
          : run.status === "running"
            ? t.runsRunning
            : t.runsSkipped;
  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <span className="text-xs font-medium text-muted-foreground">{t.runsTitle}</span>
        {item.kind === "watch" ? (
          <button type="button" className="text-xs text-muted-foreground underline-offset-2 hover:underline" onClick={() => setOnlyFindings((v) => !v)}>
            {onlyFindings ? t.runsShowAll(runs.length) : t.runsOnlyFindings}
          </button>
        ) : null}
      </div>
      {shown.length === 0 ? (
        <p className="text-xs text-muted-foreground">{runs.length === 0 ? t.runsNone : t.runsNothingFound(runs.length)}</p>
      ) : (
        <ul className="divide-y divide-border rounded-md border border-border" data-runs>
          {shown.slice(0, 20).map((run) => (
            <li key={run.id} className="px-3 py-2 text-xs">
              <div className="flex items-center gap-2">
                <span className={cn("font-medium", run.status === "failed" ? "text-destructive" : run.status === "running" ? "text-sky-600" : "text-foreground")}>
                  {label(run)}
                </span>
                <span className="text-muted-foreground">{clock(run.startedAt, lang)}</span>
                <span className="text-muted-foreground">{duration(run, t)}</span>
                {run.trigger === "manual" ? <span className="text-muted-foreground">{t.runsByHand}</span> : null}
                <span className="flex-1" />
                {run.threadId ? (
                  <button type="button" className="text-foreground underline-offset-2 hover:underline" onClick={() => nav.toThread(run.threadId!, { split: true })}>
                    {t.runsOpenChat}
                  </button>
                ) : null}
              </div>
              {run.error ? <p className="mt-1 whitespace-pre-wrap break-words text-destructive">{run.error}</p> : null}
              {run.skipReason ? <p className="mt-1 text-muted-foreground">{run.skipReason}</p> : null}
              {run.output && run.output.trim() !== "" ? (
                <pre className="mt-1 max-h-32 overflow-auto whitespace-pre-wrap break-words rounded bg-muted px-2 py-1 font-mono text-[11px]">{run.output.trim()}</pre>
              ) : null}
            </li>
          ))}
        </ul>
      )}
    </div>
  );
}

// ---------- a row of the page ----------

type Deleted = { id: string; name: string; restorable: boolean };

function Row({ rpc, item, now, open, onOpen, onDeleted }: { rpc: Rpc; item: HubItem; now: number; open: boolean; onOpen: () => void; onDeleted: (d: Deleted) => void }) {
  const nav = useBbNavigate();
  const t = useMessages(messages);
  const lang = useLang();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [confirmRun, setConfirmRun] = useState(false);
  const [confirmDelete, setConfirmDelete] = useState(false);
  const confirmTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const deleteTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(
    () => () => {
      if (confirmTimer.current) clearTimeout(confirmTimer.current);
      if (deleteTimer.current) clearTimeout(deleteTimer.current);
    },
    [],
  );
  const remove = async () => {
    if (!confirmDelete) {
      setConfirmDelete(true);
      deleteTimer.current = setTimeout(() => setConfirmDelete(false), 4000);
      return;
    }
    setConfirmDelete(false);
    setBusy(true);
    setError(null);
    try {
      const result = await rpc.call("hub_delete", { projectId: item.projectId, automationId: item.id });
      onDeleted({ id: item.id, name: item.name, restorable: result.restorable });
      await store.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
      setBusy(false);
    }
  };
  const act = async (method: "hub_pause" | "hub_resume" | "hub_run") => {
    setBusy(true);
    setError(null);
    try {
      await rpc.call(method, { projectId: item.projectId, automationId: item.id });
      await store.refresh();
    } catch (e) {
      setError(e instanceof Error ? e.message : String(e));
    } finally {
      setBusy(false);
    }
  };
  const runNow = () => {
    if (!confirmRun) {
      setConfirmRun(true);
      confirmTimer.current = setTimeout(() => setConfirmRun(false), 4000);
      return;
    }
    setConfirmRun(false);
    void act("hub_run");
  };
  const attention = groupOf(item) === "attention";
  const when = scheduleText(item, t, lang);
  const hours = activeHours(item, lang);
  return (
    <li id={`hub-row-${item.id}`} className={cn("scroll-mt-4 text-sm", open && "bg-muted/40")} data-row={item.id} data-group={groupOf(item)}>
      <div
        role="button"
        tabIndex={0}
        aria-expanded={open}
        onClick={onOpen}
        onKeyDown={(e) => {
          if (e.key === "Enter" || e.key === " ") {
            e.preventDefault();
            onOpen();
          }
        }}
        className="flex cursor-pointer items-center gap-3 px-4 py-2.5 hover:bg-state-hover"
      >
        <Dot status={item.status} />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <span className="truncate font-medium">{item.name}</span>
            {item.mode === "script" && item.kind !== "watch" ? <span className="shrink-0 text-xs text-muted-foreground">{t.script}</span> : null}
          </div>
          <div className="flex min-w-0 items-center gap-2 text-xs text-muted-foreground">
            <span className="shrink-0">{when}</span>
            {hours ? <span className="hidden shrink-0 sm:inline">{hours}</span> : null}
            <span className="truncate">{item.projectName}</span>
          </div>
          {attention && item.lastError ? (
            <p className="mt-0.5 line-clamp-2 break-words text-xs text-destructive" data-why>
              {item.lastError}
            </p>
          ) : null}
        </div>
        {item.kind === "watch" && item.strip ? (
          <span className="hidden md:flex">
            <Strip strip={item.strip} />
          </span>
        ) : null}
        <span className={cn("hidden w-48 shrink-0 truncate whitespace-nowrap text-right text-xs sm:block", attention ? "text-destructive" : "text-muted-foreground")}>
          {statusText(item, now, t, lang)}
        </span>
        {item.status === "finished" ? (
          <span className="w-9" />
        ) : (
          <Toggle
            on={item.enabled}
            busy={busy}
            label={item.enabled ? t.pause(item.name) : t.resume(item.name)}
            onChange={(next) => void act(next ? "hub_resume" : "hub_pause")}
          />
        )}
      </div>
      {error ? (
        <p role="alert" className="px-4 pb-2 text-xs text-destructive">
          {error}
        </p>
      ) : null}
      {open ? (
        <div className="space-y-3 border-t border-border px-4 py-3" data-details>
          <div className="flex flex-wrap items-center gap-2">
            {attention ? (
              <Button size="sm" onClick={() => openFix(nav, item, t)}>
                <Icon name="ToolCase" className="size-4" />
                {t.fix}
              </Button>
            ) : null}
            {item.status !== "finished" ? (
              <Button size="sm" variant="outline" disabled={busy || item.status === "running"} onClick={runNow} data-run>
                <Icon name="Play" className="size-4" />
                {confirmRun ? (item.mode === "agent" ? t.confirmAgentRun : t.confirmCheck) : t.runNow}
              </Button>
            ) : null}
            <Button
              size="sm"
              variant="outline"
              onClick={() => nav.toCompose({ projectId: item.projectId, initialPrompt: t.promptsChange(item.name, item.id, item.projectName), focusPrompt: true })}
            >
              <Icon name="MessageSquare" className="size-4" />
              {t.change}
            </Button>
            {item.lastRunThreadId ? (
              <Button size="sm" variant="ghost" onClick={() => nav.toThread(item.lastRunThreadId!, { split: true })}>
                {t.lastRunChat}
              </Button>
            ) : null}
            {item.createdByThreadId ? (
              <Button size="sm" variant="ghost" onClick={() => nav.toThread(item.createdByThreadId!, { split: true })}>
                {t.sourceChat}
              </Button>
            ) : null}
            <span className="flex-1" />
            <Button
              size="sm"
              variant="ghost"
              className={cn("text-destructive hover:text-destructive", confirmDelete && "bg-destructive/10")}
              disabled={busy}
              onClick={() => void remove()}
              data-delete
            >
              <Icon name="Trash2" className="size-4" />
              {confirmDelete ? t.confirmDelete : t.delete}
            </Button>
          </div>
          <dl className="grid grid-cols-[9rem_1fr] gap-x-3 gap-y-1 text-xs">
            <dt className="text-muted-foreground">{t.detailsWhen}</dt>
            <dd>
              {when}
              {hours ? `, ${hours.toLowerCase()}` : ""}
              {item.timezone ? <span className="text-muted-foreground"> ({item.timezone})</span> : null}
              {item.cron ? <span className="ml-2 font-mono text-muted-foreground">{item.cron}</span> : null}
            </dd>
            {item.nextRunAt ? (
              <>
                <dt className="text-muted-foreground">{t.detailsNextRun}</dt>
                <dd>{clock(item.nextRunAt, lang)}</dd>
              </>
            ) : null}
            {item.kind === "watch" && item.firedRecently !== null ? (
              <>
                <dt className="text-muted-foreground">{t.detailsFound}</dt>
                <dd>{item.firedRecently === 0 ? t.detailsFoundNone : t.detailsFoundSome(item.firedRecently)}</dd>
              </>
            ) : null}
            {item.onHit ? (
              <>
                <dt className="text-muted-foreground">{t.detailsOnHit}</dt>
                <dd className="whitespace-pre-wrap">{item.onHit}</dd>
              </>
            ) : null}
            {item.prompt ? (
              <>
                <dt className="text-muted-foreground">{t.detailsTask}</dt>
                <dd className="line-clamp-6 whitespace-pre-wrap break-words">{item.prompt}</dd>
              </>
            ) : null}
            {item.scriptPath ? (
              <>
                <dt className="text-muted-foreground">{t.detailsScript}</dt>
                <dd className="break-all font-mono">{item.scriptPath}</dd>
              </>
            ) : null}
          </dl>
          <Runs rpc={rpc} item={item} />
        </div>
      ) : null}
    </li>
  );
}

// ---------- the page ----------

function Templates({ templates }: { templates: Overview["templates"] }) {
  const nav = useBbNavigate();
  const t = useMessages(messages);
  if (templates.length === 0) return null;
  return (
    <section className="mt-6" data-templates>
      <h2 className="mb-2 text-xs font-medium uppercase tracking-wide text-muted-foreground">{t.templates}</h2>
      <div className="grid gap-2 sm:grid-cols-2">
        {templates.map((tpl) => (
          <button
            key={tpl.title}
            type="button"
            className="rounded-lg border border-border bg-card px-3 py-2.5 text-left hover:bg-state-hover"
            onClick={() => nav.toCompose({ initialPrompt: tpl.prompt, focusPrompt: true })}
          >
            <div className="text-sm font-medium">{tpl.title}</div>
            {tpl.description ? <div className="mt-0.5 text-xs text-muted-foreground">{tpl.description}</div> : null}
          </button>
        ))}
      </div>
    </section>
  );
}

function HubPage({ subPath }: PluginNavPanelProps) {
  const { rpc, overview, failure } = useOverview();
  const t = useMessages(messages);
  const now = useNow();
  const [open, setOpen] = useState<string | null>(null);
  const [showFinished, setShowFinished] = useState(false);
  const [deleted, setDeleted] = useState<Deleted | null>(null);
  const [restoreError, setRestoreError] = useState<string | null>(null);
  const [restoring, setRestoring] = useState(false);
  const deletedTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  useEffect(() => () => void (deletedTimer.current && clearTimeout(deletedTimer.current)), []);
  const onDeleted = (d: Deleted) => {
    setDeleted(d);
    setRestoreError(null);
    setOpen(null);
    if (deletedTimer.current) clearTimeout(deletedTimer.current);
    deletedTimer.current = setTimeout(() => setDeleted(null), 30_000);
  };
  const restore = async () => {
    if (!deleted) return;
    setRestoring(true);
    try {
      const { automationId } = await rpc.call("hub_restore", { automationId: deleted.id });
      setDeleted(null);
      await store.refresh();
      setOpen(automationId);
    } catch (e) {
      setRestoreError(t.restoreFailed(e instanceof Error ? e.message : String(e)));
    } finally {
      setRestoring(false);
    }
  };
  const grouped = useMemo(() => {
    const map = new Map<GroupKey, HubItem[]>();
    for (const item of overview?.items ?? []) {
      const g = groupOf(item);
      map.set(g, [...(map.get(g) ?? []), item]);
    }
    for (const list of map.values()) list.sort(byNext);
    return map;
  }, [overview]);

  // Deep links from the chat menu and the title bar: /automation-hub/<group> or /automation-hub/<automation id>.
  const target = decodeURIComponent(subPath.split("/")[0] ?? "");
  const handled = useRef<string>("");
  useEffect(() => {
    if (!target) {
      handled.current = "";
      return;
    }
    if (!overview || handled.current === target) return;
    const item = overview.items.find((i) => i.id === target);
    if (!item && !GROUP_KEYS.includes(target as GroupKey)) return;
    handled.current = target;
    if (item) {
      setOpen(item.id);
      if (groupOf(item) === "finished") setShowFinished(true);
    }
    requestAnimationFrame(() =>
      document.getElementById(item ? `hub-row-${item.id}` : `hub-section-${target}`)?.scrollIntoView({ block: "start", behavior: "smooth" }),
    );
  }, [target, overview]);

  const error = failure ?? (overview?.error ? t.noAnswer(overview.error) : null);
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-4xl px-4 pb-8 pt-3 md:px-5 md:pt-4">
        <p className="text-sm text-muted-foreground">{t.intro}</p>
        {deleted ? (
          <div role="status" className="sticky top-0 z-10 mt-3 flex flex-wrap items-center gap-2 rounded-md border border-border bg-card px-3 py-2 text-sm shadow-sm" data-deleted>
            <Icon name="Trash2" className="size-4 text-muted-foreground" />
            <span className="min-w-0">{t.deleted(deleted.name)}</span>
            <span className="text-xs text-muted-foreground">{deleted.restorable ? t.restoreNote : t.notRestorable}</span>
            {restoreError ? <span className="text-xs text-destructive">{restoreError}</span> : null}
            <span className="flex-1" />
            {deleted.restorable ? (
              <Button size="sm" variant="outline" disabled={restoring} onClick={() => void restore()} data-restore>
                <Icon name="ArrowTurnBackward" className="size-4" />
                {t.restore}
              </Button>
            ) : null}
            <Button size="sm" variant="ghost" aria-label={t.dismiss} onClick={() => setDeleted(null)}>
              <Icon name="CircleX" className="size-4" />
            </Button>
          </div>
        ) : null}
        {error ? (
          <p role="alert" className="mt-3 rounded-md border border-destructive/40 px-3 py-2 text-sm text-destructive" data-error>
            {error}
          </p>
        ) : null}
        {overview === null && !error ? <p className="mt-6 text-sm text-muted-foreground">{t.loading}</p> : null}
        {overview && overview.items.length === 0 && !overview.error ? (
          <div className="mt-6 rounded-lg border border-dashed border-border px-6 py-8 text-center text-sm text-muted-foreground" data-empty>
            {t.empty}
          </div>
        ) : null}
        {GROUP_KEYS.map((key) => {
          const list = grouped.get(key);
          if (!list || list.length === 0) return null;
          const collapsed = key === "finished" && !showFinished;
          return (
            <section key={key} id={`hub-section-${key}`} className="mt-6 scroll-mt-4" data-section={key}>
              <div className="mb-2 flex items-baseline gap-2">
                <h2 className={cn("text-xs font-medium uppercase tracking-wide", key === "attention" ? "text-destructive" : "text-muted-foreground")}>
                  {groupTitle(t, key)}
                </h2>
                <span className="text-xs text-muted-foreground">{list.length}</span>
                {key === "finished" ? (
                  <button type="button" className="text-xs text-muted-foreground underline-offset-2 hover:underline" onClick={() => setShowFinished((v) => !v)}>
                    {showFinished ? t.hide : t.show}
                  </button>
                ) : (
                  <span className="hidden truncate text-xs text-muted-foreground/80 md:inline">{groupHint(t, key)}</span>
                )}
              </div>
              {collapsed ? null : (
                <ul className={cn("divide-y divide-border overflow-hidden rounded-lg border bg-card", key === "attention" ? "border-destructive/40" : "border-border")}>
                  {list.map((item) => (
                    <Row key={item.id} rpc={rpc} item={item} now={now} open={open === item.id} onOpen={() => setOpen((cur) => (cur === item.id ? null : item.id))} onDeleted={onDeleted} />
                  ))}
                </ul>
              )}
            </section>
          );
        })}
        {overview ? <Templates templates={overview.templates} /> : null}
      </div>
    </div>
  );
}

function HeaderCounts() {
  const { overview } = useOverview();
  const nav = useBbNavigate();
  const t = useMessages(messages);
  return (
    <div className="flex items-center gap-1.5" id="hub-counts">
      {overview ? <Counts items={overview.items} onChip={(key) => openHub(nav, chipGroup[key])} /> : null}
      <Button size="sm" className="ml-1 h-7" onClick={() => openNew(nav, t)}>
        <Icon name="Plus" className="size-4" />
        {t.newAutomation}
      </Button>
      <LanguageSwitch className="ml-1" />
    </div>
  );
}

// ---------- the segment above every thread's composer ----------

type SegmentProps = { threadId: string; projectId: string; isExpanded: boolean; onToggle(): void };

function insertIntoThreadComposer(composers: ReturnType<typeof useComposers>, threadId: string, text: string): boolean {
  const composer = composers.find((c) => c.scope.kind === "thread" && c.scope.threadId === threadId);
  if (!composer) return false;
  composer.insert(text, { at: "end" });
  composer.focus();
  return true;
}

function SegmentSummary({ threadId, isExpanded, onToggle }: SegmentProps) {
  const { overview } = useOverview();
  const t = useMessages(messages);
  const composers = useComposers();
  const toggleRef = useRef(onToggle);
  toggleRef.current = onToggle;
  const composersRef = useRef(composers);
  composersRef.current = composers;
  useEffect(() => {
    const onToggleEvent = (event: Event) => {
      if ((event as CustomEvent<string | null>).detail === threadId) toggleRef.current();
    };
    const onRegular = (event: Event) => {
      if ((event as CustomEvent<string | null>).detail === threadId) insertIntoThreadComposer(composersRef.current, threadId, messagesNow(messages).promptsMakeRegular);
    };
    window.addEventListener(TOGGLE_MENU, onToggleEvent);
    window.addEventListener(MAKE_REGULAR, onRegular);
    return () => {
      window.removeEventListener(TOGGLE_MENU, onToggleEvent);
      window.removeEventListener(MAKE_REGULAR, onRegular);
    };
  }, [threadId]);
  const items = overview?.items ?? [];
  return (
    <button
      type="button"
      onClick={onToggle}
      aria-expanded={isExpanded}
      aria-label={`${t.menuTitle}: ${t.menuOpen}`}
      title={`${t.menuTitle} (${shortcutLabel("menu")})`}
      className="flex min-w-0 items-center gap-1 rounded-md px-1 py-0.5 hover:bg-state-hover"
      data-hub-segment
    >
      <PulseIcon className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="hidden text-xs text-muted-foreground md:inline">{t.menuTitle}</span>
      {overview ? <Counts items={items} small compact /> : null}
      <Icon name={isExpanded ? "ChevronUp" : "ChevronDown"} className="size-3 shrink-0 text-muted-foreground" />
    </button>
  );
}

function MenuButton({ icon, children, shortcut, onClick, tone }: { icon: string; children: ReactNode; shortcut?: ShortcutId; onClick: () => void; tone?: "primary" }) {
  return (
    <button
      type="button"
      onClick={onClick}
      className={cn(
        "flex w-full items-center gap-2 rounded-md px-2 py-1.5 text-left text-xs hover:bg-state-hover",
        tone === "primary" ? "font-medium text-foreground" : "text-foreground",
      )}
    >
      <Icon name={icon} className="size-3.5 shrink-0 text-muted-foreground" />
      <span className="min-w-0 flex-1 truncate">{children}</span>
      {shortcut ? <Kbd id={shortcut} /> : null}
    </button>
  );
}

function SegmentDetails({ threadId, projectId, isExpanded, onToggle }: SegmentProps) {
  const { overview } = useOverview();
  const nav = useBbNavigate();
  const t = useMessages(messages);
  const lang = useLang();
  const composers = useComposers();
  const now = useNow();
  if (!isExpanded) return null;
  const items = overview?.items ?? [];
  const failing = items.filter((i) => groupOf(i) === "attention");
  const running = items.filter((i) => i.status === "running");
  const next = items.filter((i) => i.enabled && i.nextRunAt !== null && i.status !== "running" && groupOf(i) !== "attention").sort(byNext).slice(0, 4);
  const go = (fn: () => void) => () => {
    fn();
    onToggle();
  };
  return (
    <div className="mt-1 rounded-lg border border-border bg-card p-2 text-xs" data-hub-menu>
      <div className="grid gap-3 md:grid-cols-[minmax(0,1fr)_20rem]">
        <div className="min-w-0 space-y-2">
          <section>
            <h3 className={cn("mb-1 px-2 font-medium", failing.length ? "text-destructive" : "text-muted-foreground")}>{t.menuAttention}</h3>
            {failing.length === 0 ? (
              <p className="px-2 text-muted-foreground">{t.menuAllGood}</p>
            ) : (
              <ul className="space-y-0.5" data-menu-failing>
                {failing.slice(0, 4).map((item) => (
                  <li key={item.id} className="flex items-center gap-2 rounded-md px-2 py-1 hover:bg-muted/50">
                    <Dot status={item.status} />
                    <div className="min-w-0 flex-1">
                      <div className="truncate font-medium">{item.name}</div>
                      {item.lastError ? <div className="truncate text-destructive">{item.lastError}</div> : null}
                    </div>
                    <Button size="sm" className="h-6 px-2 text-xs" onClick={go(() => openFix(nav, item, t))}>
                      {t.menuFix}
                    </Button>
                    <Button size="sm" variant="ghost" className="h-6 px-2 text-xs" onClick={go(() => openHub(nav, item.id))}>
                      {t.menuHistory}
                    </Button>
                  </li>
                ))}
                {failing.length > 4 ? (
                  <li>
                    <button type="button" className="px-2 text-muted-foreground hover:underline" onClick={go(() => openHub(nav, "attention"))}>
                      {t.menuMore(failing.length - 4)}
                    </button>
                  </li>
                ) : null}
              </ul>
            )}
          </section>
          {running.length > 0 ? (
            <section>
              <h3 className="mb-1 px-2 font-medium text-muted-foreground">{t.menuRunning}</h3>
              <ul className="space-y-0.5">
                {running.map((item) => (
                  <li key={item.id}>
                    <button type="button" className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-state-hover" onClick={go(() => openHub(nav, item.id))}>
                      <Dot status={item.status} />
                      <span className="truncate">{item.name}</span>
                    </button>
                  </li>
                ))}
              </ul>
            </section>
          ) : null}
          <section>
            <h3 className="mb-1 px-2 font-medium text-muted-foreground">{t.menuNext}</h3>
            {next.length === 0 ? (
              <p className="px-2 text-muted-foreground">{t.menuNothingNext}</p>
            ) : (
              <ul className="space-y-0.5" data-menu-next>
                {next.map((item) => (
                  <li key={item.id}>
                    <button type="button" className="flex w-full items-center gap-2 rounded-md px-2 py-1 text-left hover:bg-state-hover" onClick={go(() => openHub(nav, item.id))}>
                      <Dot status={item.status} />
                      <span className="min-w-0 flex-1 truncate">{item.name}</span>
                      <span className="shrink-0 text-muted-foreground">{relative(item.nextRunAt, now, lang)}</span>
                    </button>
                  </li>
                ))}
              </ul>
            )}
          </section>
        </div>
        <div className="space-y-0.5 border-t border-border pt-2 md:border-l md:border-t-0 md:pl-2 md:pt-0" data-menu-actions>
          <MenuButton icon="Repeat" shortcut="makeRegular" tone="primary" onClick={go(() => insertIntoThreadComposer(composers, threadId, t.promptsMakeRegular))}>
            {t.menuMakeRegular}
          </MenuButton>
          <MenuButton icon="Plus" shortcut="newAutomation" onClick={go(() => openNew(nav, t, projectId))}>
            {t.menuNewAutomation}
          </MenuButton>
          <MenuButton icon="LayoutList" shortcut="openHub" onClick={go(() => openHub(nav))}>
            {t.menuOpenHub}
          </MenuButton>
        </div>
      </div>
    </div>
  );
}

// ---------- badge and icon ----------

function useHubBadge(): ExperimentalBadge | null {
  const { overview } = useOverview();
  const t = useMessages(messages);
  const c = counts(overview?.items ?? []);
  return c.attention > 0 ? { count: c.attention, tone: "critical", label: t.badge(c.attention) } : null;
}

function PulseIcon({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" className={className} aria-hidden>
      <circle cx="12" cy="12" r="9" />
      <path d="M12 7v5l3 2" />
      <path d="M3.5 12H6M18 12h2.5" />
    </svg>
  );
}

export default definePluginApp((app) => {
  const t = messagesNow(messages);
  app.experimental_icons.register({ name: "AutomationHub", component: PulseIcon });
  app.slots.navPanel({
    id: "hub",
    title: "Automation Hub",
    icon: "AutomationHub",
    path: PANEL_PATH,
    component: HubPage,
    headerContent: HeaderCounts,
    experimental_useBadge: useHubBadge,
  });
  app.slots.experimental_threadContextSegment({
    id: "automations",
    title: t.menuTitle,
    group: "9_automation-hub",
    summary: SegmentSummary,
    details: SegmentDetails,
  });
  app.commands.register({
    id: "open-hub",
    title: t.commandsOpenHub,
    defaultShortcut: SHORTCUTS.openHub,
    run: () => (lastNav ? openHub(lastNav) : undefined),
  });
  app.commands.register({
    id: "menu",
    title: t.commandsMenu,
    defaultShortcut: SHORTCUTS.menu,
    isAvailable: (ctx) => ctx.threadId !== null,
    run: (ctx) => void window.dispatchEvent(new CustomEvent(TOGGLE_MENU, { detail: ctx.threadId })),
  });
  app.commands.register({
    id: "new-automation",
    title: t.commandsNewAutomation,
    defaultShortcut: SHORTCUTS.newAutomation,
    run: (ctx) => (lastNav ? openNew(lastNav, messagesNow(messages), ctx.projectId ?? undefined) : undefined),
  });
  app.commands.register({
    id: "make-regular",
    title: t.commandsMakeRegular,
    defaultShortcut: SHORTCUTS.makeRegular,
    isAvailable: (ctx) => ctx.threadId !== null,
    run: (ctx) => void window.dispatchEvent(new CustomEvent(MAKE_REGULAR, { detail: ctx.threadId })),
  });

});
