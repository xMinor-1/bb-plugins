// Plan limits: the full list for the page and a compact one for the footer card.
import type { ReactNode } from "react";
import { experimental_ProviderIcon as ProviderIcon, experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { LimitAccount, LimitWindow } from "../src/shared/types";
import { clock, countdown, resetMoment } from "../lib/format";
import { useLang, useMessages } from "../lib/i18n";
import { messages } from "../lib/messages";
import { Card, Empty, Meter, Percent, toneOf, useWidth } from "./kit";

export function ProviderGlyph({ id, className = "size-3.5" }: { id: string; className?: string }): ReactNode {
  return <ProviderIcon providerKind="agent" provider={{ id }} className={`${className} shrink-0`} />;
}

function resetText(window: LimitWindow, t: ReturnType<typeof useMessages<typeof messages.en>>, lang: "en" | "ru"): string {
  if (!window.resetsAt) return "";
  const left = Date.parse(window.resetsAt) - Date.now();
  if (left < 24 * 60 * 60_000) {
    const text = countdown(window.resetsAt, lang);
    return text ? t.resetsIn(text) : "";
  }
  return t.resetsAt(resetMoment(window.resetsAt, lang));
}

/** The line under an account that explains why its figures look the way they do. */
function AccountNote({ account }: { account: LimitAccount }): ReactNode {
  const t = useMessages(messages);
  const lang = useLang();
  if (account.backup) {
    return <p className="text-xs text-muted-foreground">{t.backup(clock(Date.parse(account.backup.fetchedAt), lang))}</p>;
  }
  if (account.stale && account.observedAt) {
    return (
      <p className="flex items-center gap-1 text-xs text-muted-foreground">
        <Icon name="AlertTriangle" className="size-3" aria-hidden />
        {t.stale(clock(account.observedAt, lang))}
      </p>
    );
  }
  if (account.status !== "ok") return <p className="text-xs text-muted-foreground">{t.status[account.status]}</p>;
  return null;
}

function AccountHeader({ account, compact, showHost }: { account: LimitAccount; compact: boolean; showHost: boolean }): ReactNode {
  const t = useMessages(messages);
  const who = account.accountEmail ?? account.providerName;
  return (
    <div className="flex min-w-0 items-center gap-1.5">
      <ProviderGlyph id={account.providerId} />
      {compact ? (
        <span className="min-w-0 flex-1 truncate text-xs font-medium text-foreground" title={`${account.providerName}: ${who}`}>
          {who}
        </span>
      ) : (
        <>
          <span className="text-sm font-medium text-foreground">{account.providerName}</span>
          {account.accountEmail ? <span className="min-w-0 truncate text-sm text-muted-foreground">{account.accountEmail}</span> : null}
        </>
      )}
      {account.planLabel ? (
        <span className="shrink-0 rounded bg-muted px-1 text-[11px] leading-4 text-muted-foreground">{account.planLabel}</span>
      ) : null}
      {!compact && ((showHost && account.hostName) || account.poolName) ? (
        <span className="ml-auto shrink-0 text-xs text-muted-foreground">
          {account.poolName ? t.pool(account.poolName) : account.hostName}
        </span>
      ) : null}
    </div>
  );
}

/** The page's card: every account with every window, full labels. */
/** Below this width the page's limit rows switch to the footer card's short form. */
const NARROW = 460;

export function LimitsCard({ accounts }: { accounts: LimitAccount[] | null }): ReactNode {
  const t = useMessages(messages);
  const lang = useLang();
  const [ref, width] = useWidth<HTMLDivElement>();
  const manyMachines = new Set((accounts ?? []).map((a) => a.hostId)).size > 1;
  return (
    <div ref={ref}>
    <Card title={t.limitsTitle} hint={t.limitsHint}>
      {accounts === null ? (
        <Empty>{t.loading}</Empty>
      ) : accounts.length === 0 ? (
        <Empty>{t.limitsNone}</Empty>
      ) : width > 0 && width < NARROW ? (
        <LimitsCompact accounts={accounts} />
      ) : (
        <div className="space-y-3">
          {accounts.map((account) => (
            <div key={account.id} className="space-y-1.5">
              <AccountHeader account={account} compact={false} showHost={manyMachines} />
              {account.windows.length > 0 ? (
                <div className="grid grid-cols-[minmax(6rem,11rem)_minmax(2rem,1fr)_2.75rem_minmax(5.5rem,9.5rem)] items-center gap-x-3 gap-y-1.5 pl-5">
                  {account.windows.map((window, index) => {
                    const tone = toneOf(window.usedPercent);
                    return (
                      <div key={index} className="contents">
                        <span className="truncate text-sm text-muted-foreground" title={t.windowLabel(window.kind, window.label, window.model)}>
                          {t.windowLabel(window.kind, window.label, window.model)}
                        </span>
                        <Meter value={window.usedPercent} tone={tone} />
                        <span className="text-right text-sm">
                          <Percent value={`${Math.round(window.usedPercent)}%`} tone={tone} />
                        </span>
                        <span className="truncate text-right text-xs text-muted-foreground">{resetText(window, t, lang)}</span>
                      </div>
                    );
                  })}
                </div>
              ) : null}
              <div className="pl-5">
                <AccountNote account={account} />
              </div>
            </div>
          ))}
        </div>
      )}
    </Card>
    </div>
  );
}

/** The footer card's rows: short labels, a bar, the percentage and time to reset. */
export function LimitsCompact({ accounts }: { accounts: LimitAccount[] }): ReactNode {
  const t = useMessages(messages);
  const lang = useLang();
  return (
    <div className="space-y-2.5">
      {accounts.map((account, index) => (
        <div key={account.id} className={`space-y-1 ${index > 0 ? "border-t border-border pt-2.5" : ""}`}>
          <AccountHeader account={account} compact showHost={false} />
          {account.windows.length > 0 ? (
            <div className="grid grid-cols-[2.25rem_minmax(1.5rem,1fr)_2.25rem_auto] items-center gap-x-2 gap-y-1 text-xs">
              {account.windows.map((window, i) => {
                const tone = toneOf(window.usedPercent);
                return (
                  <div key={i} className="contents">
                    <span className="truncate text-muted-foreground" title={t.windowLabel(window.kind, window.label, window.model)}>
                      {t.windowShort(window.kind, window.model) || window.label}
                    </span>
                    <Meter value={window.usedPercent} tone={tone} className="h-1" />
                    <span className="text-right">
                      <Percent value={`${Math.round(window.usedPercent)}%`} tone={tone} />
                    </span>
                    <span className="truncate text-right tabular-nums text-muted-foreground">{countdown(window.resetsAt, lang) ?? ""}</span>
                  </div>
                );
              })}
            </div>
          ) : null}
          <AccountNote account={account} />
        </div>
      ))}
    </div>
  );
}
