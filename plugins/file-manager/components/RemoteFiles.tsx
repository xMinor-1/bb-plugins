import { useCallback, useEffect, useId, useLayoutEffect, useMemo, useRef, useState, type MouseEvent } from "react";

import type { FileEntry, ViewMode } from "../contract";
import { useMenuPointerGuard } from "../hooks/useMenuPointerGuard";
import { usePreviewBase } from "../hooks/usePreviewBase";
import { downloadRemoteFile } from "../lib/download";
import { parseRpcError } from "../lib/errors";
import { useFmRpc, type RpcOutput } from "../lib/fm-rpc";
import { defineMessages, useMessages } from "../lib/i18n";
import { ErrorBanner } from "./ErrorBanner";
import { FileGallery } from "./FileGallery";
import { entryIconName } from "./FileRow";
import { PathEditor } from "./PathBar";
import { FileViewerDialog } from "./dialogs/FileViewerDialog";
import { Button } from "./ui/button";
import { ContextMenu, ContextMenuContent, ContextMenuItem, ContextMenuTrigger } from "./ui/context-menu";
import { Icon } from "./ui/icon";

export const machineMessages = defineMessages(
  { machine: "Machine", local: "This machine" },
  { machine: "Машина", local: "Эта машина" },
);

const messages = defineMessages(
  {
    readOnly: "Read-only",
    home: "Home folder",
    location: "Folder path",
    editPath: "Edit folder path",
    invalidPath: "Enter an absolute folder path on this machine.",
    pathFailed: "Could not open that folder. Check the path and your access.",
    up: "Parent folder",
    refresh: "Refresh",
    files: "Files",
    gallery: "Gallery",
    list: "List",
    opening: "Opening folder…",
    empty: "This folder is empty.",
    truncated: "Only the first entries are shown.",
    fetchFailed: "Could not open this folder on the selected machine",
    unavailable: "This machine is unavailable.",
    outsideRoot: "This folder is outside the machine’s browsing root.",
    retryFolder: "Check the machine connection and try again, or open the home folder.",
    unpreviewable: "This file name is unsupported in previews",
    download: "Download",
    downloadFailed: "Could not start download",
    retryDownload: "Refresh the folder and try again.",
  },
  {
    readOnly: "Только чтение",
    home: "Домашняя папка",
    location: "Путь к папке",
    editPath: "Изменить путь к папке",
    invalidPath: "Введите абсолютный путь к папке на этой машине.",
    pathFailed: "Не удалось открыть папку. Проверьте путь и права доступа.",
    up: "Родительская папка",
    refresh: "Обновить",
    files: "Файлы",
    gallery: "Галерея",
    list: "Список",
    opening: "Открываю папку…",
    empty: "Эта папка пуста.",
    truncated: "Показаны только первые элементы.",
    fetchFailed: "Не удалось открыть папку на выбранной машине",
    unavailable: "Эта машина недоступна.",
    outsideRoot: "Эта папка находится за пределами доступной области машины.",
    retryFolder: "Проверьте соединение с машиной и попробуйте ещё раз или откройте домашнюю папку.",
    unpreviewable: "Такое имя файла не поддерживается в просмотре",
    download: "Скачать",
    downloadFailed: "Не удалось начать скачивание",
    retryDownload: "Обновите папку и попробуйте снова.",
  },
);

type Directory = RpcOutput<"remoteDirectory">;
type FolderResponse =
  | { status: "loading"; path: string | undefined }
  | { status: "ready"; directory: Directory }
  | { status: "error"; path: string | undefined; error: unknown };
type PathEdit =
  | { status: "editing" }
  | { status: "saving"; revision: number }
  | { status: "error"; code: ReturnType<typeof parseRpcError>["code"] };

const EMPTY_PATHS: ReadonlySet<string> = new Set();
const WINDOWS_ABSOLUTE_PATH = /^[a-z]:[\\/]|^\\\\/iu;
const noop = (): void => undefined;

function folderSegments(directory: Directory) {
  const { path, rootPath } = directory;
  const windows = WINDOWS_ABSOLUTE_PATH.test(rootPath);
  const separator = windows ? "\\" : "/";
  const comparePath = windows ? path.replaceAll("/", "\\") : path;
  const compareRoot = windows ? rootPath.replaceAll("/", "\\") : rootPath;
  const relative = comparePath.slice(compareRoot.length);
  const names = relative.split(separator).filter(Boolean);
  const prefix = compareRoot.endsWith(separator) ? compareRoot : compareRoot + separator;
  return names.map((name, index) => ({ name, path: prefix + names.slice(0, index + 1).join(separator) }));
}

