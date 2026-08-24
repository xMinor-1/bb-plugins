// components/PanelActions.tsx — the action cluster a panel tab wears.
//
// A nav panel gets its actions from the shared title bar (components/
// HeaderActions.tsx, wired through the panel bus). A panel tab has no title
// bar: the host paints a tab strip and hands the plugin the whole content
// area. So the same actions ride here, inside the toolbar, and everything the
// wide toolbar spreads across the strip — sort, hidden files, collapse all,
// refresh — folds into the one overflow menu, because a side panel is ~450px
// wide and the path bar has to keep its share of it.
import type { SortDirection, SortField } from "../hooks/useDirectory";
import type { PanelCommand } from "./panel-bus";
import { Button } from "./ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "./ui/dropdown-menu";
import { Icon } from "./ui/icon";

const SORT_LABELS: Record<SortField, string> = {
  name: "Name",
  size: "Size",
  modified: "Modified",
  kind: "Kind",
};

export interface PanelActionsProps {
  /** False until the bootstrap lands: every action needs a folder to act on. */
  ready: boolean;
  /** False when the backend reported the folder read-only. */
  writable: boolean;
  canPaste: boolean;
  showHidden: boolean;
  sortField: SortField;
  sortDirection: SortDirection;
  /** How many folders the tree has open — drives the collapse-all rule. */
  expandedCount: number;
  onCommand: (command: PanelCommand) => void;
  onSortFieldChange: (field: SortField) => void;
  onSortDirectionChange: (direction: SortDirection) => void;
}

export function PanelActions({
  ready,
  writable,
  canPaste,
  showHidden,
  sortField,
  sortDirection,
  expandedCount,
  onCommand,
  onSortFieldChange,
  onSortDirectionChange,
}: PanelActionsProps) {
  const mutationsDisabled = !ready || !writable;

  return (
    <div className="flex shrink-0 items-center gap-1" data-testid="fm-panel-actions">
      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-8 w-8 shrink-0 p-0"
        disabled={mutationsDisabled}
        aria-label="Upload files"
        data-testid="fm-panel-upload"
        // Dispatched straight from the click handler: the panel's hidden
        // <input type="file"> only opens while the user gesture is still live.
        onClick={() => onCommand({ type: "upload" })}
      >
        <Icon name="PackageReceive" className="size-4" aria-hidden="true" />
      </Button>

      <Button
        type="button"
        variant="ghost"
        size="sm"
        className="h-8 w-8 shrink-0 p-0"
        disabled={mutationsDisabled}
        aria-label="New folder"
        data-testid="fm-panel-new-folder"
        onClick={() => onCommand({ type: "new-folder" })}
      >
        <Icon name="FolderPlus" className="size-4" aria-hidden="true" />
      </Button>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            className="h-8 w-8 shrink-0 p-0"
            aria-label="More actions"
            data-testid="fm-panel-overflow"
          >
            <Icon name="MoreHorizontal" className="size-4" aria-hidden="true" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-56">
          <DropdownMenuItem
            disabled={!ready}
            data-testid="fm-panel-refresh"
            onSelect={() => onCommand({ type: "refresh" })}
          >
            <Icon name="ArrowReloadHorizontal" className="size-4" aria-hidden="true" />
            Refresh
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!ready}
            data-testid="fm-panel-toggle-hidden"
            onSelect={() => onCommand({ type: "toggle-hidden" })}
          >
            <Icon name={showHidden ? "EyeOff" : "Eye"} className="size-4" aria-hidden="true" />
            {showHidden ? "Hide hidden files" : "Show hidden files"}
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={expandedCount === 0}
            data-testid="fm-panel-collapse-all"
            onSelect={() => onCommand({ type: "collapse-all" })}
          >
            <Icon name="Minimize2" className="size-4" aria-hidden="true" />
            Collapse all folders
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!ready}
            data-testid="fm-panel-select-all"
            onSelect={() => onCommand({ type: "select-all" })}
          >
            <Icon name="Check" className="size-4" aria-hidden="true" />
            Select all
          </DropdownMenuItem>

          <DropdownMenuSeparator />

          <DropdownMenuItem
            disabled={!canPaste || mutationsDisabled}
            data-testid="fm-panel-paste"
            onSelect={() => onCommand({ type: "paste" })}
          >
            <Icon name="Copy" className="size-4" aria-hidden="true" />
            Paste
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!ready}
            data-testid="fm-panel-copy-path"
            onSelect={() => onCommand({ type: "copy-path" })}
          >
            <Icon name="Paperclip" className="size-4" aria-hidden="true" />
            Copy folder path
          </DropdownMenuItem>
          <DropdownMenuItem
            disabled={!ready}
            data-testid="fm-panel-set-start-folder"
            onSelect={() => onCommand({ type: "set-start-folder" })}
          >
            <Icon name="Pin" className="size-4" aria-hidden="true" />
            Set as start folder
          </DropdownMenuItem>

          <DropdownMenuSeparator />

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
    </div>
  );
}
