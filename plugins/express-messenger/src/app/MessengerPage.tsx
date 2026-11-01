// The Messenger page: choose the machine, sign in there, keep the directory current, and manage
// the watch rules. Chat names shown here stay in the person's own bb.
import { useCallback, useEffect, useRef, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { useBbNavigate, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { Matches, Status } from "../../contract";
import type { Overview, Rule, rpcContract } from "../../server";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { intlLocale, LanguageSwitch, useLang, useMessages } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { messages } from "./messages";

/** The server's realtime channel, RULES_CHANGED in server.ts (the panel may import only types from there). */
const RULES_CHANGED = "rules-changed";

const errorText = (cause: unknown) => (cause instanceof Error ? cause.message : String(cause));

function Section({ title, children, aside }: { title: string; children: ReactNode; aside?: ReactNode }) {
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

function Notice({ tone, children }: { tone: "ok" | "error" | "info"; children: ReactNode }) {
  return (
    <div
      role={tone === "error" ? "alert" : "status"}
      className={cn(
        "rounded-md border px-3 py-2 text-sm",
        tone === "ok" && "border-border text-foreground",
        tone === "error" && "border-destructive/50 text-destructive",
        tone === "info" && "border-dashed border-border text-muted-foreground",
      )}
    >
      {children}
    </div>
  );
}

function Row({ label, children }: { label: string; children: ReactNode }) {
  return (
    <div className="flex flex-wrap gap-x-3 gap-y-0.5 text-sm">
      <span className="min-w-[9rem] text-muted-foreground">{label}</span>
      <span className="min-w-0 flex-1 break-words">{children}</span>
    </div>
  );
}

export function MessengerPage() {
  const t = useMessages(messages);
  const lang = useLang();
  const rpc = useRpc<typeof rpcContract>();
  const navigate = useBbNavigate();
  const [overview, setOverview] = useState<Overview | null>(null);
  const [hostId, setHostId] = useState<string | null>(null);
  const [status, setStatus] = useState<Status | null>(null);
  const [rules, setRules] = useState<Rule[]>([]);
  const [busy, setBusy] = useState<"signIn" | "sync" | "forget" | "check" | null>(null);
  const [note, setNote] = useState<{ tone: "ok" | "error"; text: string } | null>(null);
  const statusRequest = useRef(0);

  const when = useCallback(
    (ms: number) => new Intl.DateTimeFormat(intlLocale(lang), { day: "numeric", month: "short", hour: "2-digit", minute: "2-digit" }).format(new Date(ms)),
    [lang],
  );

  useEffect(() => {
    rpc.call("overview", null).then((value) => {
      setOverview(value);
      const connected = value.machines.filter((machine) => machine.connected);
      const remembered = value.machines.find((machine) => machine.id === value.lastUsed);
      setHostId((current) => current ?? remembered?.id ?? connected[0]?.id ?? value.machines[0]?.id ?? null);
    }, (cause) => setNote({ tone: "error", text: errorText(cause) }));
  }, [rpc]);

  const loadStatus = useCallback(() => {
    if (!hostId || !overview?.url) return;
    const request = ++statusRequest.current;
    rpc.call("status", { hostId }).then(
      (value) => {
        if (request === statusRequest.current) setStatus(value);
      },
      (cause) => {
        if (request === statusRequest.current) {
          setStatus(null);
          setNote({ tone: "error", text: errorText(cause) });
        }
      },
    );
  }, [rpc, hostId, overview?.url]);
  useEffect(loadStatus, [loadStatus]);

  const loadRules = useCallback(() => {
    rpc.call("rules", null).then((value) => setRules(value.rules), (cause) => setNote({ tone: "error", text: errorText(cause) }));
  }, [rpc]);
  useEffect(loadRules, [loadRules]);
  useRealtime(RULES_CHANGED, loadRules);

  const act = async (kind: NonNullable<typeof busy>, work: () => Promise<{ ok: boolean; message: string }>) => {
    setBusy(kind);
    setNote(null);
    try {
      const result = await work();
      setNote({ tone: result.ok ? "ok" : "error", text: result.message });
    } catch (cause) {
      setNote({ tone: "error", text: errorText(cause) });
    } finally {
      setBusy(null);
      loadStatus();
    }
  };

  if (!overview) {
    return <div className="p-6 text-sm text-muted-foreground">{note ? note.text : t.loading}</div>;
  }

  const machine = overview.machines.find((candidate) => candidate.id === hostId) ?? null;
  const ready = !!overview.url && !!machine?.connected;

  return (
    <div className="mx-auto w-full max-w-3xl space-y-4 p-4 sm:p-6">
      <header className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-lg font-semibold">{t.title}</h1>
          <p className="mt-1 text-sm text-muted-foreground">{t.intro}</p>
        </div>
        <LanguageSwitch />
      </header>

      {!overview.url ? <Notice tone="error">{t.noUrl}</Notice> : null}
      {note ? <Notice tone={note.tone}>{note.text}</Notice> : null}

      <Section title={t.machine}>
        {overview.machines.length === 0 ? (
          <Notice tone="info">{t.noMachines}</Notice>
        ) : (
          <label className="block space-y-1 text-sm">
            <select
              className="h-9 w-full rounded-md border border-input bg-transparent px-2 text-sm"
              value={hostId ?? ""}
              onChange={(event) => {
                setHostId(event.target.value);
                setStatus(null);
              }}
            >
              {overview.machines.map((candidate) => (
                <option key={candidate.id} value={candidate.id}>
                  {candidate.name}
                  {candidate.connected ? "" : ` (${t.offline})`}
                </option>
              ))}
            </select>
            <span className="block text-xs text-muted-foreground">{t.machineHint}</span>
          </label>
        )}
      </Section>

      <Section title={t.signInTitle}>
        {status ? (
          <div className="space-y-1.5">
            <Row label={t.browser}>{status.browser ?? <span className="text-destructive">{t.noBrowser}</span>}</Row>
            <Row label={t.signedIn}>{status.signedIn === null ? t.unknown : status.signedIn ? t.signedIn : <span className="text-destructive">{t.signedOut}</span>}</Row>
            <Row label={t.directory}>
              {status.directory ? t.directoryLine(String(status.directory.chats), String(status.directory.people), when(status.directory.at)) : t.noDirectory}
            </Row>
            {status.lastError ? <Row label={t.lastProblem}>{status.lastError}</Row> : null}
          </div>
        ) : ready ? (
          <p className="text-sm text-muted-foreground">{t.loading}</p>
        ) : null}
        <div className="flex flex-wrap gap-2">
          <Button size="sm" disabled={!ready || busy !== null || status?.browser === null} onClick={() => act("signIn", () => rpc.call("signIn", { hostId: hostId! }))}>
            {busy === "signIn" ? t.signingIn : t.signIn}
          </Button>
          <Button size="sm" variant="outline" disabled={!ready || busy !== null || status?.browser === null} onClick={() => act("sync", () => rpc.call("sync", { hostId: hostId! }))}>
            {busy === "sync" ? t.syncing : t.sync}
          </Button>
          <Button
            size="sm"
            variant="ghost"
            disabled={!machine?.connected || busy !== null}
            onClick={() => {
              if (window.confirm(t.forgetConfirm)) void act("forget", () => rpc.call("forget", { hostId: hostId! }));
            }}
          >
            {t.forget}
          </Button>
        </div>
      </Section>

      <Section title={t.agentsTitle}>
        {overview.policy.error ? <Notice tone="error">{overview.policy.error}</Notice> : null}
        <Row label={t.allowed}>
          {overview.policy.rules.length ? (
            <span className="font-mono text-xs">{overview.policy.rules.map((rule) => `${rule.provider} ${rule.model}`).join(", ")}</span>
          ) : (
            <span className="text-destructive">{t.noneAllowed}</span>
          )}
        </Row>
        <Row label={t.digestAgent}>
          {overview.digestAgent.text ? <span className="font-mono text-xs">{overview.digestAgent.text}</span> : "—"}
          {overview.digestAgent.problem ? (
            <span className="block text-xs text-destructive">{overview.digestAgent.problem === "unset" ? t.digestUnset : t.digestNotAllowed}</span>
          ) : null}
        </Row>
        <p className="text-sm text-muted-foreground">{overview.confirmSend ? t.confirmOn : t.confirmOff}</p>
      </Section>

      <Section
        title={t.rulesTitle}
        aside={
          rules.length ? (
            <Button size="sm" variant="outline" disabled={busy !== null} onClick={() => act("check", () => rpc.call("checkNow", null))}>
              {t.checkNow}
            </Button>
          ) : null
        }
      >
        <p className="text-sm text-muted-foreground">{t.rulesIntro}</p>
        {rules.length === 0 ? <Notice tone="info">{t.noRules}</Notice> : null}
        <ul className="divide-y divide-border">
          {rules.map((rule) => {
            const where = overview.machines.find((candidate) => candidate.id === rule.hostId);
            return (
              <li key={rule.id} className="flex flex-wrap items-center gap-2 py-2.5 text-sm">
                <div className="min-w-0 flex-1">
                  <div className={cn("truncate font-medium", !rule.enabled && "text-muted-foreground line-through")}>{rule.chatName}</div>
                  <div className="text-xs text-muted-foreground">
                    {[where?.name, t.ruleLine(rule.last, rule.cooldownMinutes), rule.lastFiredAt ? t.firedAt(when(rule.lastFiredAt)) : t.notFired].filter(Boolean).join(" · ")}
                  </div>
                  {rule.instructions ? <div className="text-xs text-muted-foreground">“{rule.instructions}”</div> : null}
                  {rule.lastError ? <div className="text-xs text-destructive">{rule.lastError}</div> : null}
                </div>
                {rule.lastThreadId ? (
                  <Button size="sm" variant="ghost" onClick={() => navigate.toThread(rule.lastThreadId!, { split: true })}>
                    {t.openThread}
                  </Button>
                ) : null}
                <Button
                  size="sm"
                  variant="outline"
                  aria-pressed={rule.enabled}
                  onClick={() => rpc.call("setRuleEnabled", { id: rule.id, enabled: !rule.enabled }).catch((cause) => setNote({ tone: "error", text: errorText(cause) }))}
                >
                  {rule.enabled ? t.on : t.off}
                </Button>
                <Button size="sm" variant="ghost" onClick={() => rpc.call("removeRule", { id: rule.id }).catch((cause) => setNote({ tone: "error", text: errorText(cause) }))}>
                  {t.remove}
                </Button>
              </li>
            );
          })}
        </ul>
        {ready && hostId ? <AddRule hostId={hostId} onError={(text) => setNote({ tone: "error", text })} /> : null}
      </Section>
    </div>
  );
}

function AddRule({ hostId, onError }: { hostId: string; onError: (text: string) => void }) {
  const t = useMessages(messages);
  const rpc = useRpc<typeof rpcContract>();
  const [query, setQuery] = useState("");
  const [found, setFound] = useState<Matches | null>(null);
  const [searching, setSearching] = useState(false);
  const [last, setLast] = useState("10");
  const [cooldown, setCooldown] = useState("15");
  const [instructions, setInstructions] = useState("");
  const request = useRef(0);

  const search = (event: FormEvent) => {
    event.preventDefault();
    if (!query.trim()) return;
    const mine = ++request.current;
    setSearching(true);
    rpc
      .call("findChats", { hostId, query: query.trim() })
      .then(
        (value) => {
          if (mine === request.current) setFound(value);
        },
        (cause) => onError(errorText(cause)),
      )
      .finally(() => {
        if (mine === request.current) setSearching(false);
      });
  };

  const watch = (chatId: string) => {
    const lastN = Math.min(50, Math.max(1, Number(last) || 10));
    const minutes = Math.min(1440, Math.max(1, Number(cooldown) || 15));
    rpc
      .call("addRule", { hostId, chatId, last: lastN, cooldownMinutes: minutes, ...(instructions.trim() ? { instructions: instructions.trim() } : {}) })
      .then(
        () => {
          setFound(null);
          setQuery("");
          setInstructions("");
        },
        (cause) => onError(errorText(cause)),
      );
  };

  return (
    <div className="space-y-2 rounded-md border border-dashed border-border p-3">
      <div className="text-sm font-medium">{t.addTitle}</div>
      <form className="flex flex-wrap gap-2" onSubmit={search}>
        <Input className="min-w-[12rem] flex-1" aria-label={t.search} placeholder={t.searchPlaceholder} value={query} onChange={(event) => setQuery(event.target.value)} />
        <Button size="sm" type="submit" variant="outline" disabled={searching || !query.trim()}>
          {searching ? t.loading : t.find}
        </Button>
      </form>
      <div className="grid gap-2" style={{ gridTemplateColumns: "repeat(auto-fill, minmax(10rem, 1fr))" }}>
        <label className="space-y-1 text-xs text-muted-foreground">
          <span>{t.lastField}</span>
          <Input type="number" min={1} max={50} value={last} onChange={(event) => setLast(event.target.value)} />
        </label>
        <label className="space-y-1 text-xs text-muted-foreground">
          <span>{t.cooldownField}</span>
          <Input type="number" min={1} max={1440} value={cooldown} onChange={(event) => setCooldown(event.target.value)} />
        </label>
      </div>
      <label className="block space-y-1 text-xs text-muted-foreground">
        <span>{t.instructionsField}</span>
        <Input placeholder={t.instructionsPlaceholder} value={instructions} maxLength={1000} onChange={(event) => setInstructions(event.target.value)} />
      </label>
      {found && found.matches.length === 0 ? <p className="text-sm text-muted-foreground">{t.noMatches}</p> : null}
      {found && found.matches.length ? (
        <ul className="divide-y divide-border">
          {found.matches.map((chat) => (
            <li key={chat.id} className="flex flex-wrap items-center gap-2 py-2 text-sm">
              <div className="min-w-0 flex-1">
                <div className="truncate">{chat.name}</div>
                <div className="text-xs text-muted-foreground">
                  {[t.kind(chat.kind), chat.person?.position, chat.unread ? t.unread(chat.unread) : null].filter(Boolean).join(" · ")}
                </div>
              </div>
              <Button size="sm" onClick={() => watch(chat.id)}>
                {t.watch}
              </Button>
            </li>
          ))}
        </ul>
      ) : null}
    </div>
  );
}
