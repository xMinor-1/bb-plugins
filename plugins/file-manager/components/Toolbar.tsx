// components/Toolbar.tsx — the one persistent control strip.
//
// The path bar on the left (breadcrumbs, or a text field — PATHBAR-SPEC §3),
// then the in-folder filter, the sort menu, the hidden-files toggle and a
// manual refresh. Sort and hidden are persisted through `savePreferences`; the
// filter is client-side only and is deliberately *not* in the URL (§8: a `?`
// in a file name would break it).
import type { DragEvent, ReactNode, RefObject } from "react";

import type { SortDirection, SortField } from "../hooks/useDirectory";
import { cn } from "../lib/utils";
import { formatBytes } from "../lib/format";
import { PathBar } from "./PathBar";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Icon } from "./ui/icon";
import { Input } from "./ui/input";

const SORT_LABELS: Record<SortField, string> = {
  name: "Name",
  size: "Size",
  modified: "Modified",
  kind: "Kind",
};

export interface ToolbarProps {
  /**
   * "wide" is the nav panel: every control has its own button, and the title
   * bar carries upload / new folder / the overflow menu.
   * "compact" is a panel tab, a ~450px column with no title bar of its own:
   * sort, hidden files, collapse-all, refresh and the bookmark list move into
   * `actions`' overflow menu, and the filter folds into a magnifier so the
   * path bar keeps a readable width (components/PanelActions.tsx). The
   * bookmark *star* stays on the strip in both variants.
   */
  variant?: "wide" | "compact";
  /** Rendered at the trailing edge; the compact variant's action cluster. */
  actions?: ReactNode;
  /** Compact only: whether the filter field is unfolded. */
  searchOpen?: boolean;
  onSearchOpenChange?: (open: boolean) => void;
  path: string;
  root: string;
  onNavigate: (path: string) => void;
  query: string;
  onQueryChange: (query: string) => void;
  searchInputRef?: RefObject<HTMLInputElement | null>;
  sortField: SortField;
  sortDirection: SortDirection;
  onSortFieldChange: (field: SortField) => void;
  onSortDirectionChange: (direction: SortDirection) => void;
  showHidden: boolean;
  onToggleHidden: () => void;
  /** How many folders the tree currently has open — drives the disabled rule. */
  expandedCount: number;
  onCollapseAll: () => void;
  onRefresh: () => void;
  refreshing: boolean;
  /** How many rows the hidden filter is holding back right now. */
  hiddenCount: number;
  /* --- bookmarks (§8.11) --- */
  /** True when the folder on screen is in the bookmark list. */
  bookmarked: boolean;
  /**
   * False only while the list has not arrived. A full list still toggles: the
   * refusal is a sentence, not a grey button (lib/bookmarks.ts).
   */
  canToggleBookmark: boolean;
  onToggleBookmark: () => void;
  /**
   * The bookmark *list*, as its own dropdown. Rendered in the wide toolbar
   * only: see the compact split below.
   */
  bookmarksMenu?: ReactNode;
  volume: { totalBytes: number; freeBytes: number } | null;
  dropTargetPath?: string | null;
  onDragOverCrumb?: (path: string, event: DragEvent<HTMLElement>) => void;
  onDragLeaveCrumb?: (path: string, event: DragEvent<HTMLElement>) => void;
  onDropOnCrumb?: (path: string, event: DragEvent<HTMLElement>) => void;
  /* --- path bar (PATHBAR-SPEC §3); the panel owns the mode and the commit --- */
  pathEditing: boolean;
  onPathOpen: () => void;
  onPathCancel: (options: { focusGrid: boolean }) => void;
  onPathSubmit: (raw: string) => void;
  pathError: string | null;
  onPathDirty: () => void;
  pathBusy?: boolean;
  pathFocusTick: number;
  className?: string;
}

