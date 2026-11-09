// The body of a shared sign-in step: the login and password form (typed once,
// kept in the credential store), what each plugin made of them, and a button
// for each plugin that signs in in its own window.
import { useEffect, useMemo, useRef, useState } from "react";
import type { FormEvent } from "react";
import { experimental_useRpcMutation } from "@get-bb/plugin-sdk/app";
import { z } from "zod";
import type { AccountStep } from "../../contract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { defineMessages, useMessages } from "@/lib/i18n";
import { useSavedIn } from "./parts";

const messages = defineMessages(
  {
    login: "Login",
    password: "Password",
    save: "Save and sign in",
    saving: "Saving…",
    replace: "Change",
    forget: "Forget",
    cancel: "Cancel",
    once: "Type them once: Fleet Kit keeps them in the credential store and signs these plugins in.",
    line: (state: AccountStep["plugins"][number]["state"] | AccountStep["windows"][number]["state"]) =>
      ({ done: "Signed in", todo: "Not signed in yet", problem: "Didn't work", waiting: "Installing the plugin", checking: "Checking…" })[state],
    reason: (reason: NonNullable<AccountStep["plugins"][number]["reason"]>) =>
      ({
        rejected: "The service did not accept this login or password. Fleet Kit will not send them again: check them and type them anew.",
        "old-version": "This plugin's version cannot take the shared sign-in yet; sign in on its page.",
        "not-allowed": "This plugin does not take the sign-in from Fleet Kit; sign in on its page.",
        "no-answer": "The plugin did not answer; Fleet Kit tries again with the next sync.",
      })[reason],
    waitingNote: "It gets the sign-in as soon as it is installed.",
    open: "Open",
    signIn: "Sign in",
    windowOpened: "A sign-in window opened. Sign in there; this step updates by itself.",
    windowSeparate: "Signs in in its own window",
  },
  {
    login: "Логин",
    password: "Пароль",
    save: "Сохранить и войти",
    saving: "Сохраняю…",
    replace: "Изменить",
    forget: "Забыть",
    cancel: "Отмена",
    once: "Введите один раз: пульт сохранит их в хранилище паролей системы и сам выполнит вход в эти плагины.",
    line: (state) => ({ done: "Вход выполнен", todo: "Вход ещё не выполнен", problem: "Не получилось", waiting: "Плагин ещё ставится", checking: "Проверяю…" })[state],
    reason: (reason) =>
      ({
        rejected: "Сервис не принял логин или пароль. Пульт больше не будет их отправлять: проверьте и введите заново.",
        "old-version": "Эта версия плагина пока не принимает общий вход, войдите на его странице.",
        "not-allowed": "Плагин не принимает вход от пульта, войдите на его странице.",
        "no-answer": "Плагин не ответил, пульт повторит при следующей сверке.",
      })[reason],
    waitingNote: "Вход выполнится сам, как только плагин встанет.",
    open: "Открыть",
    signIn: "Войти",
    windowOpened: "Открылось окно входа. Войдите в нём, шаг обновится сам.",
    windowSeparate: "Вход в отдельном окне",
  },
);

const ICON: Record<string, { name: string; className: string }> = {
  done: { name: "CircleCheck", className: "text-emerald-600 dark:text-emerald-400" },
  todo: { name: "Circle", className: "text-muted-foreground" },
  problem: { name: "AlertTriangle", className: "text-amber-600 dark:text-amber-400" },
  waiting: { name: "Clock", className: "text-muted-foreground" },
  checking: { name: "Loading", className: "animate-spin text-muted-foreground" },
};

/** Why a step's last action failed, in the person's words, inside the step's card. */
export function StepError({ error, className }: { error: string | null; className?: string }) {
  const ref = useRef<HTMLParagraphElement>(null);
  // It appears after the click and makes the card longer: keep it in view.
  useEffect(() => {
    if (error) ref.current?.scrollIntoView?.({ block: "nearest" });
  }, [error]);
  if (!error) return null;
  return (
    <p ref={ref} role="alert" data-step-error className={cn("mt-2 flex items-start gap-1.5 pl-6 text-xs text-destructive", className)}>
      <Icon name="AlertTriangle" className="mt-px size-3.5 shrink-0" />
      <span className="min-w-0 break-words">{error}</span>
    </p>
  );
}

function AccountForm({ account, label, error, onSave, onCancel }: {
  account: AccountStep;
  label: string;
  error: string | null;
  onSave: (login: string, password: string) => Promise<void>;
  onCancel?: () => void;
}) {
  const t = useMessages(messages);
  const [login, setLogin] = useState("");
  const [password, setPassword] = useState("");
  const [pending, setPending] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (login.trim() === "" || password === "" || pending) return;
    setPending(true);
    try {
      await onSave(login, password);
      setPassword("");
    } catch {
      // The step shows why; what was typed stays to try again.
    } finally {
      setPending(false);
    }
  };
  return (
    <form onSubmit={submit} className="mt-2 flex flex-col gap-2 pl-6" aria-label={label} data-account-form>
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">{t.login}</span>
        <Input autoComplete="username" spellCheck={false} value={login} onChange={(event) => setLogin(event.target.value)} name="login" />
        {account.loginHint ? <span className="text-muted-foreground">{account.loginHint}</span> : null}
      </label>
      <label className="flex flex-col gap-1 text-xs">
        <span className="text-muted-foreground">{t.password}</span>
        <Input type="password" autoComplete="current-password" spellCheck={false} value={password} onChange={(event) => setPassword(event.target.value)} name="password" />
        {account.passwordHint ? <span className="text-muted-foreground">{account.passwordHint}</span> : null}
      </label>
      <div className="flex flex-wrap items-center gap-2">
        <Button type="submit" size="sm" disabled={pending || login.trim() === "" || password === ""}>
          {pending ? t.saving : t.save}
        </Button>
        {onCancel ? (
          <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
            {t.cancel}
          </Button>
        ) : null}
      </div>
      <StepError error={error} className="mt-0 pl-0" />
      <p className="text-xs text-muted-foreground">{t.once}</p>
    </form>
  );
}

