// components/PathBar.tsx — the location strip: breadcrumbs, or a text field.
//
// PATHBAR-SPEC §3. Two mutually exclusive states in one box:
//
//   * **crumb mode** (idle) is byte-for-byte what shipped in 0.3.x. The crumbs
//     stay because they are drop targets for internal and OS drags (SPEC §8.4)
//     and one-click jumps to an ancestor — a text input can be neither;
//   * **edit mode** replaces them, in place, with a single-line input holding
//     the full absolute path, selected, ready to be pasted over.
//
// Three ways in, all of them `onOpen`: a click on the flex slack right of the
// last crumb (Explorer/Nautilus), the `Edit path` button, and `Ctrl/Cmd+L`
// (owned by the panel's key map, §7.2). Escape and blur both revert; only
// Enter commits, and a commit that fails keeps the text and the caret exactly
// where they were.
import { useLayoutEffect, useRef, useState, type DragEvent } from "react";

import { cn } from "../lib/utils";
import { Breadcrumbs } from "./Breadcrumbs";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";
import { Input } from "./ui/input";

export interface PathBarProps {
  /** Absolute path of the directory being shown. */
  path: string;
  root: string;
  onNavigate: (path: string) => void;
  /** True while the text field is up. Owned by the panel. */
  editing: boolean;
  onOpen: () => void;
  /** Leave edit mode without committing. */
  onCancel: (options: { focusGrid: boolean }) => void;
  /** Enter. The panel answers by navigating, or by setting `error`. */
  onSubmit: (raw: string) => void;
  /** Inline failure under the input; typing clears it through `onDirty`. */
  error: string | null;
  onDirty: () => void;
  /** True while `statPath` is in flight. */
  busy?: boolean;
  /**
   * Bumped by the panel every time the bar is opened. A second `Ctrl+L` while
   * it is already open re-selects the text instead of resetting it, which is
   * what a browser's address bar does.
   */
  focusTick: number;
  dropTargetPath?: string | null;
  onDragOverCrumb?: (path: string, event: DragEvent<HTMLElement>) => void;
  onDragLeaveCrumb?: (path: string, event: DragEvent<HTMLElement>) => void;
  onDropOnCrumb?: (path: string, event: DragEvent<HTMLElement>) => void;
}

export function PathBar({
  path,
  root,
  onNavigate,
  editing,
  onOpen,
  onCancel,
  onSubmit,
  error,
  onDirty,
  busy = false,
  focusTick,
  dropTargetPath = null,
  onDragOverCrumb,
  onDragLeaveCrumb,
  onDropOnCrumb,
}: PathBarProps) {
  return (
    <div
      className="relative flex min-w-0 flex-1 items-center gap-1"
      data-testid="fm-path-bar"
      // The absolute path is one hover away without spending a pixel of width.
      title={path}
    >
      {editing ? (
        <PathEditor
          key="editor"
          initialValue={path}
          busy={busy}
          invalid={error !== null}
          focusTick={focusTick}
          onSubmit={onSubmit}
          onCancel={onCancel}
          onDirty={onDirty}
        />
      ) : (
        <Breadcrumbs
          path={path}
          root={root}
          onNavigate={onNavigate}
          dropTargetPath={dropTargetPath}
          onDragOverTarget={onDragOverCrumb}
          onDragLeaveTarget={onDragLeaveCrumb}
          onDropOnTarget={onDropOnCrumb}
          onEmptyAreaClick={onOpen}
          className="cursor-text"
        />
      )}

      {/* The shortcut is written down exactly once, and it has to be here —
          the vendored `Button` omits `title` on purpose, so it hangs on the
          wrapper, where a hover over the button still picks it up. */}
      <span className="shrink-0" title="Edit path (Ctrl+L)">
        <Button
          type="button"
          variant="ghost"
          size="sm"
          className="h-8 w-8 shrink-0 p-0"
          aria-label="Edit path"
          aria-pressed={editing}
          data-testid="fm-path-edit"
          // Keep the click a pure toggle: without this the button steals focus
          // from the input first, the blur reverts, and the click would then
          // re-open the bar it was meant to close.
          onMouseDown={(event) => event.preventDefault()}
          onClick={() => {
            if (editing) onCancel({ focusGrid: true });
            else onOpen();
          }}
        >
          <Icon name="Edit" className="size-4" aria-hidden="true" />
        </Button>
      </span>

      {error === null ? null : (
        // Absolutely positioned, so a failed commit never changes the toolbar's
        // height and the table below never jumps. This is also exactly where a
        // completion list would render later (§6).
        <p
          id="fm-path-error"
          role="alert"
          data-testid="fm-path-error"
          className="absolute left-0 top-full z-20 mt-1 max-w-full break-words rounded-md border border-destructive/40 bg-popover px-2 py-1 text-xs text-destructive shadow-md"
        >
          {error}
        </p>
      )}
    </div>
  );
}

