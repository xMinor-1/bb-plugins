// Scenario Tags — a row of scenario tags above the message box.
//
// Collapsed, the row shows the pinned tags; expanded, every scenario by group,
// each with a pin. A tag opens a short form with the scenario's questions;
// the answers become a prompt that goes into the message box. The person
// reads it and sends it themselves: nothing here submits.
import { useCallback, useEffect, useId, useMemo, useRef, useState, type KeyboardEvent } from "react";
import { definePluginApp, useComposer, useRealtime, useRpc, useSettings, type PluginComposerApi } from "@get-bb/plugin-sdk/app";
import type { RpcContract } from "./server";
import { Icon } from "@/components/ui/icon";
import { messagesNow, useMessages } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import {
  checkScenario,
  editPrompt,
  groupedScenarios,
  isOwn,
  initialAnswers,
  missingFields,
  parseCatalog,
  pinnedScenarios,
  renderPrompt,
  togglePin,
  withOwn,
  type Answers,
  type Catalog,
  type OwnPins,
  type Scenario,
  type ScenarioField,
} from "./src/catalog";
import { messages } from "./src/messages";
import { FieldInput } from "./src/app/fields";
import { OWN_CHANGED, PINS_CHANGED, PREVIEW_RENDERER } from "./src/shared";
import { DEFAULT_BUILDER_PROMPT, DEFAULT_EDIT_PROMPT, DEFAULT_SAVE_CHAT_PROMPT } from "./src/prompts";
import { DeleteConfirm, OwnActions, SuggestPanel } from "./src/app/own";
import { ScenarioPreview } from "./src/app/preview";

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

/** The person's own scenarios, checked again on the way in. */
function useOwnScenarios(): [Scenario[], (id: string) => void] {
  const rpc = useRpc<RpcContract>();
  const [own, setOwn] = useState<Scenario[]>([]);
  const latest = useRef(0);
  const load = useCallback(() => {
    const request = ++latest.current;
    rpc.call("own_list", null).then(
      (result) => {
        if (request !== latest.current) return;
        const checked = result.scenarios.map(checkScenario).flatMap((item) => ("scenario" in item ? [item.scenario] : []));
        setOwn(checked);
      },
      () => {},
    );
  }, [rpc]);
  useEffect(load, [load]);
  useRealtime(OWN_CHANGED, load);
  const remove = useCallback(
    (id: string) => {
      latest.current++;
      setOwn((current) => current.filter((scenario) => scenario.id !== id));
      rpc.call("own_delete", { id }).catch(load);
    },
    [rpc, load],
  );
  return [own, remove];
}

type ComposerTexts = { builder: string; saveChat: string; edit: string; suggestEmail: string; suggestHint: string };

const text = (value: unknown, fallback: string) => (typeof value === "string" && value.trim() !== "" ? value : fallback);

/** What the row puts into the message box; the plus menu reads the latest copy outside React. */
let latestTexts: ComposerTexts = {
  builder: DEFAULT_BUILDER_PROMPT,
  saveChat: DEFAULT_SAVE_CHAT_PROMPT,
  edit: DEFAULT_EDIT_PROMPT,
  suggestEmail: "",
  suggestHint: "",
};

function useComposerTexts(): ComposerTexts {
  const { values } = useSettings();
  const texts = useMemo(
    () => ({
      builder: text(values?.builderPrompt, DEFAULT_BUILDER_PROMPT),
      saveChat: text(values?.saveChatPrompt, DEFAULT_SAVE_CHAT_PROMPT),
      edit: text(values?.editPrompt, DEFAULT_EDIT_PROMPT),
      suggestEmail: text(values?.suggestEmail, "").trim(),
      suggestHint: text(values?.suggestHint, ""),
    }),
    [values],
  );
  useEffect(() => {
    latestTexts = texts;
  }, [texts]);
  return texts;
}

