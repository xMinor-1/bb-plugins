// The Mail page: pick the machine, connect the mailbox, read and answer mail,
// send the drafts agents prepared, choose which agents may read mail.
import { useCallback, useEffect, useState } from "react";
import { useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { ConnectionStatus, Draft, Folder } from "../../contract";
import type { rpcContract } from "../../server";
import { Button } from "@/components/ui/button";
import { LanguageSwitch, useMessages } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { messages } from "../messages";
import { AgentsSection } from "./AgentsSection";
import { ConnectionSection } from "./ConnectionSection";
import { DraftCard } from "./DraftCard";
import { Mailbox } from "./Mailbox";
import { Notice, errorText } from "./ui";
import type { Rpc } from "./rpc";

type Machine = { id: string; name: string; connected: boolean };
type Tab = Folder | "waiting" | "settings";

const TABS: { id: Tab; label: "tabInbox" | "tabWaiting" | "tabSent" | "tabSettings" }[] = [
  { id: "inbox", label: "tabInbox" },
  { id: "waiting", label: "tabWaiting" },
  { id: "sent", label: "tabSent" },
  { id: "settings", label: "tabSettings" },
];

export function MailPage() {
  const rpc = useRpc<typeof rpcContract>();
  const t = useMessages(messages);
  const [machines, setMachines] = useState<Machine[] | null>(null);
  const [hostId, setHostId] = useState<string | null>(null);
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [suggestedUrl, setSuggestedUrl] = useState("");
  const [tab, setTab] = useState<Tab>("inbox");

  useEffect(() => {
    rpc.call("machines").then(
      ({ machines: list, lastUsed, suggestedUrl: url }) => {
        setMachines(list);
        setSuggestedUrl(url);
        const connected = list.filter((machine) => machine.connected);
        const remembered = connected.find((machine) => machine.id === lastUsed);
        setHostId((remembered ?? connected[0] ?? null)?.id ?? null);
      },
      (cause) => setError(errorText(cause)),
    );
  }, [rpc]);

  const loadStatus = useCallback(() => {
    if (!hostId) return;
    setStatus(null);
    setError(null);
    rpc.call("status", { hostId }).then(setStatus, (cause) => setError(errorText(cause)));
  }, [rpc, hostId]);

  useEffect(loadStatus, [loadStatus]);

  const connected = (machines ?? []).filter((machine) => machine.connected);
  const ready = Boolean(status?.url && status.lastCheck?.ok);
  const current: Tab = ready ? tab : "settings";

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-6xl space-y-4 px-4 pb-6 pt-3 md:px-5 md:pt-4">
        <div className={cn("flex items-start justify-between gap-2", hostId && status && ready && "border-b border-border pb-2")}>
          {hostId && status && ready ? (
            <nav className="flex min-w-0 flex-wrap gap-1" aria-label={t.navLabel}>
              {TABS.map((item) => (
                <Button key={item.id} variant="ghost" size="sm" aria-pressed={current === item.id} onClick={() => setTab(item.id)}>
                  {t[item.label]}
                </Button>
              ))}
            </nav>
          ) : (
            <span />
          )}
          <LanguageSwitch className="mt-1" />
        </div>
        {machines === null && !error ? <Notice tone="info">{t.loading}</Notice> : null}
        {machines !== null && connected.length === 0 ? <Notice tone="error">{t.noMachine}</Notice> : null}

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

        {error ? <Notice tone="error">{error}</Notice> : null}

        {hostId && status ? (
          <>
            {current === "inbox" || current === "sent" ? <Mailbox key={`${hostId}:${current}`} rpc={rpc} hostId={hostId} folder={current} /> : null}
            {current === "waiting" ? <Waiting rpc={rpc} hostId={hostId} /> : null}
            {current === "settings" ? (
              <div className={cn("max-w-3xl space-y-4")}>
                {!ready ? (
                  <p className="text-sm text-muted-foreground">{t.intro}</p>
                ) : null}
                <ConnectionSection rpc={rpc} hostId={hostId} status={status} suggestedUrl={suggestedUrl} onStatus={setStatus} />
                <AgentsSection rpc={rpc} hostId={hostId} />
              </div>
            ) : null}
          </>
        ) : hostId && !error ? (
          <Notice tone="info">{t.askingMachine}</Notice>
        ) : null}
      </div>
    </div>
  );
}

/** Drafts prepared in bb that wait for the person's Send. */
function Waiting({ rpc, hostId }: { rpc: Rpc; hostId: string }) {
  const t = useMessages(messages);
  const [drafts, setDrafts] = useState<Draft[] | null>(null);
  const [error, setError] = useState<string | null>(null);

  const load = useCallback(() => {
    rpc.call("drafts", { hostId }).then(
      (result) => {
        setDrafts(result.drafts);
        setError(null);
      },
      (cause) => setError(errorText(cause)),
    );
  }, [rpc, hostId]);

  useEffect(load, [load]);
  useRealtime("drafts-changed", (payload) => {
    const id = (payload as { id?: string } | null)?.id;
    if (!drafts?.some((draft) => draft.id === id)) load();
  });

  if (error) return <Notice tone="error">{error}</Notice>;
  if (drafts === null) return <Notice tone="info">{t.loadingDrafts}</Notice>;
  if (drafts.length === 0) return <Notice tone="info">{t.nothingWaiting}</Notice>;
  return (
    <div className="max-w-3xl space-y-3">
      {drafts.map((draft) => (
        <DraftCard key={`${draft.id}:${draft.revision}`} rpc={rpc} target={{ hostId }} id={draft.id} initial={draft} />
      ))}
    </div>
  );
}
