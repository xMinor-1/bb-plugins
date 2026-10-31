// Step 1: connect this machine to Exchange. Windows laptops in a domain sign in
// as the Windows user with no password; elsewhere a login and password, kept in
// the OS credential store.
import { useState } from "react";
import type { AuthMode, ConnectionStatus } from "../../contract";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Field, Notice, Section, errorText } from "./ui";
import type { Rpc } from "./rpc";

const automaticLabel = (platform: string) =>
  platform === "win32" ? "Windows sign-in — no password, as the user signed in to Windows" : "Kerberos ticket — no password, needs a valid ticket on this machine";

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
  const [auth, setAuth] = useState<AuthMode>(status.auth ?? (status.platform === "win32" ? "negotiate" : "password"));
  const [user, setUser] = useState(status.user ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<null | "connect" | "check" | "forget">(null);
  const [error, setError] = useState<string | null>(null);

  const refresh = async () => onStatus(await rpc.call("status", { hostId }));

  const connect = async () => {
    setBusy("connect");
    setError(null);
    try {
      await rpc.call("saveConnection", { hostId, url, auth, ...(auth === "password" ? { user, ...(password ? { password } : {}) } : {}) });
      setPassword("");
      await rpc.call("check", { hostId });
      await refresh();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const check = async (retry = false) => {
    setBusy("check");
    setError(null);
    try {
      await rpc.call("check", { hostId, retry });
      await refresh();
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const forget = async () => {
    if (!window.confirm("Disconnect mail on this machine? The saved password and the list of waiting drafts are removed; the drafts stay in Outlook.")) return;
    setBusy("forget");
    setError(null);
    try {
      onStatus(await rpc.call("forget", { hostId }));
      setPassword("");
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const saved = status.url !== null;
  const changed = url !== (status.url ?? "") || auth !== status.auth || (auth === "password" && (user !== (status.user ?? "") || password !== ""));
  const needsPassword = auth === "password" && !password && !(status.hasPassword && status.auth === "password");
  const curlMissing = status.curlError !== null;

  return (
    <Section step={1} title="Connect your mailbox">
      <p className="text-sm text-muted-foreground">
        bb reads mail straight from Exchange on this machine. Mail stays in your mailbox; nothing is copied to bb.
      </p>

      {curlMissing ? <Notice tone="error">{status.curlError}</Notice> : null}
      {auth === "negotiate" && status.curl && !status.curl.negotiate ? (
        <Notice tone="warn">The curl on this machine cannot do automatic sign-in. Use a login and password.</Notice>
      ) : null}

      <Field label="Exchange address" hint="Exchange Web Services, for example https://mail.example.com/EWS/Exchange.asmx">
        <Input value={url} onChange={(event) => setUrl(event.target.value)} placeholder="https://mail.example.com/EWS/Exchange.asmx" spellCheck={false} />
      </Field>

      <fieldset className="space-y-1.5 text-sm">
        <legend className="mb-1 text-muted-foreground">Sign-in</legend>
        <label className="flex items-start gap-2">
          <input type="radio" name="auth" className="mt-1" checked={auth === "negotiate"} onChange={() => setAuth("negotiate")} />
          <span>{automaticLabel(status.platform)}</span>
        </label>
        <label className="flex items-start gap-2">
          <input type="radio" name="auth" className="mt-1" checked={auth === "password"} onChange={() => setAuth("password")} />
          <span>Login and password — the password is kept in {status.passwordStore ?? "the system credential store"}</span>
        </label>
      </fieldset>

      {auth === "password" ? (
        <div className="grid gap-3 sm:grid-cols-2">
          <Field label="Login" hint="DOMAIN\name or name@company.com">
            <Input value={user} onChange={(event) => setUser(event.target.value)} autoComplete="username" spellCheck={false} />
          </Field>
          <Field label="Password" hint={status.hasPassword && status.auth === "password" ? "Saved. Type a new one to replace it." : undefined}>
            <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" />
          </Field>
        </div>
      ) : null}

      {error ? <Notice tone="error">{error}</Notice> : null}
      {status.blocked && !changed ? (
        <Notice tone="error">
          Sign-in is paused: {status.blocked} Agents and this panel stop trying, so the domain does not lock your account. Enter the password again, or
          try once more if you are sure it is right.
        </Notice>
      ) : status.lastCheck && !changed ? (
        <Notice tone={status.lastCheck.ok ? "ok" : "error"}>{status.lastCheck.message}</Notice>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => void connect()} disabled={busy !== null || curlMissing || url.trim() === "" || (auth === "password" && user.trim() === "") || needsPassword || (saved && !changed && status.lastCheck?.ok === true)}>
          {busy === "connect" ? "Connecting…" : saved ? "Save and check" : "Connect"}
        </Button>
        {saved ? (
          <Button variant="outline" onClick={() => void check(Boolean(status.blocked))} disabled={busy !== null}>
            {busy === "check" ? "Checking…" : status.blocked ? "Try once more" : "Check again"}
          </Button>
        ) : null}
        {saved ? (
          <Button variant="ghost" onClick={() => void forget()} disabled={busy !== null}>
            Disconnect
          </Button>
        ) : null}
      </div>
    </Section>
  );
}
