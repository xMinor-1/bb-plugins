// Pieces both Fleet Kit pages use: the page frame, a titled section, and the
// secret field. A secret is typed into a password field and goes straight to
// the backend, which keeps it in the credential store; the panel never shows it.
import { useEffect, useState } from "react";
import type { FormEvent, ReactNode } from "react";
import type { Status } from "../../contract";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";
import { Input } from "@/components/ui/input";
import { cn } from "@/lib/utils";
import { defineMessages, useLang, useMessages } from "@/lib/i18n";
import { storeName } from "../shared/texts";

export const STATUS_CHANNEL = "status-changed";

const messages = defineMessages(
  {
    savedIn: (store: string) => `Saved in ${store}`,
    notSet: "Not set",
    replace: "Replace",
    remove: "Remove",
    pasteValue: "Paste the value",
    save: "Save",
    cancel: "Cancel",
  },
  {
    savedIn: (store) => `Сохранён: ${store}`,
    notSet: "Не задан",
    replace: "Заменить",
    remove: "Удалить",
    pasteValue: "Вставьте значение",
    save: "Сохранить",
    cancel: "Отмена",
  },
);

export function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

export function Frame({ children }: { children: ReactNode }) {
  return (
    <div className="h-full min-h-0 flex-1 overflow-y-auto">
      <div className="mx-auto box-border w-full max-w-3xl px-4 pb-6 pt-3 md:px-5 md:pt-4">{children}</div>
    </div>
  );
}

export function Section({ title, icon, children, aside }: { title: string; icon: string; children: ReactNode; aside?: ReactNode }) {
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

/** The password field and its Save button. */
export function SecretInput({ label, onSave, onCancel, className }: {
  label: string;
  onSave: (value: string) => Promise<void>;
  onCancel?: () => void;
  className?: string;
}) {
  const t = useMessages(messages);
  const [value, setValue] = useState("");
  const [pending, setPending] = useState(false);
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault();
    if (value.trim() === "" || pending) return;
    setPending(true);
    try {
      await onSave(value);
      setValue("");
    } catch {
      // Not saved: the caller shows why, and the value stays in the field to try again.
    } finally {
      setPending(false);
    }
  };
  return (
    <form onSubmit={submit} className={cn("flex items-center gap-2", className)}>
      <Input
        type="password"
        autoComplete="off"
        spellCheck={false}
        value={value}
        onChange={(event) => setValue(event.target.value)}
        placeholder={t.pasteValue}
        aria-label={label}
      />
      <Button type="submit" size="sm" disabled={pending || value.trim() === ""}>
        {t.save}
      </Button>
      {onCancel ? (
        <Button type="button" variant="ghost" size="sm" onClick={onCancel}>
          {t.cancel}
        </Button>
      ) : null}
    </form>
  );
}

/** A build secret on the status page: set or not, replace, remove. */
export function SecretRow({ secret, store, onSave, onClear }: {
  secret: Status["secrets"][number];
  store: string;
  onSave: (value: string) => Promise<void>;
  onClear: () => Promise<void>;
}) {
  const t = useMessages(messages);
  const lang = useLang();
  const [editing, setEditing] = useState(!secret.set);
  useEffect(() => setEditing(!secret.set), [secret.set]);
  return (
    <li className="py-2.5">
      {/* Wraps on a narrow panel: the buttons move to their own line instead of past the card's edge. */}
      <div className="flex flex-wrap items-center gap-x-2 gap-y-1">
        <Icon name={secret.set ? "Lock" : "SquareUnlock02"} className={cn("size-4", secret.set ? "text-muted-foreground" : "text-amber-600 dark:text-amber-400")} />
        <span className="min-w-0 flex-1 font-medium">{secret.title}</span>
        <span className="min-w-0 break-words text-xs text-muted-foreground">{secret.set ? t.savedIn(storeName(store, lang)) : t.notSet}</span>
        {secret.set && !editing ? (
          <div className="ml-auto flex shrink-0 gap-1">
            <Button variant="ghost" size="sm" onClick={() => setEditing(true)}>
              {t.replace}
            </Button>
            <Button variant="ghost" size="sm" onClick={() => void onClear()}>
              {t.remove}
            </Button>
          </div>
        ) : null}
      </div>
      {secret.hint ? <p className="mt-1 pl-6 text-xs text-muted-foreground">{secret.hint}</p> : null}
      {editing ? (
        <SecretInput className="mt-2 pl-6" label={secret.title} onSave={onSave} onCancel={secret.set ? () => setEditing(false) : undefined} />
      ) : null}
    </li>
  );
}

/** "Saved in <store>" in the person's language. */
export function useSavedIn(): (store: string) => string {
  const t = useMessages(messages);
  const lang = useLang();
  return (store) => t.savedIn(storeName(store, lang));
}
