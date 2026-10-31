// Fleet Kit panel: build version, the last sync, OpenCode model protection,
// build secrets, and a "Sync now" button. Data comes from the backend over
// RPC; the backend's "status-changed" signal triggers a refetch.
import { useCallback, useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import { definePluginApp, useRealtime, useRpc } from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import type { Status, Step } from "./contract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";

const STATUS_CHANNEL = "status-changed";

function useStatus() {
  const rpc = useRpc<typeof rpcContract>();
  const [status, setStatus] = useState<Status | null>(null);
  const [error, setError] = useState<string | null>(null);
  const report = useCallback((cause: unknown) => setError(cause instanceof Error ? cause.message : String(cause)), []);
  const refetch = useCallback(() => {
    rpc.call("status").then((value) => {
      setStatus(value);
      setError(null);
    }, report);
  }, [rpc, report]);
  useEffect(() => refetch(), [refetch]);
  useRealtime(STATUS_CHANNEL, refetch);
  return { rpc, status, error, report, refetch };
}

function relative(iso: string | null): string {
  if (iso === null) return "never";
  const delta = Date.parse(iso) - Date.now();
  const minutes = Math.round(Math.abs(delta) / 60_000);
  const text = minutes < 1 ? "less than a minute" : minutes < 60 ? `${minutes} min` : `${Math.round(minutes / 60)} h`;
  return delta >= 0 ? `in ${text}` : `${text} ago`;
}

function Section({ title, icon, children, aside }: { title: string; icon: string; children: ReactNode; aside?: ReactNode }) {
  return (
    <section className="rounded-lg border border-border bg-card">
      <header className="flex items-center gap-2 border-b border-border px-4 py-2.5">
        <Icon name={icon} className="size-4 text-muted-foreground" />
        <h2 className="flex-1 text-sm font-medium">{title}</h2>
        {aside}
      </header>
      <div className="px-4 py-3 text-sm">{children}</div>
    </section>
  );
}

const OUTCOME_LABEL: Record<NonNullable<Status["lastSync"]>["outcome"], string> = {
  ok: "Up to date",
  changed: "Changes applied",
  warning: "Applied with warnings",
  error: "Errors",
};

function OutcomeBadge({ outcome }: { outcome: NonNullable<Status["lastSync"]>["outcome"] | "none" }) {
  const tone =
    outcome === "error"
      ? "border-destructive/40 text-destructive"
      : outcome === "warning"
        ? "border-amber-500/40 text-amber-600 dark:text-amber-400"
        : "border-border text-muted-foreground";
  return (
    <span className={cn("rounded-full border px-2 py-0.5 text-xs", tone)}>{outcome === "none" ? "Not synced yet" : OUTCOME_LABEL[outcome]}</span>
  );
}

const STEP_ICON: Record<Step["outcome"], { name: string; className: string }> = {
  ok: { name: "Check", className: "text-muted-foreground" },
  changed: { name: "ArrowUp", className: "text-foreground" },
  skipped: { name: "Minus", className: "text-muted-foreground" },
  warning: { name: "AlertTriangle", className: "text-amber-600 dark:text-amber-400" },
  error: { name: "CircleX", className: "text-destructive" },
};

function StepRow({ step }: { step: Step }) {
  const icon = STEP_ICON[step.outcome];
  return (
    <li className="flex gap-2 py-1.5">
      <Icon name={icon.name} className={cn("mt-0.5 size-4 shrink-0", icon.className)} />
      <div className="min-w-0">
        <span className="font-medium">{step.item}</span>
        <span className="text-muted-foreground"> {step.message}</span>
      </div>
    </li>
  );
}

function SecretRow({ secret, store, onSave, onClear }: {
  secret: Status["secrets"][number];
  store: string;
  onSave: (value: string) => Promise<void>;
  onClear: () => Promise<void>;
}) {
  const [editing, setEditing] = useState(!secret.set);
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  useEffect(() => setEditing(!secret.set), [secret.set]);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (value.trim() === "" || pending) return;
    setPending(true);
    try {
      await onSave(value);
      setValue("");
    } finally {
      setPending(false);
    }
  };
  return (
    <li className="py-2.5">
      <div className="flex items-center gap-2">
        <Icon name={secret.set ? "Lock" : "SquareUnlock02"} className={cn("size-4", secret.set ? "text-muted-foreground" : "text-amber-600 dark:text-amber-400")} />
        <span className="flex-1 font-medium">{secret.title}</span>
        <span className="text-xs text-muted-foreground">{secret.set ? `Saved in ${store}` : "Not set"}</span>
        {secret.set && !editing ? (
          <>
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              Replace
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void onClear()}>
              Remove
            </Button>
          </>
        ) : null}
      </div>
      {secret.hint ? <p className="mt-1 pl-6 text-xs text-muted-foreground">{secret.hint}</p> : null}
      {editing ? (
        <form onSubmit={submit} className="mt-2 flex items-center gap-2 pl-6">
          <Input
            type="password"
            autoComplete="off"
            spellCheck={false}
            value={value}
            onChange={(event) => setValue(event.target.value)}
            placeholder="Paste the value"
            aria-label={secret.title}
          />
          <Button type="submit" size="sm" disabled={pending || value.trim() === ""}>
            Save
          </Button>
          {secret.set ? (
            <Button type="button" variant="ghost" size="sm" onClick={() => setEditing(false)}>
              Cancel
            </Button>
          ) : null}
        </form>
      ) : null}
    </li>
  );
}