interface PathEditorProps {
  /** Seeded once, on mount: the bar is mounted only while it is open. */
  initialValue: string;
  busy: boolean;
  invalid: boolean;
  focusTick: number;
  onSubmit: (raw: string) => void;
  onCancel: (options: { focusGrid: boolean }) => void;
  onDirty: () => void;
}

/**
 * Mounted only in edit mode, so its draft text lives exactly as long as the
 * mode does: a failed commit keeps it (the component stays up), and every way
 * out of edit mode discards it (the component goes away). No second copy of
 * "what is typed" in the panel.
 */
function PathEditor({
  initialValue,
  busy,
  invalid,
  focusTick,
  onSubmit,
  onCancel,
  onDirty,
}: PathEditorProps) {
  const [value, setValue] = useState(initialValue);
  const localRef = useRef<HTMLInputElement | null>(null);

  // Runs on mount and on every later open: focus and select the whole value,
  // so the next keystroke of a paste-over replaces it.
  useLayoutEffect(() => {
    const input = localRef.current;
    if (input === null) return;
    input.focus();
    input.select();
  }, [focusTick]);

  return (
    <div
      role="group"
      aria-label="Folder path"
      aria-busy={busy}
      className="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-input px-2"
      data-testid="fm-path-group"
    >
      <Icon name="Folder" className="size-4 shrink-0 text-muted-foreground" aria-hidden="true" />
      <Input
        ref={localRef}
        id="fm-path-input"
        type="text"
        value={value}
        aria-label="Folder path"
        aria-describedby="fm-path-hint"
        aria-invalid={invalid || undefined}
        aria-errormessage={invalid ? "fm-path-error" : undefined}
        spellCheck={false}
        autoCapitalize="off"
        autoCorrect="off"
        enterKeyHint="go"
        data-testid="fm-path-input"
        className={cn(
          "h-7 flex-1 border-0 bg-transparent px-0 font-mono text-sm focus-visible:ring-0",
          invalid && "text-destructive",
        )}
        onChange={(event) => {
          setValue(event.target.value);
          onDirty();
        }}
        onKeyDown={(event) => {
          // An IME candidate window is being driven: Enter accepts the
          // candidate and Escape cancels the composition, and neither is a
          // decision about the path. Every browser flags that keydown with
          // `isComposing` (and the legacy keyCode 229 with it), so the bar
          // simply does not look at it (§3.5).
          if ((event.nativeEvent as KeyboardEvent).isComposing || event.keyCode === 229) return;
          if (event.key === "Enter") {
            event.preventDefault();
            onSubmit(event.currentTarget.value);
            return;
          }
          if (event.key === "Escape") {
            // Mirrors the filter box: the panel's own Escape clears the
            // selection, and this one must not reach it (§7.3).
            event.preventDefault();
            event.stopPropagation();
            onCancel({ focusGrid: true });
          }
          // Everything else — including Tab, which blurs and therefore
          // reverts — is left to the browser (§6: Tab stays free).
        }}
        onBlur={() => {
          // A blur is not a decision: it fires when a sort menu opens, when a
          // row drag starts, when the OS takes the window. Reverting is one
          // Ctrl+L away; committing half a path is not undoable (§3.5).
          onCancel({ focusGrid: false });
        }}
      />
      <span id="fm-path-hint" className="sr-only">
        Type or paste a path and press Enter. Escape cancels.
      </span>
    </div>
  );
}
