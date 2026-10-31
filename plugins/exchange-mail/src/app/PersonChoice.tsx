// The card in a thread where the person chooses who an agent meant: when an
// address book search finds several people, the agent does not pick one. The
// choice goes back to the agent as the result of its search (server.ts,
// mail_find_person); "None of them" tells it to ask.
import { useState } from "react";
import type { PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import type { Person } from "../../contract";
import type { PersonChoicePayload, PersonChoiceValue } from "../../server";
import { Button } from "@/components/ui/button";
import { defineMessages, useLang, useMessages } from "@/lib/i18n";
import { personDetails } from "./RecipientsInput";
import { Notice, errorText } from "./ui";

const texts = defineMessages(
  {
    title: (query: string) => `Several people match “${query}”. Who do you mean?`,
    hint: "The agent waits for your choice and does not pick anyone itself.",
    none: "None of them",
    group: "group",
    contact: "your contact",
    broken: "This choice cannot be shown.",
  },
  {
    title: (query) => `По запросу «${query}» нашлось несколько человек. Кого вы имеете в виду?`,
    hint: "Агент ждёт вашего выбора и сам никого не выбирает.",
    none: "Никто из них",
    group: "группа",
    contact: "ваш контакт",
    broken: "Этот выбор не получается показать.",
  },
);

const text = (value: unknown) => (typeof value === "string" ? value : null);

/** The payload comes through bb from this plugin's server; checked anyway, as anything shown in a thread is. */
export function readChoice(payload: unknown): PersonChoicePayload | null {
  if (!payload || typeof payload !== "object") return null;
  const { query, people } = payload as Record<string, unknown>;
  if (typeof query !== "string" || !Array.isArray(people)) return null;
  const valid = people.flatMap((raw): Person[] => {
    if (!raw || typeof raw !== "object") return [];
    const p = raw as Record<string, unknown>;
    if (typeof p.name !== "string" || typeof p.email !== "string") return [];
    const kind = p.kind === "group" || p.kind === "contact" ? p.kind : "person";
    return [{ name: p.name, email: p.email, title: text(p.title), department: text(p.department), company: text(p.company), office: text(p.office), kind }];
  });
  return valid.length ? { query, people: valid } : null;
}

export function PersonChoice({ interaction, submit }: PluginPendingInteractionProps) {
  const t = useMessages(texts);
  const lang = useLang();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const choice = readChoice(interaction.payload);
  if (!choice) return <Notice tone="error">{t.broken}</Notice>;

  const choose = async (email: string | null) => {
    setBusy(true);
    setError(null);
    try {
      await submit({ email, lang } satisfies PersonChoiceValue);
    } catch (cause) {
      setError(errorText(cause));
      setBusy(false);
    }
  };

  return (
    <div className="space-y-2 rounded-lg border border-border bg-card p-3 text-sm">
      <p className="font-medium">{t.title(choice.query)}</p>
      <p className="text-xs text-muted-foreground">{t.hint}</p>
      <ul className="space-y-1">
        {choice.people.map((person) => {
          const details = [personDetails(person), person.company].filter(Boolean).join(", ");
          return (
            <li key={person.email}>
              <button
                type="button"
                disabled={busy}
                onClick={() => void choose(person.email)}
                className="w-full rounded-md border border-border px-3 py-2 text-left hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring disabled:opacity-60"
              >
                <span className="block">
                  <span className="font-medium">{person.name}</span>
                  {person.kind !== "person" ? <span className="ml-2 text-xs text-muted-foreground">{person.kind === "group" ? t.group : t.contact}</span> : null}
                </span>
                {details ? <span className="block text-xs text-muted-foreground">{details}</span> : null}
                <span className="block break-all text-xs text-muted-foreground">{person.email}</span>
              </button>
            </li>
          );
        })}
      </ul>
      <Button size="sm" variant="ghost" disabled={busy} onClick={() => void choose(null)}>
        {t.none}
      </Button>
      {error ? <Notice tone="error">{error}</Notice> : null}
    </div>
  );
}
