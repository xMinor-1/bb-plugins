// The MCP page: your servers with their health, the form that connects new
// ones from pasted client settings, and the catalog of servers the company
// offers.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { Catalog, CatalogItem, ImportResult, ServerView, Status } from "../../contract";
import type { rpcContract } from "../../server";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { intlLocale, LanguageSwitch, useLang, useMessages, type Lang } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { errors, messages, reasons } from "../messages";

type Rpc = ReturnType<typeof useRpc<typeof rpcContract>>;
type Machine = { id: string; name: string; connected: boolean };
type Overview = {
  machines: Machine[];
  lastUsed: string | null;
  catalogConfigured: boolean;
  platformUrl: string;
  timeoutSec: number;
};

/** "[mcp:<code>] English text" → the person's language; other errors as they are. */
function explain(known: Record<string, string>, raw: string): { text: string; detail: string | null } {
  const match = /^\[mcp:([\w-]+)\]\s*(.*)$/s.exec(raw);
  if (!match) return { text: raw, detail: null };
  const text = known[match[1]!];
  return text ? { text, detail: match[2] || null } : { text: match[2] || raw, detail: null };
}

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

function formatTime(ms: number, lang: Lang): string {
  const date = new Date(ms);
  const today = new Date().toDateString() === date.toDateString();
  return new Intl.DateTimeFormat(intlLocale(lang), today ? { hour: "2-digit", minute: "2-digit" } : { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(date);
}

function Notice({ tone, children }: { tone: "error" | "warn" | "info" | "ok"; children: ReactNode }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "rounded-md border px-3 py-2 text-sm",
        tone === "error" && "border-destructive/50 text-destructive",
        tone === "warn" && "border-amber-500/40 text-foreground",
        tone === "info" && "border-dashed border-border text-muted-foreground",
        tone === "ok" && "border-border text-foreground",
      )}
    >
      {children}
    </div>
  );
}

function ErrorNotice({ raw, tone = "error", title }: { raw: string; tone?: "error" | "warn"; title?: string }) {
  const t = useMessages(messages);
  const { text, detail } = explain(useMessages(errors), raw);
  return (
    <Notice tone={tone}>
      {title ? <span className="font-medium">{title} </span> : null}
      {text}
      {detail && detail !== text ? (
        <details className="mt-1 text-xs text-muted-foreground">
          <summary className="cursor-pointer select-none">{t.details}</summary>
          <span className="break-words">{detail}</span>
        </details>
      ) : null}
    </Notice>
  );
}

function Section({ title, aside, children }: { title: string; aside?: ReactNode; children: ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <h2 className="text-sm font-medium">{title}</h2>
        {aside}
      </div>
      <div className="mt-3 space-y-3">{children}</div>
    </section>
  );
}

function Switch({ checked, onChange, label, disabled }: { checked: boolean; onChange: (next: boolean) => void; label: string; disabled?: boolean }) {
  return (
    <button
      type="button"
      role="switch"
      aria-checked={checked}
      aria-label={label}
      title={label}
      disabled={disabled}
      onClick={() => onChange(!checked)}
      className={cn(
        "relative inline-flex h-5 w-9 shrink-0 cursor-pointer items-center rounded-full border border-transparent transition-colors focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:cursor-not-allowed disabled:opacity-50",
        checked ? "bg-foreground" : "bg-input",
      )}
    >
      <span className={cn("inline-block size-4 rounded-full bg-background shadow transition-transform", checked ? "translate-x-4" : "translate-x-0")} />
    </button>
  );
}

function HealthBadge({ server }: { server: ServerView }) {
  const t = useMessages(messages);
  const lang = useLang();
  const { status, since, checkedAt, tools, detail } = server.health;
  const label = !server.enabled && status === "unknown" ? t.healthDisabled : { ok: t.healthOk, down: t.healthDown, unauthorized: t.healthUnauthorized, unknown: t.healthUnknown }[status];
  const dot = { ok: "bg-emerald-500", down: "bg-amber-500", unauthorized: "bg-destructive", unknown: "bg-muted-foreground/50" }[status];
  const extra = [
    since !== null && status !== "unknown" ? t.since(formatTime(since, lang)) : null,
    status === "ok" && tools !== null ? t.tools(tools) : null,
    status !== "ok" && detail ? detail : null,
  ].filter(Boolean);
  return (
    <span className="inline-flex min-w-0 flex-wrap items-center gap-x-1.5 text-xs" title={checkedAt !== null ? t.checkedAt(formatTime(checkedAt, lang)) : undefined}>
      <span className={cn("inline-block size-2 shrink-0 rounded-full", dot)} aria-hidden />
      <span className={cn("font-medium", status === "unauthorized" && "text-destructive", status === "down" && "text-amber-600 dark:text-amber-400")}>{label}</span>
      {extra.length > 0 ? <span className="text-muted-foreground">{extra.join(", ")}</span> : null}
    </span>
  );
}

