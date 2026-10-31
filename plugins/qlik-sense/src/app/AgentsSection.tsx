// Step 3: which agents (provider + model) may receive Qlik data. Starts empty.
import { useCallback, useEffect, useState } from "react";
import type { AgentsView } from "../../server";
import { Button } from "@/components/ui/button";
import { Checkbox } from "@/components/ui/checkbox";
import { Notice, Section, errorText } from "./ui";
import type { Rpc } from "./rpc";

type Rule = { provider: string; model: string };

const sameRule = (a: Rule, b: Rule) => a.provider === b.provider && a.model === b.model;

export function AgentsSection({ rpc, hostId }: { rpc: Rpc; hostId: string }) {
  const [saved, setSaved] = useState<Rule[] | null>(null);
  const [draft, setDraft] = useState<Rule[]>([]);
  const [policyError, setPolicyError] = useState<string | null>(null);
  const [agents, setAgents] = useState<AgentsView | null>(null);
  const [agentsError, setAgentsError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);

  useEffect(() => {
    rpc.call("policy").then(
      (policy) => {
        setSaved(policy.rules);
        setDraft(policy.rules);
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

  const toggle = (rule: Rule, on: boolean) =>
    setDraft((current) => (on ? [...current.filter((r) => !sameRule(r, rule)), rule] : current.filter((r) => !sameRule(r, rule))));

  const save = async () => {
    setSaving(true);
    try {
      const policy = await rpc.call("savePolicy", { rules: draft });
      setSaved(policy.rules);
      setDraft(policy.rules);
      setPolicyError(policy.error);
    } catch (cause) {
      setPolicyError(errorText(cause));
    } finally {
      setSaving(false);
    }
  };

  const offered = (agents?.providers ?? []).flatMap((provider) => provider.groups.map((group) => ({ provider: provider.id, model: group.pattern })));
  const other = draft.filter((rule) => !offered.some((candidate) => sameRule(candidate, rule)));
  const dirty = saved !== null && JSON.stringify(saved) !== JSON.stringify(draft);

  return (
    <Section step={3} title="Agents that may read Qlik data">
      <p className="text-sm text-muted-foreground">
        Qlik data goes only to the models ticked here — tick the ones your company approved for its data. Other agents do not see the Qlik tools,
        and a thread that already holds Qlik data cannot be continued with a model outside this list. Changes apply to new agent sessions.
      </p>

      {policyError ? <Notice tone="error">{policyError}</Notice> : null}
      {agentsError ? <Notice tone="error">{agentsError}</Notice> : null}
      {agents === null && !agentsError ? <Notice tone="info">Loading agents on this machine…</Notice> : null}

      {agents?.providers.map((provider) => (
        <div key={provider.id} className="space-y-1.5">
          <p className="text-sm font-medium">
            {provider.name} <span className="font-mono text-xs text-muted-foreground">{provider.id}</span>
          </p>
          {provider.error ? <p className="text-xs text-muted-foreground">Models did not load: {provider.error}</p> : null}
          <ul className="ml-1 space-y-1">
            {provider.groups.map((group) => {
              const rule = { provider: provider.id, model: group.pattern };
              const checked = draft.some((candidate) => sameRule(candidate, rule));
              return (
                <li key={group.pattern}>
                  <label className="flex items-center gap-3 text-sm">
                    <Checkbox checked={checked} onCheckedChange={(value) => toggle(rule, value === true)} />
                    <span>
                      {group.label}
                      {group.models.length > 1 ? <span className="text-muted-foreground"> — {group.models.length} models</span> : null}
                    </span>
                    <span className="font-mono text-xs text-muted-foreground">{group.pattern}</span>
                  </label>
                </li>
              );
            })}
          </ul>
        </div>
      ))}

      {other.length ? (
        <div className="space-y-1">
          <p className="text-sm font-medium">Other rules</p>
          {other.map((rule) => (
            <label key={`${rule.provider} ${rule.model}`} className="flex items-center gap-3 text-sm">
              <Checkbox checked onCheckedChange={(value) => toggle(rule, value === true)} />
              <span className="font-mono text-xs">
                {rule.provider} {rule.model}
              </span>
            </label>
          ))}
        </div>
      ) : null}

      <div className="flex items-center gap-3">
        <Button onClick={() => void save()} disabled={!dirty || saving}>
          {saving ? "Saving…" : "Save agents"}
        </Button>
        <span className="text-xs text-muted-foreground">{draft.length === 0 ? "No agent gets Qlik data." : `${draft.length} rule${draft.length === 1 ? "" : "s"}`}</span>
      </div>
    </Section>
  );
}
