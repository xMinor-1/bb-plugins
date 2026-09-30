// The small bar under a drawing in progress: comment on it, take back the
// last stroke, or start over.
import { Icon } from "@/components/ui/icon";
import type { Point } from "./markdown-doc";

export function DrawingBar({
  point,
  onComment,
  onUndo,
  onClear,
}: {
  point: Point;
  onComment: () => void;
  onUndo: () => void;
  onClear: () => void;
}) {
  const stop = (event: { stopPropagation: () => void; preventDefault: () => void }) => {
    event.stopPropagation();
    event.preventDefault();
  };
  return (
    <div
      className="absolute z-40 inline-flex items-center gap-0.5 rounded-md border border-border bg-popover p-0.5 text-xs text-popover-foreground shadow-md"
      style={{ top: point.top, left: point.left }}
      onPointerDown={(event) => event.stopPropagation()}
      onMouseDown={stop}
    >
      <button
        type="button"
        className="inline-flex h-7 items-center gap-1.5 rounded-[5px] px-2 font-medium hover:bg-accent"
        onClick={(event) => {
          event.stopPropagation();
          onComment();
        }}
      >
        <Icon name="MessageSquarePlus" className="size-3.5" />
        Comment
      </button>
      <button
        type="button"
        className="inline-flex size-7 items-center justify-center rounded-[5px] text-muted-foreground hover:bg-accent hover:text-foreground"
        aria-label="Undo the last stroke"
        title="Undo the last stroke (⌘Z)"
        onClick={(event) => {
          event.stopPropagation();
          onUndo();
        }}
      >
        <Icon name="ArrowTurnBackward" className="size-3.5" />
      </button>
      <button
        type="button"
        className="inline-flex size-7 items-center justify-center rounded-[5px] text-muted-foreground hover:bg-accent hover:text-foreground"
        aria-label="Clear the drawing"
        title="Clear the drawing"
        onClick={(event) => {
          event.stopPropagation();
          onClear();
        }}
      >
        <Icon name="Trash2" className="size-3.5" />
      </button>
    </div>
  );
}