function hostOf(url: string): string {
  try {
    const parsed = new URL(url);
    return `${parsed.host}${parsed.pathname.length > 1 ? parsed.pathname : ""}`;
  } catch {
    return url;
  }
}

function ServerRow({
  server,
  defaultTimeout,
  busy,
  run,
}: {
  server: ServerView;
  defaultTimeout: number;
  busy: boolean;
  run: (action: (rpc: Rpc, hostId: string) => Promise<Status>) => Promise<boolean>;
}) {
  const t = useMessages(messages);
  const [confirming, setConfirming] = useState(false);
  const [timeout, setTimeoutText] = useState(server.timeoutSec === null ? "" : String(server.timeoutSec));
  useEffect(() => setTimeoutText(server.timeoutSec === null ? "" : String(server.timeoutSec)), [server.timeoutSec]);
  const parsedTimeout = timeout.trim() === "" ? null : Number(timeout);
  const timeoutValid = parsedTimeout === null || (Number.isInteger(parsedTimeout) && parsedTimeout >= 1 && parsedTimeout <= 600);
  const timeoutChanged = parsedTimeout !== server.timeoutSec;

  return (
    <li className="space-y-2 py-3 first:pt-0 last:pb-0" data-server={server.name}>
      <div className="flex flex-wrap items-start gap-x-3 gap-y-2">
        <div className="pt-0.5">
          <Switch
            checked={server.enabled}
            disabled={busy}
            label={t.toggleLabel(server.name)}
            onChange={(enabled) => void run((rpc, hostId) => rpc.call("setEnabled", { hostId, name: server.name, enabled }))}
          />
        </div>
        <div className="min-w-0 flex-1 space-y-1">
          <div className="flex min-w-0 flex-wrap items-baseline gap-x-2">
            <span className="break-all font-mono text-sm">{server.name}</span>
            <span className="min-w-0 truncate text-xs text-muted-foreground" title={server.url}>
              {hostOf(server.url)}
            </span>
          </div>
          <HealthBadge server={server} />
        </div>
        <div className="flex shrink-0 flex-wrap items-center gap-1">
          <Button variant="ghost" size="sm" disabled={busy} onClick={() => void run((rpc, hostId) => rpc.call("check", { hostId, names: [server.name], maxAgeMs: 0 }))}>
            {t.check}
          </Button>
          {confirming ? (
            <>
              <span className="text-xs text-muted-foreground">{t.removeConfirm}</span>
              <Button
                variant="destructive"
                size="sm"
                disabled={busy}
                onClick={() => void run((rpc, hostId) => rpc.call("remove", { hostId, name: server.name })).then(() => setConfirming(false))}
              >
                {t.removeYes}
              </Button>
              <Button variant="ghost" size="sm" onClick={() => setConfirming(false)}>
                {t.keep}
              </Button>
            </>
          ) : (
            <Button variant="ghost" size="sm" disabled={busy} onClick={() => setConfirming(true)}>
              {t.remove}
            </Button>
          )}
        </div>
      </div>
      {server.conflict ? (
        <div className="flex flex-wrap items-center gap-2 pl-12">
          <span className="text-xs text-amber-600 dark:text-amber-400">{t.conflict}</span>
          <Button variant="outline" size="sm" disabled={busy} onClick={() => void run((rpc, hostId) => rpc.call("setEnabled", { hostId, name: server.name, enabled: true, replace: true }))}>
            {t.replace}
          </Button>
        </div>
      ) : null}
      {server.health.status === "unauthorized" && server.enabled ? <p className="pl-12 text-xs text-muted-foreground">{t.unauthorizedHint}</p> : null}
      <div className="flex flex-wrap items-center gap-2 pl-12 text-xs">
        <label className="flex items-center gap-2 text-muted-foreground" title={`${t.timeoutHint} ${t.timeoutDefault(defaultTimeout)}`}>
          {t.timeout}
          <Input
            className="h-7 w-16 text-xs md:h-7"
            inputMode="numeric"
            value={timeout}
            placeholder={defaultTimeout > 0 ? String(defaultTimeout) : "—"}
            aria-invalid={!timeoutValid}
            onChange={(event) => setTimeoutText(event.target.value.replace(/[^\d]/g, ""))}
          />
        </label>
        {timeoutChanged && timeoutValid ? (
          <Button variant="outline" size="sm" className="h-7" disabled={busy} onClick={() => void run((rpc, hostId) => rpc.call("setTimeout", { hostId, name: server.name, timeoutSec: parsedTimeout }))}>
            {t.saveTimeout}
          </Button>
        ) : null}
      </div>
    </li>
  );
}

