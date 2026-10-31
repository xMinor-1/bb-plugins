// Step 1: the Qlik address, the login, and the password kept on the agent's machine.
import { useEffect, useState, type FormEvent } from "react";
import type { ConnectionStatus } from "../../contract";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useMessages } from "@/lib/i18n";
import { messages } from "./messages";
import { Field, Notice, Section, errorText } from "./ui";
import type { Rpc } from "./rpc";

/** A check result: from Qlik (`apps` set when signed in), or a local problem shown as is. */
type CheckResult = { ok: boolean; message: string; apps: number | null; local?: boolean };

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
  const [result, setResult] = useState<CheckResult | null>(null);
  const t = useMessages(messages);

  useEffect(() => {
    setUrl(status.url ?? suggestedUrl);
    setUser(status.user ?? "");
  }, [status.url, status.user, suggestedUrl]);

  const refresh = async () => onStatus(await rpc.call("status", { hostId }));

  const check = async (retry: boolean) => {
    const outcome = await rpc.call("checkSignIn", { hostId, retry });
    setResult(outcome);
    await refresh();
  };

  const save = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    if (!user.includes("\\")) {
      setResult({ ok: false, message: t.loginNoDomain, apps: null, local: true });
      return;
    }
    setBusy("save");
    setResult(null);
    try {
      onStatus(await rpc.call("saveConnection", { hostId, url, user, ...(password ? { password } : {}) }));
      setPassword("");
      await check(false);
    } catch (cause) {
      setResult({ ok: false, message: errorText(cause), apps: null });
    } finally {
      setBusy(null);
    }
  };

  const retry = async () => {
    setBusy("retry");
    try {
      await check(true);
    } catch (cause) {
      setResult({ ok: false, message: errorText(cause), apps: null });
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
      setResult({ ok: false, message: errorText(cause), apps: null });
    } finally {
      setBusy(null);
    }
  };

  const storeLabel = { keychain: t.storeKeychain, dpapi: t.storeDpapi, file: t.storeFile };
  const savedIn = status.hasPassword && status.passwordStore ? storeLabel[status.passwordStore] : null;
  const fileFallback = status.passwordStore === "file" && (status.platform === "darwin" || status.platform === "win32");
  const last = result ?? status.lastCheck;

  return (
    <Section step={1} title={t.signInTitle}>
      <form onSubmit={save} className="space-y-3">
        <Field label={t.address} hint={t.addressHint}>
          <Input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://qlik.example.com" autoComplete="url" required />
        </Field>
        <Field label={t.login} hint={t.loginHint}>
          <Input value={user} onChange={(event) => setUser(event.target.value)} placeholder="DOMAIN\user" autoComplete="username" required />
        </Field>
        <Field label={t.password} hint={savedIn ? t.passwordSaved(savedIn) : t.passwordNew}>
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
            {busy === "save" ? t.checking : t.saveAndCheck}
          </Button>
          {status.url ? (
            <Button type="button" variant="ghost" onClick={() => void forget()} disabled={busy !== null}>
              {t.forget}
            </Button>
          ) : null}
        </div>
      </form>

      {status.blocked ? (
        <Notice tone="error">
          <p>{t.rejected}</p>
          <p className="mt-1 text-xs opacity-80">{status.blocked}</p>
          <p className="mt-1">{t.blockedExplain}</p>
          <Button className="mt-2" size="sm" variant="outline" onClick={() => void retry()} disabled={busy !== null}>
            {busy === "retry" ? t.signingIn : t.tryOnceMore}
          </Button>
        </Notice>
      ) : last ? (
        <Notice tone={last.ok ? "ok" : "error"}>
          {last.ok && last.apps !== null ? (
            t.signedIn(last.apps)
          ) : last.ok || ("local" in last && last.local) ? (
            last.message
          ) : (
            <>
              <p>{t.signInFailed}</p>
              <p className="mt-1 text-xs opacity-80">{last.message}</p>
            </>
          )}
        </Notice>
      ) : null}

      {fileFallback ? (
        <Notice tone="warn">{t.fileFallback}</Notice>
      ) : null}
    </Section>
  );
}
