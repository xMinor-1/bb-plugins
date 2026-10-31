// A To or Cc field that suggests people from the address book while a name is
// typed: arrows and Enter or a click put "Name <address>" in place of the
// typed name. Typing addresses by hand works as before; when the address book
// does not answer, there are simply no suggestions.
import { useEffect, useId, useRef, useState, type KeyboardEvent } from "react";
import type { Person } from "../../contract";
import { Input } from "@/components/ui/input";
import { defineMessages, useMessages } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { lastRecipient, recipientText } from "../shared/recipients";
import type { Rpc } from "./rpc";

const texts = defineMessages(
  {
    suggestions: "People from the address book",
    group: "group",
    contact: "your contact",
  },
  {
    suggestions: "Люди из адресной книги",
    group: "группа",
    contact: "ваш контакт",
  },
);

/** Wait this long after the last key before asking the address book. */
export const SUGGEST_DELAY_MS = 300;
const SHOWN = 8;

export const personDetails = (person: Person) => [person.title, person.department].filter((part): part is string => Boolean(part)).join(", ");

export function RecipientsInput({
  rpc,
  hostId,
  value,
  onChange,
  label,
  ariaLabel,
  placeholder,
  autoFocus,
}: {
  rpc: Rpc;
  hostId: string;
  value: string;
  onChange: (value: string) => void;
  /** Shown above the field. */
  label?: string;
  /** The field's name for screen readers when there is no label. */
  ariaLabel?: string;
  placeholder?: string;
  autoFocus?: boolean;
}) {
  const t = useMessages(texts);
  const id = useId();
  const listId = `${id}-people`;
  const [people, setPeople] = useState<Person[]>([]);
  const [active, setActive] = useState(0);
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const asked = useRef(0);
  const { head, typing } = lastRecipient(value);
  const query = typing.trim();

  useEffect(() => {
    const mine = ++asked.current;
    // An address already written as "Name <address>" or in quotes is finished.
    if (query.length < 2 || /[<>"]/.test(query)) {
      setPeople([]);
      return;
    }
    const timer = setTimeout(() => {
      rpc.call("findPeople", { hostId, query }).then(
        (found) => {
          if (asked.current !== mine) return;
          setPeople(found.people.slice(0, SHOWN));
          setActive(0);
        },
        () => {
          if (asked.current === mine) setPeople([]);
        },
      );
    }, SUGGEST_DELAY_MS);
    return () => clearTimeout(timer);
  }, [rpc, hostId, query]);

  const shown = focused && !dismissed && people.length > 0;

  const pick = (person: Person) => {
    const before = head && !/\s$/.test(head) ? `${head} ` : head;
    onChange(`${before}${recipientText(person)}, `);
    setPeople([]);
  };

  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (!shown) return;
    if (event.key === "ArrowDown" || event.key === "ArrowUp") {
      event.preventDefault();
      const step = event.key === "ArrowDown" ? 1 : -1;
      setActive((current) => (current + step + people.length) % people.length);
    } else if (event.key === "Enter") {
      event.preventDefault();
      pick(people[active] ?? people[0]!);
    } else if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      setDismissed(true);
    }
  };

  return (
    <div className="space-y-1">
      {label ? (
        <label htmlFor={id} className="block text-muted-foreground">
          {label}
        </label>
      ) : null}
      <Input
        id={id}
        role="combobox"
        aria-autocomplete="list"
        aria-expanded={shown}
        aria-controls={listId}
        aria-activedescendant={shown ? `${listId}-${active}` : undefined}
        aria-label={label ? undefined : (ariaLabel ?? placeholder)}
        value={value}
        placeholder={placeholder}
        autoFocus={autoFocus}
        spellCheck={false}
        onChange={(event) => {
          setDismissed(false);
          onChange(event.target.value);
        }}
        onFocus={() => setFocused(true)}
        onBlur={() => setFocused(false)}
        onKeyDown={onKeyDown}
      />
      {shown ? (
        <ul id={listId} role="listbox" aria-label={t.suggestions} className="max-h-72 overflow-auto rounded-md border border-border bg-popover p-1 text-sm shadow-sm">
          {people.map((person, n) => {
            const details = personDetails(person);
            return (
              <li
                key={person.email}
                id={`${listId}-${n}`}
                role="option"
                aria-selected={n === active}
                // Keeps the focus in the field, so the click lands before the list closes.
                onMouseDown={(event) => event.preventDefault()}
                onMouseEnter={() => setActive(n)}
                onClick={() => pick(person)}
                className={cn("cursor-pointer rounded px-2 py-1", n === active && "bg-accent text-accent-foreground")}
              >
                <span className="block">
                  <span className="font-medium">{person.name}</span>
                  {person.kind !== "person" ? <span className="ml-2 text-xs text-muted-foreground">{person.kind === "group" ? t.group : t.contact}</span> : null}
                </span>
                <span className="block break-all text-xs text-muted-foreground">{details ? `${details} — ${person.email}` : person.email}</span>
              </li>
            );
          })}
        </ul>
      ) : null}
    </div>
  );
}
