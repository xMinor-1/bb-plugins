// The preview the person confirms before `scenario_save` stores a scenario:
// the tag as it will look, its form, and the text it puts into the message box.
// It replaces the thread composer while the agent waits for the answer.
import { useId, useState } from "react";
import type { PluginPendingInteractionProps } from "@get-bb/plugin-sdk/app";
import { useMessages } from "@/lib/i18n";
import { cn } from "@/lib/utils";
import { checkScenario, initialAnswers, type Scenario } from "../catalog";
import { messages } from "../messages";
import type { PreviewDecision, PreviewPayload } from "../shared";
import { FieldInput } from "./fields";

/** The payload is untrusted: check it again before showing a Save button. */
export function readPreview(payload: unknown): { scenario: Scenario; replaces: string | null } | null {
  if (!payload || typeof payload !== "object") return null;
  const { scenario, replaces } = payload as Partial<PreviewPayload>;
  const checked = checkScenario(scenario);
  if (!("scenario" in checked)) return null;
  return { scenario: checked.scenario, replaces: typeof replaces === "string" ? replaces : null };
}

export function ScenarioPreview({ interaction, submit, cancel }: PluginPendingInteractionProps) {
  const t = useMessages(messages);
  const formId = useId();
  const [busy, setBusy] = useState(false);
  const preview = readPreview(interaction.payload);
  const answer = (decision: PreviewDecision) => {
    setBusy(true);
    submit(decision).catch(() => setBusy(false));
  };

  if (!preview) {
    return (
      <div className="flex flex-col gap-2 rounded-lg border border-border bg-background p-3">
        <p className="text-sm text-destructive">{t.previewInvalid}</p>
        <div>
          <button type="button" onClick={() => void cancel()} className={secondaryButton}>
            {t.close}
          </button>
        </div>
      </div>
    );
  }
  const { scenario, replaces } = preview;
  const answers = initialAnswers(scenario);

  return (
    <section
      aria-label={replaces ? t.previewReplace(replaces) : t.previewNew}
      className="flex max-h-[60vh] flex-col gap-3 overflow-y-auto rounded-lg border border-border bg-background p-3"
    >
      <div className="flex flex-col gap-1">
        <h2 className="text-sm font-medium text-foreground">{replaces ? t.previewReplace(replaces) : t.previewNew}</h2>
        <div className="flex flex-wrap items-center gap-2">
          <span className="inline-flex h-6 max-w-[14rem] items-center rounded-full border border-border bg-background px-2.5 text-xs text-foreground">
            <span className="truncate">{scenario.label}</span>
          </span>
          <span className="text-xs text-muted-foreground">{t.previewWhere}</span>
        </div>
        {scenario.description && <p className="text-xs text-muted-foreground">{scenario.description}</p>}
      </div>

      <div className="flex flex-col gap-2">
        <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t.previewForm}</h3>
        {scenario.fields.length === 0 ? (
          <p className="text-xs text-muted-foreground">{t.previewNoFields}</p>
        ) : (
          scenario.fields.map((field) => {
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
                  invalid={false}
                  onChange={() => {}}
                  attachmentCount={0}
                  inputId={inputId}
                  autoFocus={false}
                  disabled
                  t={t}
                />
                {field.hint && <span className="text-[11px] text-muted-foreground">{field.hint}</span>}
              </div>
            );
          })
        )}
      </div>

      <div className="flex flex-col gap-1">
        <h3 className="text-[11px] font-medium uppercase tracking-wide text-muted-foreground">{t.previewPrompt}</h3>
        <pre className="max-h-40 overflow-y-auto whitespace-pre-wrap break-words rounded-md bg-muted px-2 py-1.5 font-sans text-xs text-foreground">
          {scenario.prompt ?? scenario.fields.map((field) => `${field.label}: …`).join("\n")}
        </pre>
      </div>

      <div className="flex flex-wrap items-center gap-2">
        <button type="button" disabled={busy} onClick={() => answer({ save: true })} className={primaryButton}>
          {t.save}
        </button>
        <button type="button" disabled={busy} onClick={() => answer({ save: false })} className={secondaryButton}>
          {t.dontSave}
        </button>
      </div>
    </section>
  );
}

export const primaryButton = cn(
  "inline-flex h-7 items-center gap-1 rounded-md bg-primary px-3 text-xs font-medium text-primary-foreground",
  "hover:bg-primary/90 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
);
export const secondaryButton = cn(
  "inline-flex h-7 items-center rounded-md px-2 text-xs text-muted-foreground",
  "hover:bg-accent hover:text-accent-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring disabled:opacity-60",
);
