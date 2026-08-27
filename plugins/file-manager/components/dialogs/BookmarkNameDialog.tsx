// components/dialogs/BookmarkNameDialog.tsx — renaming a bookmark (§8.11).
//
// A separate dialog from `RenameDialog` on purpose: that one renames a file on
// disk and mirrors `validateName` (§6) byte for byte, while this renames a
// *label* that never reaches the filesystem. Sharing the component would mean
// sharing the 255-byte rule, the "name is taken" check and the extension-aware
// pre-selection, none of which are true here.
import { useEffect, useRef, useState } from "react";

import { MAX_BOOKMARK_NAME_LENGTH } from "../../contract";
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

const CONTROL_CHARACTERS = /[\u0000-\u001f]/u;

/** Client mirror of `src/bookmarks.ts#validateBookmarkName`. */
export function validateBookmarkName(name: string): string | null {
  if (name === "") return "Enter a name.";
  if (CONTROL_CHARACTERS.test(name)) return "A name cannot contain control characters.";
  // Code points, like the server: this label never becomes a file name, so a
  // byte budget would only punish names that are not written in Latin.
  if ([...name].length > MAX_BOOKMARK_NAME_LENGTH) {
    return `That name is too long (max ${String(MAX_BOOKMARK_NAME_LENGTH)} characters).`;
  }
  return null;
}

export interface BookmarkNameDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The name the bookmark has now; the field opens on it, selected. */
  initialName: string;
  /** Absolute folder the bookmark points at; shown as context. */
  pathLabel: string;
  onSubmit: (name: string) => Promise<void>;
}

export function BookmarkNameDialog({
  open,
  onOpenChange,
  initialName,
  pathLabel,
  onSubmit,
}: BookmarkNameDialogProps) {
  const [name, setName] = useState(initialName);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    if (!open) return;
    setName(initialName);
    setError(null);
    setBusy(false);
  }, [open, initialName]);

  const submit = async (): Promise<void> => {
    const trimmed = name.trim();
    const problem = validateBookmarkName(trimmed);
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
        data-testid="fm-bookmark-name-dialog"
      >
        <DialogHeader>
          <DialogTitle>Rename bookmark</DialogTitle>
          <DialogDescription className="truncate">{pathLabel}</DialogDescription>
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
            aria-label="Bookmark name"
            aria-invalid={error !== null}
            className={cn("h-9", error !== null && "border-surface-destructive-border")}
            onFocus={(event) => event.currentTarget.select()}
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
              Save
            </Button>
          </DialogFooter>
        </form>
      </DialogContent>
    </Dialog>
  );
}
