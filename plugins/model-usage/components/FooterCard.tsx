// The card above the sidebar footer: limits per provider tab, and on the All
// tab the tokens per group of models for a chosen window.
import { useEffect, useState, type ReactNode } from "react";
import {
  experimental_Icon as Icon,
  experimental_usePluginId,
  useBbNavigate,
  type ExperimentalSidebarFooterDisclosureProps,
} from "@get-bb/plugin-sdk/app";
import type { TokenWindow } from "../src/shared/types";
import { TOKEN_WINDOWS } from "../src/shared/types";
import { useMessages } from "../lib/i18n";
import { messages } from "../lib/messages";
import { refresh, setPluginId, useStore } from "../lib/store";
import { LimitsCompact, ProviderGlyph } from "./Limits";
import { TokensCompact } from "./Tokens";
import { PANEL_PATH } from "./UsagePage";

const CARD_MAX_AGE_MS = 2 * 60_000;
const TAB_KEY = "model-usage.card-tab";
const WINDOW_KEY = "model-usage.card-window";

function stored<T extends string>(key: string, allowed: readonly T[], fallback: T): T {
  try {
    const value = localStorage.getItem(key) as T | null;
    return value && allowed.includes(value) ? value : fallback;
  } catch {
    return fallback;
  }
}

function remember(key: string, value: string): void {
  try {
    localStorage.setItem(key, value);
  } catch {
    // Private mode: the choice lasts until the page reloads.
  }
}

export function FooterCard({ dismiss }: ExperimentalSidebarFooterDisclosureProps): ReactNode {
  setPluginId(experimental_usePluginId());
  const t = useMessages(messages);
  const navigate = useBbNavigate();
  const store = useStore();
  const [tab, setTab] = useState(() => {
    try {
      return localStorage.getItem(TAB_KEY) ?? "all";
    } catch {
      return "all";
    }
  });
  const [window_, setWindow] = useState<TokenWindow>(() => stored(WINDOW_KEY, TOKEN_WINDOWS, "24h"));

  useEffect(() => {
    const controller = new AbortController();
    void refresh({ maxAgeMs: CARD_MAX_AGE_MS, signal: controller.signal });
    const timer = setInterval(() => void refresh({ maxAgeMs: CARD_MAX_AGE_MS, signal: controller.signal }), CARD_MAX_AGE_MS);
    return () => {
      controller.abort();
      clearInterval(timer);
    };
  }, []);

  const accounts = store.limits?.accounts ?? [];
  const providers = [...new Map(accounts.map((a) => [a.providerId, a.providerName])).entries()];
  const tabs: Array<{ id: string; label: string }> = providers.length > 1 ? [{ id: "all", label: t.allTab }, ...providers.map(([id, name]) => ({ id, label: name }))] : [];
  const active = tabs.some((x) => x.id === tab) ? tab : "all";
  const shown = active === "all" ? accounts : accounts.filter((a) => a.providerId === active);
  const tokens = store.tokens;
  const onlyTokens = accounts.length === 0;
  const openPage = () => {
    navigate.toPluginPanel(PANEL_PATH, { subPath: window_ });
    dismiss();
  };

  return (
    <div className="flex max-h-[26rem] flex-col">
      <div className="flex h-9 shrink-0 items-center gap-0.5 border-b border-border px-1.5">
        {tabs.length > 0 ? (
          <div role="tablist" className="flex min-w-0 items-center gap-0.5 overflow-x-auto">
            {tabs.map((x) => (
              <button
                key={x.id}
                type="button"
                role="tab"
                aria-selected={x.id === active}
                title={x.label}
                onClick={() => {
                  setTab(x.id);
                  remember(TAB_KEY, x.id);
                }}
                className={`flex h-6 min-w-6 shrink-0 items-center justify-center rounded-md px-1.5 text-xs font-medium ${x.id === active ? "bg-muted text-foreground" : "text-muted-foreground hover:text-foreground"}`}
              >
                {x.id === "all" ? x.label : <ProviderGlyph id={x.id} />}
              </button>
            ))}
          </div>
        ) : (
          <span className="truncate px-1.5 text-xs font-medium text-foreground">{t.title}</span>
        )}
        <span className="flex-1" />
        <button
          type="button"
          title={t.refresh}
          aria-label={t.refresh}
          disabled={store.refreshing}
          onClick={() => void refresh({ maxAgeMs: 0, force: true })}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Icon name={store.refreshing ? "Loading" : "ArrowReloadHorizontal"} className={`size-3.5 ${store.refreshing ? "animate-spin" : ""}`} aria-hidden />
        </button>
        <button
          type="button"
          title={t.collapse}
          aria-label={t.collapse}
          onClick={dismiss}
          className="flex size-6 shrink-0 items-center justify-center rounded-md text-muted-foreground hover:bg-muted hover:text-foreground"
        >
          <Icon name="ChevronDown" className="size-4" aria-hidden />
        </button>
      </div>
      <div className="min-h-0 space-y-2.5 overflow-y-auto p-2.5">
        {store.limits === null && store.tokens === null ? (
          <p className="text-xs text-muted-foreground">{store.error ? t.loadFailed : t.loading}</p>
        ) : null}
        {shown.length > 0 ? <LimitsCompact accounts={shown} /> : null}
        {tokens && active === "all" ? (
          <div className={`space-y-1.5 ${shown.length > 0 ? "border-t border-border pt-2.5" : ""}`}>
            <div className="flex items-center gap-2 text-xs text-muted-foreground">
              <span className="min-w-0 flex-1 truncate">{onlyTokens ? t.tokensTitle : t.col.total}</span>
              <span role="group" aria-label={t.windowAria} className="inline-flex shrink-0 rounded-md border border-border p-px">
                {TOKEN_WINDOWS.map((w) => (
                  <button
                    key={w}
                    type="button"
                    aria-pressed={w === window_}
                    onClick={() => {
                      setWindow(w);
                      remember(WINDOW_KEY, w);
                    }}
                    className={`rounded-[4px] px-1.5 text-[11px] leading-[18px] ${w === window_ ? "bg-muted font-medium text-foreground" : "text-muted-foreground hover:text-foreground"}`}
                  >
                    {t.windowsShort[w]}
                  </button>
                ))}
              </span>
            </div>
            <TokensCompact snapshot={tokens} window={window_} detailed={onlyTokens} />
          </div>
        ) : null}
        <button type="button" onClick={openPage} className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
          {onlyTokens ? t.openPage : t.detailsByModel}
        </button>
      </div>
    </div>
  );
}
