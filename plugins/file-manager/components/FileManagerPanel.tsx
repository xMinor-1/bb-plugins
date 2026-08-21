// components/FileManagerPanel.tsx — the panel root: layout, state ownership,
// the keyboard map and the drag&drop surface (§8.1–§8.5, §9).
//
// Everything that can fail is caught here. A throw inside a slot component
// disables the plugin's whole UI until `bb plugin reload`, so every RPC
// rejection ends in a toast or an ErrorBanner, never in an exception.
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type DragEvent as ReactDragEvent,
  type KeyboardEvent as ReactKeyboardEvent,
  type MouseEvent as ReactMouseEvent,
} from "react";
import { useBbNavigate, type PluginNavPanelProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";

import { PANEL_PATH, type FileEntry } from "../contract";
import { useClipboard } from "../hooks/useClipboard";
import { useDirectory, type SortDirection, type SortField } from "../hooks/useDirectory";
import { useJobs } from "../hooks/useJobs";
import { useSelection } from "../hooks/useSelection";
import { useTree, type UseTreeResult } from "../hooks/useTree";
import { useUploads } from "../hooks/useUploads";
import { downloadEntry, downloadPaths } from "../lib/download";
import { batchFailureText, errorToastText, parseRpcError, type BatchFailure } from "../lib/errors";
import {
  absoluteToSubPath,
  dirname,
  getClientRoot,
  isSameOrDescendant,
  isSamePath,
  parentPath as parentOf,
  setClientRoot,
  subPathToAbsolute,
} from "../lib/fm-paths";
import {
  AUTO_EXPAND_HOVER_MS,
  MAX_TREE_ROWS,
  topLevelPaths,
  type TreeEntryRow,
} from "../lib/fm-tree";
import { useFmRpc, type RpcOutput } from "../lib/fm-rpc";
import {
  saveStartFolder,
  START_FOLDER_SAVED_TEXT,
  START_FOLDER_SAVE_FAILED_TEXT,
} from "../lib/start-folder";
import type { UploadRequest } from "../lib/upload-manager";
import { ActivityTray } from "./ActivityTray";
import { BackgroundContextMenu } from "./BackgroundContextMenu";
import { EmptyState, type EmptyStateKind } from "./EmptyState";
import { ErrorBanner } from "./ErrorBanner";
import { effectiveKind } from "./FileRow";
import { FileTable } from "./FileTable";
import { RowContextMenu } from "./RowContextMenu";
import { Toolbar } from "./Toolbar";
import { ConfirmDeleteDialog } from "./dialogs/ConfirmDeleteDialog";
import { ConflictDialog, type ConflictChoice } from "./dialogs/ConflictDialog";
import { ExtractDialog, isFormatSupported, type ExtractSubmission } from "./dialogs/ExtractDialog";
import { FolderPickerDialog } from "./dialogs/FolderPickerDialog";
import { NewFolderDialog } from "./dialogs/NewFolderDialog";
import { RenameDialog } from "./dialogs/RenameDialog";
import { ContextMenu, ContextMenuTrigger } from "./ui/context-menu";
import { publishPanelSnapshot, resetPanelSnapshot, subscribePanelCommands } from "./panel-bus";

type GetState = RpcOutput<"getState">;
type BatchResult = RpcOutput<"moveEntries">;

/** Private drag flavour; `text/plain` carries the same paths as a fallback. */
const DRAG_MIME = "application/x-bb-file-manager";

const DEFAULT_ARCHIVE_SUPPORT = { zip: false, tar: false, sevenZip: false };

type DialogState =
  | { kind: "none" }
  | { kind: "new-folder" }
  | { kind: "rename"; entry: FileEntry }
  | { kind: "delete"; entries: FileEntry[] }
  | { kind: "extract"; entry: FileEntry }
  | { kind: "picker"; mode: "move" | "copy"; paths: string[] }
  | {
      kind: "conflict";
      operation: "move" | "copy";
      destinationDir: string;
      paths: string[];
      conflicts: BatchFailure[];
    };

/* ------------------------------------------------------------------ */
/* Drag & drop helpers                                                 */
/* ------------------------------------------------------------------ */

function isExternalDrag(event: ReactDragEvent<HTMLElement>): boolean {
  // `dataTransfer` is always there in a browser, but a throw inside an event
  // handler takes the plugin's whole UI down with it — cheap insurance.
  const types = (event.dataTransfer as DataTransfer | undefined)?.types;
  return types !== undefined && Array.from(types).includes("Files");
}

function readDraggedPaths(dataTransfer: DataTransfer): string[] {
  const raw = dataTransfer.getData(DRAG_MIME);
  if (raw !== "") {
    try {
      const parsed: unknown = JSON.parse(raw);
      if (Array.isArray(parsed)) {
        return parsed.filter((value): value is string => typeof value === "string");
      }
    } catch {
      /* fall through to the text/plain fallback */
    }
  }
  const text = dataTransfer.getData("text/plain");
  if (text === "") return [];
  return text.split("\n").filter((line) => line.startsWith("/"));
}

/**
 * Grab the `FileSystemEntry` list synchronously — `dataTransfer.items` is
 * neutered as soon as the drop handler returns. Returns null when the browser
 * has no `webkitGetAsEntry`, which is the folder-upload fallback of risk #3.
 */
function snapshotDropEntries(dataTransfer: DataTransfer): FileSystemEntry[] | null {
  const items = dataTransfer.items;
  if (items.length === 0) return null;
  const collected: FileSystemEntry[] = [];
  for (const item of Array.from(items)) {
    if (item.kind !== "file") continue;
    if (typeof item.webkitGetAsEntry !== "function") return null;
    const entry = item.webkitGetAsEntry();
    if (entry !== null) collected.push(entry);
  }
  return collected.length === 0 ? null : collected;
}

async function walkDropEntry(
  entry: FileSystemEntry,
  prefix: string,
  out: { file: File; relativeDir: string }[],
): Promise<void> {
  if (entry.isFile) {
    const fileEntry = entry as FileSystemFileEntry;
    const file = await new Promise<File | null>((resolve) => {
      fileEntry.file(resolve, () => resolve(null));
    });
    if (file !== null) out.push({ file, relativeDir: prefix });
    return;
  }
  if (!entry.isDirectory) return;
  const directoryEntry = entry as FileSystemDirectoryEntry;
  const childPrefix = prefix === "" ? entry.name : `${prefix}/${entry.name}`;
  const reader = directoryEntry.createReader();
  for (;;) {
    const batch = await new Promise<FileSystemEntry[]>((resolve) => {
      reader.readEntries(resolve, () => resolve([]));
    });
    if (batch.length === 0) break;
    for (const child of batch) await walkDropEntry(child, childPrefix, out);
  }
}

async function writeClipboardText(text: string): Promise<boolean> {
  try {
    const clipboard: unknown =
      typeof navigator === "undefined" ? undefined : (navigator as Navigator).clipboard;
    if (clipboard !== undefined && clipboard !== null) {
      await (clipboard as Clipboard).writeText(text);
      return true;
    }
  } catch {
    /* fall through */
  }
  return false;
}

function isTypingTarget(target: EventTarget | null): boolean {
  if (!(target instanceof HTMLElement)) return false;
  const tag = target.tagName;
  return (
    tag === "INPUT" || tag === "TEXTAREA" || tag === "SELECT" || target.isContentEditable === true
  );
}

/* ------------------------------------------------------------------ */
/* Panel                                                               */
/* ------------------------------------------------------------------ */

export function FileManagerPanel({ subPath }: PluginNavPanelProps) {
  const rpc = useFmRpc();
  const navigate = useBbNavigate();
  const navigateRef = useRef(navigate);
  navigateRef.current = navigate;

  const [state, setState] = useState<GetState | null>(null);
  const [stateError, setStateError] = useState<string | null>(null);
  const [ready, setReady] = useState(false);

  const root = state?.root ?? getClientRoot();
  const currentPath = useMemo(() => subPathToAbsolute(subPath, root), [subPath, root]);
  const currentPathRef = useRef(currentPath);
  currentPathRef.current = currentPath;

  const [showHidden, setShowHidden] = useState(false);
  const [confirmOnDelete, setConfirmOnDelete] = useState(true);
  const [sortField, setSortField] = useState<SortField>("name");
  const [sortDirection, setSortDirection] = useState<SortDirection>("asc");
  const [query, setQuery] = useState("");
  const [dialog, setDialog] = useState<DialogState>({ kind: "none" });
  const [contextTarget, setContextTarget] = useState<string | null>(null);
  const [dropTarget, setDropTarget] = useState<string | null>(null);
  const [externalDrag, setExternalDrag] = useState(false);

  const rootRef = useRef<HTMLDivElement>(null);
  const scrollRef = useRef<HTMLDivElement>(null);
  /** The `role="treegrid"` element: the panel's one keyboard widget (§8.3). */
  const gridRef = useRef<HTMLTableElement>(null);
  const searchRef = useRef<HTMLInputElement>(null);
  const fileInputRef = useRef<HTMLInputElement>(null);
  const contextRowRef = useRef<string | null>(null);
  const pendingDropTargetRef = useRef<string | null>(null);
  const dragDepthRef = useRef(0);
  const subPathRef = useRef(subPath);
  subPathRef.current = subPath;

  /* -------------------------------------------------------------- */
  /* Bootstrap (§8.1)                                                */
  /* -------------------------------------------------------------- */

  useEffect(() => {
    let cancelled = false;
    void (async () => {
      try {
        const result = await rpc.call("getState", null);
        if (cancelled) return;
        // The panel learns the hard root here: it is the home directory of the
        // user running bb, so path helpers cannot default to a fixed value.
        setClientRoot(result.root);
        setState(result);
        setShowHidden(result.preferences.showHiddenFiles);
        setConfirmOnDelete(result.preferences.confirmOnDelete);
        setSortField(result.preferences.sortField);
        setSortDirection(result.preferences.sortDirection);
        setStateError(null);
        if (subPathRef.current === "" && !isSamePath(result.startFolder, result.root)) {
          navigateRef.current.toPluginPanel(PANEL_PATH, {
            subPath: absoluteToSubPath(result.startFolder, result.root),
            replace: true,
          });
        }
      } catch (failure) {
        if (!cancelled) setStateError(parseRpcError(failure).rawMessage);
      } finally {
        if (!cancelled) setReady(true);
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [rpc]);

  /* -------------------------------------------------------------- */
  /* Data                                                            */
  /* -------------------------------------------------------------- */

  // The filter is NOT handed to `useDirectory`: it moved wholesale into
  // `flattenTree`, so there is exactly one implementation of it and it can
  // keep the ancestors of a nested match visible (§5.7).
  const directory = useDirectory({
    path: currentPath,
    showHidden,
    sortField,
    sortDirection,
    enabled: ready,
  });
  const tree = useTree({
    rootPath: currentPath,
    rootEntries: directory.entries,
    showHidden,
    sortField,
    sortDirection,
    query,
    enabled: ready,
  });
  const treeRef = useRef<UseTreeResult>(tree);
  treeRef.current = tree;

  /**
   * §8.4's optimistic move: the rows leave the screen the moment the drag is
   * dropped and come back if the backend refuses them. They stay hidden past
   * the answer, until the fresh listing that really drops them lands, so there
   * is no reappear-then-vanish flicker in between.
   */
  const [pendingMoved, setPendingMoved] = useState<readonly string[]>([]);
  const { rows, visiblePaths } = useMemo(() => {
    if (pendingMoved.length === 0) {
      return { rows: tree.rows, visiblePaths: tree.visiblePaths };
    }
    const hidden = (path: string): boolean =>
      pendingMoved.some((moved) => isSameOrDescendant(path, moved));
    const kept = tree.rows.filter((row) =>
      row.kind === "entry" ? !hidden(row.entry.path) : !hidden(row.parentPath),
    );
    return {
      rows: kept,
      visiblePaths: kept.flatMap((row) => (row.kind === "entry" ? [row.entry.path] : [])),
    };
  }, [pendingMoved, tree.rows, tree.visiblePaths]);

  // A listing that lands is the authority on what is really gone: release the
  // optimistic set against it instead of holding rows hostage on an error.
  useEffect(() => {
    setPendingMoved((previous) => (previous.length === 0 ? previous : []));
  }, [directory.data]);

  const selection = useSelection(visiblePaths);
  const selectionRef = useRef(selection);
  selectionRef.current = selection;
  const clipboard = useClipboard();
  const uploads = useUploads();
  const refetchRef = useRef(directory.refetch);
  refetchRef.current = directory.refetch;
  const jobs = useJobs({
    onFinished: (job) => {
      if (job.state === "done") toast.success(`${job.label} finished`);
      else if (job.state === "failed") toast.error(job.errorMessage ?? `${job.label} failed`);
      refetchRef.current();
    },
    onVanished: () => {
      refetchRef.current();
    },
  });

  const writable = directory.data?.writable ?? true;
  const archiveSupport = state?.archiveSupport ?? DEFAULT_ARCHIVE_SUPPORT;
  // Built over the *flattened* rows, so every nested row is selectable,
  // openable and menu-addressable exactly like a top-level one.
  const rowByPath = useMemo(() => {
    const map = new Map<string, TreeEntryRow>();
    for (const row of rows) if (row.kind === "entry") map.set(row.entry.path, row);
    return map;
  }, [rows]);
  const rowByPathRef = useRef(rowByPath);
  rowByPathRef.current = rowByPath;
  const entryByPath = useMemo(() => {
    const map = new Map<string, FileEntry>();
    for (const [path, row] of rowByPath) map.set(path, row.entry);
    return map;
  }, [rowByPath]);
  const existingNames = useMemo(
    () => new Set((directory.data?.entries ?? []).map((entry) => entry.name)),
    [directory.data],
  );
  /**
   * Rename validates against the siblings of the row being renamed, which for
   * a nested row is a different directory than the one the panel is in.
   */
  const siblingNames = useCallback(
    (path: string): ReadonlySet<string> => {
      const parent = dirname(path);
      if (isSamePath(parent, currentPathRef.current)) return existingNames;
      const entries = treeRef.current.nodeEntries(parent);
      return entries === null
        ? new Set<string>()
        : new Set(entries.map((entry) => entry.name));
    },
    [existingNames],
  );
  const selectedEntries = useMemo(
    () =>
      selection.selectedPaths
        .map((path) => entryByPath.get(path))
        .filter((entry): entry is FileEntry => entry !== undefined),
    [selection.selectedPaths, entryByPath],
  );
  const canPaste = clipboard.canPasteInto(currentPath);
  // Stable across a pure expand/collapse so the memoised rows do not all
  // re-render; the relative "modified" column only needs a fresh clock when
  // the listing itself changed.
  const nowMs = useMemo(() => Date.now(), [directory.data]);

  /* -------------------------------------------------------------- */
  /* Preferences                                                     */
  /* -------------------------------------------------------------- */

  const persist = useCallback(
    (values: Parameters<typeof rpc.call<"savePreferences">>[1]) => {
      void (async () => {
        try {
          await rpc.call("savePreferences", values);
        } catch (failure) {
          toast.error(errorToastText(failure, "Could not save your preferences."));
        }
      })();
    },
    [rpc],
  );

  const toggleHidden = useCallback(() => {
    setShowHidden((previous) => {
      persist({ showHiddenFiles: !previous });
      return !previous;
    });
  }, [persist]);

  const applySortField = useCallback(
    (field: SortField) => {
      setSortField(field);
      persist({ sortField: field });
    },
    [persist],
  );

  const applySortDirection = useCallback(
    (direction: SortDirection) => {
      setSortDirection(direction);
      persist({ sortDirection: direction });
    },
    [persist],
  );

  const handleHeaderSort = useCallback(
    (field: SortField) => {
      if (field === sortField) {
        const next: SortDirection = sortDirection === "asc" ? "desc" : "asc";
        setSortDirection(next);
        persist({ sortDirection: next });
        return;
      }
      setSortField(field);
      setSortDirection("asc");
      persist({ sortField: field, sortDirection: "asc" });
    },
    [persist, sortDirection, sortField],
  );

  /* -------------------------------------------------------------- */
  /* Navigation                                                      */
  /* -------------------------------------------------------------- */

  const navigateTo = useCallback((absolute: string) => {
    navigateRef.current.toPluginPanel(PANEL_PATH, {
      subPath: absoluteToSubPath(absolute),
    });
  }, []);

  const parentPath = directory.data?.parentPath ?? parentOf(currentPath, root);

  const goToParent = useCallback(() => {
    if (parentPath !== null) navigateTo(parentPath);
  }, [navigateTo, parentPath]);

  /* -------------------------------------------------------------- */
  /* Mutations                                                       */
  /* -------------------------------------------------------------- */

  const applyBatch = useCallback(
    (
      result: BatchResult,
      operation: "move" | "copy" | "delete",
      retry?: { destinationDir: string },
    ) => {
      const conflicts = result.failed.filter((failure) => failure.code === "exists");
      if (conflicts.length > 0 && retry !== undefined && operation !== "delete") {
        setDialog({
          kind: "conflict",
          operation,
          destinationDir: retry.destinationDir,
          paths: conflicts.map((conflict) => conflict.path),
          conflicts,
        });
      } else if (result.failed.length > 0) {
        const text = batchFailureText(result.failed, operation);
        if (text !== null) toast.error(text);
      }
      // Delete and move both consume their sources: `succeeded` echoes the
      // caller's own paths (src/mutations.ts), which is exactly what the tree
      // is keyed on. A move cannot be re-keyed — with `conflict: "rename"` the
      // destination base name is unknown — so it collapses instead (§5.4).
      if (operation !== "copy") treeRef.current.pruneSubtree(result.succeeded);
      refetchRef.current();
    },
    [],
  );

  const moveTo = useCallback(
    (paths: readonly string[], destinationDir: string) => {
      const targets = topLevelPaths(paths).filter(
        (path) => !isSamePath(dirname(path), destinationDir),
      );
      if (targets.length === 0) return;
      const restore = (only?: ReadonlySet<string>): void => {
        setPendingMoved((previous) =>
          previous.filter(
            (path) => !targets.includes(path) || (only !== undefined && !only.has(path)),
          ),
        );
      };
      void (async () => {
        // §8.4: the rows go the moment the drop happens, not a round trip later.
        setPendingMoved((previous) => [...previous, ...targets]);
        try {
          const result = await rpc.call("moveEntries", {
            paths: [...targets],
            destinationDir,
            conflict: "fail",
          });
          // Whatever the backend refused (a conflict included) comes straight
          // back; what it moved stays hidden until the refetch confirms it.
          restore(new Set(result.failed.map((failure) => failure.path)));
          applyBatch(result, "move", { destinationDir });
        } catch (failure) {
          restore();
          toast.error(errorToastText(failure, "Could not move those items."));
        }
      })();
    },
    [applyBatch, rpc],
  );

  const copyTo = useCallback(
    (paths: readonly string[], destinationDir: string) => {
      void (async () => {
        try {
          const result = await rpc.call("copyEntries", {
            paths: topLevelPaths(paths),
            destinationDir,
            conflict: "rename",
          });
          applyBatch(result, "copy");
        } catch (failure) {
          toast.error(errorToastText(failure, "Could not copy those items."));
        }
      })();
    },
    [applyBatch, rpc],
  );

  const deleteEntries = useCallback(
    async (entries: readonly FileEntry[]): Promise<void> => {
      if (entries.length === 0) return;
      try {
        const result = await rpc.call("deleteEntries", {
          paths: entries.map((entry) => entry.path),
          recursive: true,
        });
        applyBatch(result, "delete");
      } catch (failure) {
        toast.error(errorToastText(failure, "Could not delete those items."));
      }
    },
    [applyBatch, rpc],
  );

  const requestDelete = useCallback(
    (entries: readonly FileEntry[]) => {
      // Deleting a folder already removes its children; sending both would
      // come back as `not_found` on the child (§4.5).
      const keep = new Set(topLevelPaths(entries.map((entry) => entry.path)));
      const targets = entries.filter((entry) => keep.has(entry.path));
      if (targets.length === 0) return;
      if (confirmOnDelete) {
        setDialog({ kind: "delete", entries: targets });
        return;
      }
      void deleteEntries(targets);
    },
    [confirmOnDelete, deleteEntries],
  );

  const paste = useCallback(() => {
    const pending = clipboard.clipboard;
    if (pending === null) return;
    const destinationDir = currentPathRef.current;
    void (async () => {
      try {
        const result = await clipboard.paste(destinationDir);
        if (result === null) return;
        applyBatch(result, pending.mode === "cut" ? "move" : "copy", { destinationDir });
      } catch (failure) {
        toast.error(errorToastText(failure, "Could not paste here."));
      }
    })();
  }, [applyBatch, clipboard]);

  const copyPathsToClipboard = useCallback((paths: readonly string[]) => {
    if (paths.length === 0) return;
    void (async () => {
      const ok = await writeClipboardText(paths.join("\n"));
      if (ok) toast.success(paths.length === 1 ? "Path copied" : `${String(paths.length)} paths copied`);
      else toast.error("This browser did not allow copying to the clipboard.");
    })();
  }, []);

  const downloadSelection = useCallback((entries: readonly FileEntry[]) => {
    const files = entries.filter(
      (entry) => !entry.escapesRoot && effectiveKind(entry) === "file",
    );
    if (files.length === 0) {
      toast.error("Folders cannot be downloaded in this version.");
      return;
    }
    if (files.length === 1 && files[0] !== undefined) {
      downloadEntry(files[0]);
      return;
    }
    void downloadPaths(files.map((entry) => entry.path));
  }, []);

  const openEntry = useCallback(
    (entry: FileEntry) => {
      if (entry.escapesRoot) {
        toast.error(`Link points outside ${root}`);
        return;
      }
      const kind = effectiveKind(entry);
      if (kind === "directory") {
        navigateTo(entry.path);
        return;
      }
      if (entry.archiveFormat !== null) {
        setDialog({ kind: "extract", entry });
        return;
      }
      downloadEntry(entry);
    },
    [navigateTo, root],
  );

  const startExtract = useCallback(
    async (submission: ExtractSubmission): Promise<void> => {
      const result = await rpc.call("extractArchive", {
        archivePath: submission.entry.path,
        destinationDir: submission.destinationDir,
        createSubfolder: submission.createSubfolder,
        conflict: "rename",
      });
      jobs.track(result.job);
    },
    [jobs, rpc],
  );

  // Same write the settings section performs (lib/start-folder.ts) — the panel
  // just reports it as a toast instead of inline text.
  const setStartFolder = useCallback(
    (path: string) => {
      void (async () => {
        try {
          await saveStartFolder(rpc, path);
          toast.success(START_FOLDER_SAVED_TEXT);
        } catch (failure) {
          toast.error(errorToastText(failure, START_FOLDER_SAVE_FAILED_TEXT));
        }
      })();
    },
    [rpc],
  );

  /* -------------------------------------------------------------- */
  /* Uploads                                                         */
  /* -------------------------------------------------------------- */

  const enqueueUploads = useCallback(
    (requests: readonly UploadRequest[]) => {
      if (requests.length === 0) return;
      uploads.enqueue(requests);
    },
    [uploads],
  );

  const openFilePicker = useCallback(() => {
    fileInputRef.current?.click();
  }, []);

  /** Manual refresh: the current directory *and* every cached child listing. */
  const handleRefresh = useCallback(() => {
    treeRef.current.refreshAll();
    refetchRef.current();
  }, []);

  /* -------------------------------------------------------------- */
  /* Selection / mouse                                               */
  /* -------------------------------------------------------------- */

  const handleRowClick = useCallback(
    (entry: FileEntry, event: ReactMouseEvent<HTMLElement>) => {
      gridRef.current?.focus();
      selectionRef.current.handleRowClick(entry.path, {
        ctrlKey: event.ctrlKey,
        metaKey: event.metaKey,
        shiftKey: event.shiftKey,
      });
    },
    [],
  );

  const handleToggleSelect = useCallback((entry: FileEntry) => {
    selectionRef.current.toggle(entry.path);
  }, []);

  /** Chevron: expansion only. Selection and anchor stay where they were. */
  const handleToggleExpand = useCallback((entry: FileEntry) => {
    gridRef.current?.focus();
    selectionRef.current.setFocus(entry.path);
    treeRef.current.toggle(entry);
  }, []);

  const handleRetryNode = useCallback((path: string) => {
    treeRef.current.reload(path);
  }, []);

  const handleCollapseAll = useCallback(() => {
    treeRef.current.collapseAll();
  }, []);

  const handleBackgroundClick = useCallback(
    (event: ReactMouseEvent<HTMLElement>) => {
      const target = event.target;
      if (target instanceof HTMLElement && target.closest("[data-fm-path]") !== null) return;
      selection.clear();
    },
    [selection],
  );

  const handleRowContextMenu = useCallback((entry: FileEntry) => {
    contextRowRef.current = entry.path;
    const current = selectionRef.current;
    if (!current.isSelected(entry.path)) current.select(entry.path);
  }, []);

  const handleContainerContextMenu = useCallback(() => {
    const path = contextRowRef.current;
    contextRowRef.current = null;
    setContextTarget(path);
  }, []);

  const menuEntries = useMemo(() => {
    if (contextTarget === null) return [];
    if (selection.selected.has(contextTarget) && selectedEntries.length > 0) return selectedEntries;
    const entry = entryByPath.get(contextTarget);
    return entry === undefined ? [] : [entry];
  }, [contextTarget, entryByPath, selectedEntries, selection.selected]);

  /* -------------------------------------------------------------- */
  /* Drag & drop (§8.4)                                              */
  /* -------------------------------------------------------------- */

  const dropTargetFor = useCallback((entry: FileEntry): string | null => {
    if (entry.escapesRoot) return null;
    if (effectiveKind(entry) === "directory") return entry.path;
    // A file row inside an expanded folder resolves to that folder, not to the
    // current directory — otherwise a drop on `docs/inner.txt` would land in
    // `~`. At depth 0 this still returns null, i.e. today's behaviour.
    const row = rowByPathRef.current.get(entry.path);
    return row !== undefined && row.depth > 0 ? row.parentPath : null;
  }, []);

  /* Spring-loaded folders: dwell over a collapsed folder during a drag and it
     opens, so a nested destination is reachable without dropping first. */
  const hoverExpandRef = useRef<{ path: string; timer: number } | null>(null);

  const clearHoverExpand = useCallback((path?: string) => {
    const pending = hoverExpandRef.current;
    if (pending === null) return;
    if (path !== undefined && pending.path !== path) return;
    window.clearTimeout(pending.timer);
    hoverExpandRef.current = null;
  }, []);

  const scheduleHoverExpand = useCallback(
    (entry: FileEntry) => {
      const row = rowByPathRef.current.get(entry.path);
      if (row === undefined || !row.expandable || row.expanded) {
        clearHoverExpand();
        return;
      }
      if (hoverExpandRef.current?.path === entry.path) return;
      clearHoverExpand();
      const path = entry.path;
      const timer = window.setTimeout(() => {
        hoverExpandRef.current = null;
        treeRef.current.expand(path);
      }, AUTO_EXPAND_HOVER_MS);
      hoverExpandRef.current = { path, timer };
    },
    [clearHoverExpand],
  );

  useEffect(() => () => clearHoverExpand(), [clearHoverExpand]);

  const handleRowDragStart = useCallback(
    (entry: FileEntry, event: ReactDragEvent<HTMLElement>) => {
      if (entry.escapesRoot) {
        event.preventDefault();
        return;
      }
      const current = selectionRef.current;
      let paths = topLevelPaths(current.selectedPaths);
      if (!current.isSelected(entry.path)) {
        current.select(entry.path);
        paths = [entry.path];
      }
      event.dataTransfer.effectAllowed = "move";
      event.dataTransfer.setData(DRAG_MIME, JSON.stringify(paths));
      event.dataTransfer.setData("text/plain", paths.join("\n"));
    },
    [],
  );

  const handleRowDragOver = useCallback(
    (entry: FileEntry, event: ReactDragEvent<HTMLElement>) => {
      const target = dropTargetFor(entry);
      if (target === null) return;
      const external = isExternalDrag(event);
      if (!external) {
        const dragged = selectionRef.current;
        if (dragged.isSelected(entry.path)) return;
        // A folder can never be dropped into itself or into one of its own
        // descendants — now reachable on screen, so it must not even
        // highlight (SPEC §8.4).
        if (dragged.selectedPaths.some((path) => isSameOrDescendant(target, path))) return;
      }
      scheduleHoverExpand(entry);
      pendingDropTargetRef.current = target;
      event.preventDefault();
      event.dataTransfer.dropEffect = external ? "copy" : "move";
    },
    [dropTargetFor, scheduleHoverExpand],
  );

  const handleRowDragLeave = useCallback(
    (entry: FileEntry, event: ReactDragEvent<HTMLElement>) => {
      // The browser fires `dragleave` for every hop between the nested
      // elements of one row (td → div → span). Restarting the spring-load
      // dwell on those would make a 700 ms hover unreachable for anyone whose
      // hand is not perfectly still.
      const related = event.relatedTarget;
      if (related instanceof Node && event.currentTarget.contains(related)) return;
      clearHoverExpand(entry.path);
    },
    [clearHoverExpand],
  );

  const handleTargetDragOver = useCallback((path: string, event: ReactDragEvent<HTMLElement>) => {
    pendingDropTargetRef.current = path;
    event.preventDefault();
    event.dataTransfer.dropEffect = isExternalDrag(event) ? "copy" : "move";
  }, []);

  const noopDragHandler = useCallback(() => undefined, []);

  const handleRootDragOver = useCallback(
    (event: ReactDragEvent<HTMLElement>) => {
      const pending = pendingDropTargetRef.current;
      pendingDropTargetRef.current = null;
      const external = isExternalDrag(event);
      if (external) {
        // Without preventDefault the browser navigates to the dropped file and
        // the panel is gone (§8.4).
        event.preventDefault();
        event.dataTransfer.dropEffect = "copy";
        setExternalDrag(true);
      }
      setDropTarget(pending ?? (external ? currentPathRef.current : null));
    },
    [],
  );

  const handleRootDragEnter = useCallback((event: ReactDragEvent<HTMLElement>) => {
    dragDepthRef.current += 1;
    if (isExternalDrag(event)) {
      event.preventDefault();
      setExternalDrag(true);
    }
  }, []);

  const handleRootDragLeave = useCallback(
    (event: ReactDragEvent<HTMLElement>) => {
      // A hop between two elements *inside* the panel is not a leave, whatever
      // the enter/leave counter says: the counter drifts whenever a row is
      // re-rendered away under the pointer, and a drifted counter cancels the
      // spring-load dwell and the drop highlight mid-drag.
      const related = event.relatedTarget;
      if (related instanceof Node && event.currentTarget.contains(related)) return;
      dragDepthRef.current = Math.max(0, dragDepthRef.current - 1);
      if (dragDepthRef.current === 0) {
        clearHoverExpand();
        setExternalDrag(false);
        setDropTarget(null);
      }
    },
    [clearHoverExpand],
  );

  const handleRootDragEnd = useCallback(() => {
    dragDepthRef.current = 0;
    clearHoverExpand();
    setExternalDrag(false);
    setDropTarget(null);
  }, [clearHoverExpand]);

  const handleRootDrop = useCallback(
    (event: ReactDragEvent<HTMLElement>) => {
      event.preventDefault();
      const pending = pendingDropTargetRef.current;
      pendingDropTargetRef.current = null;
      const destination = pending ?? dropTarget ?? currentPathRef.current;
      clearHoverExpand();
      dragDepthRef.current = 0;
      setExternalDrag(false);
      setDropTarget(null);

      if (isExternalDrag(event)) {
        const entries = snapshotDropEntries(event.dataTransfer);
        if (entries === null) {
          const files = Array.from(event.dataTransfer.files);
          if (files.length === 0) return;
          toast.message("Folder upload is not supported in this browser — drop individual files.");
          enqueueUploads(files.map((file) => ({ file, dirPath: destination, relativeDir: "" })));
          return;
        }
        void (async () => {
          const collected: { file: File; relativeDir: string }[] = [];
          for (const entry of entries) await walkDropEntry(entry, "", collected);
          enqueueUploads(
            collected.map((item) => ({
              file: item.file,
              dirPath: destination,
              relativeDir: item.relativeDir,
            })),
          );
        })();
        return;
      }

      const paths = readDraggedPaths(event.dataTransfer);
      if (paths.length === 0) return;
      moveTo(paths, destination);
    },
    [clearHoverExpand, dropTarget, enqueueUploads, moveTo],
  );

  /* -------------------------------------------------------------- */
  /* Keyboard map (§8.3)                                             */
  /* -------------------------------------------------------------- */

  const rowElement = useCallback((path: string | null): HTMLElement | null => {
    const container = scrollRef.current;
    if (path === null || container === null) return null;
    const escaped = path.replace(/["\\]/gu, "\\$&");
    const row = container.querySelector(`[data-fm-path="${escaped}"]`);
    return row instanceof HTMLElement ? row : null;
  }, []);

  const focusRow = useCallback(
    (path: string | null) => {
      rowElement(path)?.scrollIntoView({ block: "nearest" });
    },
    [rowElement],
  );

  /**
   * `Shift+F10` / the Menu key. Both context menus hang off the scroll
   * container, which never holds focus (the panel root does), so the browser's
   * own `contextmenu` event never reaches the Radix trigger. Synthesize it on
   * the focused row — the row handler then fills the menu exactly like a right
   * click would, and Radix positions the menu over that row.
   */
  const openKeyboardContextMenu = useCallback(
    (path: string | null) => {
      const container = scrollRef.current;
      if (container === null) return;
      const target = rowElement(path) ?? container;
      const rect = target.getBoundingClientRect();
      target.dispatchEvent(
        new MouseEvent("contextmenu", {
          bubbles: true,
          cancelable: true,
          clientX: Math.round(rect.left + 8),
          clientY: Math.round(rect.top + rect.height / 2),
        }),
      );
    },
    [rowElement],
  );

  useEffect(() => {
    focusRow(selection.focus);
  }, [focusRow, selection.focus]);

  const handleKeyDown = useCallback(
    (event: ReactKeyboardEvent<HTMLDivElement>) => {
      if (isTypingTarget(event.target)) return;
      const mod = event.ctrlKey || event.metaKey;
      const focusedRow = selection.focus === null ? undefined : rowByPath.get(selection.focus);
      const focusedEntry = focusedRow?.entry;

      if (mod && event.shiftKey && (event.key === "." || event.key === ">")) {
        event.preventDefault();
        toggleHidden();
        return;
      }
      if (mod && event.shiftKey && (event.key === "N" || event.key === "n")) {
        event.preventDefault();
        if (writable) setDialog({ kind: "new-folder" });
        return;
      }
      if (!mod && (event.key === "ContextMenu" || (event.shiftKey && event.key === "F10"))) {
        event.preventDefault();
        openKeyboardContextMenu(selection.focus);
        return;
      }
      if (mod && !event.shiftKey) {
        switch (event.key) {
          case "a":
          case "A":
            event.preventDefault();
            selection.selectAll();
            return;
          case "x":
          case "X":
            event.preventDefault();
            clipboard.cut(topLevelPaths(selection.selectedPaths));
            return;
          case "c":
          case "C":
            event.preventDefault();
            clipboard.copy(topLevelPaths(selection.selectedPaths));
            return;
          case "v":
          case "V":
            event.preventDefault();
            paste();
            return;
          case "f":
          case "F":
            event.preventDefault();
            searchRef.current?.focus();
            searchRef.current?.select();
            return;
          default:
            break;
        }
        return;
      }

      switch (event.key) {
        case "ArrowDown":
          event.preventDefault();
          selection.moveFocus(1, event.shiftKey);
          return;
        case "ArrowUp":
          event.preventDefault();
          selection.moveFocus(-1, event.shiftKey);
          return;
        case "Home":
          event.preventDefault();
          selection.focusEdge("start", event.shiftKey);
          return;
        case "End":
          event.preventDefault();
          selection.focusEdge("end", event.shiftKey);
          return;
        case "Enter":
          if (focusedEntry !== undefined) {
            event.preventDefault();
            openEntry(focusedEntry);
          }
          return;
        case "Backspace":
          event.preventDefault();
          goToParent();
          return;
        case "ArrowRight": {
          // `Alt+ArrowRight` is the host's history-forward gesture, exactly
          // like `Alt+ArrowLeft` below — leave it alone (§8.3).
          if (event.altKey) return;
          // Tree semantics only: open the folder, else step into it. Never
          // preventDefault for a row that has nothing to open (§8.3).
          if (focusedRow === undefined || !focusedRow.expandable) return;
          if (!focusedRow.expanded) {
            event.preventDefault();
            tree.expand(focusedRow.entry.path);
            return;
          }
          // Step *into* the folder only when a child row is really on screen.
          // Children arrive asynchronously, and an empty or filtered-away
          // folder never gets any, so a blind moveFocus(1) walks past the
          // folder the user is trying to enter and onto its next sibling.
          const index = rows.indexOf(focusedRow);
          const next = index < 0 ? undefined : rows[index + 1];
          if (next?.kind === "entry" && isSamePath(next.parentPath, focusedRow.entry.path)) {
            event.preventDefault();
            selection.moveFocus(1);
          }
          return;
        }
        case "ArrowLeft":
          // `Alt+ArrowLeft` (and `Backspace`) stay "go up a directory"; the
          // bare key collapses, or walks to the parent *row*.
          if (event.altKey) {
            event.preventDefault();
            goToParent();
            return;
          }
          if (focusedRow === undefined) return;
          if (focusedRow.expandable && focusedRow.expanded) {
            event.preventDefault();
            tree.collapse(focusedRow.entry.path);
            return;
          }
          if (focusedRow.depth > 0) {
            event.preventDefault();
            selection.select(focusedRow.parentPath);
          }
          return;
        case "F2":
          if (selectedEntries.length === 1 && selectedEntries[0] !== undefined) {
            event.preventDefault();
            setDialog({ kind: "rename", entry: selectedEntries[0] });
          }
          return;
        case "Delete":
          if (selectedEntries.length > 0) {
            event.preventDefault();
            requestDelete(selectedEntries);
          }
          return;
        case "Escape":
          // §8.3: "clear search box if focused, else clear selection". The box
          // clears itself (Toolbar stops the event there), so by the time the
          // panel sees an Escape the focus is elsewhere and it belongs to the
          // selection — clearing the filter here would strand the selection.
          if (selection.count > 0) {
            event.preventDefault();
            selection.clear();
          }
          return;
        default:
          // Never preventDefault on keys we do not handle (§8.3).
          return;
      }
    },
    [
      clipboard,
      goToParent,
      openEntry,
      openKeyboardContextMenu,
      paste,
      requestDelete,
      rowByPath,
      rows,
      selectedEntries,
      selection,
      toggleHidden,
      tree,
      writable,
    ],
  );

  /* -------------------------------------------------------------- */
  /* Title-bar bridge                                                */
  /* -------------------------------------------------------------- */

  useEffect(() => {
    publishPanelSnapshot({
      currentPath,
      writable,
      ready,
      showHidden,
      selectionCount: selection.count,
      canPaste,
    });
  }, [canPaste, currentPath, ready, selection.count, showHidden, writable]);

  useEffect(() => resetPanelSnapshot, []);

  const commandRef = useRef<(command: { type: string }) => void>(() => undefined);
  commandRef.current = (command) => {
    switch (command.type) {
      case "upload":
        openFilePicker();
        return;
      case "new-folder":
        setDialog({ kind: "new-folder" });
        return;
      case "refresh":
        treeRef.current.refreshAll();
        refetchRef.current();
        return;
      case "toggle-hidden":
        toggleHidden();
        return;
      case "select-all":
        selection.selectAll();
        return;
      case "paste":
        paste();
        return;
      case "copy-path":
        copyPathsToClipboard([currentPathRef.current]);
        return;
      case "set-start-folder":
        setStartFolder(currentPathRef.current);
        return;
      default:
        return;
    }
  };

  useEffect(
    () =>
      subscribePanelCommands((command) => {
        commandRef.current(command);
      }),
    [],
  );

  /* -------------------------------------------------------------- */
  /* Render                                                          */
  /* -------------------------------------------------------------- */

  const emptyKind: EmptyStateKind =
    query.trim() !== ""
      ? "no-results"
      : directory.error?.code === "path_escape"
        ? "escapes-root"
        : writable
          ? "empty"
          : "not-writable";

  const hiddenCount = directory.data?.hiddenCount ?? 0;
  const truncated = directory.data?.truncated ?? false;

  return (
    <div
      ref={rootRef}
      data-testid="fm-panel"
      data-current-path={currentPath}
      className="@container relative flex h-full min-h-0 flex-col bg-background text-foreground outline-none"
      onKeyDown={handleKeyDown}
      onDragEnter={handleRootDragEnter}
      onDragOver={handleRootDragOver}
      onDragLeave={handleRootDragLeave}
      onDragEnd={handleRootDragEnd}
      onDrop={handleRootDrop}
    >
      <Toolbar
        path={currentPath}
        root={root}
        onNavigate={navigateTo}
        query={query}
        onQueryChange={setQuery}
        searchInputRef={searchRef}
        sortField={sortField}
        sortDirection={sortDirection}
        onSortFieldChange={applySortField}
        onSortDirectionChange={applySortDirection}
        showHidden={showHidden}
        onToggleHidden={toggleHidden}
        expandedCount={tree.expandedCount}
        onCollapseAll={handleCollapseAll}
        onRefresh={handleRefresh}
        refreshing={directory.isRefetching}
        hiddenCount={hiddenCount}
        volume={directory.data?.volume ?? null}
        dropTargetPath={dropTarget}
        onDragOverCrumb={handleTargetDragOver}
        onDragLeaveCrumb={noopDragHandler}
        onDropOnCrumb={noopDragHandler}
      />

      {stateError === null ? null : (
        <ErrorBanner
          error={stateError}
          title="The file manager backend did not answer"
          onRetry={() => {
            setReady(false);
            setStateError(null);
            window.setTimeout(() => setReady(true), 0);
          }}
        />
      )}

      {directory.error === null ? null : (
        <ErrorBanner
          error={directory.error.rawMessage}
          title="Could not open this folder"
          onRetry={handleRefresh}
        />
      )}

      {truncated ? (
        <div className="flex items-center gap-2 border-b border-border bg-surface-attention px-3 py-1.5 text-xs text-warning-text">
          Showing the first {String(state?.maxListEntries ?? directory.entries.length)} of{" "}
          {String(directory.data?.totalEntries ?? 0)} items. Use the filter to narrow it down.
        </div>
      ) : null}

      {tree.rowsTruncated ? (
        <div className="flex items-center gap-2 border-b border-border bg-surface-attention px-3 py-1.5 text-xs text-warning-text">
          Showing the first {String(MAX_TREE_ROWS)} rows. Collapse a folder to see more.
        </div>
      ) : null}

      <ContextMenu>
        <ContextMenuTrigger asChild>
          <div
            ref={scrollRef}
            data-testid="fm-scroll"
            className="min-h-0 flex-1 overflow-auto"
            onClick={handleBackgroundClick}
            onContextMenu={handleContainerContextMenu}
          >
            <FileTable
              gridRef={gridRef}
              rows={rows}
              loading={directory.isLoading || !ready}
              selectedPaths={selection.selected}
              focusedPath={selection.focus}
              cutPaths={
                clipboard.clipboard?.mode === "cut"
                  ? new Set(clipboard.clipboard.paths)
                  : new Set<string>()
              }
              sortField={sortField}
              sortDirection={sortDirection}
              onSort={handleHeaderSort}
              parentPath={parentPath}
              onNavigateParent={goToParent}
              dropTargetPath={dropTarget}
              nowMs={nowMs}
              onSelectAll={(selectAll) => {
                if (selectAll) selection.selectAll();
                else selection.clear();
              }}
              onToggleExpand={handleToggleExpand}
              onRetryNode={handleRetryNode}
              onRowClick={handleRowClick}
              onRowDoubleClick={openEntry}
              onRowContextMenu={handleRowContextMenu}
              onToggleSelect={handleToggleSelect}
              onRowDragStart={handleRowDragStart}
              onRowDragOver={handleRowDragOver}
              onRowDragLeave={handleRowDragLeave}
              onRowDrop={noopDragHandler}
              onRowDragEnd={handleRootDragEnd}
              onParentDragOver={(event) => {
                if (parentPath !== null) handleTargetDragOver(parentPath, event);
              }}
              onParentDragLeave={noopDragHandler}
              onParentDrop={noopDragHandler}
              emptyState={
                <EmptyState
                  kind={emptyKind}
                  query={query}
                  onClearSearch={() => setQuery("")}
                  onNewFolder={writable ? () => setDialog({ kind: "new-folder" }) : undefined}
                  onUpload={writable ? openFilePicker : undefined}
                />
              }
            />
          </div>
        </ContextMenuTrigger>

        {menuEntries.length > 0 ? (
          <RowContextMenu
            entries={menuEntries}
            writable={writable}
            canPaste={canPaste}
            canExtract={
              menuEntries.length === 1 &&
              menuEntries[0]?.archiveFormat != null &&
              isFormatSupported(menuEntries[0].archiveFormat, archiveSupport)
            }
            onOpen={openEntry}
            onDownload={() => downloadSelection(menuEntries)}
            onExtract={(entry) => setDialog({ kind: "extract", entry })}
            onCut={() => clipboard.cut(topLevelPaths(menuEntries.map((entry) => entry.path)))}
            onCopy={() => clipboard.copy(topLevelPaths(menuEntries.map((entry) => entry.path)))}
            onPaste={paste}
            onMoveTo={() =>
              setDialog({
                kind: "picker",
                mode: "move",
                paths: menuEntries.map((entry) => entry.path),
              })
            }
            onCopyTo={() =>
              setDialog({
                kind: "picker",
                mode: "copy",
                paths: menuEntries.map((entry) => entry.path),
              })
            }
            onRename={(entry) => setDialog({ kind: "rename", entry })}
            onCopyPath={() => copyPathsToClipboard(menuEntries.map((entry) => entry.path))}
            onDelete={() => requestDelete(menuEntries)}
            onSetStartFolder={(entry) => setStartFolder(entry.path)}
          />
        ) : (
          <BackgroundContextMenu
            writable={writable}
            canPaste={canPaste}
            showHidden={showHidden}
            onNewFolder={() => setDialog({ kind: "new-folder" })}
            onUpload={openFilePicker}
            onPaste={paste}
            onSelectAll={() => selection.selectAll()}
            onRefresh={handleRefresh}
            onToggleHidden={toggleHidden}
            expandedCount={tree.expandedCount}
            onCollapseAll={handleCollapseAll}
            onCopyPath={() => copyPathsToClipboard([currentPath])}
            onSetStartFolder={() => setStartFolder(currentPath)}
          />
        )}
      </ContextMenu>

      <ActivityTray
        uploads={uploads.uploads}
        jobs={jobs.jobs}
        onCancelUpload={uploads.cancel}
        onRetryUpload={uploads.retry}
        onDismissUpload={uploads.remove}
        onClearFinished={() => {
          uploads.clearFinished();
          jobs.clearFinished();
        }}
        onCancelJob={(jobId) => {
          void jobs.cancel(jobId).catch((failure: unknown) => {
            toast.error(errorToastText(failure, "Could not cancel that job."));
          });
        }}
        onDismissJob={jobs.dismiss}
      />

      {externalDrag ? (
        <div
          data-testid="fm-drop-overlay"
          className="pointer-events-none absolute inset-0 rounded-md ring-2 ring-inset ring-primary/50"
        />
      ) : null}

      <input
        ref={fileInputRef}
        type="file"
        multiple
        className="hidden"
        data-testid="fm-file-input"
        onChange={(event) => {
          const files = event.target.files;
          if (files !== null) {
            enqueueUploads(
              Array.from(files).map((file) => ({
                file,
                dirPath: currentPathRef.current,
                relativeDir: "",
              })),
            );
          }
          event.target.value = "";
        }}
      />

      {dialog.kind === "new-folder" ? (
        <NewFolderDialog
          open
          onOpenChange={(open) => {
            if (!open) setDialog({ kind: "none" });
          }}
          existingNames={existingNames}
          destinationLabel={currentPath}
          onSubmit={async (name) => {
            await rpc.call("createFolder", { path: currentPath, name });
            refetchRef.current();
          }}
        />
      ) : null}

      {dialog.kind === "rename" ? (
        <RenameDialog
          open
          entry={dialog.entry}
          existingNames={siblingNames(dialog.entry.path)}
          onOpenChange={(open) => {
            if (!open) setDialog({ kind: "none" });
          }}
          onSubmit={async (entry, newName) => {
            const result = await rpc.call("renameEntry", { path: entry.path, newName });
            // The one mutation whose new absolute path is knowable, so the one
            // that keeps its subtree open instead of collapsing it (§5.4).
            treeRef.current.remapPrefix(entry.path, result.entry.path);
            refetchRef.current();
          }}
        />
      ) : null}

      {dialog.kind === "delete" ? (
        <ConfirmDeleteDialog
          open
          entries={dialog.entries}
          onOpenChange={(open) => {
            if (!open) setDialog({ kind: "none" });
          }}
          onConfirm={deleteEntries}
        />
      ) : null}

      {dialog.kind === "extract" ? (
        <ExtractDialog
          open
          entry={dialog.entry}
          root={root}
          showHidden={showHidden}
          archiveSupport={archiveSupport}
          onOpenChange={(open) => {
            if (!open) setDialog({ kind: "none" });
          }}
          onSubmit={startExtract}
        />
      ) : null}

      {dialog.kind === "picker" ? (
        <FolderPickerDialog
          open
          title={dialog.mode === "move" ? "Move to…" : "Copy to…"}
          initialPath={currentPath}
          root={root}
          showHidden={showHidden}
          confirmLabel="Choose this folder"
          onOpenChange={(open) => {
            if (!open) setDialog({ kind: "none" });
          }}
          onChoose={(destination) => {
            // "Set as start folder" takes the folder it was invoked on (§8.6),
            // both from the row menu and from the background menu, so the
            // picker only ever runs the two batch destinations.
            if (dialog.mode === "move") moveTo(dialog.paths, destination);
            else copyTo(dialog.paths, destination);
          }}
        />
      ) : null}

      {dialog.kind === "conflict" ? (
        <ConflictDialog
          open
          conflicts={dialog.conflicts}
          destinationDir={dialog.destinationDir}
          operation={dialog.operation === "move" ? "Move" : "Copy"}
          onOpenChange={(open) => {
            if (!open) setDialog({ kind: "none" });
          }}
          onResolve={(choice: ConflictChoice) => {
            if (choice === "skip") {
              refetchRef.current();
              return;
            }
            const conflictPolicy = choice === "overwrite" ? "overwrite" : "rename";
            const { operation, destinationDir, paths } = dialog;
            void (async () => {
              try {
                const result =
                  operation === "move"
                    ? await rpc.call("moveEntries", {
                        paths,
                        destinationDir,
                        conflict: conflictPolicy,
                      })
                    : await rpc.call("copyEntries", {
                        paths,
                        destinationDir,
                        conflict: conflictPolicy,
                      });
                applyBatch(result, operation);
              } catch (failure) {
                toast.error(errorToastText(failure, "Could not finish that operation."));
              }
            })();
          }}
        />
      ) : null}
    </div>
  );
}