/** A plugin that signs in in its own window: its RPC takes `{ hostId }` and returns once the window closes. */
function WindowLine({ line, hostId, onOpen }: { line: AccountStep["windows"][number]; hostId: string | null; onOpen: (path: string) => void }) {
  const t = useMessages(messages);
  // A contract of the other plugin's one method; the panel bundle has no defineRpcContract, which only returns its argument.
  const contract = useMemo(() => ({ [line.method]: { input: z.object({ hostId: z.string() }), output: z.unknown() } }), [line.method]);
  const mutation = experimental_useRpcMutation({ contract, pluginId: line.id, method: line.method });
  const [opened, setOpened] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const icon = ICON[line.state]!;
  const canSignIn = (line.state === "todo" || line.state === "problem") && hostId !== null;
  return (
    <li className="flex flex-col gap-1 py-1" data-account-window={line.id} data-state={line.state}>
      <div className="flex flex-wrap items-start gap-2">
        <Icon name={icon.name} className={cn("mt-0.5 size-4 shrink-0", icon.className)} />
        <span className="min-w-0 flex-1">
          {line.title}
          <span className="block text-xs text-muted-foreground">{line.hint ?? t.windowSeparate}</span>
        </span>
        <span className="text-xs text-muted-foreground">{t.line(line.state)}</span>
      </div>
      {line.summary && line.state !== "done" ? <p className="pl-6 text-xs text-muted-foreground">{line.summary}</p> : null}
      {line.state === "waiting" ? <p className="pl-6 text-xs text-muted-foreground">{t.waitingNote}</p> : null}
      {canSignIn ? (
        <div className="flex flex-wrap items-center gap-2 pl-6">
          <Button
            size="sm"
            disabled={opened}
            onClick={() => {
              setOpened(true);
              setError(null);
              mutation.mutate({ hostId: hostId! } as never).then(
                () => setOpened(false),
                (cause: unknown) => {
                  setOpened(false);
                  setError(cause instanceof Error ? cause.message : String(cause));
                },
              );
            }}
          >
            {opened ? <Icon name="Loading" className="size-4 animate-spin" /> : null}
            {t.signIn}
          </Button>
          {line.path ? (
            <Button size="sm" variant="ghost" onClick={() => onOpen(line.path!)}>
              {t.open}
            </Button>
          ) : null}
        </div>
      ) : null}
      {opened ? <p role="status" className="pl-6 text-xs text-muted-foreground">{t.windowOpened}</p> : null}
      {error ? <p role="alert" className="pl-6 text-xs text-destructive">{error}</p> : null}
    </li>
  );
}

export function AccountBody({ account, title, secretStore, error, onSave, onForget, onOpen }: {
  account: AccountStep;
  title: string;
  secretStore: string;
  error: string | null;
  onSave: (login: string, password: string) => Promise<void>;
  onForget: () => void;
  onOpen: (path: string) => void;
}) {
  const t = useMessages(messages);
  const savedIn = useSavedIn();
  const [replacing, setReplacing] = useState(false);
  const formShown = account.plugins.length > 0 && (!account.saved || replacing);
  return (
    <>
      {formShown ? (
        <AccountForm
          account={account}
          label={title}
          error={error}
          onSave={(login, password) => onSave(login, password).then(() => setReplacing(false))}
          onCancel={account.saved ? () => setReplacing(false) : undefined}
        />
      ) : account.saved ? (
        <div className="mt-1.5 flex flex-wrap items-center gap-x-2 gap-y-1 pl-6 text-xs text-muted-foreground">
          <span className="min-w-0 flex-1 break-words">{savedIn(secretStore)}</span>
          <Button variant="ghost" size="sm" onClick={() => setReplacing(true)}>
            {t.replace}
          </Button>
          <Button variant="ghost" size="sm" onClick={onForget}>
            {t.forget}
          </Button>
        </div>
      ) : null}
      {formShown ? null : <StepError error={error} />}
      <ul className="mt-2 flex flex-col gap-0.5 pl-6">
        {account.plugins.map((line) => {
          const icon = ICON[line.state]!;
          const note = line.reason ? t.reason(line.reason) : line.state === "waiting" ? t.waitingNote : line.summary;
          return (
            <li key={line.id} className="flex flex-col gap-1 py-1" data-account-plugin={line.id} data-state={line.state}>
              <div className="flex flex-wrap items-start gap-2">
                <Icon name={icon.name} className={cn("mt-0.5 size-4 shrink-0", icon.className)} />
                <span className="min-w-0 flex-1">{line.title}</span>
                <span className={cn("text-xs", line.state === "problem" ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground")}>{t.line(line.state)}</span>
              </div>
              {note ? <p className={cn("pl-6 text-xs", line.state === "problem" ? "text-amber-700 dark:text-amber-300" : "text-muted-foreground")}>{note}</p> : null}
              {line.path && line.state !== "done" && line.state !== "waiting" && (line.state !== "todo" || line.summary !== null) ? (
                <div className="pl-6">
                  <Button size="sm" variant="outline" onClick={() => onOpen(line.path!)}>
                    {t.open}
                    <Icon name="ArrowRight" className="size-4" />
                  </Button>
                </div>
              ) : null}
            </li>
          );
        })}
        {account.windows.map((line) => (
          <WindowLine key={line.id} line={line} hostId={account.hostId} onOpen={onOpen} />
        ))}
      </ul>
    </>
  );
}
