// hooks/useMenuPointerGuard.ts — "releasing the button that opened the menu
// must not pick whatever it lands on".
//
// Radix's MenuItem selects on `pointerup` even when the matching `pointerdown`
// happened somewhere else:
//
//   onPointerUp: (event) => { if (!isPointerDownRef.current) event.currentTarget?.click() }
//
// That is deliberate — it makes press-drag-release work on a dropdown — but a
// context menu is opened BY a press whose release lands inside the menu that
// just appeared. Radix normally dodges it by putting the menu to the right of
// the cursor (`side: "right", sideOffset: 2`), so the pointer is outside the
// content. Near the right edge of the window the popper flips the menu to the
// other side, the cursor ends up ON an item, and letting go of the right
// button runs it. In a side panel — which is always at that edge — the menu
// looks like it "flashes and picks something by itself".
//
// So: swallow a `pointerup` that this menu never saw a `pointerdown` for.
// Every real activation (click an item, or press-drag-release that STARTED
// inside the menu) still passes, and so does the keyboard.
import { useCallback, useRef } from "react";
import type { PointerEvent as ReactPointerEvent } from "react";

export interface MenuPointerGuard {
  onPointerDownCapture: (event: ReactPointerEvent<HTMLElement>) => void;
  onPointerUpCapture: (event: ReactPointerEvent<HTMLElement>) => void;
}

/**
 * Spread onto a `ContextMenuContent`. Capture phase on the content runs before
 * React delivers the event to the item underneath, which is what lets it stop
 * the synthetic click Radix would otherwise dispatch.
 */
export function useMenuPointerGuard(): MenuPointerGuard {
  const sawPointerDown = useRef(false);

  const onPointerDownCapture = useCallback(() => {
    sawPointerDown.current = true;
  }, []);

  const onPointerUpCapture = useCallback((event: ReactPointerEvent<HTMLElement>) => {
    // One press buys one release. Consuming it rather than latching keeps the
    // guard correct if Radix reuses this instance across a close/open cycle
    // (a closing animation can outlive the click that started it).
    if (sawPointerDown.current) {
      sawPointerDown.current = false;
      return;
    }
    event.preventDefault();
    event.stopPropagation();
  }, []);

  return { onPointerDownCapture, onPointerUpCapture };
}
