// components/dialogs/PropertiesDialog.tsx — "Properties" (§8.10).
//
// Two shapes behind one dialog. A single target is described in full from
// `pathProperties`, which is one lstat and therefore safe to run on every
// open. Several selected rows get a summary the panel already has the data
// for — counting them costs no round trip at all.
//
// A folder's real size is the one expensive question here, so it stays behind
// a button: `directorySize` walks the subtree with hard limits and can answer
// "partial", which this renders as a lower bound rather than as a total. bb's
// RPC has no abort channel, so closing the dialog cannot call the walk off —
// it retires the ticket the answer would land on, and the walk's own time
// budget bounds what is left running.
import { useCallback, useEffect, useMemo, useRef, useState, type ReactNode } from "react";

import type { DirectorySize, EntryKind, FileEntry, PathProperties } from "../../contract";
import { parseRpcError } from "../../lib/errors";
import { rootPhrase } from "../../lib/fm-paths";
import { useFmRpc } from "../../lib/fm-rpc";
import {
  UNKNOWN,
  formatBytes,
  formatCount,
  formatDateTime,
  formatExactBytes,
} from "../../lib/format";
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

/**
 * What the dialog was opened on. The empty-space menu knows only a folder
 * path; the row menu hands over the listing rows it already has, which is what
 * lets a multi-row selection be summarised without asking the server.
 */
export type PropertiesTarget =
  | { kind: "path"; path: string }
  | { kind: "entries"; entries: readonly FileEntry[] };

export interface PropertiesDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  target: PropertiesTarget;
}

const KIND_LABELS: Readonly<Record<EntryKind, string>> = {
  file: "File",
  directory: "Folder",
  symlink: "Symbolic link",
  other: "Special file",
};

/** Why a walk stopped early, in words the dialog can put under a number. */
const STOP_REASONS: Readonly<Record<NonNullable<DirectorySize["stoppedBy"]>, string>> = {
  depth: "the tree is deeper than the walk goes",
  entries: "there are more entries than one walk counts",
  time: "the walk ran out of time",
};

/** "Folder", "File", "Symbolic link to folder". */
export function describeKind(properties: PathProperties): string {
  if (!properties.isSymlink) return KIND_LABELS[properties.kind];
  if (properties.targetKind === null) return "Symbolic link (unresolved)";
  return `Symbolic link to ${KIND_LABELS[properties.targetKind].toLowerCase()}`;
}

/** True for anything whose size means "its contents", i.e. needs the walk. */
export function needsSizeWalk(properties: PathProperties): boolean {
  if (properties.escapesRoot) return false;
  return properties.isSymlink
    ? properties.targetKind === "directory"
    : properties.kind === "directory";
}

export interface SelectionSummary {
  total: number;
  files: number;
  folders: number;
  others: number;
  /** Total of the sizes the listing already knows: plain files only. */
  knownBytes: number;
  /** True when something selected has no size the panel can add up. */
  hasUnmeasured: boolean;
}

/**
 * The multi-selection answer, straight off the rows on screen. Folders have no
 * size in a listing and a symlink's `sizeBytes` is the length of its target
 * string rather than of the file — so neither is added up, and `hasUnmeasured`
 * says the total is only about the plain files.
 */
export function summarizeEntries(entries: readonly FileEntry[]): SelectionSummary {
  let files = 0;
  let folders = 0;
  let others = 0;
  let knownBytes = 0;
  let hasUnmeasured = false;
  for (const entry of entries) {
    const kind = effectiveKind(entry);
    if (kind === "directory") {
      folders += 1;
      hasUnmeasured = true;
      continue;
    }
    if (kind === "file") {
      files += 1;
      if (entry.isSymlink) hasUnmeasured = true;
      else knownBytes += entry.sizeBytes;
      continue;
    }
    others += 1;
    hasUnmeasured = true;
  }
  return { total: entries.length, files, folders, others, knownBytes, hasUnmeasured };
}

