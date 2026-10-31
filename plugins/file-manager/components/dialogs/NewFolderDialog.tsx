// components/dialogs/NewFolderDialog.tsx
//
// The name check is a *mirror* of the backend's `validateName` (§6) so the
// user gets an inline message instead of a toast; the server still re-checks
// everything it is handed.
import { useEffect, useRef, useState } from "react";

import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Input } from "../ui/input";
import { cn } from "../../lib/utils";
import { defineMessages, messagesNow, useMessages } from "../../lib/i18n";

const messages = defineMessages(
  {
    enterName: "Enter a name.",
    reserved: "That name is reserved.",
    slash: "A name cannot contain a slash.",
    control: "A name cannot contain control characters.",
    tooLong: "That name is too long (max 255 bytes).",
    exists: "An item with that name already exists.",
    title: "New folder",
    inFolder: (label: string) => `in ${label}`,
    folderName: "Folder name",
    placeholder: "untitled folder",
    cancel: "Cancel",
    create: "Create",
  },
  {
    enterName: "Введите имя.",
    reserved: "Это имя зарезервировано.",
    slash: "Имя не может содержать косую черту.",
    control: "Имя не может содержать управляющие символы.",
    tooLong: "Имя слишком длинное (не больше 255 байт).",
    exists: "Элемент с таким именем уже есть.",
    title: "Новая папка",
    inFolder: (label) => `в ${label}`,
    folderName: "Имя папки",
    placeholder: "новая папка",
    cancel: "Отмена",
    create: "Создать",
  },
);

const CONTROL_CHARACTERS = /[\u0000-\u001f]/u;

/** Client mirror of `src/root.ts#validateName`; returns null when the name is fine. */
export function validateEntryName(name: string, taken?: ReadonlySet<string>): string | null {
  const t = messagesNow(messages);
  if (name === "") return t.enterName;
  if (name === "." || name === "..") return t.reserved;
  if (name.includes("/")) return t.slash;
  if (CONTROL_CHARACTERS.test(name)) return t.control;
  if (new TextEncoder().encode(name).length > 255) return t.tooLong;
  if (taken?.has(name) === true) return t.exists;
  return null;
}

export interface NewFolderDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** Names already present in the target directory, for the inline check. */
  existingNames?: ReadonlySet<string>;
  /** Absolute directory the folder is created in; shown as context. */
  destinationLabel: string;
  onSubmit: (name: string) => Promise<void>;
}

export function NewFolderDialog({
  open,
  onOpenChange,
  existingNames,
  destinationLabel,
  onSubmit,
}: NewFolderDialogProps) {
  const t = useMessages(messages);
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (open) {
      setName("");
      setError(null);
      setBusy(false);
    }
  }, [open]);

  const submit = async (): Promise<void> => {
    const trimmed = name.trim();
    const problem = validateEntryName(trimmed, existingNames);
    if (problem !== null) {
      setError(problem);
      inputRef.current?.focus();
      return;
    }
    setBusy(true);
    try {
      await onSubmit(trimmed);
      onOpenChange(false);
    } catch (failure) {
      setError(failure instanceof Error ? failure.message : String(failure));
    } finally {
      setBusy(false);
    }
  };

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-sm bg-card text-card-foreground"
        data-testid="fm-new-folder-dialog"
      >
        <DialogHeader>
          <DialogTitle>{t.title}</DialogTitle>
          <DialogDescription className="truncate">{t.inFolder(destinationLabel)}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Input
            ref={inputRef}
            autoFocus
            value={name}
            aria-label={t.folderName}
            aria-invalid={error !== null}
            placeholder={t.placeholder}
            className={cn("h-9", error !== null && "border-surface-destructive-border")}
            onChange={(event) => {
              setName(event.target.value);
              setError(null);
            }}
          />
          {error === null ? null : (
            <p role="alert" className="mt-1.5 text-xs text-destructive">
              {error}
            </p>
          )}
          <DialogFooter className="mt-4 gap-2">
            <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
              {t.cancel}
            </Button>
            <Button
              type="submit"
              className="bg-primary text-primary-foreground hover:bg-primary/90"
              disabled={busy}
            >
              {t.create}
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
