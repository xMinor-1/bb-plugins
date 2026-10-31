// Step 1: the Qlik address, the login, and the password kept on the agent's machine.
import { useEffect, useState, type FormEvent } from "react";
import type { ConnectionStatus } from "../../contract";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, Notice, Section, errorText } from "./ui";
import type { Rpc } from "./rpc";

const STORE_LABEL: Record<string, string> = {
  keychain: "macOS Keychain",
  dpapi: "Windows, encrypted with your Windows account",
  file: "a file only your user can read",
};

export function ConnectionSection({
  rpc,
  hostId,
  status,
  suggestedUrl,
  onStatus,
}: {
  rpc: Rpc;
  hostId: string;
  status: ConnectionStatus;
  suggestedUrl: string;
  onStatus: (status: ConnectionStatus) => void;
}) {
  const [url, setUrl] = useState(status.url ?? suggestedUrl);
  const [user, setUser] = useState(status.user ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<null | "save" | "retry" | "forget">(null);
  const [result, setResult] = useState<{ ok: boolean; message: string } | null>(null);

  useEffect(() => {
    setUrl(status.url ?? suggestedUrl);
    setUser(status.user ?? "");
  }, [status.url, status.user, suggestedUrl]);

  const refresh = async () => onStatus(await rpc.call("status", { hostId }));

  const check = async (retry: boolean) => {
    const outcome = await rpc.call("checkSignIn", { hostId, retry });
    setResult({ ok: outcome.ok, message: outcome.message });
    await refresh();
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    setBusy("save");
    setResult(null);
    try {
      onStatus(await rpc.call("saveConnection", { hostId, url, user, ...(password ? { password } : {}) }));
      setPassword("");
      await check(false);
    } catch (cause) {
      setResult({ ok: false, message: errorText(cause) });
    } finally {
      setBusy(null);
    }
  };

  const retry = async () => {
    setBusy("retry");
    try {
      await check(true);
    } catch (cause) {
      setResult({ ok: false, message: errorText(cause) });
    } finally {
      setBusy(null);
    }
  };

  const forget = async () => {
    setBusy("forget");
    try {
      onStatus(await rpc.call("forget", { hostId }));
      setResult(null);
      setPassword("");
    } catch (cause) {
      setResult({ ok: false, message: errorText(cause) });
    } finally {
      setBusy(null);
    }
  };

  const savedIn = status.hasPassword && status.passwordStore ? STORE_LABEL[status.passwordStore] : null;
  const fileFallback = status.passwordStore === "file" && (status.platform === "darwin" || status.platform === "win32");
  const last = result ?? status.lastCheck;

  return (
    <Section step={1} title="Sign in to Qlik Sense">
      <form onSubmit={save} className="space-y-3">
        <Field label="Qlik Sense address" hint="The address you open in the browser, with the virtual proxy prefix if there is one.">
          <Input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://qlik.example.com" autoComplete="url" required />
        </Field>
        <Field label="Login" hint="As in the Qlik sign-in form: DOMAIN\user.">
          <Input value={user} onChange={(event) => setUser(event.target.value)} placeholder="DOMAIN\user" autoComplete="username" required />
        </Field>
        <Field
          label="Password"
          hint={savedIn ? `Saved in ${savedIn}. Leave empty to keep it.` : "Stays on this machine. bb's server never stores it."}
        >
          <Input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={savedIn ? "••••••••" : ""}
            autoComplete="current-password"
            required={!status.hasPassword}
          />
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={busy !== null}>
            {busy === "save" ? "Checking…" : "Save and check sign-in"}
          </Button>
          {status.url ? (
            <Button type="button" variant="ghost" onClick={() => void forget()} disabled={busy !== null}>
              Forget this connection
            </Button>
          ) : null}
        </div>
      </form>

      {status.blocked ? (
        <Notice tone="error">
          <p>{status.blocked}</p>
          <p className="mt-1">
            Nothing signs in again until you enter the password again, so the domain does not lock your account. If the password is right,
            try once more.
          </p>
          <Button className="mt-2" size="sm" variant="outline" onClick={() => void retry()} disabled={busy !== null}>
            {busy === "retry" ? "Signing in…" : "Try once more"}
          </Button>
        </Notice>
      ) : last ? (
        <Notice tone={last.ok ? "ok" : "error"}>{last.message}</Notice>
      ) : null}

      {fileFallback ? (
        <Notice tone="warn">The system password store refused the password, so it is kept in a file only your user can read.</Notice>
      ) : null}
    </Section>
  );
}
