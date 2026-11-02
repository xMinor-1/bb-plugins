// The sign-in page: pick the machine agents run on, sign in, see who may read the data.
import { useCallback, useEffect, useState } from "react";
import { useRpc } from "@get-bb/plugin-sdk/app";
import type { ConnectionStatus } from "../../contract";
import type { rpcContract } from "../../server";
import { ConnectionSection } from "./ConnectionSection";
import { LanguageSwitch, useMessages } from "@/lib/i18n";
import { messages } from "./messages";
import { Notice, Section, errorText } from "./ui";

type Machine = { id: string; name: string; connected: boolean };
type Config = { name: string; summary: string; notice: string; address: string | null; problem: string | null; canCheck: boolean; rules: { provider: string; model: string }[] };

export function DataServicePage() {
  const rpc = useRpc<typeof rpcContract>();
  const [machines, setMachines] = useState<Machine[] | null>(null);
  const [config, setConfig] = useState<Config | null>(null);
  const [hostId, setHostId] = useState<string | null>(null);
  const [status, setStatus] = useState<ConnectionStatus | null>(null);
  const [error, setError] = useState<string | null>(null);
  const t = useMessages(messages);

  useEffect(() => {
    rpc.call("config").then(setConfig, (cause) => setError(errorText(cause)));
    rpc.call("machines").then(
      ({ machines: list, lastUsed }) => {
        setMachines(list);
        const connected = list.filter((machine) => machine.connected);
        setHostId((connected.find((machine) => machine.id === lastUsed) ?? connected[0] ?? null)?.id ?? null);
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

  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl space-y-4 px-4 pb-6 pt-3 md:px-5 md:pt-4">
        <div className="flex items-start gap-3">
          <div className="flex-1 space-y-1">
            {config ? <h1 className="text-base font-medium">{config.name}</h1> : null}
            <p className="text-sm text-muted-foreground">{config?.summary || t.intro}</p>
            {config?.summary ? <p className="text-sm text-muted-foreground">{t.intro}</p> : null}
          </div>
          <LanguageSwitch />
        </div>

        {machines === null && !error ? <Notice tone="info">{t.loading}</Notice> : null}
        {machines !== null && connected.length === 0 ? <Notice tone="error">{t.noMachine}</Notice> : null}
        {config?.problem ? (
          <Notice tone="error">
            <p>{t.configProblem}</p>
            <p className="mt-1 text-xs opacity-80">{t.technical(config.problem)}</p>
          </Notice>
        ) : null}
        {config?.notice ? <Notice tone="warn">{config.notice}</Notice> : null}

        {connected.length > 1 ? (
          <label className="block space-y-1 text-sm">
            <span className="text-muted-foreground">{t.machine}</span>
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

        {hostId && status && config ? (
          <>
            <ConnectionSection rpc={rpc} hostId={hostId} status={status} address={config.address} onStatus={setStatus} />
            <Section step={2} title={t.agentsTitle}>
              {config.rules.length ? (
                <>
                  <ul className="space-y-1 text-sm">
                    {config.rules.map((rule) => (
                      <li key={`${rule.provider} ${rule.model}`} className="font-mono text-xs">
                        {rule.provider} {rule.model}
                      </li>
                    ))}
                  </ul>
                  <p className="text-xs text-muted-foreground">{t.agentsHint}</p>
                </>
              ) : (
                <Notice tone="warn">{t.agentsNone}</Notice>
              )}
            </Section>
          </>
        ) : hostId && !error ? (
          <Notice tone="info">{t.askingMachine}</Notice>
        ) : null}
      </div>
    </div>
  );
}
