// components/dialogs/FilePickerDialog.tsx — browse to one file and pick it.
//
// A sibling of FolderPickerDialog rather than a mode inside it. The folder
// picker answers "which folder am I standing in", so its rows are folders, its
// confirm button returns the *current* path and it has no notion of a
// selection; a file picker needs file rows, a selection that survives a
// navigation, and a confirm that is disabled until something is chosen.
//
// The selection is a *set*, because a question for an agent is rarely about
// one file. Rows carry a checkbox, `Shift` takes the run between the last row
// touched and this one, and the set keeps files picked in other folders — the
// footer counts them so nothing chosen two folders ago goes out silently.
// Folding both into one component would mean two behaviours behind a flag with
// half the props ignored on either side — so the browsing shell is shared by
// copy and each dialog stays readable on its own.
//
// The root is a prop, not `getClientRoot()`: this dialog opens from the
// composer, on surfaces where the panel may never have mounted and so may
// never have published the backend's root (§8.8).
import { useCallback, useEffect, useMemo, useRef, useState, type MouseEvent } from "react";

import { type FileEntry } from "../../contract";
import { parseRpcError } from "../../lib/errors";
import { breadcrumbs, joinPath, parentPath } from "../../lib/fm-paths";
import { formatBytes, formatModified } from "../../lib/format";
import { useFmRpc } from "../../lib/fm-rpc";
import { cn } from "../../lib/utils";
import { Button } from "../ui/button";
import { Checkbox } from "../ui/checkbox";
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
  /** Called once, with every file the user confirmed, in the order picked. */
  onChoose: (entries: readonly FileEntry[]) => void;
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
  /**
   * Keyed by absolute path and ordered by when it was picked: a Map keeps both
   * without a second structure, and insertion order is the order the mentions
   * go into the draft — the order the user built, not the order the folder
   * happened to list.
   */
  const [selected, setSelected] = useState<Map<string, FileEntry>>(new Map());
  /** Where a `Shift` run starts: the last row the user touched, or null. */
  const [anchorPath, setAnchorPath] = useState<string | null>(null);
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
    setSelected(new Map());
    setAnchorPath(null);
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
    (chosen: readonly FileEntry[]) => {
      if (chosenRef.current || chosen.length === 0) return;
      chosenRef.current = true;
      onChoose(chosen);
      onOpenChange(false);
    },
    [onChoose, onOpenChange],
  );

  const up = parentPath(path, root);
  const crumbs = breadcrumbs(path, root, "Home");
  const folders = entries.filter((entry) => effectiveKind(entry) === "directory");
  const files = entries.filter((entry) => effectiveKind(entry) === "file");

  const selectedList = useMemo(() => [...selected.values()], [selected]);
  const selectedBytes = selectedList.reduce((total, entry) => total + entry.sizeBytes, 0);
  const selectedHere = files.filter((file) => selected.has(file.path)).length;
  const allHereSelected = files.length > 0 && selectedHere === files.length;

  /**
   * One rule for every row click, because the three gestures differ only in
   * which rows they touch: `Shift` takes the run from the anchor to this row
   * and turns it on (extending a selection never clears it — losing a
   * ten-file pick to a stray shift-click would be the worst outcome here),
   * anything else toggles this row alone. The anchor follows the last row
   * touched, so a second `Shift` click re-runs from where the user last was.
   */
  const toggleRow = useCallback(
    (file: FileEntry, event?: MouseEvent) => {
      const shift = event?.shiftKey === true;
      setSelected((previous) => {
        const next = new Map(previous);
        if (shift && anchorPath !== null) {
          const from = files.findIndex((candidate) => candidate.path === anchorPath);
          const to = files.findIndex((candidate) => candidate.path === file.path);
          if (from !== -1 && to !== -1) {
            const [start, end] = from <= to ? [from, to] : [to, from];
            for (const entry of files.slice(start, end + 1)) next.set(entry.path, entry);
            return next;
          }
        }
        if (next.has(file.path)) next.delete(file.path);
        else next.set(file.path, file);
        return next;
      });
      setAnchorPath(file.path);
    },
    [anchorPath, files],
  );

  /** Folder-wide toggle: everything here on, or everything here off. */
  const toggleAllHere = useCallback(() => {
    setSelected((previous) => {
      const next = new Map(previous);
      if (files.every((file) => next.has(file.path))) {
        for (const file of files) next.delete(file.path);
      } else {
        for (const file of files) next.set(file.path, file);
      }
      return next;
    });
    setAnchorPath(null);
  }, [files]);

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

        {files.length === 0 ? null : (
          <label className="flex items-center gap-2 text-xs text-muted-foreground">
            <Checkbox
              checked={allHereSelected}
              aria-label="Select every file in this folder"
              data-testid="fm-picker-select-all"
              onCheckedChange={toggleAllHere}
            />
            {allHereSelected ? "Clear this folder" : "Select every file here"}
          </label>
        )}

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
            const isSelected = selected.has(file.path);
            return (
              <div
                key={file.path}
                data-testid="fm-picker-file"
                data-selected={isSelected ? "true" : undefined}
                className={cn(
                  "flex h-9 w-full items-center gap-2 px-3 text-left text-sm hover:bg-state-hover",
                  isSelected && "bg-surface-selected hover:bg-surface-selected",
                )}
              >
                {/* The checkbox is a real control rather than a drawn glyph, so
                    the row is reachable and reads correctly to a screen reader;
                    the button beside it carries the same toggle for a click
                    anywhere on the row, `Shift` included. */}
                <Checkbox
                  checked={isSelected}
                  aria-label={`Select ${file.name}`}
                  data-testid="fm-picker-check"
                  onClick={(event) => toggleRow(file, event)}
                  // Radix fires onCheckedChange for keyboard activation too,
                  // where there is no mouse event and so no Shift to read.
                  onCheckedChange={() => undefined}
                />
                <button
                  type="button"
                  aria-pressed={isSelected}
                  className="flex min-w-0 flex-1 items-center gap-2 text-left"
                  onClick={(event) => toggleRow(file, event)}
                  // The shortcut every file browser has: a double-click is the
                  // pick. It takes the whole selection, this row included —
                  // dropping the rest would silently undo the work of picking.
                  onDoubleClick={() => {
                    const chosen = new Map(selected);
                    chosen.set(file.path, file);
                    confirm([...chosen.values()]);
                  }}
                >
                  <Icon
                    name="File"
                    className="size-4 shrink-0 text-muted-foreground"
                    aria-hidden="true"
                  />
                  <span className="truncate">{file.name}</span>
                  <span className="ml-auto shrink-0 text-xs text-muted-foreground">
                    {formatBytes(file.sizeBytes)}
                  </span>
                </button>
              </div>
            );
          })}
        </div>

        {/* One line that answers "what am I about to send", including files
            picked in a folder that is no longer on screen. */}
        <p
          className="truncate text-xs text-muted-foreground"
          data-testid="fm-picker-summary"
          title={selectedList.map((entry) => entry.path).join("\n") || path}
        >
          {selectedList.length === 0
            ? path
            : selectedList.length === 1 && selectedList[0] !== undefined
              ? `${selectedList[0].name} — ${formatBytes(selectedList[0].sizeBytes)}, ${formatModified(selectedList[0].modifiedAtMs)}`
              : `${String(selectedList.length)} files selected — ${formatBytes(selectedBytes)}`}
        </p>

        <DialogFooter className="gap-2">
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Cancel
          </Button>
          <Button
            type="button"
            className="bg-primary text-primary-foreground hover:bg-primary/90"
            disabled={selectedList.length === 0}
            data-testid="fm-picker-confirm"
            onClick={() => confirm(selectedList)}
          >
            {selectedList.length > 1
              ? `${confirmLabel} (${String(selectedList.length)})`
              : confirmLabel}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
