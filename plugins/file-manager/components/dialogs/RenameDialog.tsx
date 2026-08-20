// components/dialogs/RenameDialog.tsx — single-entry rename (F2).
//
// Pre-selects the stem and leaves the extension alone, the way every OS file
// manager does; `splitFileName` knows about the two-part archive suffixes.
import { useEffect, useRef, useState } from "react";

import type { FileEntry } from "../../contract";
import { splitFileName } from "../../lib/fm-paths";
import { cn } from "../../lib/utils";
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
import { validateEntryName } from "./NewFolderDialog";

export interface RenameDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entry: FileEntry | null;
  /** Sibling names, for the inline "already exists" check. */
  existingNames?: ReadonlySet<string>;
  onSubmit: (entry: FileEntry, newName: string) => Promise<void>;
}

export function RenameDialog({
  open,
  onOpenChange,
  entry,
  existingNames,
  onSubmit,
}: RenameDialogProps) {
  const [name, setName] = useState("");
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open || entry === null) return undefined;
    setName(entry.name);
    setError(null);
    setBusy(false);
    const { stem } = splitFileName(entry.name);
    // The input mounts with the dialog; select after Radix's own focus pass.
    const timer = setTimeout(() => {
      const node = inputRef.current;
      if (node === null) return;
      node.focus();
      node.setSelectionRange(0, stem.length);
    }, 0);
    return () => {
      clearTimeout(timer);
    };
  }, [open, entry]);

  if (entry === null) return null;

  const siblings =
    existingNames === undefined
      ? undefined
      : new Set([...existingNames].filter((candidate) => candidate !== entry.name));

  const submit = async (): Promise<void> => {
    const trimmed = name.trim();
    if (trimmed === entry.name) {
      onOpenChange(false);
      return;
    }
    const problem = validateEntryName(trimmed, siblings);
    if (problem !== null) {
      setError(problem);
      return;
    }
    setBusy(true);
    try {
      await onSubmit(entry, trimmed);
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
        data-testid="fm-rename-dialog"
      >
        <DialogHeader>
          <DialogTitle>Rename</DialogTitle>
          <DialogDescription className="truncate">{entry.name}</DialogDescription>
        </DialogHeader>
        <form
          onSubmit={(event) => {
            event.preventDefault();
            void submit();
          }}
        >
          <Input
            ref={inputRef}
            value={name}
            aria-label="New name"
            aria-invalid={error !== null}
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
              Rename
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
