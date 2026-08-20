// components/Breadcrumbs.tsx — clickable ancestors of the current directory.
//
// Every crumb is also an internal drag&drop target (§8.4): dropping a row on
// "Home" moves it to the root. External (OS) drops resolve to a crumb too, so
// the same element carries both protocols.
import type { DragEvent } from "react";

import { Icon } from "./ui/icon";
import { cn } from "../lib/utils";
import { breadcrumbs } from "../lib/fm-paths";

export interface BreadcrumbsProps {
  /** Absolute path of the directory being shown. */
  path: string;
  root: string;
  onNavigate: (path: string) => void;
  /** Absolute path currently highlighted as a drop target, if any. */
  dropTargetPath?: string | null;
  onDragOverTarget?: (path: string, event: DragEvent<HTMLElement>) => void;
  onDragLeaveTarget?: (path: string, event: DragEvent<HTMLElement>) => void;
  onDropOnTarget?: (path: string, event: DragEvent<HTMLElement>) => void;
  className?: string;
}

export function Breadcrumbs({
  path,
  root,
  onNavigate,
  dropTargetPath = null,
  onDragOverTarget,
  onDragLeaveTarget,
  onDropOnTarget,
  className,
}: BreadcrumbsProps) {
  const crumbs = breadcrumbs(path, root, "Home");

  return (
    <nav
      aria-label="Breadcrumb"
      data-testid="fm-breadcrumbs"
      className={cn("flex min-w-0 flex-1 items-center gap-0.5 overflow-x-auto", className)}
    >
      {crumbs.map((crumb, index) => {
        const isLast = index === crumbs.length - 1;
        const isDropTarget = dropTargetPath === crumb.path;
        return (
          <div key={crumb.path} className="flex shrink-0 items-center gap-0.5">
            {index === 0 ? null : (
              <Icon
                name="ChevronRight"
                className="size-3.5 shrink-0 text-muted-foreground"
                aria-hidden="true"
              />
            )}
            <button
              type="button"
              data-fm-crumb={crumb.path}
              aria-current={isLast ? "page" : undefined}
              className={cn(
                "flex h-7 max-w-[14rem] items-center gap-1 truncate rounded-md px-1.5 text-sm",
                "hover:bg-state-hover focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring",
                isLast ? "font-medium text-foreground" : "text-muted-foreground",
                isDropTarget && "bg-surface-selected ring-2 ring-primary/50",
              )}
              onClick={() => {
                if (!isLast) onNavigate(crumb.path);
              }}
              onDragOver={(event) => onDragOverTarget?.(crumb.path, event)}
              onDragLeave={(event) => onDragLeaveTarget?.(crumb.path, event)}
              onDrop={(event) => onDropOnTarget?.(crumb.path, event)}
            >
              {crumb.isRoot ? (
                <Icon name="FolderOpen" className="size-4 shrink-0" aria-hidden="true" />
              ) : null}
              <span className="truncate">{crumb.name}</span>
            </button>
          </div>
        );
      })}
    </nav>
  );
}
