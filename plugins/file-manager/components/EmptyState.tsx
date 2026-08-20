// components/EmptyState.tsx — the four "nothing to show" states of the table
// body (§8): an empty directory, a search that matched nothing, a directory
// that turned out to be a symlink leaving the root, and the first-run hint.
//
// Rendered *inside* the scroll container, never as a full-panel takeover, so
// the toolbar and the drop target stay live behind it.
import { Button } from "./ui/button";
import { Icon, type IconName } from "./ui/icon";
import { cn } from "../lib/utils";

export type EmptyStateKind = "empty" | "no-results" | "escapes-root" | "not-writable";

export interface EmptyStateProps {
  kind: EmptyStateKind;
  /** Echoed back in the "no results" copy. */
  query?: string;
  onClearSearch?: () => void;
  onNewFolder?: () => void;
  onUpload?: () => void;
  className?: string;
}

interface Copy {
  icon: IconName;
  title: string;
  body: string;
}

const COPY: Record<EmptyStateKind, Copy> = {
  empty: {
    icon: "FolderOpen",
    title: "This folder is empty",
    body: "Drop files here to upload them, or create a folder.",
  },
  "no-results": {
    icon: "Search",
    title: "No matching items",
    body: "Nothing in this folder matches your filter.",
  },
  "escapes-root": {
    icon: "AlertTriangle",
    title: "Outside the home folder",
    body: "This link points outside /home/coder, so it cannot be opened here.",
  },
  "not-writable": {
    icon: "Lock",
    title: "Read-only folder",
    body: "You can browse and download here, but not change anything.",
  },
};

export function EmptyState({
  kind,
  query,
  onClearSearch,
  onNewFolder,
  onUpload,
  className,
}: EmptyStateProps) {
  const copy = COPY[kind];
  const body =
    kind === "no-results" && query !== undefined && query !== ""
      ? `Nothing in this folder matches “${query}”.`
      : copy.body;

  return (
    <div
      data-testid="fm-empty-state"
      data-empty-kind={kind}
      className={cn(
        "flex flex-col items-center justify-center gap-2 px-6 py-16 text-center",
        className,
      )}
    >
      <Icon name={copy.icon} className="size-6 text-muted-foreground" aria-hidden="true" />
      <p className="text-sm font-medium text-foreground">{copy.title}</p>
      <p className="max-w-xs text-xs text-muted-foreground">{body}</p>
      <div className="mt-2 flex items-center gap-2">
        {kind === "no-results" && onClearSearch !== undefined ? (
          <Button type="button" variant="outline" size="sm" onClick={onClearSearch}>
            Clear filter
          </Button>
        ) : null}
        {kind === "empty" && onUpload !== undefined ? (
          <Button type="button" variant="outline" size="sm" onClick={onUpload}>
            <Icon name="PackageReceive" className="size-4" aria-hidden="true" />
            Upload files
          </Button>
        ) : null}
        {kind === "empty" && onNewFolder !== undefined ? (
          <Button type="button" variant="outline" size="sm" onClick={onNewFolder}>
            <Icon name="FolderPlus" className="size-4" aria-hidden="true" />
            New folder
          </Button>
        ) : null}
      </div>
    </div>
  );
}