function ConnectSection({ rpc, hostId, onResult }: { rpc: Rpc; hostId: string; onResult: (result: ImportResult) => void }) {
  const t = useMessages(messages);
  const why = useMessages(reasons);
  const [text, setText] = useState("");
  const [visible, setVisible] = useState(false);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [result, setResult] = useState<ImportResult | null>(null);

  const add = async () => {
    setBusy(true);
    setError(null);
    setResult(null);
    try {
      const outcome = await rpc.call("importConfig", { hostId, text });
      // The pasted text holds tokens: it does not stay on the page.
      setText("");
      setVisible(false);
      setResult(outcome);
      onResult(outcome);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Section title={t.connectTitle}>
      <p className="text-sm text-muted-foreground">{t.connectHint}</p>
      <div className="space-y-1">
        <div className="flex items-center justify-between gap-2">
          <label htmlFor="mcp-paste" className="text-sm text-muted-foreground">
            {t.pasteLabel}
          </label>
          <Button variant="ghost" size="sm" className="h-7" onClick={() => setVisible((value) => !value)} aria-pressed={visible}>
            {visible ? t.hide : t.show}
          </Button>
        </div>
        <textarea
          id="mcp-paste"
          className="min-h-32 w-full rounded-md border border-input bg-transparent px-3 py-2 font-mono text-xs placeholder:text-muted-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          style={visible ? undefined : ({ WebkitTextSecurity: "disc" } as React.CSSProperties)}
          spellCheck={false}
          autoComplete="off"
          autoCorrect="off"
          autoCapitalize="off"
          data-1p-ignore
          data-lpignore="true"
          placeholder={t.pastePlaceholder}
          value={text}
          onChange={(event) => setText(event.target.value)}
        />
        <p className="text-xs text-muted-foreground">{t.secretsNote}</p>
      </div>
      <div className="flex items-center gap-2">
        <Button size="sm" disabled={busy || text.trim() === ""} onClick={() => void add()}>
          {busy ? t.adding : t.add}
        </Button>
      </div>
      {error ? <ErrorNotice raw={error} /> : null}
      {result ? (
        <Notice tone={result.added.length + result.updated.length > 0 ? "ok" : "warn"}>
          {result.added.length > 0 ? <p>{t.added(result.added.join(", "))}</p> : null}
          {result.updated.length > 0 ? <p>{t.updated(result.updated.join(", "))}</p> : null}
          {result.skipped.length > 0 ? (
            <div className="mt-1">
              <p className="text-muted-foreground">{t.skippedTitle}</p>
              <ul className="list-disc pl-5">
                {result.skipped.map((skip) => (
                  <li key={skip.name}>
                    <span className="font-mono">{skip.name}</span> — {why[skip.reason]}
                  </li>
                ))}
              </ul>
            </div>
          ) : null}
        </Notice>
      ) : null}
    </Section>
  );
}

const slug = (value: string) => value.toLowerCase().replace(/[^a-z0-9]+/g, "");

/** Whether one of the person's servers was made from this catalog item: its name carries the item's id or name. */
export function isConnected(item: CatalogItem, servers: readonly ServerView[]): boolean {
  const keys = new Set([slug(item.id), slug(item.name)].filter((key) => key.length >= 2));
  return servers.some((server) => {
    const parts = server.name.toLowerCase().split(/[^a-z0-9]+/).filter(Boolean);
    return parts.some((part) => keys.has(part)) || keys.has(slug(server.name));
  });
}

export function platformLink(platformUrl: string, item: CatalogItem): string | null {
  const base = platformUrl.trim();
  if (!/^https?:\/\//i.test(base)) return null;
  return base.includes("{id}") ? base.split("{id}").join(encodeURIComponent(item.id)) : base;
}

function CatalogSection({ rpc, hostId, platformUrl, servers }: { rpc: Rpc; hostId: string; platformUrl: string; servers: readonly ServerView[] }) {
  const t = useMessages(messages);
  const [catalog, setCatalog] = useState<Catalog | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [query, setQuery] = useState("");
  const [loading, setLoading] = useState(false);

  const load = useCallback(
    (refresh: boolean) => {
      setLoading(true);
      setError(null);
      rpc
        .call("catalog", refresh ? { hostId, refresh: true } : { hostId })
        .then(setCatalog, (cause) => setError(errorText(cause)))
        .finally(() => setLoading(false));
    },
    [rpc, hostId],
  );
  useEffect(() => load(false), [load]);

  const items = useMemo(() => {
    const all = catalog?.items ?? [];
    const words = query.toLowerCase().split(/\s+/).filter(Boolean);
    return words.length === 0 ? all : all.filter((item) => words.every((word) => `${item.name} ${item.description ?? ""} ${item.category ?? ""}`.toLowerCase().includes(word)));
  }, [catalog, query]);

  return (
    <Section
      title={t.catalogTitle}
      aside={
        <Button variant="ghost" size="sm" disabled={loading} onClick={() => load(true)}>
          {loading ? t.loading : t.catalogRefresh}
        </Button>
      }
    >
      <p className="text-sm text-muted-foreground">{t.catalogHint}</p>
      {error ? <ErrorNotice raw={error} /> : null}
      {catalog?.error ? <ErrorNotice raw={catalog.error} tone={catalog.items.length > 0 ? "warn" : "error"} /> : null}
      {!platformUrl ? <Notice tone="info">{t.noPlatform}</Notice> : null}
      {catalog && catalog.items.length > 6 ? (
        <Input className="max-w-sm" type="search" placeholder={t.catalogSearch} aria-label={t.catalogSearch} value={query} onChange={(event) => setQuery(event.target.value)} />
      ) : null}
      {catalog === null && !error ? <Notice tone="info">{t.loading}</Notice> : null}
      {catalog && catalog.items.length === 0 && !catalog.error ? <Notice tone="info">{t.catalogEmpty}</Notice> : null}
      {catalog && catalog.items.length > 0 && items.length === 0 ? <Notice tone="info">{t.catalogNothingFound}</Notice> : null}
      {items.length > 0 ? (
        <ul className="grid gap-3 sm:grid-cols-2 xl:grid-cols-3">
          {items.map((item) => {
            const link = platformLink(platformUrl, item);
            const connected = isConnected(item, servers);
            return (
              <li key={item.id} className="flex min-w-0 flex-col gap-2 rounded-md border border-border p-3" data-catalog-item={item.id}>
                <div className="flex min-w-0 items-start justify-between gap-2">
                  <span className="min-w-0 break-words text-sm font-medium">{item.name}</span>
                  {connected ? <span className="shrink-0 rounded-full border border-border px-2 py-0.5 text-xs text-muted-foreground">{t.connected}</span> : null}
                </div>
                {item.category ? <span className="text-xs text-muted-foreground">{item.category}</span> : null}
                {item.description ? <p className="line-clamp-4 text-xs text-muted-foreground">{item.description}</p> : null}
                {link ? (
                  <div className="mt-auto pt-1">
                    <Button variant="outline" size="sm" asChild>
                      <a href={link} target="_blank" rel="noopener noreferrer">
                        {t.create}
                      </a>
                    </Button>
                  </div>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </Section>
  );
}

export function McpPage() {
  const rpc = useRpc<typeof rpcContract>();
  const t = useMessages(messages);
  const [overview, setOverview] = useState<Overview | null>(null);
  const [hostId, setHostId] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [actionError, setActionError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const [checking, setChecking] = useState(false);
  const generation = useRef(0);

  useEffect(() => {
    rpc.call("machines").then(
      (result) => {
        setOverview(result);
        const connected = result.machines.filter((machine) => machine.connected);
        const remembered = connected.find((machine) => machine.id === result.lastUsed);
        setHostId((remembered ?? connected[0] ?? null)?.id ?? null);
      },
      (cause) => setError(errorText(cause)),
    );
  }, [rpc]);

  const check = useCallback(
    (names: string[] | undefined, maxAgeMs: number) => {
      if (!hostId) return;
      const mine = generation.current;
      setChecking(true);
      rpc
        .call("check", names ? { hostId, names, maxAgeMs } : { hostId, maxAgeMs })
        .then(
          (next) => {
            if (generation.current === mine) setStatus(next);
          },
          (cause) => setActionError(errorText(cause)),
        )
        .finally(() => setChecking(false));
    },
    [rpc, hostId],
  );

  // On open: what the machine knows now, then a fresh check of anything not checked in the last two minutes.
  useEffect(() => {
    if (!hostId) return;
    const mine = ++generation.current;
    setStatus(null);
    setError(null);
    rpc.call("status", { hostId }).then(
      (next) => {
        if (generation.current !== mine) return;
        setStatus(next);
        if (next.servers.length > 0) check(undefined, 120_000);
      },
      (cause) => setError(errorText(cause)),
    );
  }, [rpc, hostId, check]);

  useRealtime("servers-changed", (payload) => {
    const changed = (payload as { hostId?: string } | null)?.hostId;
    if (!hostId || changed !== hostId || busy) return;
    rpc.call("status", { hostId }).then(setStatus, () => undefined);
  });

  const run = useCallback(
    async (action: (client: Rpc, machine: string) => Promise<Status>) => {
      if (!hostId) return false;
      setBusy(true);
      setActionError(null);
      try {
        setStatus(await action(rpc, hostId));
        return true;
      } catch (cause) {
        setActionError(errorText(cause));
        return false;
      } finally {
        setBusy(false);
      }
    },
    [rpc, hostId],
  );

  const connected = (overview?.machines ?? []).filter((machine) => machine.connected);
  const servers = status?.servers ?? [];

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto" data-mcp-page>
      <div className="mx-auto box-border w-full max-w-5xl space-y-4 px-4 pb-6 pt-3 md:px-5 md:pt-4">
        <div className="flex items-start justify-between gap-3">
          <div className="min-w-0 space-y-1">
            <h1 className="text-base font-semibold">{t.title}</h1>
            <p className="text-sm text-muted-foreground">{t.intro}</p>
          </div>
          <LanguageSwitch className="mt-1 shrink-0" />
        </div>

        {overview === null && !error ? <Notice tone="info">{t.loading}</Notice> : null}
        {overview !== null && connected.length === 0 ? <Notice tone="error">{t.noMachine}</Notice> : null}
        {connected.length > 1 ? (
          <label className="block max-w-sm space-y-1 text-sm">
            <span className="text-muted-foreground">{t.machineLabel}</span>
            <select className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm" value={hostId ?? ""} onChange={(event) => setHostId(event.target.value)}>
              {connected.map((machine) => (
                <option key={machine.id} value={machine.id}>
                  {machine.name}
                </option>
              ))}
            </select>
          </label>
        ) : null}
        {error ? <ErrorNotice raw={error} /> : null}
        {hostId && status === null && !error ? <Notice tone="info">{t.askingMachine}</Notice> : null}

        {hostId && status ? (
          <>
            {status.configError ? <ErrorNotice raw={status.configError} tone="warn" title={t.configErrorTitle} /> : null}
            <Section
              title={servers.length > 0 ? `${t.mineTitle} (${servers.length})` : t.mineTitle}
              aside={
                servers.length > 0 ? (
                  <Button variant="ghost" size="sm" disabled={checking || busy} onClick={() => check(undefined, 0)}>
                    {checking ? t.checking : t.refresh}
                  </Button>
                ) : null
              }
            >
              {actionError ? <ErrorNotice raw={actionError} /> : null}
              {servers.length === 0 ? (
                <Notice tone="info">{t.mineEmpty}</Notice>
              ) : (
                <ul className="divide-y divide-border">
                  {servers.map((server) => (
                    <ServerRow key={server.name} server={server} defaultTimeout={overview?.timeoutSec ?? 0} busy={busy} run={run} />
                  ))}
                </ul>
              )}
              {servers.length > 0 ? (
                <p className="text-xs text-muted-foreground">
                  {t.newThreadNote} {t.storeNote(status.store)}
                </p>
              ) : null}
            </Section>
            <ConnectSection
              rpc={rpc}
              hostId={hostId}
              onResult={(result) => {
                setStatus(result.status);
                const fresh = [...result.added, ...result.updated];
                if (fresh.length > 0) check(fresh, 0);
              }}
            />
            {overview?.catalogConfigured ? <CatalogSection rpc={rpc} hostId={hostId} platformUrl={overview.platformUrl} servers={servers} /> : null}
          </>
        ) : null}
      </div>
    </div>
  );
}
