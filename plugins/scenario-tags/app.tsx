// Scenario Tags — a row of scenario tags above the message box.
//
// Collapsed, the row shows the pinned tags; expanded, every scenario by group,
// each with a pin. A tag opens a short form with the scenario's questions;
// the answers become a prompt that goes into the message box. The person
// reads it and sends it themselves: nothing here submits.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { definePluginApp, useComposer, useRealtime, useRpc, useSettings } from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "./server";
import { Icon } from "@/components/ui/icon";
import { useMessages } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  groupedScenarios,
  initialAnswers,
  missingFields,
  parseCatalog,
  pinnedScenarios,
  renderPrompt,
  togglePin,
  type Answers,
  type Catalog,
  type OwnPins,
  type Scenario,
  type ScenarioField,
} from "./src/catalog";
import { messages } from "./src/messages";
import { PINS_CHANGED } from "./src/shared";

type Texts = (typeof messages)["en"];

// ---------- Data ----------

function useCatalog(): Catalog {
  const { values } = useSettings();
  const raw = values?.scenarios;
  return useMemo(() => parseCatalog(typeof raw === "string" ? raw : ""), [raw]);
}

/** The person's own pins; `undefined` while loading. */
function usePins(): [OwnPins | null | undefined, (next: OwnPins | null) => void] {
  const rpc = useRpc<RpcContract>();
  const [own, setOwn] = useState<OwnPins | null | undefined>(undefined);
  const latest = useRef(0);
  const load = useCallback(() => {
    const request = ++latest.current;
    rpc.call("pins_get", null).then(
      (result) => {
        if (request === latest.current) setOwn(result.own);
      },
      () => {
        if (request === latest.current) setOwn((current) => (current === undefined ? null : current));
      },
    );
  }, [rpc]);
  useEffect(load, [load]);
  useRealtime(PINS_CHANGED, load);
  const save = useCallback(
    (next: OwnPins | null) => {
      latest.current++;
      setOwn(next);
      rpc.call("pins_set", { own: next }).catch(load);
    },
    [rpc, load],
  );
  return [own, save];
}

// ---------- Tags ----------

function Tag({ scenario, onOpen, active }: { scenario: Scenario; onOpen: (scenario: Scenario) => void; active?: boolean }) {
  return (
    <button
      type="button"
      title={scenario.description}
      onClick={() => onOpen(scenario)}
      className={cn(
        "inline-flex h-6 max-w-[14rem] shrink-0 items-center rounded-full border px-2.5 text-xs",
        "transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        active
          ? "border-primary bg-primary text-primary-foreground"
          : "border-border bg-background text-foreground hover:bg-accent hover:text-accent-foreground",
      )}
    >
      <span className="truncate">{scenario.label}</span>
    </button>
  );
}

function PinButton({ pinned, label, onToggle, t }: { pinned: boolean; label: string; onToggle: () => void; t: Texts }) {
  const text = pinned ? t.unpin(label) : t.pin(label);
  return (
    <button
      type="button"
      aria-label={text}
      title={text}
      aria-pressed={pinned}
      onClick={onToggle}
      className={cn(
        "inline-flex size-5 shrink-0 items-center justify-center rounded-full",
        "hover:bg-accent focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
        pinned ? "text-foreground" : "text-muted-foreground/60",
      )}
    >
      <Icon name={pinned ? "Pin" : "PinOff"} className="size-3" />
    </button>
  );
}

function AllScenarios({
  catalog,
  row,
  onOpen,
  onTogglePin,
  onReset,
  canReset,
  t,
}: {
  catalog: Catalog;
  row: readonly Scenario[];
  onOpen: (scenario: Scenario) => void;
  onTogglePin: (scenario: Scenario) => void;
  onReset: () => void;
  canReset: boolean;
  t: Texts;
}) {
  const inRow = new Set(row.map((scenario) => scenario.id));
  return (
    <div className="flex max-h-64 flex-col gap-2 overflow-y-auto pb-1 pt-1.5">
      {groupedScenarios(catalog).map(({ group, scenarios }) => (
        <section key={group?.id ?? "__other"} className="flex flex-col gap-1">
          <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{group?.label ?? t.other}</h3>
          <div className="flex flex-wrap gap-x-2 gap-y-1">
            {scenarios.map((scenario) => (
              <span key={scenario.id} className="inline-flex min-w-0 items-center gap-0.5">
                <Tag scenario={scenario} onOpen={onOpen} />
                <PinButton pinned={inRow.has(scenario.id)} label={scenario.label} onToggle={() => onTogglePin(scenario)} t={t} />
              </span>
            ))}
          </div>
        </section>
      ))}
      <div className="flex flex-wrap items-center gap-3 text-[11px] text-muted-foreground">
        {canReset && (
          <button type="button" onClick={onReset} className="underline-offset-2 hover:text-foreground hover:underline">
            {t.resetPins}
          </button>
        )}
        {catalog.problems.length > 0 && <span>{t.problems(catalog.problems.length)}</span>}
      </div>
    </div>
  );
}

