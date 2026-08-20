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

const CONTROL_CHARACTERS = /[\u0000-\u001f]/u;

/** Client mirror of `src/root.ts#validateName`; returns null when the name is fine. */
export function validateEntryName(name: string, taken?: ReadonlySet<string>): string | null {
  if (name === "") return "Enter a name.";
  if (name === "." || name === "..") return "That name is reserved.";
  if (name.includes("/")) return "A name cannot contain a slash.";
  if (CONTROL_CHARACTERS.test(name)) return "A name cannot contain control characters.";
  if (new TextEncoder().encode(name).length > 255) return "That name is too long (max 255 bytes).";
  if (taken?.has(name) === true) return "An item with that name already exists.";
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
          <DialogTitle>New folder</DialogTitle>
          <DialogDescription className="truncate">in {destinationLabel}</DialogDescription>
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
            aria-label="Folder name"
            aria-invalid={error !== null}
            placeholder="untitled folder"
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
              Cancel
            </Button>
            <Button
              type="submit"
              className="bg-primary text-primary-foreground hover:bg-primary/90"
              disabled={busy}
            >
              Create
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
