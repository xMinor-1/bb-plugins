// components/dialogs/FilePickerDialog.tsx — browse to one file and pick it.
//
// A sibling of FolderPickerDialog rather than a mode inside it. The folder
// picker answers "which folder am I standing in", so its rows are folders, its
// confirm button returns the *current* path and it has no notion of a
// selection; a file picker needs file rows, a selected row that survives a
// navigation, and a confirm that is disabled until something is chosen.
// Folding both into one component would mean two behaviours behind a flag with
// half the props ignored on either side — so the browsing shell is shared by
// copy and each dialog stays readable on its own.
//
// The root is a prop, not `getClientRoot()`: this dialog opens from the
// composer, on surfaces where the panel may never have mounted and so may
// never have published the backend's root (§8.8).
import { useCallback, useEffect, useRef, useState } from "react";

import { type FileEntry } from "../../contract";
import { parseRpcError } from "../../lib/errors";
import { breadcrumbs, joinPath, parentPath } from "../../lib/fm-paths";
import { formatBytes, formatModified } from "../../lib/format";
import { useFmRpc } from "../../lib/fm-rpc";
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
import { Icon } from "../ui/icon";
import { effectiveKind } from "../FileRow";

export interface FilePickerDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  title: string;
  description?: string;
  /** The hard root, from the backend bootstrap. Browsing never leaves it. */
  root: string;
  /** Where the browser starts; defaults to the root. */
  initialPath?: string;
  confirmLabel?: string;
  /** Called once, with the file the user confirmed. */
  onChoose: (entry: FileEntry) => void;
}

export function FilePickerDialog({
  open,
  onOpenChange,
  title,
  description,
  root,
  initialPath,
  confirmLabel = "Add to chat",
  onChoose,
}: FilePickerDialogProps) {
  const rpc = useFmRpc();
  const [path, setPath] = useState(initialPath ?? root);
  const [entries, setEntries] = useState<FileEntry[]>([]);
  const [selected, setSelected] = useState<FileEntry | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  /**
   * One choice per opening. Closing plays an exit animation, so the confirm
   * button lives on for a few hundred milliseconds — long enough for an
   * impatient second click to insert the same mention twice.
   */
  const chosenRef = useRef(false);

  useEffect(() => {
    if (!open) return;
    setPath(initialPath ?? root);
    setSelected(null);
    setError(null);
    chosenRef.current = false;
  }, [open, initialPath, root]);

  const load = useCallback(
    async (target: string): Promise<void> => {
      setLoading(true);
      try {
        // Hidden files stay hidden here: this dialog has no toggle of its own,
        // and the panel's is a different surface's preference.
        const result = await rpc.call("listDir", { path: target, showHidden: false });
        setEntries(result.entries.filter((entry) => !entry.escapesRoot));
        setError(null);
      } catch (failure) {
        setError(parseRpcError(failure).message);
        setEntries([]);
      } finally {
        setLoading(false);
      }
    },
    [rpc],
  );

  useEffect(() => {
    if (!open) return;
    void load(path);
  }, [open, path, load]);

  const confirm = useCallback(
    (entry: FileEntry) => {
      if (chosenRef.current) return;
      chosenRef.current = true;
      onChoose(entry);
      onOpenChange(false);
    },
    [onChoose, onOpenChange],
  );

  const up = parentPath(path, root);
  const crumbs = breadcrumbs(path, root, "Home");
  const folders = entries.filter((entry) => effectiveKind(entry) === "directory");
  const files = entries.filter((entry) => effectiveKind(entry) === "file");

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="max-w-md bg-card text-card-foreground" data-testid="fm-file-picker">
        <DialogHeader>
          <DialogTitle>{title}</DialogTitle>
          {description === undefined ? null : <DialogDescription>{description}</DialogDescription>}
        </DialogHeader>

        <nav aria-label="Breadcrumb" className="flex items-center gap-0.5 overflow-x-auto">
          {crumbs.map((crumb, index) => (
            <div key={crumb.path} className="flex shrink-0 items-center gap-0.5">
              {index === 0 ? null : (
                <Icon name="ChevronRight" className="size-3 text-muted-foreground" aria-hidden="true" />
              )}
              <button
                type="button"
                className="rounded-md px-1 py-0.5 text-xs text-muted-foreground hover:bg-state-hover hover:text-foreground"
                onClick={() => setPath(crumb.path)}
              >
                {crumb.name}
              </button>
            </div>
          ))}
        </nav>

        <div className="h-56 overflow-y-auto rounded-md border border-border bg-surface-recessed">
          {up === null ? null : (
            <button
              type="button"
              className="flex h-9 w-full items-center gap-2 px-3 text-sm text-muted-foreground hover:bg-state-hover"
              onClick={() => setPath(up)}
            >
              <Icon name="FolderOpen" className="size-4" aria-hidden="true" />
              ..
            </button>
          )}
          {loading && entries.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">Loading…</p>
          ) : null}
          {error !== null ? (
            <p role="alert" className="px-3 py-2 text-xs text-destructive">
              {error}
            </p>
          ) : null}
          {!loading && error === null && entries.length === 0 ? (
            <p className="px-3 py-2 text-xs text-muted-foreground">This folder is empty.</p>
          ) : null}

          {folders.map((folder) => (
            <button
              key={folder.path}
              type="button"
              data-testid="fm-picker-folder"
              className="flex h-9 w-full items-center gap-2 px-3 text-left text-sm hover:bg-state-hover"
              onClick={() => setPath(joinPath(path, folder.name))}
            >
              <Icon name="Folder" className="size-4 shrink-0" aria-hidden="true" />
              <span className="truncate">{folder.name}</span>
            </button>
          ))}

          {files.map((file) => {
            const isSelected = selected?.path === file.path;
            return (
              <button
                key={file.path}
                type="button"
                data-testid="fm-picker-file"
                data-selected={isSelected ? "true" : undefined}
                aria-pressed={isSelected}
                className={cn(
                  "flex h-9 w-full items-center gap-2 px-3 text-left text-sm hover:bg-state-hover",
                  isSelected && "bg-surface-selected hover:bg-surface-selected",
                )}
                onClick={() => setSelected(file)}
                // The shortcut every file browser has: a double-click is the
                // pick, not just the selection.
                onDoubleClick={() => confirm(file)}
              >
                <Icon name="File" className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
                <span className="truncate">{file.name}</span>
                <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                  {formatBytes(file.sizeBytes)}
                </span>
              </button>
            );
          })}
        </div>

        <p className="truncate text-xs text-muted-foreground" title={selected?.path ?? path}>
          {selected === null
            ? path
            : `${selected.name} — ${formatBytes(selected.sizeBytes)}, ${formatModified(selected.modifiedAtMs)}`}
        </p>

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            className="bg-primary text-primary-foreground hover:bg-primary/90"
            disabled={selected === null}
            onClick={() => {
              if (selected !== null) confirm(selected);
            }}
          >
            {confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
