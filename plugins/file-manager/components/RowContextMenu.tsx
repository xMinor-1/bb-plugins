// components/RowContextMenu.tsx — desktop renderer for selected-entry actions.
import { Fragment } from "react";

import { useMenuPointerGuard } from "../hooks/useMenuPointerGuard";
import {
  selectedEntryActionModel,
  type SelectedEntryActionsProps,
} from "./selected-entry-actions";
import {
  ContextMenuContent,
  ContextMenuItem,
  ContextMenuLabel,
  ContextMenuSeparator,
  ContextMenuShortcut,
} from "./ui/context-menu";
import { Icon } from "./ui/icon";

export type RowContextMenuProps = SelectedEntryActionsProps;

export function RowContextMenu(props: RowContextMenuProps) {
  const model = selectedEntryActionModel(props);
  const pointerGuard = useMenuPointerGuard();

  return (
    <ContextMenuContent className="w-56" data-testid="fm-row-menu" {...pointerGuard}>
      <ContextMenuLabel className="truncate">{model.label}</ContextMenuLabel>
      {model.groups.map((group, groupIndex) => (
        <Fragment key={group[0]?.id ?? String(groupIndex)}>
          <ContextMenuSeparator />
          {group.map((action) => (
            <ContextMenuItem
              key={action.id}
              data-testid={action.id === "bookmark" ? "fm-row-bookmark" : undefined}
              disabled={action.disabled}
              className={
                action.destructive
                  ? "text-destructive focus:bg-destructive/15 focus:text-destructive"
                  : undefined
              }
              onSelect={action.run}
            >
              <Icon name={action.icon} className="size-4" aria-hidden="true" />
              <span data-fm-selected-action={action.id}>{action.label}</span>
              {action.trailing !== undefined || action.shortcut !== undefined ? (
                <ContextMenuShortcut>{action.trailing ?? action.shortcut}</ContextMenuShortcut>
              ) : null}
            </ContextMenuItem>
          ))}
        </Fragment>
      ))}
    </ContextMenuContent>
  );
}