export function Toolbar({
  variant = "wide",
  actions,
  searchOpen = false,
  onSearchOpenChange,
  path,
  root,
  onNavigate,
  query,
  onQueryChange,
  searchInputRef,
  sortField,
  sortDirection,
  onSortFieldChange,
  onSortDirectionChange,
  showHidden,
  onToggleHidden,
  expandedCount,
  onCollapseAll,
  onRefresh,
  refreshing,
  hiddenCount,
  bookmarked,
  canToggleBookmark,
  onToggleBookmark,
  bookmarksMenu,
  volume,
  dropTargetPath = null,
  onDragOverCrumb,
  onDragLeaveCrumb,
  onDropOnCrumb,
  pathEditing,
  onPathOpen,
  onPathCancel,
  onPathSubmit,
  pathError,
  onPathDirty,
  pathBusy = false,
  pathFocusTick,
  className,
}: ToolbarProps) {
  const compact = variant === "compact";
  // Compact keeps one of the two: the path bar, or the filter it folded out
  // into. Both at once leaves neither wide enough to read.
  const filterExpanded = !compact || searchOpen;

  const filterField = (
    <div className={cn("relative", compact ? "min-w-0 flex-1" : "w-40 shrink-0 @lg:w-56")}>
      <Icon
        name="Search"
        className="pointer-events-none absolute left-2 top-1/2 size-3.5 -translate-y-1/2 text-muted-foreground"
        aria-hidden="true"
      />
      <Input
        ref={searchInputRef}
        type="search"
        value={query}
        data-testid="fm-search"
        aria-label="Filter this folder"
        placeholder="Filter…"
        className="h-8 pl-7 text-sm"
        onChange={(event) => onQueryChange(event.target.value)}
        onKeyDown={(event) => {
          if (event.key === "Escape") {
            event.stopPropagation();
            if (query !== "") {
              event.preventDefault();
              onQueryChange("");
              return;
            }
            // Compact folds the field away again, so Escape leaves the folder
            // on screen rather than a stranded empty input.
            if (compact) {
              event.preventDefault();
              onSearchOpenChange?.(false);
              return;
            }
            event.currentTarget.blur();
          }
        }}
      />
    </div>
  );

  return (
    <div
      data-testid="fm-toolbar"
      data-fm-toolbar-variant={variant}
      className={cn(
        "flex shrink-0 items-center gap-2 border-b border-border px-3 py-2",
        className,
      )}
    >
      {filterExpanded && compact ? null : (
        <PathBar
          path={path}
          root={root}
          onNavigate={onNavigate}
          editing={pathEditing}
          onOpen={onPathOpen}
          onCancel={onPathCancel}
          onSubmit={onPathSubmit}
          error={pathError}
          onDirty={onPathDirty}
          busy={pathBusy}
          focusTick={pathFocusTick}
          dropTargetPath={dropTargetPath}
          onDragOverCrumb={onDragOverCrumb}
          onDragLeaveCrumb={onDragLeaveCrumb}
          onDropOnCrumb={onDropOnCrumb}
        />
      )}

      {filterExpanded ? filterField : null}

      {compact ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 w-8 shrink-0 p-0"
          aria-label={searchOpen ? "Hide the filter" : "Filter this folder"}
          aria-pressed={searchOpen}
          data-testid="fm-search-toggle"
          onClick={() => {
            if (searchOpen && query !== "") onQueryChange("");
            onSearchOpenChange?.(!searchOpen);
          }}
        >
          <Icon name={searchOpen ? "X" : "Search"} className="size-4" aria-hidden="true" />
        </Button>
      ) : null}

      {/* §8.11. The star stays in *both* variants: it is the only control on
          the strip whose state is the answer to a question ("is this folder
          one of mine?"), and an overflow item cannot show state without being
          opened. The list beside it is a browse action, not a per-folder one,
          so compact hands it to the panel-tab overflow instead — a second
          trigger button does not fit a ~450px column
          (components/PanelActions.tsx). */}
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-8 w-8 shrink-0 p-0"
        aria-pressed={bookmarked}
        aria-label={bookmarked ? "Remove bookmark" : "Bookmark this folder"}
        data-testid="fm-bookmark-toggle"
        disabled={!canToggleBookmark}
        onClick={onToggleBookmark}
      >
        <Icon
          name="Star"
          className={cn("size-4", bookmarked && "text-primary")}
          aria-hidden="true"
        />
      </Button>

      {compact ? null : bookmarksMenu}

      {compact ? null : (
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 shrink-0 gap-1 px-2"
            aria-label="Sort"
            data-testid="fm-sort-menu"
          >
            <Icon name="Sort" className="size-4" aria-hidden="true" />
            <span className="hidden text-xs @lg:inline">{SORT_LABELS[sortField]}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-44">
          <DropdownMenuLabel>Sort by</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={sortField}
            onValueChange={(value) => onSortFieldChange(value as SortField)}
          >
            {(Object.keys(SORT_LABELS) as SortField[]).map((field) => (
              <DropdownMenuRadioItem key={field} value={field}>
                {SORT_LABELS[field]}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
          <DropdownMenuSeparator />
          <DropdownMenuRadioGroup
            value={sortDirection}
            onValueChange={(value) => onSortDirectionChange(value as SortDirection)}
          >
            <DropdownMenuRadioItem value="asc">Ascending</DropdownMenuRadioItem>
            <DropdownMenuRadioItem value="desc">Descending</DropdownMenuRadioItem>
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
      )}

      {compact ? null : (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-8 w-8 shrink-0 p-0"
        aria-pressed={showHidden}
        aria-label={
          showHidden
            ? "Hide hidden files"
            : hiddenCount > 0
              ? `Show hidden files (${String(hiddenCount)} hidden)`
              : "Show hidden files"
        }
        data-testid="fm-toggle-hidden"
        onClick={onToggleHidden}
      >
        <Icon name={showHidden ? "Eye" : "EyeOff"} className="size-4" aria-hidden="true" />
      </Button>
      )}

      {compact ? null : (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-8 w-8 shrink-0 p-0"
        aria-label="Collapse all folders"
        data-testid="fm-collapse-all"
        disabled={expandedCount === 0}
        onClick={onCollapseAll}
      >
        <Icon name="Minimize2" className="size-4" aria-hidden="true" />
      </Button>
      )}

      {compact ? null : (
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-8 w-8 shrink-0 p-0"
        aria-label="Refresh"
        data-testid="fm-refresh"
        onClick={onRefresh}
      >
        <Icon
          name="ArrowReloadHorizontal"
          className={cn("size-4", refreshing && "animate-spin")}
          aria-hidden="true"
        />
      </Button>
      )}

      {compact || volume === null ? null : (
        <span
          className="hidden shrink-0 text-xs tabular-nums text-muted-foreground @2xl:inline"
          title={`${formatBytes(volume.freeBytes)} free of ${formatBytes(volume.totalBytes)}`}
        >
          {formatBytes(volume.freeBytes)} free
        </span>
      )}

      {actions}
    </div>
  );
}
