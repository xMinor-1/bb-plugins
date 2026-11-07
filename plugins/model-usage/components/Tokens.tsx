// Tokens per model: the page's table and the footer card's group totals.
import type { ReactNode } from "react";
import { experimental_Icon as Icon } from "@get-bb/plugin-sdk/app";
import type { ModelGroup, TokenTotals, TokenWindow, TokensSnapshot } from "../src/shared/types";
import { clock, compactNumber, exactNumber } from "../lib/format";
import { useLang, useMessages, type Lang } from "../lib/i18n";
import { messages, type Messages } from "../lib/messages";
import { Card, Caption, Empty, useWidth } from "./kit";
import { ProviderGlyph } from "./Limits";

export function groupName(group: ModelGroup, snapshot: TokensSnapshot, t: Messages): string {
  if (group.source === "claude-code") return t.claudeCode;
  if (group.corporate) return snapshot.corporateLabel || t.corporateDefault;
  return t.opencodeProvider(group.providerId);
}

/** "offline, as of 18:40" and the like; null when the figures are live. */
export function groupState(group: ModelGroup, t: Messages, lang: Lang): string | null {
  const at = group.collectedAt ? clock(group.collectedAt, lang) : null;
  if (group.problem === "offline") return at ? t.offlineAsOf(at) : t.offline;
  if (group.problem === "error") return at ? t.readFailedAsOf(at) : t.readFailed;
  return null;
}

const glyphOf = (group: ModelGroup) => (group.source === "claude-code" ? "claude-code" : "acp-opencode");

function sumGroup(group: ModelGroup, window: TokenWindow): TokenTotals {
  return group.models.reduce<TokenTotals>(
    (sum, m) => ({
      requests: sum.requests + m.windows[window].requests,
      input: sum.input + m.windows[window].input,
      output: sum.output + m.windows[window].output,
      cacheRead: sum.cacheRead + m.windows[window].cacheRead,
      cacheWrite: sum.cacheWrite + m.windows[window].cacheWrite,
      total: sum.total + m.windows[window].total,
    }),
    { requests: 0, input: 0, output: 0, cacheRead: 0, cacheWrite: 0, total: 0 },
  );
}

function Num({ value, lang, dash = false }: { value: number; lang: Lang; dash?: boolean }): ReactNode {
  if (dash && value === 0) return <span className="text-muted-foreground/70">—</span>;
  return <span title={exactNumber(value, lang)}>{compactNumber(value, lang)}</span>;
}

/** Room the full table needs; below it the requests column and share bars go. */
const FULL = 600;
/** Below this the table becomes a list: a line per model with its parts under it. */
const LIST = 440;

const cell = "px-2 py-1.5 text-right tabular-nums";

