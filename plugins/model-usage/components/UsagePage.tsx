// The Usage page: plan limits, tokens per model, then Claude Code activity.
import { useEffect, useRef, useState, type ReactNode } from "react";
import { experimental_Icon as Icon, experimental_usePluginId, useBbNavigate, useRpc, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "../contract";
import type { UsageSummary } from "../src/claude/usage-scan";
import { TOKEN_WINDOWS, type TokenWindow, type TokensSnapshot, type LimitsSnapshot } from "../src/shared/types";
import { clock } from "../lib/format";
import { LanguageSwitch, useLang, useMessages } from "../lib/i18n";
import { messages } from "../lib/messages";
import { refresh, setPluginId, useStore } from "../lib/store";
import { Caption, Card, Empty } from "./kit";
import { LimitsCard } from "./Limits";
import { TokensCard } from "./Tokens";
import { ActivitySections } from "./Activity";

export const PANEL_PATH = "usage";
const POLL_MS = 60_000;
const COLD_POLL_MS = 2_000;
const RETRY_MS = 15_000;

function windowOf(subPath: string): TokenWindow {
  const head = subPath.split("/")[0] as TokenWindow;
  return TOKEN_WINDOWS.includes(head) ? head : "24h";
}

function onMachine<T extends { hostId: string | null }>(items: T[], machine: string): T[] {
  return machine === "all" ? items : items.filter((item) => item.hostId === machine);
}

export function UsagePage({ subPath }: PluginNavPanelProps): ReactNode {
  setPluginId(experimental_usePluginId());
  const t = useMessages(messages);
  const lang = useLang();
  const navigate = useBbNavigate();
  const rpc = useRpc<typeof rpcContract>();
  const rpcRef = useRef(rpc);
  rpcRef.current = rpc;
  const window_ = windowOf(subPath);
  const store = useStore();
  const [machine, setMachine] = useState("all");
  const [activity, setActivity] = useState<UsageSummary | null>(null);
  const [activityError, setActivityError] = useState<string | null>(null);
  const [nonce, setNonce] = useState(0);

  // Limits and tokens: the shared store, refreshed while the page is open.
  useEffect(() => {
    const controller = new AbortController();
    void refresh({ maxAgeMs: POLL_MS, signal: controller.signal });
    const timer = setInterval(() => void refresh({ maxAgeMs: POLL_MS, signal: controller.signal }), POLL_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, []);

  // Claude Code activity for the chosen window. Only the latest request's answer is applied.
  const latest = useRef(0);
  useEffect(() => {
    if (store.tokens?.corporateOnly) return;
    let alive = true;
    let timer = 0;
    const tick = async () => {
      const mine = ++latest.current;
      try {
        const next = await rpcRef.current.call("activity", { window: window_ });
        if (!alive || mine !== latest.current) return;
        setActivity(next);
        setActivityError(null);
        timer = globalThis.setTimeout(() => void tick(), next.scan.cold ? COLD_POLL_MS : POLL_MS) as unknown as number;
      } catch (failure) {
        if (!alive || mine !== latest.current) return;
        setActivityError(failure instanceof Error ? failure.message : String(failure));
        timer = globalThis.setTimeout(() => void tick(), RETRY_MS) as unknown as number;
      }
    };
    void tick();
    return () => {
      alive = false;
      clearTimeout(timer);
    };
  }, [window_, nonce, store.tokens?.corporateOnly]);

  const limits: LimitsSnapshot | null = store.limits;
  const tokens: TokensSnapshot | null = store.tokens;
  const corporateOnly = tokens?.corporateOnly ?? false;
  const machines = new Map<string, string>();
  for (const m of limits?.machines ?? []) machines.set(m.id, m.name);
  for (const g of tokens?.groups ?? []) machines.set(g.hostId, g.hostName);
  const hasClaude = (tokens?.groups ?? []).some((g) => g.source === "claude-code") || (activity?.totals.calls ?? 0) > 0;
  // Activity comes from the bb server's own records, so it belongs to the primary machine.
  const primaryId = limits?.machines.find((m) => m.primary)?.id ?? null;
  const activityHere = machine === "all" || machine === primaryId;
  const updatedAt = Math.max(limits?.updatedAt ?? 0, tokens?.updatedAt ?? 0);

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto p-4">
      <div className="mx-auto w-full max-w-3xl space-y-4">
        <div className="flex flex-wrap items-center gap-2">
          <div role="group" aria-label={t.windowAria} className="inline-flex gap-0.5 rounded-md border border-border p-0.5">
            {TOKEN_WINDOWS.map((w) => (
              <button
                key={w}
                type="button"
                aria-pressed={w === window_}
                onClick={() => navigate.toPluginPanel(PANEL_PATH, { subPath: w })}
                className={`whitespace-nowrap rounded-[5px] px-2.5 py-1 text-sm ${w === window_ ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                {t.windows[w]}
              </button>
            ))}
          </div>
          {machines.size > 1 ? (
            <select
              aria-label={t.machineAria}
              value={machine}
              onChange={(event) => setMachine(event.target.value)}
              className="max-w-[12rem] truncate rounded-md border border-border bg-background px-2 py-1 text-sm text-foreground"
            >
              <option value="all">{t.allMachines}</option>
              {[...machines].map(([id, name]) => (
                <option key={id} value={id}>
                  {name}
                </option>
              ))}
            </select>
          ) : null}
          <button
            type="button"
            disabled={store.refreshing}
            onClick={() => {
              void refresh({ maxAgeMs: 0, force: true });
              setNonce((n) => n + 1);
            }}
            className="inline-flex items-center gap-1.5 whitespace-nowrap rounded-md border border-border px-2.5 py-1 text-sm text-muted-foreground hover:text-foreground disabled:opacity-60"
          >
            <Icon name={store.refreshing ? "Loading" : "ArrowReloadHorizontal"} className={`size-3.5 ${store.refreshing ? "animate-spin" : ""}`} aria-hidden />
            {t.refresh}
          </button>
          <span className="ml-auto flex items-center gap-2">
            {updatedAt > 0 ? <span className="whitespace-nowrap text-xs text-muted-foreground">{t.updated(clock(updatedAt, lang))}</span> : null}
            <LanguageSwitch />
          </span>
        </div>

        {store.error && !limits && !tokens ? (
          <Card title={t.loadFailed}>
            <Caption>{store.error}</Caption>
          </Card>
        ) : null}

        {corporateOnly ? null : <LimitsCard accounts={limits ? onMachine(limits.accounts, machine) : null} />}

        <TokensCard
          snapshot={tokens ? { ...tokens, groups: onMachine(tokens.groups, machine) } : null}
          window={window_}
        />

        {corporateOnly || !hasClaude || !activityHere ? null : (
          <section className="space-y-4">
            <div className="flex items-baseline gap-2 pt-2">
              <h2 className="text-base font-medium text-foreground">{t.activityTitle}</h2>
              <span className="text-xs text-muted-foreground">{t.activityHint}</span>
            </div>
            {activityError && !activity ? (
              <Card title={t.loadFailed}>
                <Caption>{activityError}</Caption>
              </Card>
            ) : activity === null ? (
              <Card>
                <Empty>{t.loading}</Empty>
              </Card>
            ) : (
              <ActivitySections summary={activity} window={window_} />
            )}
          </section>
        )}
      </div>
    </div>
  );
}
