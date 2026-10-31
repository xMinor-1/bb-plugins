// components/dialogs/ConfirmDeleteDialog.tsx
//
// Shown only when the `confirmOnDelete` setting is on (§7.1); the panel calls
// `deleteEntries` directly otherwise. Deleting a symlink removes the link, not
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
import { defineMessages, pluralRu, useMessages } from "../../lib/i18n";

const messages = defineMessages(
  {
    deleteOne: (name: string) => `Delete “${name}”?`,
    deleteMany: (count: number) => `Delete ${String(count)} items?`,
    noUndo: "This cannot be undone — there is no trash in this plugin.",
    more: (count: number) => `and ${String(count)} more…`,
    folders: (count: number) =>
      `${count === 1 ? "One folder" : `${String(count)} folders`} will be deleted with all of their contents.`,
    links: (count: number) =>
      `${count === 1 ? "One symbolic link" : `${String(count)} symbolic links`} will be removed; the files they point at are left alone.`,
    cancel: "Cancel",
    delete: "Delete",
  },
  {
    deleteOne: (name) => `Удалить «${name}»?`,
    deleteMany: (count) =>
      `Удалить ${String(count)} ${pluralRu(count, ["элемент", "элемента", "элементов"])}?`,
    noUndo: "Это не отменить — корзины у этого плагина нет.",
    more: (count) => `и ещё ${String(count)}…`,
    folders: (count) =>
      count === 1
        ? "Папка будет удалена вместе со всем содержимым."
        : `${String(count)} ${pluralRu(count, ["папка будет удалена", "папки будут удалены", "папок будут удалены"])} вместе со всем содержимым.`,
    links: (count) =>
      count === 1
        ? "Символическая ссылка будет удалена; файлы, на которые она указывает, останутся."
        : `${String(count)} ${pluralRu(count, ["символическая ссылка будет удалена", "символические ссылки будут удалены", "символических ссылок будут удалены"])}; файлы, на которые они указывают, останутся.`,
    cancel: "Отмена",
    delete: "Удалить",
  },
);

export interface ConfirmDeleteDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  entries: readonly FileEntry[];
  onConfirm: (entries: readonly FileEntry[]) => Promise<void>;
}

export function ConfirmDeleteDialog({
  open,
  onOpenChange,
  entries,
  onConfirm,
}: ConfirmDeleteDialogProps) {
  const t = useMessages(messages);
  const [busy, setBusy] = useState(false);
  useEffect(() => {
    if (open) setBusy(false);
  }, [open]);

  if (entries.length === 0) return null;

  const first = entries[0];
  const folders = entries.filter((entry) => effectiveKind(entry) === "directory").length;
  const links = entries.filter((entry) => entry.isSymlink).length;
  const title =
    entries.length === 1 && first !== undefined
      ? t.deleteOne(first.name)
      : t.deleteMany(entries.length);

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
            {t.noUndo}
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
                {t.more(entries.length - 50)}
              </li>
            ) : null}
          </ul>
        ) : null}

        {folders > 0 ? (
          <p className="rounded-md bg-surface-attention px-2 py-1.5 text-xs text-warning-text">
            {t.folders(folders)}
          </p>
        ) : null}
        {links > 0 ? (
          <p className="text-xs text-muted-foreground">
            {t.links(links)}
          </p>
        ) : null}

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            {t.cancel}
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
            {t.delete}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
