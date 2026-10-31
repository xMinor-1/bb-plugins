// The small bar under a drawing in progress: comment on it, take back the
// last stroke, or start over. With one stroke the two would do the same, so
// only Clear shows.
import { Icon } from "@/components/ui/icon";
import { defineMessages, useMessages } from "@/lib/i18n";
import type { Point } from "./markdown-doc";

const messages = defineMessages(
  {
    comment: "Comment",
    undo: "Undo the last stroke",
    undoTitle: "Undo the last stroke (⌘Z)",
    clear: "Clear the whole drawing",
  },
  {
    comment: "Комментировать",
    undo: "Отменить последний штрих",
    undoTitle: "Отменить последний штрих (⌘Z)",
    clear: "Стереть весь рисунок",
  },
);

export function DrawingBar({
  point,
  strokes,
  onComment,
  onUndo,
  onClear,
}: {
  point: Point;
  /** Strokes drawn so far. */
  strokes: number;
  onComment: () => void;
  onUndo: () => void;
  onClear: () => void;
}) {
  const t = useMessages(messages);
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
        {t.comment}
      </button>
      {strokes > 1 ? (
        <button
          type="button"
          className="inline-flex size-7 items-center justify-center rounded-[5px] text-muted-foreground hover:bg-accent hover:text-foreground"
          aria-label={t.undo}
          title={t.undoTitle}
          onClick={(event) => {
            event.stopPropagation();
            onUndo();
          }}
        >
          <Icon name="ArrowTurnBackward" className="size-3.5" />
        </button>
      ) : null}
      <button
        type="button"
        className="inline-flex size-7 items-center justify-center rounded-[5px] text-muted-foreground hover:bg-accent hover:text-foreground"
        aria-label={t.clear}
        title={t.clear}
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
