// components/PanelActions.tsx — the action cluster a panel tab wears.
//
// A nav panel gets its actions from the shared title bar (components/
// HeaderActions.tsx, wired through the panel bus). A panel tab has no title
// bar: the host paints a tab strip and hands the plugin the whole content
// area. So the same actions ride here, inside the toolbar, and everything the
// wide toolbar spreads across the strip — sort, hidden files, collapse all,
// refresh — folds into the one overflow menu, because a side panel is ~450px
// wide and the path bar has to keep its share of it.
//
// One action exists here and nowhere else: the jump into the thread's own
// checkout (§10.3). Only this surface is told which thread it belongs to.
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

/**
 * §10.3 — the jump into the thread's own checkout. Only the panel tab of an
 * existing thread ever has one; every other surface passes null.
 */
export interface ThreadFolderAction {
  /** True when the jump can happen right now. */
  available: boolean;
  /** Why it cannot, already phrased for display; null when it can. */
  blockedReason: string | null;
  onOpen: () => void;
}

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
  /** Null on a surface with no thread, and while the lookup is still running. */
  threadFolder?: ThreadFolderAction | null;
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
  threadFolder = null,
}: PanelActionsProps) {
  const mutationsDisabled = !ready || !writable;
  /*
   * Where the thread folder lives, and why it has two homes rather than one.
   *
   * A jump into the thread's own code is the whole reason this tab sits beside
   * the thread, so while it can be used it gets its own button rather than a
   * row two clicks deep in the overflow — spending the feature to save 32px
   * would be the wrong trade. When it cannot be used the button would be a
   * dead pixel that cannot explain itself — the vendored Tooltip is unusable
   * here (Radix tooltip is a devDependency, so shipping it would break a
   * catalog install) and a disabled <button> shows no native tooltip in every
   * browser either — so the reason moves into the overflow menu as a disabled
   * row: full text, and the place a user looks for a missing action. Never
   * both at once; one action must not appear twice in one strip.
   */
  const blockedReason = threadFolder?.blockedReason ?? null;

  return (
    <div className="flex shrink-0 items-center gap-1" data-testid="fm-panel-actions">
      {threadFolder?.available === true ? (
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 w-8 shrink-0 p-0"
          aria-label="Open this thread's workspace folder"
          data-testid="fm-panel-thread-folder"
          onClick={threadFolder.onOpen}
        >
          <Icon name="FolderGit" className="size-4" aria-hidden="true" />
        </Button>
      ) : null}

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
          {blockedReason === null ? null : (
            <>
              <DropdownMenuItem disabled data-testid="fm-panel-thread-folder-blocked">
                <Icon name="FolderGit" className="size-4" aria-hidden="true" />
                {blockedReason}
              </DropdownMenuItem>
              <DropdownMenuSeparator />
            </>
          )}
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
