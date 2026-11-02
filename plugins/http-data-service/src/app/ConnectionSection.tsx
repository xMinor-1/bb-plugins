// The login and password, kept on the agent's machine. The address comes from the build.
import { useEffect, useState, type FormEvent } from "react";
import type { ConnectionStatus } from "../../contract";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { useMessages } from "@/lib/i18n";
import { messages } from "./messages";
import { Field, Notice, Section, errorText } from "./ui";
import type { Rpc } from "./rpc";

type Result = { ok: true } | { ok: false; code: string } | { ok: false; text: string };

export function ConnectionSection({
  rpc,
  hostId,
  status,
  address,
  onStatus,
}: {
  rpc: Rpc;
  hostId: string;
  status: ConnectionStatus;
  address: string | null;
  onStatus: (status: ConnectionStatus) => void;
}) {
  const [user, setUser] = useState(status.user ?? "");
  const [password, setPassword] = useState("");
  const [busy, setBusy] = useState<null | "save" | "check" | "forget">(null);
  const [result, setResult] = useState<Result | null>(null);
  const t = useMessages(messages);

  useEffect(() => setUser(status.user ?? ""), [status.user]);

  const check = async (retry: boolean) => {
    const outcome = await rpc.call("checkSignIn", { hostId, retry });
    setResult(outcome.ok ? { ok: true } : { ok: false, code: outcome.code ?? "unreachable" });
    onStatus(await rpc.call("status", { hostId }));
  };

  const run = async (kind: "save" | "check" | "forget", action: () => Promise<void>) => {
    setBusy(kind);
    try {
      await action();
    } catch (cause) {
      setResult({ ok: false, text: `${t.saveFailed} ${t.technical(errorText(cause))}` });
    } finally {
      setBusy(null);
    }
  };

  const save = (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (busy) return;
    if (user.includes(":")) {
      setResult({ ok: false, text: t.loginColon });
      return;
    }
    setResult(null);
    void run("save", async () => {
      onStatus(await rpc.call("saveConnection", { hostId, user, ...(password ? { password } : {}) }));
      setPassword("");
      await check(false);
    });
  };

  const forget = () =>
    void run("forget", async () => {
      onStatus(await rpc.call("forget", { hostId }));
      setResult(null);
      setPassword("");
    });

  const storeLabel = { keychain: t.storeKeychain, "credential-manager": t.storeCredentialManager, file: t.storeFile };
  const savedIn = status.hasPassword && status.passwordStore ? storeLabel[status.passwordStore] : null;
  // The saved check speaks after a restart; this session's result speaks over it.
  const last: Result | null =
    result ?? (status.lastCheck ? (status.lastCheck.ok ? { ok: true } : { ok: false, code: status.lastCheck.code ?? "unreachable" }) : null);

  return (
    <Section step={1} title={t.signInTitle}>
      <form onSubmit={save} className="space-y-3">
        {address ? (
          <Field label={t.address} hint={t.addressHint}>
            <Input value={address} readOnly disabled />
          </Field>
        ) : null}
        <Field label={t.login} hint={t.loginHint}>
          <Input value={user} onChange={(event) => setUser(event.target.value)} autoComplete="username" required />
        </Field>
        <Field label={t.password} hint={savedIn ? t.passwordSaved(savedIn) : t.passwordNew}>
          <Input
            type="password"
            value={password}
            onChange={(event) => setPassword(event.target.value)}
            placeholder={savedIn ? "••••••••" : ""}
            autoComplete="current-password"
            required={!status.hasPassword || status.addressChanged}
          />
        </Field>
        <div className="flex flex-wrap items-center gap-2">
          <Button type="submit" disabled={busy !== null}>
            {busy === "save" ? t.checking : t.saveAndCheck}
          </Button>
          {status.hasPassword && !status.blocked && !status.addressChanged ? (
            <Button type="button" variant="outline" disabled={busy !== null} onClick={() => void run("check", () => check(false))}>
              {busy === "check" ? t.checking : t.check}
            </Button>
          ) : null}
          {status.user ? (
            <Button type="button" variant="ghost" onClick={forget} disabled={busy !== null}>
              {t.forget}
            </Button>
          ) : null}
        </div>
      </form>

      {status.addressChanged ? (
        <Notice tone="warn">{t.failure("addressChanged")}</Notice>
      ) : status.blocked ? (
        <Notice tone="error">
          <p>{t.failure(last && !last.ok && "code" in last ? last.code : "paused")}</p>
          <Button className="mt-2" size="sm" variant="outline" onClick={() => void run("check", () => check(true))} disabled={busy !== null}>
            {busy === "check" ? t.checking : t.tryOnceMore}
          </Button>
        </Notice>
      ) : last ? (
        <Notice tone={last.ok ? "ok" : "error"}>{last.ok ? t.signedIn : "text" in last ? last.text : t.failure(last.code)}</Notice>
      ) : null}

      {status.passwordStore === "file" ? <Notice tone="warn">{t.fileStoreNote}</Notice> : null}
    </Section>
  );
}
