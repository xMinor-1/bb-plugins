// The Qlik Sense panel: pick the machine agents run on, sign in, tick reports, choose agents.
import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { ConnectionStatus } from "../../contract";
import type { rpcContract } from "../../server";
import { AgentsSection } from "./AgentsSection";
import { ConnectionSection } from "./ConnectionSection";
import { ReportsSection } from "./ReportsSection";
import { Notice, errorText } from "./ui";

type Machine = { id: string; name: string; connected: boolean };

export function QlikPage() {
  const rpc = useRpc<typeof rpcContract>();
  const [machines, setMachines] = useState<Machine[] | null>(null);
  const [hostId, setHostId] = useState<string | null>(null);
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [suggestedUrl, setSuggestedUrl] = useState("");

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
  const signedIn = Boolean(status?.hasPassword && status.lastCheck?.ok && !status.blocked);

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl space-y-4 px-4 pb-6 pt-3 md:px-5 md:pt-4">
        <p className="text-sm text-muted-foreground">
          Agents read the Qlik Sense reports you tick here, and only with the models you allow. Qlik is reached from the machine below; the
          password stays on it.
        </p>

        {machines === null && !error ? <Notice tone="info">Loading…</Notice> : null}
        {machines !== null && connected.length === 0 ? <Notice tone="error">No machine is connected to bb right now.</Notice> : null}

        {connected.length > 1 ? (
          <label className="block space-y-1 text-sm">
            <span className="text-muted-foreground">Machine where agents reach Qlik</span>
            <select
              className="h-9 w-full rounded-md border border-input bg-transparent px-3 text-sm"
              value={hostId ?? ""}
              onChange={(event) => setHostId(event.target.value)}
            >
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
            <ConnectionSection rpc={rpc} hostId={hostId} status={status} suggestedUrl={suggestedUrl} onStatus={setStatus} />
            <ReportsSection key={`${hostId}:${status.url ?? ""}`} rpc={rpc} hostId={hostId} signedIn={signedIn} />
            <AgentsSection rpc={rpc} hostId={hostId} />
          </>
        ) : hostId && !error ? (
          <Notice tone="info">Asking the machine…</Notice>
        ) : null}
      </div>
    </div>
  );
}