/** The shared file icons and viewer need a listing-shaped entry. Remote metadata is absent. */
function toFileEntry(entry: Directory["entries"][number]): FileEntry {
  return {
    ...entry,
    targetKind: null,
    sizeBytes: 0,
    modifiedAtMs: 0,
    isHidden: false,
    isSymlink: false,
    escapesRoot: false,
    archiveFormat: null,
  };
}

export function RemoteFiles({ hostId, initialPath, initialViewMode = "list", onVisit, onViewModeChange }: {
  hostId: string;
  initialPath?: string;
  initialViewMode?: ViewMode;
  onVisit: (hostId: string, path: string) => void;
  onViewModeChange?: (hostId: string, mode: ViewMode) => void;
}) {
  const t = useMessages(messages);
  const rpc = useFmRpc();
  const startingPath = useRef(initialPath);
  const listingRevision = useRef(0);
  const downloadRevision = useRef(0);
  const [current, setCurrent] = useState<FolderResponse>({ status: "loading", path: initialPath });
  const [viewMode, setViewMode] = useState(initialViewMode);
  const [preview, setPreview] = useState<FileEntry | null>(null);
  const [downloadPath, setDownloadPath] = useState<string | null>(null);
  const [downloadFailed, setDownloadFailed] = useState(false);
  const [pathEdit, setPathEdit] = useState<PathEdit | null>(null);
  const errorId = useId();
  const editButton = useRef<HTMLButtonElement>(null);
  const restoreEditFocus = useRef(false);
  const menuPointerGuard = useMenuPointerGuard();

  const loadFolder = useCallback(async (path?: string, editing = false): Promise<void> => {
    const revision = ++listingRevision.current;
    if (editing) {
      // A rejected typed path must leave the current folder and its entries visible.
      setPathEdit({ status: "saving", revision });
    } else {
      setPathEdit(null);
      setCurrent({ status: "loading", path });
      setPreview(null);
    }

    let directory: Directory;
    try {
      directory = await rpc.call("remoteDirectory", path === undefined ? { hostId } : { hostId, path });
    } catch (error) {
      if (listingRevision.current !== revision) return;
      if (editing) setPathEdit({ status: "error", code: parseRpcError(error).code });
      else setCurrent({ status: "error", path, error });
      return;
    }
    if (listingRevision.current !== revision) return;
    if (editing) restoreEditFocus.current = true;
    setPathEdit(null);
    setPreview(null);
    setDownloadPath(null);
    setDownloadFailed(false);
    setCurrent({ status: "ready", directory });
    onVisit(hostId, directory.path);
  }, [hostId, onVisit, rpc]);

  useEffect(() => {
    void loadFolder(startingPath.current);
    return () => { listingRevision.current += 1; };
  }, [loadFolder]);

  useLayoutEffect(() => {
    if (pathEdit === null && restoreEditFocus.current) {
      restoreEditFocus.current = false;
      editButton.current?.focus();
    }
  }, [pathEdit]);

  const errorCode = current.status === "error" ? parseRpcError(current.error).code : null;
  const directory = current.status === "ready" ? current.directory : null;
  const path = current.status === "ready" ? current.directory.path : current.path;
  const crumbs = directory === null ? [] : [
    { name: directory.rootPath, path: directory.rootPath },
    ...folderSegments(directory),
  ];
  const entries = useMemo(() => directory?.entries.map(toFileEntry) ?? [], [directory]);
  const previewBaseUrl = usePreviewBase({
    hostId,
    path: directory?.path ?? "",
    enabled: directory !== null && viewMode === "gallery",
  });

  const navigate = (nextPath?: string): void => { void loadFolder(nextPath); };
  const invalidatePathEdit = (): void => {
    if (pathEdit?.status === "saving" && listingRevision.current === pathEdit.revision) {
      listingRevision.current += 1;
    }
  };
  const changeViewMode = (mode: ViewMode): void => {
    setViewMode(mode);
    onViewModeChange?.(hostId, mode);
  };
  const pathError = pathEdit?.status === "error" ? (
    pathEdit.code === "unsupported" ? t.unavailable
      : pathEdit.code === "path_escape" ? t.outsideRoot
        : pathEdit.code === "invalid_path" ? t.invalidPath : t.pathFailed
  ) : null;
  const parent = directory?.parentPath ?? null;
  const openParent = (): void => { if (parent !== null) navigate(parent); };
  const unavailableReason = (entry: FileEntry): string | undefined =>
    entry.kind === "file" && entry.name.includes("\\") ? t.unpreviewable : undefined;
  const openEntry = (entry: FileEntry): void => {
    if (entry.kind === "directory") navigate(entry.path);
    // BB's raw-file route treats a backslash as a segment separator.
    else if (unavailableReason(entry) === undefined) setPreview(entry);
  };
  const downloadEntry = async (entry: FileEntry, directoryPath: string): Promise<void> => {
    const { baseUrl, path } = await rpc.call("remotePreview", { hostId, path: directoryPath });
    if (path !== directoryPath) throw new Error("Remote folder changed before download");
    await downloadRemoteFile(baseUrl, entry.name);
  };
  const downloadFromMenu = (entry: FileEntry, directoryPath: string): void => {
    const listing = listingRevision.current;
    const request = ++downloadRevision.current;
    setDownloadFailed(false);
    void downloadEntry(entry, directoryPath).catch(() => {
      if (listingRevision.current === listing && downloadRevision.current === request) setDownloadFailed(true);
    });
  };
  const downloadTarget = entries.find((entry) => entry.path === downloadPath);
  const openContextMenu = (event: MouseEvent<HTMLElement>): void => {
    const path = event.target instanceof Element
      ? event.target.closest("[data-fm-path]")?.getAttribute("data-fm-path")
      : undefined;
    const entry = entries.find((candidate) => candidate.path === path);
    if (entry?.kind !== "file" || unavailableReason(entry) !== undefined) {
      event.preventDefault();
      return;
    }
    setDownloadPath(entry.path);
  };

  return (
    <div className="@container flex min-h-0 flex-1 flex-col bg-background text-foreground" data-testid="fm-remote-panel">
      <div className="flex min-w-0 flex-wrap items-center gap-1.5 border-b border-border px-2 py-1.5">
        <div className="flex min-w-0 flex-1 basis-48 items-center gap-1.5">
          <Button type="button" size="icon" variant="ghost" className="shrink-0" aria-label={t.home} onClick={() => navigate()}>
            <Icon name="FolderOpen" className="size-4" aria-hidden />
          </Button>
          <Button type="button" size="icon" variant="ghost" className="shrink-0" aria-label={t.up} disabled={parent === null} onClick={openParent}>
            <Icon name="ArrowUp" className="size-4" aria-hidden />
          </Button>
          <div className="relative flex min-w-0 flex-1" title={path}>
            {pathEdit === null ? (
              <nav aria-label={t.location} className="flex min-w-0 flex-1 items-center text-xs">
                <div className="flex min-w-0 items-center gap-1 overflow-x-auto">
                  {crumbs.map((crumb, index) => (
                    <span key={crumb.path} className="flex shrink-0 items-center gap-1">
                      {index > 0 ? <Icon name="ChevronRight" className="size-3 text-muted-foreground" aria-hidden /> : null}
                      <Button
                        type="button"
                        size="sm"
                        variant="ghost"
                        aria-current={index === crumbs.length - 1 ? "page" : undefined}
                        onClick={() => navigate(crumb.path)}
                      >
                        <span className="max-w-32 truncate" title={crumb.name}>{crumb.name}</span>
                      </Button>
                    </span>
                  ))}
                </div>
                <button
                  ref={editButton}
                  type="button"
                  aria-label={t.editPath}
                  title={t.editPath}
                  disabled={current.status === "loading"}
                  className="h-8 min-w-6 flex-1 cursor-text rounded-md hover:bg-state-hover focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-inset focus-visible:ring-ring"
                  onClick={() => setPathEdit({ status: "editing" })}
                />
              </nav>
            ) : (
              <PathEditor
                initialValue={path ?? ""}
                busy={pathEdit.status === "saving"}
                invalid={pathError !== null}
                errorId={errorId}
                focusTick={0}
                onSubmit={(value) => {
                  if (pathEdit.status === "saving") return;
                  if (!value.startsWith("/") && !WINDOWS_ABSOLUTE_PATH.test(value)) {
                    setPathEdit({ status: "error", code: "invalid_path" });
                  } else {
                    void loadFolder(value, true);
                  }
                }}
                onDirty={() => {
                  invalidatePathEdit();
                  setPathEdit({ status: "editing" });
                }}
                onCancel={({ focusGrid }) => {
                  invalidatePathEdit();
                  restoreEditFocus.current = focusGrid;
                  setPathEdit(null);
                }}
              />
            )}
            {pathError !== null ? (
              <p id={errorId} role="alert" className="absolute left-0 top-full z-20 mt-1 w-max max-w-full break-words rounded-md border border-destructive/40 bg-popover px-2 py-1 text-xs text-destructive shadow-md">
                {pathError}
              </p>
            ) : null}
          </div>
        </div>
        <span className="hidden text-xs text-muted-foreground @sm:inline">{t.readOnly}</span>
        <Button type="button" size="icon" variant="ghost" aria-label={t.list} aria-pressed={viewMode === "list"} onClick={() => changeViewMode("list")}>
          <Icon name="ListView" className="size-4" aria-hidden />
        </Button>
        <Button type="button" size="icon" variant="ghost" aria-label={t.gallery} aria-pressed={viewMode === "gallery"} onClick={() => changeViewMode("gallery")}>
          <Icon name="GridView" className="size-4" aria-hidden />
        </Button>
        <Button type="button" size="icon" variant="ghost" aria-label={t.refresh} onClick={() => navigate(path)}>
          <Icon name="RotateCcw" className="size-4" aria-hidden />
        </Button>
      </div>

      {downloadFailed ? (
        <ErrorBanner
          error={t.retryDownload}
          title={t.downloadFailed}
          onDismiss={() => setDownloadFailed(false)}
        />
      ) : null}

      <ContextMenu onOpenChange={(open) => { if (!open) setDownloadPath(null); }}>
        <ContextMenuTrigger asChild>
          <div className="min-h-0 flex-1 overflow-y-auto" onContextMenu={openContextMenu}>
            {current.status === "loading" ? (
              <p role="status" className="px-3 py-2 text-sm text-muted-foreground">{t.opening}</p>
            ) : current.status === "error" ? (
              <ErrorBanner
                error={errorCode === "unsupported" ? t.unavailable : errorCode === "path_escape" ? t.outsideRoot : t.retryFolder}
                title={t.fetchFailed}
                onRetry={() => navigate(path)}
              />
            ) : entries.length === 0 ? (
              <p className="px-3 py-2 text-sm text-muted-foreground">{t.empty}</p>
            ) : viewMode === "gallery" ? (
              <FileGallery
                entries={entries}
                loading={false}
                selectedPaths={EMPTY_PATHS}
                focusedPath={null}
                cutPaths={EMPTY_PATHS}
                dragEnabled={false}
                dropTargetPath={null}
                previewBaseUrl={previewBaseUrl}
                parentPath={parent}
                onNavigateParent={openParent}
                onOpenEntry={openEntry}
                unavailableReason={unavailableReason}
                onRowClick={noop}
                onRowDoubleClick={noop}
                onRowContextMenu={noop}
                onToggleSelect={noop}
                onRowDragStart={noop}
                onRowDragOver={noop}
                onRowDragLeave={noop}
                onRowDrop={noop}
                onRowDragEnd={noop}
                onParentDragOver={noop}
                onParentDragLeave={noop}
                onParentDrop={noop}
              />
            ) : (
              <ul aria-label={t.files} className="px-2 py-1">
                {entries.map((entry) => {
                  const reason = unavailableReason(entry);
                  return (
                    <li key={entry.path}>
                      <Button
                        type="button"
                        variant="ghost"
                        data-fm-path={entry.path}
                        className="w-full justify-start gap-2 px-2 text-sm font-normal"
                        disabled={reason !== undefined}
                        aria-label={reason === undefined ? undefined : `${entry.name}. ${reason}`}
                        onClick={() => openEntry(entry)}
                      >
                        <Icon name={entryIconName(entry)} className="size-4 shrink-0 text-muted-foreground" aria-hidden />
                        <span className="min-w-0 truncate" title={reason ?? entry.name}>{entry.name}</span>
                      </Button>
                    </li>
                  );
                })}
              </ul>
            )}
            {directory?.truncated ? <p role="status" className="px-3 py-2 text-xs text-muted-foreground">{t.truncated}</p> : null}
          </div>
        </ContextMenuTrigger>
        {downloadTarget !== undefined && directory !== null ? (
          <ContextMenuContent {...menuPointerGuard}>
            <ContextMenuItem onSelect={() => downloadFromMenu(downloadTarget, directory.path)}>
              <Icon name="Download" className="size-4" aria-hidden />
              {t.download}
            </ContextMenuItem>
          </ContextMenuContent>
        ) : null}
      </ContextMenu>

      {preview !== null && directory !== null ? (
        <FileViewerDialog
          key={preview.path}
          open
          entry={preview}
          remote={{ hostId, directoryPath: directory.path }}
          onDownload={() => downloadEntry(preview, directory.path)}
          onOpenChange={(open) => { if (!open) setPreview(null); }}
        />
      ) : null}
    </div>
  );
}
