// components/BackgroundContextMenu.tsx — right-click on empty table space.
//
// Same Radix root as RowContextMenu (see that file); this is the variant the
// panel renders when the click did not land on a row.
import { useMenuPointerGuard } from "../hooks/useMenuPointerGuard";
import {
  ContextMenuCheckboxItem,
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from "./ui/context-menu";
import { Icon } from "./ui/icon";

export interface BackgroundContextMenuProps {
  writable: boolean;
  canPaste: boolean;
  showHidden: boolean;
  onNewFolder: () => void;
  onUpload: () => void;
  onPaste: () => void;
  onSelectAll: () => void;
  onRefresh: () => void;
  onToggleHidden: () => void;
  /** Zero disables the "Collapse all folders" item. */
  expandedCount: number;
  onCollapseAll: () => void;
  onCopyPath: () => void;
  onSetStartFolder: () => void;
  /** Properties of the folder on screen — there is no row to describe here. */
  onProperties: () => void;
  /** True when this folder is already in the bookmark list (§8.11). */
  bookmarked: boolean;
  /** False only while the list has not arrived yet. */
  canToggleBookmark: boolean;
  onToggleBookmark: () => void;
}

export function BackgroundContextMenu({
  writable,
  canPaste,
  showHidden,
  onNewFolder,
  onUpload,
  onPaste,
  onSelectAll,
  onRefresh,
  onToggleHidden,
  expandedCount,
  onCollapseAll,
  onCopyPath,
  onSetStartFolder,
  onProperties,
  bookmarked,
  canToggleBookmark,
  onToggleBookmark,
}: BackgroundContextMenuProps) {
  // Letting go of the right button must not run whatever it landed on.
  const pointerGuard = useMenuPointerGuard();

  return (
    <ContextMenuContent className="w-56" data-testid="fm-background-menu" {...pointerGuard}>
      <ContextMenuItem disabled={!writable} onSelect={onNewFolder}>
        <Icon name="FolderPlus" className="size-4" aria-hidden="true" />
        New folder
        <ContextMenuShortcut>Ctrl+Shift+N</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem disabled={!writable} onSelect={onUpload}>
        <Icon name="PackageReceive" className="size-4" aria-hidden="true" />
        Upload files…
      </ContextMenuItem>
      <ContextMenuItem disabled={!canPaste || !writable} onSelect={onPaste}>
        <Icon name="Copy" className="size-4" aria-hidden="true" />
        Paste
        <ContextMenuShortcut>Ctrl+V</ContextMenuShortcut>
      </ContextMenuItem>

      <ContextMenuSeparator />

      <ContextMenuItem onSelect={onSelectAll}>
        <Icon name="Check" className="size-4" aria-hidden="true" />
        Select all
        <ContextMenuShortcut>Ctrl+A</ContextMenuShortcut>
      </ContextMenuItem>
      <ContextMenuItem onSelect={onRefresh}>
        <Icon name="ArrowReloadHorizontal" className="size-4" aria-hidden="true" />
        Refresh
      </ContextMenuItem>
      <ContextMenuCheckboxItem checked={showHidden} onSelect={onToggleHidden}>
        Show hidden files
        <ContextMenuShortcut>Ctrl+Shift+.</ContextMenuShortcut>
      </ContextMenuCheckboxItem>
      <ContextMenuItem disabled={expandedCount === 0} onSelect={onCollapseAll}>
        <Icon name="Minimize2" className="size-4" aria-hidden="true" />
        Collapse all folders
      </ContextMenuItem>

      <ContextMenuSeparator />

      <ContextMenuItem onSelect={onCopyPath}>
        <Icon name="Paperclip" className="size-4" aria-hidden="true" />
        Copy folder path
      </ContextMenuItem>
      <ContextMenuItem onSelect={onSetStartFolder}>
        <Icon name="Pin" className="size-4" aria-hidden="true" />
        Set as start folder
      </ContextMenuItem>
      {/* Next to the start folder because they answer the same question from
          two sides: one folder you always open, many you jump between. */}
      <ContextMenuItem
        disabled={!canToggleBookmark}
        data-testid="fm-background-bookmark"
        onSelect={onToggleBookmark}
      >
        <Icon name={bookmarked ? "PinOff" : "Star"} className="size-4" aria-hidden="true" />
        {bookmarked ? "Remove bookmark" : "Bookmark this folder"}
      </ContextMenuItem>
      <ContextMenuItem onSelect={onProperties}>
        <Icon name="Info" className="size-4" aria-hidden="true" />
        Properties
        <ContextMenuShortcut>Alt+Enter</ContextMenuShortcut>
      </ContextMenuItem>
    </ContextMenuContent>
  );
}
