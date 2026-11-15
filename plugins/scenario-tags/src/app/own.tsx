// Controls of the person's own scenarios: change (the agent does it),
// delete (with a confirm), and suggest to everyone (a file to send).
import { useEffect, useRef, useState } from "react";
import { experimental_copyToClipboard, experimental_saveFile } from "@get-bb/plugin-sdk/app";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { catalogEntry, OWN_PREFIX, type Scenario } from "../catalog";
import type { messages } from "../messages";
import { primaryButton, secondaryButton } from "./preview";

type Texts = (typeof messages)["en"];

/** A panel that opens below a long list scrolls itself into view. */
function useRevealed<T extends HTMLElement>() {
  const ref = useRef<T>(null);
  useEffect(() => {
    ref.current?.scrollIntoView?.({ block: "nearest" });
  }, []);
  return ref;
}

const iconButton = cn(
  "inline-flex size-5 shrink-0 items-center justify-center rounded-full text-muted-foreground/70",
  "hover:bg-accent hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
);

export function OwnActions({
  scenario,
  onEdit,
  onAskDelete,
  onSuggest,
  t,
}: {
  scenario: Scenario;
  onEdit: () => void;
  onAskDelete: () => void;
  onSuggest: () => void;
  t: Texts;
}) {
  return (
    <>
      <button type="button" aria-label={t.edit(scenario.label)} title={t.edit(scenario.label)} onClick={onEdit} className={iconButton}>
        <Icon name="Edit" className="size-3" />
      </button>
      <button type="button" aria-label={t.remove(scenario.label)} title={t.remove(scenario.label)} onClick={onAskDelete} className={iconButton}>
        <Icon name="Trash2" className="size-3" />
      </button>
      <button type="button" aria-label={t.suggest(scenario.label)} title={t.suggest(scenario.label)} onClick={onSuggest} className={iconButton}>
        <Icon name="Sent" className="size-3" />
      </button>
    </>
  );
}

export function DeleteConfirm({ scenario, onDelete, onKeep, t }: { scenario: Scenario; onDelete: () => void; onKeep: () => void; t: Texts }) {
  const ref = useRevealed<HTMLDivElement>();
  return (
    <div ref={ref} role="alertdialog" aria-label={t.remove(scenario.label)} className="flex flex-wrap items-center gap-2 rounded-md border border-border px-2 py-1.5">
      <span className="text-xs text-foreground">{t.removeAsk(scenario.label)}</span>
      <button type="button" onClick={onDelete} className={cn(primaryButton, "bg-destructive hover:bg-destructive/90")}>
        {t.removeYes}
      </button>
      <button type="button" onClick={onKeep} className={secondaryButton}>
        {t.keep}
      </button>
    </div>
  );
}

/** The file "suggest to everyone" hands over: one catalog entry. */
export function suggestionFile(scenario: Scenario): { name: string; text: string } {
  const id = scenario.id.startsWith(OWN_PREFIX) ? scenario.id.slice(OWN_PREFIX.length) : scenario.id;
  return { name: `scenario-${id}.json`, text: `${JSON.stringify(catalogEntry(scenario), null, 2)}\n` };
}

/** A mailto link with the scenario in the body; mail clients cap long links, so the body is cut. */
export function mailLink(email: string, scenario: Scenario, intro: string): string {
  const { text } = suggestionFile(scenario);
  const body = `${intro}\n\n${text}`.slice(0, 1800);
  return `mailto:${encodeURIComponent(email)}?subject=${encodeURIComponent(`Scenario: ${scenario.label}`)}&body=${encodeURIComponent(body)}`;
}

export function SuggestPanel({
  scenario,
  email,
  hint,
  onClose,
  t,
}: {
  scenario: Scenario;
  email: string;
  hint: string;
  onClose: () => void;
  t: Texts;
}) {
  const [copied, setCopied] = useState(false);
  const ref = useRevealed<HTMLDivElement>();
  const file = suggestionFile(scenario);
  const validEmail = /^[^\s@<>"]+@[^\s@<>"]+$/.test(email) ? email : "";
  return (
    <div ref={ref} role="region" aria-label={t.suggestTitle(scenario.label)} className="flex flex-col gap-2 rounded-md border border-border px-2 py-2">
      <span className="text-xs font-medium text-foreground">{t.suggestTitle(scenario.label)}</span>
      <p className="whitespace-pre-wrap text-xs text-muted-foreground">{hint.trim() || t.suggestDefaultHint}</p>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="button"
          className={primaryButton}
          onClick={() => void experimental_saveFile({ fileName: file.name, blob: new Blob([file.text], { type: "application/json" }) })}
        >
          <Icon name="Download" className="size-3.5" />
          {t.download}
        </button>
        <button
          type="button"
          className={secondaryButton}
          onClick={() =>
            void experimental_copyToClipboard({ text: file.text }).then((ok) => {
              if (ok) setCopied(true);
            })
          }
        >
          <Icon name={copied ? "Check" : "Copy"} className="mr-1 size-3.5" />
          {copied ? t.copied : t.copy}
        </button>
        {validEmail && (
          <a href={mailLink(validEmail, scenario, t.mailBody)} target="_blank" rel="noreferrer" className={secondaryButton}>
            <Icon name="Mail" className="mr-1 size-3.5" />
            {t.mail}
          </a>
        )}
        <button type="button" onClick={onClose} className={secondaryButton}>
          {t.close}
        </button>
      </div>
    </div>
  );
}