/** Puts text at the end of the draft, on its own paragraph when the draft has text. */
function putIntoComposer(composer: PluginComposerApi, value: string) {
  composer.insert(value, { at: "end", block: !composer.isEmpty });
  composer.focus();
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

type OwnPanel = { kind: "delete" | "suggest"; scenario: Scenario } | null;

function AllScenarios({
  catalog,
  row,
  onOpen,
  onTogglePin,
  onReset,
  canReset,
  onNew,
  onSaveChat,
  onEdit,
  onDelete,
  texts,
  t,
}: {
  catalog: Catalog;
  row: readonly Scenario[];
  onOpen: (scenario: Scenario) => void;
  onTogglePin: (scenario: Scenario) => void;
  onReset: () => void;
  canReset: boolean;
  onNew: () => void;
  onSaveChat: (() => void) | null;
  onEdit: (scenario: Scenario) => void;
  onDelete: (scenario: Scenario) => void;
  texts: ComposerTexts;
  t: Texts;
}) {
  const inRow = new Set(row.map((scenario) => scenario.id));
  const [panel, setPanel] = useState<OwnPanel>(null);
  const panelScenario = panel ? catalog.scenarios.find((scenario) => scenario.id === panel.scenario.id) ?? null : null;
  return (
    <div className="flex max-h-72 flex-col gap-2 overflow-y-auto pb-1 pt-1.5">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-1">
        <button
          type="button"
          onClick={onNew}
          title={t.newScenarioHint}
          className="inline-flex h-6 items-center gap-1 rounded-full border border-dashed border-border px-2.5 text-xs text-foreground hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        >
          <Icon name="Plus" className="size-3" />
          {t.newScenario}
        </button>
        {onSaveChat && (
          <button type="button" onClick={onSaveChat} className="text-xs text-muted-foreground underline-offset-2 hover:text-foreground hover:underline">
            {t.saveChat}
          </button>
        )}
      </div>
      {groupedScenarios(catalog).map(({ group, scenarios }) => (
        <section key={group?.id ?? "__other"} className="flex flex-col gap-1">
          <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{group?.label ?? t.other}</h3>
          <div className="flex flex-wrap gap-x-2 gap-y-1">
            {scenarios.map((scenario) => (
              <span key={scenario.id} className="inline-flex min-w-0 items-center gap-0.5">
                <Tag scenario={scenario} onOpen={onOpen} />
                <PinButton pinned={inRow.has(scenario.id)} label={scenario.label} onToggle={() => onTogglePin(scenario)} t={t} />
                {isOwn(scenario) && (
                  <OwnActions
                    scenario={scenario}
                    onEdit={() => onEdit(scenario)}
                    onAskDelete={() => setPanel({ kind: "delete", scenario })}
                    onSuggest={() => setPanel({ kind: "suggest", scenario })}
                    t={t}
                  />
                )}
              </span>
            ))}
          </div>
        </section>
      ))}
      {panel && panelScenario && panel.kind === "delete" && (
        <DeleteConfirm
          scenario={panelScenario}
          onDelete={() => {
            onDelete(panelScenario);
            setPanel(null);
          }}
          onKeep={() => setPanel(null)}
          t={t}
        />
      )}
      {panel && panelScenario && panel.kind === "suggest" && (
        <SuggestPanel scenario={panelScenario} email={texts.suggestEmail} hint={texts.suggestHint} onClose={() => setPanel(null)} t={t} />
      )}
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
  const composer = useComposer();
  const texts = useComposerTexts();
  const shared = useCatalog();
  const [ownScenarios, removeOwn] = useOwnScenarios();
  const catalog = useMemo(() => withOwn(shared, ownScenarios, t.mine), [shared, ownScenarios, t.mine]);
  const [own, savePins] = usePins();
  const [expanded, setExpanded] = useState(false);
  const [open, setOpen] = useState<Scenario | null>(null);

  // A scenario that left the catalog (new manifest, deleted) closes its form.
  const openId = open?.id;
  useEffect(() => {
    if (openId && !catalog.scenarios.some((scenario) => scenario.id === openId)) setOpen(null);
  }, [catalog, openId]);

  const row = pinnedScenarios(catalog, own ?? null);
  const current = open ? catalog.scenarios.find((scenario) => scenario.id === open.id) ?? null : null;
  const openScenario = (scenario: Scenario) => setOpen((now) => (now?.id === scenario.id ? null : scenario));
  const insertAndClose = (value: string) => {
    putIntoComposer(composer, value);
    setExpanded(false);
  };

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
            <span className="truncate text-xs text-muted-foreground">{catalog.scenarios.length > 0 ? t.noPins : t.emptyRow}</span>
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
            onNew={() => insertAndClose(texts.builder)}
            onSaveChat={composer.scope.kind === "thread" ? () => insertAndClose(texts.saveChat) : null}
            onEdit={(scenario) => insertAndClose(editPrompt(texts.edit, scenario))}
            onDelete={(scenario) => removeOwn(scenario.id)}
            texts={texts}
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
    plusMenu: [
      {
        id: "save-as-scenario",
        label: messagesNow(messages).saveChatMenu,
        description: messagesNow(messages).saveChatMenuHint,
        icon: "Plus",
        disabled: (composer) => composer.scope.kind !== "thread",
        run: ({ composer }) => putIntoComposer(composer, latestTexts.saveChat),
      },
    ],
  });
  app.slots.pendingInteraction({ id: PREVIEW_RENDERER, component: ScenarioPreview });
});
