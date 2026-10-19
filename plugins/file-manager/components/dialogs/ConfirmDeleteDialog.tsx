// components/dialogs/ConfirmDeleteDialog.tsx
//
// Shown when the `confirmOnDelete` setting is on (§7.1), and always when
// `permanentDelete` is on; the panel calls `deleteEntries` directly otherwise.
// By default delete moves items to the Trash, so the wording says so. Deleting a symlink removes the link, not
// its target (§6 rule 2) — worth saying out loud, because it is the one case
// where "delete" does less than it looks like it does.
import { useEffect, useState } from "react";

import type { FileEntry } from "../../contract";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Icon } from "../ui/icon";
import { effectiveKind } from "../FileRow";

export interface ConfirmDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entries: readonly FileEntry[];
  onConfirm: (entries: readonly FileEntry[]) => Promise<void>;
  /** The `permanentDelete` setting: true removes for good instead of trashing. */
  permanent?: boolean;
}

export function ConfirmDeleteDialog({
  open,
  onOpenChange,
  entries,
  onConfirm,
  permanent = false,
}: ConfirmDeleteDialogProps) {
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setBusy(false);
  }, [open]);

  if (entries.length === 0) return null;

  const first = entries[0];
  const folders = entries.filter((entry) => effectiveKind(entry) === "directory").length;
  const links = entries.filter((entry) => entry.isSymlink).length;
  const subject =
    entries.length === 1 && first !== undefined
      ? `“${first.name}”`
      : `${String(entries.length)} items`;
  const title = permanent ? `Delete ${subject} permanently?` : `Move ${subject} to Trash?`;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-sm bg-card text-card-foreground"
        data-testid="fm-delete-dialog"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon name="Trash2" className="size-4 text-destructive" aria-hidden="true" />
            {title}
          </DialogTitle>
          <DialogDescription>
            {permanent
              ? "This cannot be undone — permanent delete is on, so nothing goes to the Trash."
              : "You can restore them from the Trash."}
          </DialogDescription>
        </DialogHeader>

        {entries.length > 1 ? (
          <ul className="max-h-40 overflow-y-auto rounded-md border border-border bg-surface-recessed p-2 text-xs">
            {entries.slice(0, 50).map((entry) => (
              <li key={entry.path} className="truncate py-0.5 text-muted-foreground">
                {entry.name}
              </li>
            ))}
            {entries.length > 50 ? (
              <li className="py-0.5 text-muted-foreground">
                and {String(entries.length - 50)} more…
              </li>
            ) : null}
          </ul>
        ) : null}

        {folders > 0 ? (
          <p className="rounded-md bg-surface-attention px-2 py-1.5 text-xs text-warning-text">
            {folders === 1 ? "One folder" : `${String(folders)} folders`} will be{" "}
            {permanent ? "deleted" : "moved to the Trash"} with all of their contents.
          </p>
        ) : null}
        {links > 0 ? (
          <p className="text-xs text-muted-foreground">
            {links === 1 ? "One symbolic link" : `${String(links)} symbolic links`} will be{" "}
            {permanent ? "removed" : "moved to the Trash"}; the files they point at are left alone.
          </p>
        ) : null}

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            variant="destructive"
            disabled={busy}
            onClick={() => {
              setBusy(true);
              void (async () => {
                try {
                  await onConfirm(entries);
                  onOpenChange(false);
                } finally {
                  setBusy(false);
                }
              })();
            }}
          >
            {permanent ? "Delete permanently" : "Move to Trash"}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
