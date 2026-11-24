// Form fields of a scenario, shared by the tag form and the save preview.
import { Icon } from "@/components/ui/icon";
import { cn } from "@/lib/utils";
import type { ScenarioField } from "../catalog";
import type { messages } from "../messages";

type Texts = (typeof messages)["en"];

export const inputClass =
  "w-full rounded-md border border-input bg-background px-2 py-1 text-sm shadow-xs outline-none placeholder:text-muted-foreground focus-visible:border-ring focus-visible:ring-2 focus-visible:ring-ring/40 aria-invalid:border-destructive";

export function FieldInput({
  field,
  value,
  invalid,
  onChange,
  attachmentCount,
  inputId,
  autoFocus,
  disabled,
  t,
}: {
  field: ScenarioField;
  value: string;
  invalid: boolean;
  onChange: (value: string) => void;
  attachmentCount: number;
  inputId: string;
  autoFocus: boolean;
  disabled?: boolean;
  t: Texts;
}) {
  const common = { id: inputId, "aria-invalid": invalid || undefined, "aria-required": field.required || undefined, autoFocus, disabled };
  if (field.type === "attachment") {
    return (
      <p
        id={inputId}
        tabIndex={-1}
        className={cn(
          "flex items-center gap-1.5 text-xs outline-none",
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
