// components/RowContextMenu.tsx — right-click menu for the current selection.
//
// Renders only the `<ContextMenuContent>`: the panel owns one Radix
// ContextMenu root around the whole table, and swaps this component for
// BackgroundContextMenu depending on where the click landed. One root avoids
// the double-open you get when a per-row trigger and a container trigger both
// see the same `contextmenu` event.
import type { FileEntry } from "../contract";
import { useMenuPointerGuard } from "../hooks/useMenuPointerGuard";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from "./ui/context-menu";
import { Icon } from "./ui/icon";
import { effectiveKind } from "./FileRow";

export interface RowContextMenuProps {
  /** Everything the action applies to; never empty when this is rendered. */
  entries: readonly FileEntry[];
  /** False when `listDir` said the current directory is read-only. */
  writable: boolean;
  canPaste: boolean;
  /** True when at least one extractor exists for the selected archive. */
  canExtract: boolean;
  onOpen: (entry: FileEntry) => void;
  onDownload: () => void;
  onExtract: (entry: FileEntry) => void;
  onCut: () => void;
  onCopy: () => void;
  onPaste: () => void;
  onMoveTo: () => void;
  onCopyTo: () => void;
  onRename: (entry: FileEntry) => void;
  onCopyPath: () => void;
  onDelete: () => void;
  onSetStartFolder: (entry: FileEntry) => void;
}

export function RowContextMenu({
  entries,
  writable,
  canPaste,
  canExtract,
  onOpen,
  onDownload,
  onExtract,
  onCut,
  onCopy,
  onPaste,
  onMoveTo,
  onCopyTo,
  onRename,
  onCopyPath,
  onDelete,
  onSetStartFolder,
}: RowContextMenuProps) {
  const single = entries.length === 1 ? entries[0] : undefined;
  const isDirectory = single !== undefined && effectiveKind(single) === "directory";
  const escapes = entries.some((entry) => entry.escapesRoot);
  const downloadable = entries.some(
    (entry) => !entry.escapesRoot && effectiveKind(entry) === "file",
  );
  const archive = single !== undefined && single.archiveFormat !== null ? single : undefined;
  // Letting go of the right button must not run whatever it landed on.
  const pointerGuard = useMenuPointerGuard();

  return (
    <ContextMenuContent className="w-56" data-testid="fm-row-menu" {...pointerGuard}>
      <ContextMenuLabel className="truncate">
        {single === undefined ? `${String(entries.length)} items` : single.name}
      </ContextMenuLabel>
      <ContextMenuSeparator />

      {single !== undefined && isDirectory && !escapes ? (
        <ContextMenuItem onSelect={() => onOpen(single)}>
          <Icon name="FolderOpen" className="size-4" aria-hidden="true" />
          Open
        </ContextMenuItem>
      ) : null}

      <ContextMenuItem disabled={!downloadable} onSelect={onDownload}>
        <Icon name="Download" className="size-4" aria-hidden="true" />
        Download
        {entries.length > 1 ? <ContextMenuShortcut>{entries.length}</ContextMenuShortcut> : null}
      </ContextMenuItem>

      {archive === undefined ? null : (
        <ContextMenuItem disabled={!canExtract || !writable} onSelect={() => onExtract(archive)}>
          <Icon name="ArchiveRestore" className="size-4" aria-hidden="true" />
          Extract…
        </ContextMenuItem>
      )}

      <ContextMenuSeparator />

      <ContextMenuItem disabled={escapes} onSelect={onCut}>
        <Icon name="Layers" className="size-4" aria-hidden="true" />
        Cut
        <ContextMenuShortcut>Ctrl+X</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem disabled={escapes} onSelect={onCopy}>
        <Icon name="Copy" className="size-4" aria-hidden="true" />
        Copy
        <ContextMenuShortcut>Ctrl+C</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem disabled={!canPaste || !writable} onSelect={onPaste}>
        <Icon name="PackageReceive" className="size-4" aria-hidden="true" />
        Paste
        <ContextMenuShortcut>Ctrl+V</ContextMenuShortcut>
      </ContextMenuItem>

      <ContextMenuSeparator />

      <ContextMenuItem disabled={escapes} onSelect={onMoveTo}>
        <Icon name="FolderExport" className="size-4" aria-hidden="true" />
        Move to…
      </ContextMenuItem>
      <ContextMenuItem disabled={escapes} onSelect={onCopyTo}>
        <Icon name="Folder" className="size-4" aria-hidden="true" />
        Copy to…
      </ContextMenuItem>

      <ContextMenuSeparator />

      <ContextMenuItem
        disabled={single === undefined || !writable}
        onSelect={() => {
          if (single !== undefined) onRename(single);
        }}
      >
        <Icon name="Edit" className="size-4" aria-hidden="true" />
        Rename
        <ContextMenuShortcut>F2</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem onSelect={onCopyPath}>
        <Icon name="Paperclip" className="size-4" aria-hidden="true" />
        Copy path
      </ContextMenuItem>
      {single !== undefined && isDirectory && !escapes ? (
        <ContextMenuItem onSelect={() => onSetStartFolder(single)}>
          <Icon name="Pin" className="size-4" aria-hidden="true" />
          Set as start folder
        </ContextMenuItem>
      ) : null}

      <ContextMenuSeparator />

      <ContextMenuItem
        disabled={!writable}
        className="text-destructive focus:bg-destructive/15 focus:text-destructive"
        onSelect={onDelete}
      >
        <Icon name="Trash2" className="size-4" aria-hidden="true" />
        Delete
        <ContextMenuShortcut>Del</ContextMenuShortcut>
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
