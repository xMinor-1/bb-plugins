// components/FileTable.tsx — header row, sort affordances, skeleton and body.
//
// A real <table> (the vendored @bb/table parts) minus its own scroll wrapper:
// the panel owns the scroll container (§9), so the header can be `sticky` to
// it. Multi-select is click-driven only — no rubber band — which keeps the
// row a clean drag source (§8.4).
import type { DragEvent, MouseEvent, ReactNode, RefObject } from "react";

import type { FileEntry } from "../contract";
import { basename } from "../lib/fm-paths";
import { INDENT_STEP_PX, MAX_INDENT_DEPTH, type TreeRow, type TreeStatusRow } from "../lib/fm-tree";
import { cn } from "../lib/utils";
import { Button } from "./ui/button";
import { Icon, type IconName } from "./ui/icon";
import { TableBody, TableCell, TableHead, TableHeader, TableRow } from "./ui/table";
import { FileRow, rowDomId } from "./FileRow";

export type SortField = "name" | "size" | "modified" | "kind";
export type SortDirection = "asc" | "desc";

export interface FileTableProps {
  /** The flattened tree: entry rows plus the empty/error status rows. */
  rows: readonly TreeRow[];
  loading: boolean;
  selectedPaths: ReadonlySet<string>;
  focusedPath: string | null;
  cutPaths: ReadonlySet<string>;
  dragEnabled: boolean;
  sortField: SortField;
  sortDirection: SortDirection;
  onSort: (field: SortField) => void;
  /** Absolute parent path, or null at the root — drives the `..` row. */
  parentPath: string | null;
  onNavigateParent: () => void;
  /** Path currently highlighted as a drop target (row, `..` or breadcrumb). */
  dropTargetPath: string | null;
  onSelectAll: (selectAll: boolean) => void;
  /** Chevron click: expand or collapse this folder in place. */
  onToggleExpand: (entry: FileEntry) => void;
  /** Retry the child listing of one failed folder. */
  onRetryNode: (path: string) => void;
  onRowClick: (entry: FileEntry, event: MouseEvent<HTMLElement>) => void;
  onRowDoubleClick: (entry: FileEntry) => void;
  onRowContextMenu: (entry: FileEntry, event: MouseEvent<HTMLElement>) => void;
  onToggleSelect: (entry: FileEntry) => void;
  onRowDragStart: (entry: FileEntry, event: DragEvent<HTMLElement>) => void;
  onRowDragOver: (entry: FileEntry, event: DragEvent<HTMLElement>) => void;
  onRowDragLeave: (entry: FileEntry, event: DragEvent<HTMLElement>) => void;
  onRowDrop: (entry: FileEntry, event: DragEvent<HTMLElement>) => void;
  onRowDragEnd: (event: DragEvent<HTMLElement>) => void;
  onParentDragOver: (event: DragEvent<HTMLElement>) => void;
  onParentDragLeave: (event: DragEvent<HTMLElement>) => void;
  onParentDrop: (event: DragEvent<HTMLElement>) => void;
  nowMs: number;
  /**
   * The grid itself is the panel's keyboard widget: it holds `tabIndex={0}`
   * and `aria-activedescendant`, so the panel needs a handle to focus it.
   */
  gridRef?: RefObject<HTMLTableElement | null>;
  /** Rendered in place of the body when there are no rows. */
  emptyState?: ReactNode;
}

const SKELETON_ROWS = 8;

function sortIcon(active: boolean, direction: SortDirection): IconName {
  if (!active) return "ArrowUpDown";
  return direction === "asc" ? "ArrowUp" : "ArrowDown";
}

interface SortHeadProps {
  field: SortField;
  label: string;
  activeField: SortField;
  direction: SortDirection;
  onSort: (field: SortField) => void;
  className?: string;
  align?: "left" | "right";
}

function SortHead({
  field,
  label,
  activeField,
  direction,
  onSort,
  className,
  align = "left",
}: SortHeadProps) {
  const active = activeField === field;
  return (
    <TableHead
      aria-sort={active ? (direction === "asc" ? "ascending" : "descending") : "none"}
      className={cn("h-8 px-2 text-xs font-medium", className)}
    >
      <button
        type="button"
        data-testid={`fm-sort-${field}`}
        onClick={() => onSort(field)}
        className={cn(
          "flex h-7 w-full items-center gap-1 rounded-md px-1 hover:bg-state-hover",
          "focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
          align === "right" && "justify-end",
          active && "text-foreground",
        )}
      >
        <span>{label}</span>
        <Icon
          name={sortIcon(active, direction)}
          className={cn("size-3 shrink-0", active ? "opacity-100" : "opacity-40")}
          aria-hidden="true"
        />
      </button>
    </TableHead>
  );
}