// ---------- Form ----------

const inputClass =
  "w-full rounded-md border border-input bg-background px-2 py-1 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 aria-invalid:border-destructive";

function FieldInput({
  field,
  value,
  invalid,
  onChange,
  attachmentCount,
  inputId,
  autoFocus,
  t,
}: {
  field: ScenarioField;
  value: string;
  invalid: boolean;
  onChange: (value: string) => void;
  attachmentCount: number;
  inputId: string;
  autoFocus: boolean;
  t: Texts;
}) {
  const common = { id: inputId, "aria-invalid": invalid || undefined, "aria-required": field.required || undefined, autoFocus };
  if (field.type === "attachment") {
    return (
      <p
        id={inputId}
        tabIndex={-1}
        className={cn(
          "flex items-center gap-1.5 text-xs",
          attachmentCount > 0 ? "text-foreground" : invalid ? "text-destructive" : "text-muted-foreground",
        )}
      >
        <Icon name={attachmentCount > 0 ? "Check" : "Paperclip"} className="size-3.5 shrink-0" />
        {attachmentCount > 0 ? t.attached(attachmentCount) : t.attachHint}
      </p>
    );
  }
  if (field.type === "textarea") {
    return (
      <textarea
        {...common}
        rows={3}
        value={value}
        placeholder={field.placeholder}
        onChange={(event) => onChange(event.target.value)}
        className={cn(inputClass, "min-h-16 resize-y")}
      />
    );
  }
  if (field.type === "select") {
    return (
      <select {...common} value={value} onChange={(event) => onChange(event.target.value)} className={cn(inputClass, "h-8")}>
        <option value="">{t.choose}</option>
        {field.options.map((option) => (
          <option key={option} value={option}>
            {option}
          </option>
        ))}
      </select>
    );
  }
  return (
    <input
      {...common}
      type="text"
      value={value}
      placeholder={field.placeholder}
      onChange={(event) => onChange(event.target.value)}
      className={cn(inputClass, "h-8")}
    />
  );
}

