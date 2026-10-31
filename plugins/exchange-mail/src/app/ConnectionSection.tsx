// Step 1: connect this machine to Exchange. Windows laptops in a domain sign in
// as the Windows user with no password; elsewhere a login and password, kept in
// the OS credential store.
import { useEffect, useState } from "react";
import type { AuthMode, ConnectionStatus } from "../../contract";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { ConfirmDialog } from "./ConfirmDialog";
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

  const [askForget, setAskForget] = useState(false);

  const forget = async () => {
    setBusy("forget");
    setError(null);
    try {
      onStatus(await rpc.call("forget", { hostId }));
      setPassword("");
      setAskForget(false);
    } catch (cause) {
      setError(errorText(cause));
    } finally {
      setBusy(null);
    }
  };

  const saved = status.url !== null;
  const changed = url !== (status.url ?? "") || auth !== status.auth || (auth === "password" && (user !== (status.user ?? "") || password !== ""));
  // The saved password belongs to the saved address and login: changing either needs it typed again.
  const sameAccount = status.auth === "password" && url.trim() === (status.url ?? "") && user.trim() === (status.user ?? "");
  const needsPassword = auth === "password" && !password && !(status.hasPassword && sameAccount);
  const now = useNow(status.retryAt);
  const waiting = status.blocked !== null && status.retryAt !== null && now < status.retryAt;
  const retryClock = status.retryAt ? new Date(status.retryAt).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "";
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
          <Field
            label="Password"
            hint={
              status.hasPassword && sameAccount
                ? "Saved. Type a new one to replace it."
                : status.hasPassword && status.auth === "password"
                  ? "The saved password is only for the saved address and login. Type it for this one."
                  : undefined
            }
          >
            <Input type="password" value={password} onChange={(event) => setPassword(event.target.value)} autoComplete="current-password" />
          </Field>
        </div>
      ) : null}

      {error ? <Notice tone="error">{error}</Notice> : null}
      {status.blocked && !changed ? (
        <Notice tone="error">
          Sign-in is paused: {status.blocked} So that the domain does not lock your account, nothing — agents, this panel, a new password — tries
          again before {retryClock}.{" "}
          {waiting ? "Check the password meanwhile." : "Enter the password again, or try once more if you are sure it is right."}
        </Notice>
      ) : status.lastCheck && !changed ? (
        <Notice tone={status.lastCheck.ok ? "ok" : "error"}>{status.lastCheck.message}</Notice>
      ) : null}

      <div className="flex flex-wrap items-center gap-2">
        <Button onClick={() => void connect()} disabled={busy !== null || curlMissing || url.trim() === "" || (auth === "password" && user.trim() === "") || needsPassword || (saved && !changed && status.lastCheck?.ok === true)}>
          {busy === "connect" ? "Connecting…" : saved ? "Save and check" : "Connect"}
        </Button>
        {saved ? (
          <Button variant="outline" onClick={() => void check(Boolean(status.blocked))} disabled={busy !== null || waiting}>
            {busy === "check" ? "Checking…" : waiting ? `Try again at ${retryClock}` : status.blocked ? "Try once more" : "Check again"}
          </Button>
        ) : null}
        {saved ? (
          <Button variant="ghost" onClick={() => setAskForget(true)} disabled={busy !== null}>
            Disconnect
          </Button>
        ) : null}
      </div>
      <ConfirmDialog
        open={askForget}
        title="Disconnect mail on this machine?"
        description="The saved password and the list of drafts waiting in bb are removed. The drafts themselves stay in your Drafts folder."
        confirmLabel="Disconnect"
        busyLabel="Disconnecting…"
        busy={busy === "forget"}
        destructive
        onConfirm={() => void forget()}
        onCancel={() => setAskForget(false)}
      />
    </Section>
  );
}

/** The current time, ticking each 15 s while a pause is running, so the retry button wakes up by itself. */
function useNow(until: number | null): number {
  const [now, setNow] = useState(() => Date.now());
  useEffect(() => {
    if (until === null || Date.now() >= until) return;
    const timer = setInterval(() => {
      setNow(Date.now());
      if (Date.now() >= until) clearInterval(timer);
    }, 15_000);
    return () => clearInterval(timer);
  }, [until]);
  return now;
}
