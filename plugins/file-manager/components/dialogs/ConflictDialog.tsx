// components/dialogs/ConflictDialog.tsx — the "that name is taken" fork.
//
// §8.4: a move/copy is first issued with `conflict: "fail"`, and every entry
// that came back as `exists` lands here. Choosing Replace re-issues with
// `overwrite`, Keep both with `rename`, Skip drops them.
import type { FileManagerErrorCode } from "../../contract";
import { Button } from "../ui/button";
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from "../ui/dialog";
import { Icon } from "../ui/icon";

export type ConflictChoice = "overwrite" | "rename" | "skip";

export interface ConflictItem {
  path: string;
  code: FileManagerErrorCode;
  message: string;
}

export interface ConflictDialogProps {
  open: boolean;
  onOpenChange: (open: boolean) => void;
  /** The `failed[]` entries whose code was `exists`. */
  conflicts: readonly ConflictItem[];
  destinationDir: string;
  /** "Move" or "Copy" — only used in the copy. */
  operation: string;
  onResolve: (choice: ConflictChoice) => void;
}

function baseName(path: string): string {
  const index = path.lastIndexOf("/");
  return index === -1 ? path : path.slice(index + 1);
}

export function ConflictDialog({
  open,
  onOpenChange,
  conflicts,
  destinationDir,
  operation,
  onResolve,
}: ConflictDialogProps) {
  if (conflicts.length === 0) return null;

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-w-sm bg-card text-card-foreground"
        data-testid="fm-conflict-dialog"
      >
        <DialogHeader>
          <DialogTitle className="flex items-center gap-2">
            <Icon name="AlertTriangle" className="size-4" aria-hidden="true" />
            {conflicts.length === 1
              ? "An item with that name already exists"
              : `${String(conflicts.length)} items already exist`}
          </DialogTitle>
          <DialogDescription className="truncate">
            {operation} to {destinationDir}
          </DialogDescription>
        </DialogHeader>

        <ul className="max-h-32 overflow-y-auto rounded-md border border-border bg-surface-recessed p-2 text-xs">
          {conflicts.map((conflict) => (
            <li key={conflict.path} className="truncate py-0.5 text-muted-foreground">
              {baseName(conflict.path)}
            </li>
          ))}
        </ul>

        <DialogFooter className="gap-2">
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              onResolve("skip");
              onOpenChange(false);
            }}
          >
            Skip
          </Button>
          <Button
            type="button"
            variant="outline"
            onClick={() => {
              onResolve("rename");
              onOpenChange(false);
            }}
          >
            Keep both
          </Button>
          <Button
            type="button"
            variant="destructive"
            onClick={() => {
              onResolve("overwrite");
              onOpenChange(false);
            }}
          >
            Replace
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  );
}
