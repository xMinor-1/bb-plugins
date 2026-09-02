// Selected-entry actions for compact and coarse-pointer layouts.
import { Fragment } from "react";

import {
  selectedEntryActionModel,
  type SelectedEntryActionsProps,
} from "./selected-entry-actions";
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
import { CompactViewportOverrideProvider } from "./ui/hooks/use-compact-viewport";
import { Icon } from "./ui/icon";

export interface SelectionActionBarProps extends SelectedEntryActionsProps {
  onClear: () => void;
}

export function SelectionActionBar({ onClear, ...actionProps }: SelectionActionBarProps) {
  const model = selectedEntryActionModel(actionProps);
  const count = actionProps.entries.length;
  const itemWord = count === 1 ? "item" : "items";

  return (
    <div
      data-testid="fm-selection-bar"
      className="flex min-h-12 items-center gap-2 border-b border-border bg-surface-selected px-3 py-1.5"
    >
      <span className="min-w-0 flex-1 truncate text-sm font-medium" aria-live="polite">
        {String(count)} selected
      </span>

      {/* This surface exists for touch use. Force the responsive menu into its
          drawer renderer even on a wide coarse-pointer device. */}
      <CompactViewportOverrideProvider isCompactViewport>
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
            <DropdownMenuLabel className="truncate">{model.label}</DropdownMenuLabel>
            {model.groups.map((group, groupIndex) => (
              <Fragment key={group[0]?.id ?? String(groupIndex)}>
                <DropdownMenuSeparator />
                {group.map((action) => (
                  <DropdownMenuItem
                    key={action.id}
                    disabled={action.disabled}
                    variant={action.destructive ? "destructive" : "default"}
                    onSelect={action.run}
                  >
                    <Icon name={action.icon} aria-hidden="true" />
                    <span data-fm-selected-action={action.id}>{action.label}</span>
                    {action.trailing === undefined ? null : (
                      <DropdownMenuShortcut>{action.trailing}</DropdownMenuShortcut>
                    )}
                  </DropdownMenuItem>
                ))}
              </Fragment>
            ))}
          </DropdownMenuContent>
        </DropdownMenu>
      </CompactViewportOverrideProvider>

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
