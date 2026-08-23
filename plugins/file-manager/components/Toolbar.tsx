// components/Toolbar.tsx — the one persistent control strip.
//
// The path bar on the left (breadcrumbs, or a text field — PATHBAR-SPEC §3),
// then the in-folder filter, the sort menu, the hidden-files toggle and a
// manual refresh. Sort and hidden are persisted through `savePreferences`; the
// filter is client-side only and is deliberately *not* in the URL (§8: a `?`
// in a file name would break it).
import type { DragEvent, RefObject } from "react";

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
  return (
    <div
      data-testid="fm-toolbar"
      className={cn(
        "flex shrink-0 items-center gap-2 border-b border-border px-3 py-2",
        className,
      )}
    >
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

      <div className="relative w-40 shrink-0 @lg:w-56">
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
              } else {
                event.currentTarget.blur();
              }
            }
          }}
        />
      </div>

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

      {volume === null ? null : (
        <span
          className="hidden shrink-0 text-xs tabular-nums text-muted-foreground @2xl:inline"
          title={`${formatBytes(volume.freeBytes)} free of ${formatBytes(volume.totalBytes)}`}
        >
          {formatBytes(volume.freeBytes)} free
        </span>
      )}
    </div>
  );
}
