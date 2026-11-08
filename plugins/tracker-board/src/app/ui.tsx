// A popover and a dialog in the board's own style. Plugin CSS is global to the bb
// page, so every class carries the tb- prefix.
import { useEffect, useLayoutEffect, useRef, type ReactNode } from "react";

export function useOutside(open: boolean, onClose: () => void) {
  const ref = useRef<HTMLSpanElement | null>(null);
  useEffect(() => {
    if (!open) return;
    const down = (event: MouseEvent) => {
      if (ref.current && !ref.current.contains(event.target as Node)) onClose();
    };
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("mousedown", down);
    document.addEventListener("keydown", key);
    return () => {
      document.removeEventListener("mousedown", down);
      document.removeEventListener("keydown", key);
    };
  }, [open, onClose]);
  return ref;
}

/** A trigger with a popup under (or above) it. */
export function Popover({
  open,
  onClose,
  trigger,
  children,
  className,
  place = "below-start",
}: {
  open: boolean;
  onClose: () => void;
  trigger: ReactNode;
  children: ReactNode;
  className?: string;
  place?: "below-start" | "below-end" | "above-start";
}) {
  const ref = useOutside(open, onClose);
  const pop = useRef<HTMLDivElement | null>(null);
  // The board list sits in the right half of bb's title bar: keep a popup inside the window.
  useLayoutEffect(() => {
    const el = pop.current;
    if (!open || !el) return;
    const fit = () => {
      el.style.translate = "";
      const box = el.getBoundingClientRect();
      const room = document.documentElement.clientWidth - 8;
      const shift = box.right > room ? Math.max(8 - box.left, room - box.right) : box.left < 8 ? 8 - box.left : 0;
      if (shift) el.style.translate = `${Math.round(shift)}px 0`;
    };
    fit();
    window.addEventListener("resize", fit);
    return () => window.removeEventListener("resize", fit);
  }, [open]);
  return (
    <span className="tb-popwrap" ref={ref}>
      {trigger}
      {open ? (
        <div ref={pop} className={`tb-pop tb-pop-${place}${className ? ` ${className}` : ""}`}>
          {children}
        </div>
      ) : null}
    </span>
  );
}

export function Modal({ label, narrow, onClose, children }: { label: string; narrow?: boolean; onClose: () => void; children: ReactNode }) {
  useEffect(() => {
    const key = (event: KeyboardEvent) => {
      if (event.key === "Escape") onClose();
    };
    document.addEventListener("keydown", key);
    return () => document.removeEventListener("keydown", key);
  }, [onClose]);
  return (
    <div
      className="tb-modal-wrap"
      onMouseDown={(event) => {
        if (event.target === event.currentTarget) onClose();
      }}
    >
      <div className={`tb-modal${narrow ? " tb-modal-narrow" : ""}`} role="dialog" aria-label={label} aria-modal="true">
        {children}
      </div>
    </div>
  );
}

export function Spinner({ label }: { label?: string }) {
  return <span className="tb-spin" role="status" aria-label={label ?? "…"} />;
}