function ModelsLine({ opencode }: { opencode: NonNullable<Status["opencode"]> }) {
  const providers = opencode.allowedProviders.join(", ");
  if (!opencode.installed) return <p className="text-amber-600 dark:text-amber-400">OpenCode is not installed.</p>;
  if (opencode.version !== null && !/^v?2\./.test(opencode.version)) {
    return <p className="text-amber-600 dark:text-amber-400">OpenCode {opencode.version} is too old. Update OpenCode to 2.x.</p>;
  }
  if (opencode.models.state === "verified") {
    const level = opencode.protection === "system-policy" ? "system policy" : "user setting";
    return (
      <p className="flex items-center gap-2">
        <Icon name="SecurityCheck" className="size-4 text-muted-foreground" />
        Models: only {providers} ({level})
      </p>
    );
  }
  if (opencode.models.state === "unchecked") return <p className="text-muted-foreground">Models: not checked yet.</p>;
  return (
    <p className="flex items-start gap-2 text-amber-600 dark:text-amber-400">
      <Icon name="AlertTriangle" className="mt-0.5 size-4 shrink-0" />
      <span>Models are not limited to {providers}. {opencode.models.message}</span>
    </p>
  );
}

function FleetKitPage() {
  const { rpc, status, error, report, refetch } = useStatus();
  const [showAll, setShowAll] = useState(false);
  if (status === null) {
    return (
      <Frame>
        {error ? <p role="alert" className="text-sm text-destructive">{error}</p> : <p className="text-sm text-muted-foreground">Loading…</p>}
      </Frame>
    );
  }
  const last = status.lastSync;
  const visible = (last?.steps ?? []).filter((step) => showAll || (step.outcome !== "ok" && step.outcome !== "skipped"));
  const lock = status.opencode?.lock;
  const lockStuck = lock && Date.now() > (lock.resetAfter ? Date.parse(lock.resetAfter) : Date.parse(lock.since) + 120_000);
  return (
    <Frame>
      <div className="flex flex-wrap items-center gap-3">
        <div className="min-w-0 flex-1">
          <h1 className="text-base font-semibold">{last?.build ? `${last.build.name} ${last.build.version}` : "Fleet Kit"}</h1>
          <p className="truncate text-xs text-muted-foreground">
            {status.configured ? `Manifest: ${status.manifestUrl}` : "No manifest address yet"}
          </p>
        </div>
        <OutcomeBadge outcome={last?.outcome ?? "none"} />
        <Button
          size="sm"
          disabled={!status.configured || status.syncing}
          onClick={() => rpc.call("sync_now").then(refetch, report)}
        >
          <Icon name={status.syncing ? "Loading" : "ArrowReloadHorizontal"} className={cn("size-4", status.syncing && "animate-spin")} />
          {status.syncing ? "Syncing…" : "Sync now"}
        </Button>
      </div>
      <p className="mt-1 text-xs text-muted-foreground">
        Last sync {relative(last?.finishedAt ?? null)}
        {status.paused ? "; syncing is paused" : status.nextSyncAt ? `; next ${relative(status.nextSyncAt)}` : ""}
      </p>
      {error ? <p role="alert" className="mt-3 text-sm text-destructive">{error}</p> : null}

      {!status.configured ? (
        <div className="mt-4 rounded-lg border border-dashed border-border px-4 py-5 text-sm text-muted-foreground">
          Set the build manifest address: <code>bb plugin config fleet-kit set manifestUrl &lt;https:// URL or file path&gt;</code>
        </div>
      ) : null}

      <div className="mt-4 flex flex-col gap-4">
        {last?.fleetKitOutdated ? (
          <div role="alert" className="flex items-center gap-2 rounded-lg border border-amber-500/40 px-4 py-2.5 text-sm">
            <Icon name="AlertTriangle" className="size-4 text-amber-600 dark:text-amber-400" />
            <span className="flex-1">This build needs a newer Fleet Kit. Until it installs, nothing else from the build is applied.</span>
          </div>
        ) : null}
        {status.notices.map((notice) => (
          <div key={notice.id} className="flex items-center gap-2 rounded-lg border border-amber-500/40 px-4 py-2.5 text-sm">
            <Icon name="Info" className="size-4 text-amber-600 dark:text-amber-400" />
            <span className="flex-1">{notice.message}</span>
            <Button variant="ghost" size="sm" onClick={() => rpc.call("notice_dismiss", { id: notice.id }).then(refetch, report)}>
              Dismiss
            </Button>
          </div>
        ))}

        {status.secrets.length > 0 ? (
          <Section title="Secrets" icon="Lock">
            <ul className="divide-y divide-border">
              {status.secrets.map((secret) => (
                <SecretRow
                  key={secret.name}
                  secret={secret}
                  store={status.secretStore}
                  onSave={(value) => rpc.call("secret_set", { name: secret.name, value }).then(refetch, report)}
                  onClear={() => rpc.call("secret_clear", { name: secret.name }).then(refetch, report)}
                />
              ))}
            </ul>
          </Section>
        ) : null}

        {status.opencode ? (
          <Section title="OpenCode" icon="Bot">
            <div className="flex flex-col gap-1.5">
              <ModelsLine opencode={status.opencode} />
              {status.opencode.defaultModel ? <p className="text-muted-foreground">Default model: {status.opencode.defaultModel}</p> : null}
              {status.opencode.version ? <p className="text-muted-foreground">Version {status.opencode.version}</p> : null}
              {status.opencode.configFile ? <p className="truncate text-xs text-muted-foreground">{status.opencode.configFile}</p> : null}
              {status.opencode.lock ? (
                <div className="mt-1 flex items-center gap-2 text-amber-600 dark:text-amber-400">
                  <Icon name="Lock" className="size-4" />
                  <span className="flex-1">
                    OpenCode configuration is locked by {status.opencode.lock.owner} since {new Date(status.opencode.lock.since).toLocaleTimeString()}.
                  </span>
                  {lockStuck ? (
                    <Button variant="outline" size="sm" onClick={() => rpc.call("lock_reset").then(refetch, report)}>
                      Reset lock
                    </Button>
                  ) : null}
                </div>
              ) : null}
            </div>
          </Section>
        ) : null}

        {last ? (
          <Section
            title="Last sync"
            icon="ListTodo"
            aside={
              <Button variant="ghost" size="sm" onClick={() => setShowAll((value) => !value)}>
                {showAll ? "Only changes" : "Show all"}
              </Button>
            }
          >
            {visible.length === 0 ? (
              <p className="text-muted-foreground">Everything matches the manifest.</p>
            ) : (
              <ul className="divide-y divide-border">
                {visible.map((step, index) => (
                  <StepRow key={`${step.area}:${step.item}:${index}`} step={step} />
                ))}
              </ul>
            )}
          </Section>
        ) : null}
      </div>
    </Frame>
  );
}

function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl px-4 pb-6 pt-3 md:px-5 md:pt-4">{children}</div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.navPanel({
    id: "fleet-kit",
    title: "Fleet Kit",
    icon: "PackageReceive",
    path: "status",
    component: FleetKitPage,
  });
});