function Row({
  id,
  label,
  value,
  title,
}: {
  id: string;
  label: string;
  value: ReactNode;
  title?: string;
}) {
  return (
    <div className="grid grid-cols-[6.5rem_minmax(0,1fr)] items-baseline gap-3 py-1">
      <dt className="text-xs text-muted-foreground">{label}</dt>
      <dd
        className="min-w-0 break-words text-xs text-foreground"
        data-testid={`fm-properties-${id}`}
        title={title}
      >
        {value}
      </dd>
    </div>
  );
}

export function PropertiesDialog({ open, onOpenChange, target }: PropertiesDialogProps) {
  const rpc = useFmRpc();

  /** The one path to describe, or null when this is a multi-row summary. */
  const singlePath = useMemo(() => {
    if (target.kind === "path") return target.path;
    return target.entries.length === 1 ? (target.entries[0]?.path ?? null) : null;
  }, [target]);
  const summary = useMemo(
    () => (target.kind === "entries" ? summarizeEntries(target.entries) : null),
    [target],
  );

  const [properties, setProperties] = useState<PathProperties | null>(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const [size, setSize] = useState<DirectorySize | null>(null);
  const [sizeBusy, setSizeBusy] = useState(false);
  const [sizeError, setSizeError] = useState<string | null>(null);

  /**
   * The only cancellation available. Every answer carries the ticket it was
   * asked under; opening on another path, or closing, retires it, so a reply
   * that arrives late — a `directorySize` walk in particular — lands on
   * nothing instead of repainting a dialog about a different file.
   */
  const ticketRef = useRef(0);

  useEffect(() => {
    ticketRef.current += 1;
    const ticket = ticketRef.current;
    setProperties(null);
    setError(null);
    setSize(null);
    setSizeError(null);
    setSizeBusy(false);

    if (!open || singlePath === null) {
      setLoading(false);
      return undefined;
    }

    setLoading(true);
    void (async () => {
      try {
        const result = await rpc.call("pathProperties", { path: singlePath });
        if (ticketRef.current !== ticket) return;
        setProperties(result);
      } catch (failure) {
        if (ticketRef.current !== ticket) return;
        setError(parseRpcError(failure).message);
      } finally {
        if (ticketRef.current === ticket) setLoading(false);
      }
    })();

    return () => {
      ticketRef.current += 1;
    };
  }, [open, rpc, singlePath]);

  const calculateSize = useCallback(() => {
    if (singlePath === null) return;
    const ticket = ticketRef.current;
    setSizeBusy(true);
    setSizeError(null);
    void (async () => {
      try {
        const result = await rpc.call("directorySize", { path: singlePath });
        if (ticketRef.current !== ticket) return;
        setSize(result);
      } catch (failure) {
        if (ticketRef.current !== ticket) return;
        setSizeError(parseRpcError(failure).message);
      } finally {
        if (ticketRef.current === ticket) setSizeBusy(false);
      }
    })();
  }, [rpc, singlePath]);

  const heading =
    singlePath === null
      ? `${String(summary?.total ?? 0)} items`
      : (properties?.name ?? singlePath.split("/").pop() ?? singlePath);

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-md bg-card text-card-foreground"
        data-testid="fm-properties-dialog"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon name="Info" className="size-4" aria-hidden="true" />
            Properties
          </DialogTitle>
          <DialogDescription className="truncate">{heading}</DialogDescription>
        </DialogHeader>

        {singlePath === null && summary !== null ? (
          <dl className="divide-y divide-border">
            <Row id="selection" label="Selection" value={formatCount(summary.total, "item")} />
            <Row
              id="files"
              label="Files"
              value={`${String(summary.files)}${summary.others > 0 ? ` (+${String(summary.others)} special)` : ""}`}
            />
            <Row id="folders" label="Folders" value={String(summary.folders)} />
            <Row
              id="size"
              label="Size"
              value={formatBytes(summary.knownBytes)}
              title={formatExactBytes(summary.knownBytes)}
            />
          </dl>
        ) : null}

        {singlePath === null && summary?.hasUnmeasured === true ? (
          <p className="text-xs text-muted-foreground">
            Folders and links are not measured here — the total covers the selected files. Open a
            folder on its own to calculate its size.
          </p>
        ) : null}

        {loading ? (
          <p className="flex items-center gap-2 text-xs text-muted-foreground">
            <Icon name="Loading" className="size-4 animate-spin" aria-hidden="true" />
            Reading…
          </p>
        ) : null}

        {error === null ? null : (
          <p role="alert" className="text-xs text-destructive">
            {error}
          </p>
        )}

        {properties === null ? null : (
          <>
            <dl className="max-h-[50vh] divide-y divide-border overflow-y-auto">
              <Row id="name" label="Name" value={properties.name} />
              <Row id="kind" label="Kind" value={describeKind(properties)} />
              {properties.contentType === null ? null : (
                <Row id="type" label="Type" value={properties.contentType} />
              )}
              <Row
                id="location"
                label="Location"
                value={properties.parentPath ?? rootPhrase()}
                title={properties.path}
              />
              {needsSizeWalk(properties) ? (
                <Row
                  id="size"
                  label="Size"
                  value={
                    size === null ? (
                      <Button
                        type="button"
                        variant="outline"
                        size="sm"
                        disabled={sizeBusy}
                        onClick={calculateSize}
                        data-testid="fm-properties-calculate"
                      >
                        {sizeBusy ? (
                          <>
                            <Icon
                              name="Loading"
                              className="size-4 animate-spin"
                              aria-hidden="true"
                            />
                            Calculating…
                          </>
                        ) : (
                          "Calculate size"
                        )}
                      </Button>
                    ) : (
                      <span title={formatExactBytes(size.sizeBytes)}>
                        {size.partial ? "over " : ""}
                        {formatBytes(size.sizeBytes)}
                        <span className="text-muted-foreground">
                          {" · "}
                          {formatCount(size.fileCount, "file")} in{" "}
                          {formatCount(size.directoryCount, "folder")}
                        </span>
                      </span>
                    )
                  }
                />
              ) : (
                <Row
                  id="size"
                  label="Size"
                  value={formatBytes(properties.sizeBytes)}
                  title={formatExactBytes(properties.sizeBytes)}
                />
              )}
              {properties.isSymlink ? (
                <Row id="target" label="Target" value={properties.linkTarget ?? UNKNOWN} />
              ) : null}
              {properties.isSymlink && properties.linkTargetPath !== null ? (
                <Row id="resolved" label="Resolves to" value={properties.linkTargetPath} />
              ) : null}
              <Row id="modified" label="Modified" value={formatDateTime(properties.modifiedAtMs)} />
              <Row
                id="created"
                label="Created"
                value={
                  properties.createdAtMs === null ? UNKNOWN : formatDateTime(properties.createdAtMs)
                }
              />
              <Row id="accessed" label="Accessed" value={formatDateTime(properties.accessedAtMs)} />
              <Row
                id="permissions"
                label="Permissions"
                value={
                  <span className="font-mono">
                    {properties.modeText} ({properties.modeOctal})
                  </span>
                }
              />
              <Row
                id="owner"
                label="Owner"
                value={
                  properties.ownerName === null
                    ? `uid ${String(properties.ownerUid)}, gid ${String(properties.ownerGid)}`
                    : `${properties.ownerName} (uid ${String(properties.ownerUid)}, gid ${String(properties.ownerGid)})`
                }
              />
              <Row id="links" label="Links" value={String(properties.linkCount)} />
            </dl>

            {sizeError === null ? null : (
              <p role="alert" className="text-xs text-destructive">
                {sizeError}
              </p>
            )}

            {size?.partial === true ? (
              <p
                className="rounded-md bg-surface-attention px-2 py-1.5 text-xs text-warning-text"
                data-testid="fm-properties-partial"
              >
                Partial result — {STOP_REASONS[size.stoppedBy ?? "time"]}. The real total is larger
                than the number above.
              </p>
            ) : null}

            {properties.escapesRoot ? (
              <p className="rounded-md bg-surface-attention px-2 py-1.5 text-xs text-warning-text">
                This link leaves {rootPhrase()}, so the panel cannot follow it.
              </p>
            ) : null}
          </>
        )}

        <DialogFooter>
          <Button type="button" variant="outline" onClick={() => onOpenChange(false)}>
            Close
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
