// Which agents (provider + model) may read mail. The list comes from the
// plugin's settings, which the company's bb build sets; the panel shows it and
// which agents on this machine it covers, and does not change it.
import { useCallback, useEffect, useState } from "react";
import type { AgentsView } from "../../server";
import { useMessages } from "@/lib/i18n";
import { messages } from "../messages";
import { createPolicy } from "../shared/policy";
import { Notice, Section, errorText } from "./ui";
import type { Rpc } from "./rpc";

type Rule = { provider: string; model: string };

export function AgentsSection({ rpc, hostId }: { rpc: Rpc; hostId: string }) {
  const t = useMessages(messages);
  const [rules, setRules] = useState<Rule[] | null>(null);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentsView | null>(null);
  const [agentsError, setAgentsError] = useState<string | null>(null);

  useEffect(() => {
    rpc.call("policy").then(
      (policy) => {
        setRules(policy.rules);
        setPolicyError(policy.error);
      },
      (cause) => setPolicyError(errorText(cause)),
    );
  }, [rpc]);

  const loadAgents = useCallback(() => {
    setAgents(null);
    setAgentsError(null);
    rpc.call("agents", { hostId }).then(setAgents, (cause) => setAgentsError(errorText(cause)));
  }, [rpc, hostId]);

  useEffect(loadAgents, [loadAgents]);

  const policy = createPolicy(rules ?? []);

  return (
    <Section step={2} title={t.agentsTitle}>
      <p className="text-sm text-muted-foreground">{t.agentsIntro}</p>

      {policyError ? <Notice tone="error">{t.policyBroken(policyError)}</Notice> : null}
      {rules && rules.length === 0 && !policyError ? <Notice tone="info">{t.noAgentAllowed}</Notice> : null}
      {rules && rules.length > 0 ? (
        <ul className="space-y-1 text-sm">
          {rules.map((rule) => (
            <li key={`${rule.provider} ${rule.model}`} className="font-mono text-xs">
              {rule.provider} {rule.model}
            </li>
          ))}
        </ul>
      ) : null}

      {agentsError ? <Notice tone="error">{agentsError}</Notice> : null}
      {agents === null && !agentsError ? <Notice tone="info">{t.loadingAgents}</Notice> : null}
      {agents?.providers.length ? (
        <div className="space-y-2">
          <p className="text-sm font-medium">{t.onThisMachine}</p>
          {agents.providers.map((provider) => (
            <div key={provider.id} className="space-y-1">
              <p className="text-sm">
                {provider.name} <span className="font-mono text-xs text-muted-foreground">{provider.id}</span>
              </p>
              {provider.error ? <p className="text-xs text-muted-foreground">{t.modelsFailed(provider.error)}</p> : null}
              <ul className="ml-1 space-y-0.5">
                {provider.groups.map((group) => {
                  const allowed = group.models.filter((model) => policy.allows(provider.id, model));
                  return (
                    <li key={group.pattern} className="flex flex-wrap items-baseline gap-x-2 text-sm">
                      <span>{group.label}</span>
                      <span className={allowed.length ? "text-foreground" : "text-muted-foreground"}>
                        {allowed.length === 0 ? t.noMail : allowed.length === group.models.length ? t.mayRead : t.someMayRead(allowed.length, group.models.length)}
                      </span>
                    </li>
                  );
                })}
              </ul>
            </div>
          ))}
        </div>
      ) : null}
    </Section>
  );
}
