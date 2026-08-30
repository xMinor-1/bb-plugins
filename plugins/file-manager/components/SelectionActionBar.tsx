// Selected-entry actions for compact/touch layouts.
//
// A context menu is still the fastest desktop interaction, but it has no
// discoverable or reliable equivalent on touch screens. This bar appears once
// an entry is selected and opens the same actions in the responsive dropdown,
// which becomes a bottom drawer on compact viewports.
import type { FileEntry } from "../contract";
import { effectiveKind } from "./FileRow";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuShortcut,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Icon } from "./ui/icon";
import type { RowContextMenuProps } from "./RowContextMenu";

export interface SelectionActionBarProps extends RowContextMenuProps {
  onClear: () => void;
}

export function SelectionActionBar({
  entries,
  writable,
  canPaste,
  canExtract,
  onOpen,
  onDownload,
  onAddToChat,
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
  onProperties,
  bookmarked,
  canToggleBookmark,
  onToggleBookmark,
  onClear,
}: SelectionActionBarProps) {
  const single = entries.length === 1 ? entries[0] : undefined;
  const isDirectory = single !== undefined && effectiveKind(single) === "directory";
  const escapes = entries.some((entry) => entry.escapesRoot);
  const files = entries.filter(
    (entry) => !entry.escapesRoot && effectiveKind(entry) === "file",
  );
  const downloadable = files.length > 0;
  const archive = single !== undefined && single.archiveFormat !== null ? single : undefined;
  const count = entries.length;
  const itemWord = count === 1 ? "item" : "items";

  return (
    <div
      data-testid="fm-selection-bar"
      className="flex min-h-12 items-center gap-2 border-b border-border bg-surface-selected px-3 py-1.5"
    >
      <span className="min-w-0 flex-1 truncate text-sm font-medium" aria-live="polite">
        {String(count)} selected
      </span>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            aria-label={`Actions for ${String(count)} selected ${itemWord}`}
          >
            <Icon name="MoreHorizontal" aria-hidden="true" />
            Actions
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="w-64"
          mobileTitle={`${String(count)} selected ${itemWord}`}
          data-testid="fm-selection-menu"
        >
          <DropdownMenuLabel className="truncate">
            {single === undefined ? `${String(count)} items` : single.name}
          </DropdownMenuLabel>
          <DropdownMenuSeparator />

          {single !== undefined && isDirectory && !escapes ? (
            <DropdownMenuItem onSelect={() => onOpen(single)}>
              <Icon name="FolderOpen" aria-hidden="true" />
              Open
            </DropdownMenuItem>
          ) : null}

          <DropdownMenuItem disabled={!downloadable} onSelect={onDownload}>
            <Icon name="Download" aria-hidden="true" />
            Download
            {entries.length > 1 ? <DropdownMenuShortcut>{entries.length}</DropdownMenuShortcut> : null}
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!downloadable} onSelect={onAddToChat}>
            <Icon name="MessageSquarePlus" aria-hidden="true" />
            Add to chat
            {files.length > 1 ? <DropdownMenuShortcut>{files.length}</DropdownMenuShortcut> : null}
          </DropdownMenuItem>
          {archive === undefined ? null : (
            <DropdownMenuItem disabled={!canExtract || !writable} onSelect={() => onExtract(archive)}>
              <Icon name="ArchiveRestore" aria-hidden="true" />
              Extract…
            </DropdownMenuItem>
          )}

          <DropdownMenuSeparator />

          <DropdownMenuItem disabled={escapes} onSelect={onCut}>
            <Icon name="Layers" aria-hidden="true" />
            Cut
          </DropdownMenuItem>
          <DropdownMenuItem disabled={escapes} onSelect={onCopy}>
            <Icon name="Copy" aria-hidden="true" />
            Copy
          </DropdownMenuItem>
          <DropdownMenuItem disabled={!canPaste || !writable} onSelect={onPaste}>
            <Icon name="PackageReceive" aria-hidden="true" />
            Paste
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenuItem disabled={escapes} onSelect={onMoveTo}>
            <Icon name="FolderExport" aria-hidden="true" />
            Move to…
          </DropdownMenuItem>
          <DropdownMenuItem disabled={escapes} onSelect={onCopyTo}>
            <Icon name="Folder" aria-hidden="true" />
            Copy to…
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenuItem
            disabled={single === undefined || !writable}
            onSelect={() => {
              if (single !== undefined) onRename(single);
            }}
          >
            <Icon name="Edit" aria-hidden="true" />
            Rename
          </DropdownMenuItem>
          <DropdownMenuItem onSelect={onCopyPath}>
            <Icon name="Paperclip" aria-hidden="true" />
            Copy path
          </DropdownMenuItem>
          {single !== undefined && isDirectory && !escapes ? (
            <>
              <DropdownMenuItem onSelect={() => onSetStartFolder(single)}>
                <Icon name="Pin" aria-hidden="true" />
                Set as start folder
              </DropdownMenuItem>
              <DropdownMenuItem
                disabled={!canToggleBookmark}
                onSelect={() => onToggleBookmark(single)}
              >
                <Icon name={bookmarked ? "PinOff" : "Star"} aria-hidden="true" />
                {bookmarked ? "Remove bookmark" : "Bookmark"}
              </DropdownMenuItem>
            </>
          ) : null}
          <DropdownMenuItem onSelect={onProperties}>
            <Icon name="Info" aria-hidden="true" />
            Properties
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenuItem disabled={!writable} variant="destructive" onSelect={onDelete}>
            <Icon name="Trash2" aria-hidden="true" />
            Delete
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <Button
        type="button"
        variant="ghost"
        size="icon"
        className="size-9 shrink-0"
        aria-label="Clear selection"
        onClick={onClear}
      >
        <Icon name="X" aria-hidden="true" />
      </Button>
    </div>
  );
}