function ScenarioForm({ scenario, onDone, t }: { scenario: Scenario; onDone: () => void; t: Texts }) {
  const composer = useComposer();
  const [answers, setAnswers] = useState<Answers>(() => initialAnswers(scenario));
  const [tried, setTried] = useState(false);
  const formId = useId();
  const missing = missingFields(scenario, answers, composer.attachmentCount);
  const missingIds = new Set(tried ? missing.map((field) => field.id) : []);

  const insert = () => {
    if (missing.length > 0) {
      setTried(true);
      document.getElementById(`${formId}-${missing[0]!.id}`)?.focus();
      return;
    }
    const text = renderPrompt(scenario, answers, composer.attachmentCount, t.attachedAnswer);
    composer.insert(text, { at: "end", block: !composer.isEmpty });
    composer.focus();
    onDone();
  };

  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      onDone();
    } else if (event.key === "Enter" && (event.ctrlKey || event.metaKey)) {
      event.preventDefault();
      insert();
    }
  };

  return (
    <form
      aria-label={scenario.label}
      onKeyDown={onKeyDown}
      onSubmit={(event) => {
        event.preventDefault();
        insert();
      }}
      className="flex flex-col gap-2 pb-1 pt-1.5"
    >
      <div className="flex flex-col">
        <span className="text-sm font-medium text-foreground">{scenario.label}</span>
        {scenario.description && <span className="text-xs text-muted-foreground">{scenario.description}</span>}
      </div>
      <div className="flex max-h-72 flex-col gap-2 overflow-y-auto">
        {scenario.fields.map((field, index) => {
          const inputId = `${formId}-${field.id}`;
          return (
            <div key={field.id} className="flex flex-col gap-0.5">
              <label htmlFor={inputId} className="text-xs font-medium text-foreground">
                {field.label}
                {field.required && (
                  <span className="text-destructive" aria-label={t.required} title={t.required}>
                    {" "}*
                  </span>
                )}
              </label>
              <FieldInput
                field={field}
                value={answers[field.id] ?? ""}
                invalid={missingIds.has(field.id)}
                onChange={(value) => setAnswers((current) => ({ ...current, [field.id]: value }))}
                attachmentCount={composer.attachmentCount}
                inputId={inputId}
                autoFocus={index === 0 && field.type !== "attachment"}
                t={t}
              />
              {field.hint && <span className="text-[11px] text-muted-foreground">{field.hint}</span>}
            </div>
          );
        })}
      </div>
      <div className="flex flex-wrap items-center gap-2">
        <button
          type="submit"
          className="inline-flex h-7 items-center gap-1 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          {t.insert}
          <span className="hidden text-[10px] opacity-70 sm:inline">{t.shortcut}</span>
        </button>
        <button
          type="button"
          onClick={onDone}
          className="inline-flex h-7 items-center rounded-md px-2 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground"
        >
          {t.cancel}
        </button>
        {tried && missing.length > 0 && (
          <span role="alert" className="text-xs text-destructive">
            {t.fillRequired}
          </span>
        )}
      </div>
    </form>
  );
}

// ---------- Banner ----------

export function ScenarioBar() {
  const t = useMessages(messages);
  const catalog = useCatalog();
  const [own, savePins] = usePins();
  const [expanded, setExpanded] = useState(false);
  const [open, setOpen] = useState<Scenario | null>(null);

  // A scenario that left the catalog (new manifest) closes its form.
  const openId = open?.id;
  useEffect(() => {
    if (openId && !catalog.scenarios.some((scenario) => scenario.id === openId)) setOpen(null);
  }, [catalog, openId]);

  if (catalog.scenarios.length === 0) return null;
  const row = pinnedScenarios(catalog, own ?? null);
  const current = open ? catalog.scenarios.find((scenario) => scenario.id === open.id) ?? null : null;
  const openScenario = (scenario: Scenario) => setOpen((now) => (now?.id === scenario.id ? null : scenario));

  return (
    <div className="flex flex-col px-1">
      <div className="flex min-w-0 items-center gap-1.5">
        <button
          type="button"
          aria-expanded={expanded}
          aria-label={expanded ? t.hideAll : t.showAll}
          title={expanded ? t.hideAll : t.showAll}
          onClick={() => setExpanded((now) => !now)}
          className="inline-flex h-6 shrink-0 items-center gap-0.5 rounded-md px-1 text-xs text-muted-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Icon name={expanded ? "ChevronDown" : "ChevronRight"} className="size-3.5" />
          {t.scenarios}
        </button>
        <div className="flex min-w-0 flex-1 items-center gap-1.5 overflow-x-auto [scrollbar-width:none]">
          {row.length > 0 ? (
            row.map((scenario) => <Tag key={scenario.id} scenario={scenario} onOpen={openScenario} active={current?.id === scenario.id} />)
          ) : (
            <span className="truncate text-xs text-muted-foreground">{t.noPins}</span>
          )}
        </div>
      </div>
      {current ? (
        <ScenarioForm
          key={current.id}
          scenario={current}
          t={t}
          onDone={() => {
            setOpen(null);
            setExpanded(false);
          }}
        />
      ) : (
        expanded && (
          <AllScenarios
            catalog={catalog}
            row={row}
            onOpen={openScenario}
            onTogglePin={(scenario) => savePins(togglePin(catalog, own ?? null, scenario.id))}
            onReset={() => savePins(null)}
            canReset={own !== null && own !== undefined}
            t={t}
          />
        )
      )}
    </div>
  );
}

export default definePluginApp((app) => {
  app.composer.customize({
    id: "scenario-tags",
    scopes: ["thread", "new-thread"],
    banners: [{ id: "scenario-bar", chrome: "bare", component: ScenarioBar }],
  });
});