/**
 * The one-line answer an expanded folder owes the user: "nothing in here", or
 * why the listing failed plus a way to try again. Carries no `data-fm-path`,
 * so it is invisible to selection, to the background-click handler and to
 * `focusRow`.
 */
function StatusRow({ row, onRetry }: { row: TreeStatusRow; onRetry: (path: string) => void }) {
  const indentPx = Math.min(row.depth, MAX_INDENT_DEPTH) * INDENT_STEP_PX;
  const failed = row.status === "error";
  return (
    <TableRow
      data-testid={failed ? "fm-tree-error" : "fm-tree-empty"}
      data-fm-parent-path={row.parentPath}
      className="h-9 border-b border-border-hairline text-xs hover:bg-transparent"
    >
      <TableCell className="w-8 py-0 pl-3 pr-0" />
      <TableCell className="min-w-0 py-0" colSpan={3}>
        <div
          className="flex min-w-0 items-center gap-2 text-muted-foreground"
          style={indentPx === 0 ? undefined : { paddingInlineStart: indentPx }}
        >
          <span className="size-4 shrink-0" aria-hidden="true" />
          {failed ? (
            <>
              <Icon name="AlertTriangle" className="size-3.5 shrink-0 text-destructive" aria-hidden="true" />
              <span className="truncate">{row.message}</span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid="fm-tree-retry"
                aria-label={`Retry loading ${basename(row.parentPath)}`}
                className="h-6 shrink-0 px-2 text-xs"
                onClick={(event) => {
                  event.stopPropagation();
                  onRetry(row.parentPath);
                }}
              >
                Retry
              </Button>
            </>
          ) : (
            <span className="truncate italic">{row.message ?? "Empty folder"}</span>
          )}
        </div>
      </TableCell>
    </TableRow>
  );
}

