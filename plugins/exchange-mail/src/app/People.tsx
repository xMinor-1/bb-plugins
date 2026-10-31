// People on a message, by name. A long copy list is folded to the first few
// and "and N more". Each person opens a small menu: write to them, or copy the
// address.
import { useState } from "react";
import type { MailAddress } from "../../contract";
import { DropdownMenu, DropdownMenuContent, DropdownMenuItem, DropdownMenuLabel, DropdownMenuSeparator, DropdownMenuTrigger } from "@/components/ui/dropdown-menu";
import { defineMessages, useMessages } from "@/lib/i18n";

const texts = defineMessages(
  {
    andMore: (n: number) => `and ${n} more`,
    fewer: "show fewer",
    write: "Write to them",
    copy: "Copy address",
    copied: "Address copied",
    menuFor: (name: string) => `Actions for ${name}`,
  },
  {
    andMore: (n) => `и ещё ${n}`,
    fewer: "свернуть",
    write: "Написать",
    copy: "Скопировать адрес",
    copied: "Адрес скопирован",
    menuFor: (name) => `Действия: ${name}`,
  },
);

/** The name people know someone by; the address when there is no name. */
export const shownName = (a: MailAddress) => a.name?.trim() || a.email;

/** How many people show before "and N more". */
export const FOLD_AFTER = 3;

export function Person({ person, onWrite }: { person: MailAddress; onWrite?: (person: MailAddress) => void }) {
  const t = useMessages(texts);
  const [copied, setCopied] = useState(false);
  const name = shownName(person);
  return (
    <DropdownMenu onOpenChange={(open) => !open && setCopied(false)}>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="rounded-sm underline decoration-dotted decoration-muted-foreground/60 underline-offset-2 hover:decoration-foreground focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
          title={person.email}
          aria-label={t.menuFor(name)}
        >
          {name}
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="max-w-80">
        <DropdownMenuLabel className="space-y-0.5">
          {person.name ? <span className="block break-words">{person.name}</span> : null}
          <span className="block break-all text-xs font-normal text-muted-foreground">{person.email}</span>
        </DropdownMenuLabel>
        <DropdownMenuSeparator />
        {onWrite && person.email ? <DropdownMenuItem onSelect={() => onWrite(person)}>{t.write}</DropdownMenuItem> : null}
        {person.email ? (
          <DropdownMenuItem
            onSelect={(event) => {
              // Keep the menu open long enough to say it worked.
              event.preventDefault();
              void navigator.clipboard?.writeText(person.email).then(() => setCopied(true));
            }}
          >
            {copied ? t.copied : t.copy}
          </DropdownMenuItem>
        ) : null}
      </DropdownMenuContent>
    </DropdownMenu>
  );
}

/** A line of people, folded after the first few. */
export function People({ people, onWrite, foldAfter = FOLD_AFTER }: { people: readonly MailAddress[]; onWrite?: (person: MailAddress) => void; foldAfter?: number }) {
  const t = useMessages(texts);
  const [open, setOpen] = useState(false);
  const shown = open || people.length <= foldAfter + 1 ? people : people.slice(0, foldAfter);
  const hidden = people.length - shown.length;
  return (
    <span className="break-words">
      {shown.map((person, n) => (
        <span key={`${person.email}-${n}`}>
          {n > 0 ? ", " : null}
          <Person person={person} onWrite={onWrite} />
        </span>
      ))}
      {hidden > 0 ? (
        <>
          {" "}
          <button type="button" className="text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => setOpen(true)}>
            {t.andMore(hidden)}
          </button>
        </>
      ) : open && people.length > foldAfter + 1 ? (
        <>
          {" "}
          <button type="button" className="text-muted-foreground underline underline-offset-2 hover:text-foreground" onClick={() => setOpen(false)}>
            {t.fewer}
          </button>
        </>
      ) : null}
    </span>
  );
}