/** The page's table: a header row per group, a row per model. */
export function TokensCard({ snapshot, window }: { snapshot: TokensSnapshot | null; window: TokenWindow }): ReactNode {
  const t = useMessages(messages);
  const lang = useLang();
  const [ref, width] = useWidth<HTMLDivElement>();
  const full = width === 0 || width >= FULL;
  const list = width > 0 && width < LIST;
  // Machine names only help when there is more than one machine to tell apart.
  const manyMachines = new Set((snapshot?.groups ?? []).map((g) => g.hostId)).size > 1;
  const groups = snapshot?.groups ?? [];
  const grand = groups.reduce((sum, g) => sum + sumGroup(g, window).total, 0) || 1;
  const visible = groups.filter((g) => g.models.some((m) => m.windows[window].total > 0) || g.problem);
  const hint = snapshot?.corporateOnly ? t.tokensHintCorporate(t.windows[window]) : t.tokensHint(t.windows[window]);
  const modelsOf = (group: ModelGroup) => group.models.filter((m) => m.windows[window].total > 0 || m.windows[window].requests > 0);

  const head = (group: ModelGroup) => {
    const state = groupState(group, t, lang);
    return (
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
        <span className="inline-flex items-center gap-1.5 whitespace-nowrap">
          <ProviderGlyph id={glyphOf(group)} />
          <span className="font-medium text-foreground">{groupName(group, snapshot!, t)}</span>
        </span>
        {manyMachines ? <span className="text-xs text-muted-foreground">{group.hostName}</span> : null}
        {state ? (
          <span className="flex items-center gap-1 text-xs text-muted-foreground">
            <Icon name={group.problem === "offline" ? "Clock" : "AlertTriangle"} className="size-3" aria-hidden />
            {state}
          </span>
        ) : null}
      </span>
    );
  };

  let body: ReactNode;
  if (snapshot === null) {
    body = (
      <div className="px-3 py-2.5">
        <Empty>{t.loading}</Empty>
      </div>
    );
  } else if (visible.length === 0) {
    body = (
      <div className="px-3 py-2.5">
        <Empty>{t.tokensNone}</Empty>
      </div>
    );
  } else if (list) {
    body = (
      <div>
        {visible.map((group) => {
          const sum = sumGroup(group, window);
          const dim = group.problem ? "text-muted-foreground" : "text-foreground";
          return (
            <div key={group.key} className="border-b border-border">
              <div className={`flex items-start gap-2 px-3 py-1.5 text-sm ${group.corporate ? "bg-emerald-500/10" : "bg-muted/50"}`}>
                <span className="min-w-0 flex-1">{head(group)}</span>
                <span className={`shrink-0 font-medium tabular-nums ${dim}`}><Num value={sum.total} lang={lang} /></span>
              </div>
              {modelsOf(group).map((model) => {
                const w = model.windows[window];
                return (
                  <div key={model.id} className={`border-t border-border py-1.5 pl-8 pr-3 text-sm ${dim}`}>
                    <div className="flex items-baseline gap-2">
                      <span className="min-w-0 flex-1 truncate" title={model.id}>{model.id.replace(/^claude-/, "")}</span>
                      <span className="shrink-0 tabular-nums"><Num value={w.total} lang={lang} /></span>
                    </div>
                    <div className="flex flex-wrap gap-x-3 text-xs text-muted-foreground tabular-nums">
                      <span>{t.col.input} <Num value={w.input} lang={lang} /></span>
                      <span>{t.col.output} <Num value={w.output} lang={lang} /></span>
                      <span>{t.col.cacheRead} <Num value={w.cacheRead} lang={lang} dash /></span>
                      <span>{t.col.cacheWrite} <Num value={w.cacheWrite} lang={lang} dash /></span>
                    </div>
                  </div>
                );
              })}
            </div>
          );
        })}
      </div>
    );
  } else {
    body = (
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b border-border text-xs text-muted-foreground">
              <th className="py-1.5 pl-3 text-left font-normal">{t.col.model}</th>
              {full ? <th className="px-2 py-1.5 text-right font-normal">{t.col.requests}</th> : null}
              <th className="px-2 py-1.5 text-right font-normal">{t.col.input}</th>
              <th className="px-2 py-1.5 text-right font-normal">{t.col.output}</th>
              <th className="px-2 py-1.5 text-right font-normal">{t.col.cacheRead}</th>
              <th className="px-2 py-1.5 text-right font-normal">{t.col.cacheWrite}</th>
              <th className="py-1.5 pl-2 pr-3 text-right font-normal">{t.col.total}</th>
            </tr>
          </thead>
          <tbody>
            {visible.map((group) => {
              const sum = sumGroup(group, window);
              const dim = group.problem ? "text-muted-foreground" : "text-foreground";
              return (
                <GroupRows key={group.key}>
                  <tr className={`border-b border-border ${group.corporate ? "bg-emerald-500/10" : "bg-muted/50"}`}>
                    <td className="py-1.5 pl-3 pr-2">{head(group)}</td>
                    {full ? <td className={`${cell} font-medium ${dim}`}>{exactNumber(sum.requests, lang)}</td> : null}
                    <td className={`${cell} font-medium ${dim}`}><Num value={sum.input} lang={lang} /></td>
                    <td className={`${cell} font-medium ${dim}`}><Num value={sum.output} lang={lang} /></td>
                    <td className={`${cell} font-medium ${dim}`}><Num value={sum.cacheRead} lang={lang} dash /></td>
                    <td className={`${cell} font-medium ${dim}`}><Num value={sum.cacheWrite} lang={lang} dash /></td>
                    <td className={`py-1.5 pl-2 pr-3 text-right font-medium tabular-nums ${dim}`}>
                      <span className="flex items-center justify-end gap-2 whitespace-nowrap">
                        <Num value={sum.total} lang={lang} />
                        {full ? (
                          <span className="h-1 w-10 overflow-hidden rounded-full bg-muted">
                            <span className="block h-full rounded-full bg-foreground/55" style={{ width: `${Math.min(100, (100 * sum.total) / grand)}%` }} />
                          </span>
                        ) : null}
                      </span>
                    </td>
                  </tr>
                  {modelsOf(group).map((model) => {
                    const w = model.windows[window];
                    return (
                      <tr key={model.id} className={`border-b border-border last:border-b-0 ${dim}`}>
                        <td className="max-w-[16rem] truncate py-1.5 pl-9 pr-2" title={model.id}>{model.id.replace(/^claude-/, "")}</td>
                        {full ? <td className={cell}>{exactNumber(w.requests, lang)}</td> : null}
                        <td className={cell}><Num value={w.input} lang={lang} /></td>
                        <td className={cell}><Num value={w.output} lang={lang} /></td>
                        <td className={cell}><Num value={w.cacheRead} lang={lang} dash /></td>
                        <td className={cell}><Num value={w.cacheWrite} lang={lang} dash /></td>
                        <td className="whitespace-nowrap py-1.5 pl-2 pr-3 text-right tabular-nums"><Num value={w.total} lang={lang} /></td>
                      </tr>
                    );
                  })}
                </GroupRows>
              );
            })}
          </tbody>
        </table>
      </div>
    );
  }

  return (
    <div ref={ref}>
      <Card title={t.tokensTitle} hint={hint} flush>
        {body}
        <div className="space-y-1 px-3 py-2">
          {snapshot?.claudeScanning ? <Caption>{t.tokensScanning}</Caption> : null}
          <Caption>{t.tokensFootnote}</Caption>
        </div>
      </Card>
    </div>
  );
}

