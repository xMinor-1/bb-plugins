// "All scenarios": the whole catalog by group, with each scenario's
// description and form questions, a search box, and Add to my row / Hide on
// each. The expanded view of the row stays short; this is where the person
// finds what they do not keep there.
import { useState, type KeyboardEvent } from "react";
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import { canHide, groupedScenarios, searchScenarios, type Catalog, type Scenario } from "../catalog";
import type { messages } from "../messages";

type Texts = (typeof messages)["en"];

const smallButton = cn(
  "inline-flex h-6 shrink-0 items-center gap-1 rounded-md border border-border px-2 text-[11px] text-foreground",
  "hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
);

const mark = "inline-flex h-4 shrink-0 items-center rounded px-1 text-[10px] font-medium uppercase tracking-wide";

function ScenarioCard({
  scenario,
  inRow,
  hidden,
  isNew,
  onOpen,
  onTogglePin,
  onHide,
  onUnhide,
  t,
}: {
  scenario: Scenario;
  inRow: boolean;
  hidden: boolean;
  isNew: boolean;
  onOpen: () => void;
  onTogglePin: () => void;
  onHide: () => void;
  onUnhide: () => void;
  t: Texts;
}) {
  return (
    <li className={cn("flex min-w-0 flex-col gap-0.5 rounded-md border border-border px-2 py-1.5", hidden && "opacity-70")} data-scenario={scenario.id}>
      <div className="flex min-w-0 flex-wrap items-center gap-x-1.5 gap-y-1">
        <button
          type="button"
          onClick={onOpen}
          title={t.openForm(scenario.label)}
          className="min-w-0 max-w-full truncate text-left text-xs font-medium text-foreground underline-offset-2 hover:underline focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {scenario.label}
        </button>
        {isNew && <span className={cn(mark, "bg-primary text-primary-foreground")}>{t.newMark}</span>}
        {hidden && <span className={cn(mark, "bg-muted text-muted-foreground")}>{t.hiddenMark}</span>}
        <span className="ml-auto flex shrink-0 flex-wrap items-center gap-1">
          <button type="button" onClick={onTogglePin} aria-pressed={inRow} className={smallButton}>
            <Icon name={inRow ? "PinOff" : "Pin"} className="size-3" />
            {inRow ? t.removeFromRow : t.addToRow}
          </button>
          {canHide(scenario) &&
            (hidden ? (
              <button type="button" onClick={onUnhide} aria-label={t.showAgainLabel(scenario.label)} className={smallButton}>
                <Icon name="Eye" className="size-3" />
                {t.showAgain}
              </button>
            ) : (
              <button type="button" onClick={onHide} aria-label={t.hide(scenario.label)} className={smallButton}>
                <Icon name="EyeOff" className="size-3" />
                {t.hideShort}
              </button>
            ))}
        </span>
      </div>
      {scenario.description && <p className="text-[11px] text-muted-foreground">{scenario.description}</p>}
      <p className="text-[11px] text-muted-foreground">
        {scenario.fields.length === 0 ? (
          t.noQuestions
        ) : (
          <>
            <span className="text-foreground/80">{t.questions}</span>{" "}
            {scenario.fields.map((field, index) => (
              <span key={field.id}>
                {index > 0 && ", "}
                {field.label}
                {field.required && (
                  <span className="text-destructive" title={t.required}>
                    *
                  </span>
                )}
              </span>
            ))}
          </>
        )}
      </p>
    </li>
  );
}

export function CatalogView({
  catalog,
  rowIds,
  hiddenIds,
  newIds,
  onOpen,
  onTogglePin,
  onHide,
  onUnhide,
  onBack,
  t,
}: {
  catalog: Catalog;
  rowIds: ReadonlySet<string>;
  hiddenIds: ReadonlySet<string>;
  /** New when the view opened; kept while it is open even though they are now seen. */
  newIds: ReadonlySet<string>;
  onOpen: (scenario: Scenario) => void;
  onTogglePin: (scenario: Scenario) => void;
  onHide: (scenario: Scenario) => void;
  onUnhide: (scenario: Scenario) => void;
  onBack: () => void;
  t: Texts;
}) {
  const [query, setQuery] = useState("");
  const found = searchScenarios(catalog, query);
  const sections = groupedScenarios({ ...catalog, scenarios: found });
  const onKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== "Escape") return;
    event.preventDefault();
    event.stopPropagation();
    if (query !== "") setQuery("");
    else onBack();
  };
  return (
    <div className="flex flex-col gap-2 pb-1 pt-1.5" role="region" aria-label={t.allScenarios}>
      <div className="flex min-w-0 items-center gap-2">
        <button
          type="button"
          onClick={onBack}
          className="inline-flex h-6 shrink-0 items-center gap-1 rounded-md px-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Icon name="ArrowLeft" className="size-3.5" />
          {t.back}
        </button>
        <span className="shrink-0 text-xs font-medium text-foreground">{t.allScenarios}</span>
        <label className="ml-auto flex h-7 min-w-0 max-w-[16rem] flex-1 items-center gap-1 rounded-md border border-input bg-background px-2 focus-within:ring-2 focus-within:ring-ring">
          <Icon name="Search" className="size-3 shrink-0 text-muted-foreground" />
          <input
            type="search"
            value={query}
            autoFocus
            onChange={(event) => setQuery(event.target.value)}
            onKeyDown={onKeyDown}
            aria-label={t.search}
            placeholder={t.search}
            className="h-full min-w-0 flex-1 bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
          />
        </label>
      </div>
      <div className="flex max-h-96 flex-col gap-2 overflow-y-auto">
        {sections.length === 0 && <p className="text-xs text-muted-foreground">{t.nothingFound}</p>}
        {sections.map(({ group, scenarios }) => (
          <section key={group?.id ?? "__other"} className="flex flex-col gap-1">
            <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{group?.label ?? t.other}</h3>
            <ul className="flex flex-col gap-1">
              {scenarios.map((scenario) => (
                <ScenarioCard
                  key={scenario.id}
                  scenario={scenario}
                  inRow={rowIds.has(scenario.id)}
                  hidden={hiddenIds.has(scenario.id)}
                  isNew={newIds.has(scenario.id)}
                  onOpen={() => onOpen(scenario)}
                  onTogglePin={() => onTogglePin(scenario)}
                  onHide={() => onHide(scenario)}
                  onUnhide={() => onUnhide(scenario)}
                  t={t}
                />
              ))}
            </ul>
          </section>
        ))}
      </div>
    </div>
  );
}
