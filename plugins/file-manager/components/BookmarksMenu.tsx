// components/BookmarksMenu.tsx — the bookmark list (§8.11) and its two hosts.
//
// The list is menu *items*, not a menu, because it has to hang under two
// different triggers: its own dropdown in the wide toolbar, and the panel-tab
// overflow menu in the compact one (components/PanelActions.tsx explains why).
// `BookmarkMenuItems` is therefore the whole feature and `BookmarksMenu` is
// just the wide trigger around it — one implementation, two placements.
//
// A row that is *missing* removes itself when selected rather than carrying a
// nested delete button. A button inside a menu item would be a `<button>`
// inside a `<button>` on compact viewports, where `DropdownMenuItem` renders
// as one — invalid markup for a control nobody can see the point of until they
// hover it. Selecting the row is the only action a dead bookmark has left, so
// the row *is* the action, spelled out in its own text.
import { useEffect, useRef } from "react";

import type { Bookmark } from "../contract";
import { cn } from "../lib/utils";
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

export interface BookmarkMenuItemsProps {
  bookmarks: readonly Bookmark[];
  /** True when the folder on screen is in the list. */
  currentBookmarked: boolean;
  /** False until both the folder and the list have arrived. */
  ready: boolean;
  /** Always the existing `navigateTo` — the panel owns navigation. */
  onNavigate: (path: string) => void;
  onToggleCurrent: () => void;
  onRenameCurrent: () => void;
  onRemove: (path: string) => void;
  /**
   * Re-read the list. Called once per appearance rather than by the trigger,
   * because a menu's content is mounted only while the menu is open — which is
   * exactly the moment `available` has to describe the disk as it is now, and
   * the only rule that holds for both of this component's hosts.
   */
  onRefresh: () => void;
}

export function BookmarkMenuItems({
  bookmarks,
  currentBookmarked,
  ready,
  onNavigate,
  onToggleCurrent,
  onRenameCurrent,
  onRemove,
  onRefresh,
}: BookmarkMenuItemsProps) {
  // Through a ref so the effect stays a mount effect: the callback is rebuilt
  // on every render of the panel, and a dependency on it would re-read the
  // list on every keystroke in the filter field.
  const refreshRef = useRef(onRefresh);
  refreshRef.current = onRefresh;
  useEffect(() => {
    refreshRef.current();
  }, []);

  return (
    <>
      <DropdownMenuLabel>Bookmarks</DropdownMenuLabel>

      {/* A full list does *not* disable this. A control that goes grey with no
          explanation is worse than one that answers: the panel knows the
          ceiling and says what to do about it (lib/bookmarks.ts). */}
      <DropdownMenuItem
        disabled={!ready}
        data-testid="fm-bookmark-toggle-item"
        onSelect={onToggleCurrent}
      >
        <Icon name={currentBookmarked ? "PinOff" : "Star"} className="size-4" aria-hidden="true" />
        {currentBookmarked ? "Remove bookmark" : "Bookmark this folder"}
      </DropdownMenuItem>

      {currentBookmarked ? (
        <DropdownMenuItem data-testid="fm-bookmark-rename" onSelect={onRenameCurrent}>
          <Icon name="Edit" className="size-4" aria-hidden="true" />
          Rename this bookmark…
        </DropdownMenuItem>
      ) : null}

      <DropdownMenuSeparator />

      {bookmarks.length === 0 ? (
        <DropdownMenuItem disabled data-testid="fm-bookmarks-empty">
          No bookmarks yet
        </DropdownMenuItem>
      ) : (
        bookmarks.map((bookmark) =>
          bookmark.available ? (
            <DropdownMenuItem
              key={bookmark.path}
              data-testid="fm-bookmark"
              data-fm-path={bookmark.path}
              title={bookmark.path}
              onSelect={() => onNavigate(bookmark.path)}
            >
              <Icon name="Folder" className="size-4" aria-hidden="true" />
              <span className="truncate">{bookmark.name}</span>
            </DropdownMenuItem>
          ) : (
            <DropdownMenuItem
              key={bookmark.path}
              data-testid="fm-bookmark-missing"
              data-fm-path={bookmark.path}
              title={`${bookmark.path} is gone — choose this row to remove the bookmark`}
              onSelect={() => onRemove(bookmark.path)}
            >
              <Icon name="Trash2" className="size-4" aria-hidden="true" />
              <span className="truncate text-muted-foreground line-through">{bookmark.name}</span>
              {/* `tracking-widest` is for key caps; this is a sentence. */}
              <DropdownMenuShortcut className="tracking-normal">
                Missing — remove
              </DropdownMenuShortcut>
            </DropdownMenuItem>
          ),
        )
      )}
    </>
  );
}

export interface BookmarksMenuProps extends BookmarkMenuItemsProps {
  className?: string;
}

/** The wide toolbar's trigger: the list, one click away from the star. */
export function BookmarksMenu({ className, ...items }: BookmarksMenuProps) {
  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className={cn("h-8 w-8 shrink-0 p-0", className)}
          aria-label="Bookmarks"
          data-testid="fm-bookmarks-menu"
        >
          <Icon name="ChevronDown" className="size-4" aria-hidden="true" />
        </Button>
      </DropdownMenuTrigger>
      {/* Capped and scrollable: fifty rows is a legal list and a menu taller
          than the window is not. */}
      <DropdownMenuContent
        align="end"
        className="max-h-80 w-60 overflow-y-auto"
        data-testid="fm-bookmarks-list"
      >
        <BookmarkMenuItems {...items} />
      </DropdownMenuContent>
    </DropdownMenu>
  );
}