export function FileTable(props: FileTableProps) {
  const {
    rows,
    loading,
    selectedPaths,
    focusedPath,
    cutPaths,
    sortField,
    sortDirection,
    onSort,
    parentPath,
    onNavigateParent,
    dropTargetPath,
    onSelectAll,
    nowMs,
    emptyState,
  } = props;

  let entryCount = 0;
  let selectedCount = 0;
  let focusOnScreen = false;
  for (const row of rows) {
    if (row.kind !== "entry") continue;
    entryCount += 1;
    if (selectedPaths.has(row.entry.path)) selectedCount += 1;
    if (row.entry.path === focusedPath) focusOnScreen = true;
  }
  const allSelected = entryCount > 0 && selectedCount === entryCount;
  const someSelected = selectedCount > 0 && !allSelected;

  return (
    <table
      ref={props.gridRef}
      role="treegrid"
      aria-multiselectable="true"
      aria-label="Files"
      // The keyboard cursor is a row that never takes DOM focus (rows stay
      // `tabIndex={-1}` so the grid is one tab stop, and the drag source keeps
      // its own focus behaviour), so the grid announces it the ARIA way.
      // Dangling ids are worse than none: only point at a row that is rendered.
      tabIndex={0}
      aria-activedescendant={
        focusOnScreen && focusedPath !== null ? rowDomId(focusedPath) : undefined
      }
      data-testid="fm-table"
      className="w-full caption-bottom border-separate border-spacing-0 text-sm outline-none"
    >
      <TableHeader className="sticky top-0 z-10 bg-background [&_tr]:border-b [&_tr]:border-border">
        <TableRow className="hover:bg-transparent">
          <TableHead className="h-8 w-8 pl-3 pr-0">
            <input
              type="checkbox"
              data-testid="fm-select-all"
              aria-label="Select all"
              className="size-3.5 cursor-pointer accent-primary align-middle"
              checked={allSelected}
              ref={(node) => {
                if (node !== null) node.indeterminate = someSelected;
              }}
              onChange={(event) => onSelectAll(event.target.checked)}
            />
          </TableHead>
          <SortHead
            field="name"
            label="Name"
            activeField={sortField}
            direction={sortDirection}
            onSort={onSort}
          />
          <SortHead
            field="size"
            label="Size"
            activeField={sortField}
            direction={sortDirection}
            onSort={onSort}
            align="right"
            className="hidden w-24 @md:table-cell"
          />
          <SortHead
            field="modified"
            label="Modified"
            activeField={sortField}
            direction={sortDirection}
            onSort={onSort}
            className="hidden w-32 @md:table-cell"
          />
        </TableRow>
      </TableHeader>

      <TableBody>
        {parentPath === null ? null : (
          <TableRow
            data-testid="fm-parent-row"
            data-fm-parent={parentPath}
            data-drop-target={dropTargetPath === parentPath ? "true" : undefined}
            className={cn(
              "h-9 cursor-default border-b border-border-hairline text-sm select-none hover:bg-state-hover",
              dropTargetPath === parentPath && "ring-2 ring-inset ring-primary/50",
            )}
            onDoubleClick={onNavigateParent}
            onDragOver={props.onParentDragOver}
            onDragLeave={props.onParentDragLeave}
            onDrop={props.onParentDrop}
          >
            <TableCell className="w-8 py-0 pl-3 pr-0" />
            <TableCell className="py-0" colSpan={3}>
              <button
                type="button"
                onClick={onNavigateParent}
                className="flex items-center gap-2 rounded-md px-1 text-muted-foreground hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
              >
                <Icon name="FolderOpen" className="size-4" aria-hidden="true" />
                <span>..</span>
              </button>
            </TableCell>
          </TableRow>
        )}

        {loading && rows.length === 0
          ? Array.from({ length: SKELETON_ROWS }, (_unused, index) => (
              <TableRow
                key={`skeleton-${String(index)}`}
                data-testid="fm-skeleton-row"
                className="h-9 border-b border-border-hairline hover:bg-transparent"
              >
                <TableCell className="w-8 py-0 pl-3 pr-0">
                  <div className="size-3.5 animate-pulse rounded-sm bg-surface-recessed" />
                </TableCell>
                <TableCell className="py-0">
                  <div
                    className="h-3 animate-pulse rounded-sm bg-surface-recessed"
                    style={{ width: `${String(35 + ((index * 13) % 45))}%` }}
                  />
                </TableCell>
                <TableCell className="hidden py-0 @md:table-cell">
                  <div className="ml-auto h-3 w-12 animate-pulse rounded-sm bg-surface-recessed" />
                </TableCell>
                <TableCell className="hidden py-0 @md:table-cell">
                  <div className="h-3 w-16 animate-pulse rounded-sm bg-surface-recessed" />
                </TableCell>
              </TableRow>
            ))
          : rows.map((row) =>
              row.kind === "status" ? (
                <StatusRow key={row.key} row={row} onRetry={props.onRetryNode} />
              ) : (
                <FileRow
                  key={row.key}
                  entry={row.entry}
                  dragEnabled={props.dragEnabled}
                  depth={row.depth}
                  expandable={row.expandable}
                  expanded={row.expanded}
                  loadingChildren={row.loading}
                  childrenTruncated={row.childrenTruncated}
                  onToggleExpand={props.onToggleExpand}
                  nowMs={nowMs}
                  selected={selectedPaths.has(row.entry.path)}
                  focused={focusedPath === row.entry.path}
                  cut={cutPaths.has(row.entry.path)}
                  dropTarget={dropTargetPath === row.entry.path}
                  onRowClick={props.onRowClick}
                  onRowDoubleClick={props.onRowDoubleClick}
                  onRowContextMenu={props.onRowContextMenu}
                  onToggleSelect={props.onToggleSelect}
                  onRowDragStart={props.onRowDragStart}
                  onRowDragOver={props.onRowDragOver}
                  onRowDragLeave={props.onRowDragLeave}
                  onRowDrop={props.onRowDrop}
                  onRowDragEnd={props.onRowDragEnd}
                />
              ),
            )}

        {!loading && rows.length === 0 && emptyState !== undefined ? (
          <TableRow className="hover:bg-transparent">
            <TableCell colSpan={4} className="p-0">
              {emptyState}
            </TableCell>
          </TableRow>
        ) : null}
      </TableBody>
    </table>
  );
}