function GroupRows({ children }: { children: ReactNode }): ReactNode {
  return <>{children}</>;
}

/** The footer card's lines: a total per group, optionally with its models under it. */
export function TokensCompact({
  snapshot,
  window,
  detailed,
}: {
  snapshot: TokensSnapshot;
  window: TokenWindow;
  detailed: boolean;
}): ReactNode {
  const t = useMessages(messages);
  const lang = useLang();
  const groups = snapshot.groups.filter((g) => g.models.some((m) => m.windows[window].total > 0) || g.problem);
  const manyMachines = new Set(snapshot.groups.map((g) => g.hostId)).size > 1;
  if (groups.length === 0) return <p className="text-xs text-muted-foreground">{t.tokensNone}</p>;
  return (
    <div className="space-y-1">
      {groups.map((group) => {
        const state = groupState(group, t, lang);
        const total = sumGroup(group, window).total;
        return (
          <div key={group.key} className="space-y-0.5">
            <div className="flex min-w-0 items-center gap-1.5 text-xs">
              <ProviderGlyph id={glyphOf(group)} />
              <span className={`min-w-0 flex-1 truncate ${group.corporate ? "font-medium text-foreground" : "text-foreground"}`} title={`${groupName(group, snapshot, t)}, ${group.hostName}${state ? `, ${state}` : ""}`}>
                {groupName(group, snapshot, t)} <span className="text-muted-foreground">{state ?? (manyMachines ? group.hostName : "")}</span>
              </span>
              <span className={`shrink-0 tabular-nums ${group.problem ? "text-muted-foreground" : "text-foreground"}`} title={exactNumber(total, lang)}>
                {compactNumber(total, lang)}
              </span>
            </div>
            {detailed
              ? group.models
                  .filter((m) => m.windows[window].total > 0)
                  .map((m) => (
                    <div key={m.id} className="flex min-w-0 items-center gap-1.5 pl-5 text-xs text-muted-foreground">
                      <span className="min-w-0 flex-1 truncate" title={m.id}>{m.id.replace(/^claude-/, "")}</span>
                      <span className="shrink-0 tabular-nums" title={exactNumber(m.windows[window].total, lang)}>
                        {compactNumber(m.windows[window].total, lang)}
                      </span>
                    </div>
                  ))
              : null}
          </div>
        );
      })}
    </div>
  );
}
