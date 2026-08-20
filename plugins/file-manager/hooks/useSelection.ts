// hooks/useSelection.ts — anchor / range / toggle selection over the visible rows.
//
// The rules are §8.2 (mouse) and §8.3 (keyboard). Two invariants make them
// work: the *anchor* is where a Shift-range starts, and the *focus* is the row
// the keyboard is on. A plain click sets both; Ctrl-click moves both but keeps
// the rest of the selection; Shift-click moves only the focus.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";

export interface SelectionModifiers {
  ctrlKey?: boolean;
  metaKey?: boolean;
  shiftKey?: boolean;
}

interface SelectionState {
  selected: ReadonlySet<string>;
  anchor: string | null;
  focus: string | null;
}

const EMPTY: SelectionState = { selected: new Set<string>(), anchor: null, focus: null };

export interface UseSelectionResult {
  selected: ReadonlySet<string>;
  /** Selected rows in visible order — the order every batch RPC gets. */
  selectedPaths: string[];
  count: number;
  anchor: string | null;
  focus: string | null;
  isSelected: (path: string) => boolean;
  /** Replace the selection with one row and move the anchor there. */
  select: (path: string) => void;
  /** Ctrl/Cmd-click: add or remove one row, anchor moves to it. */
  toggle: (path: string) => void;
  /** Shift-click / Shift+Arrow: inclusive range from the anchor. */
  extendTo: (path: string) => void;
  selectOnly: (paths: readonly string[]) => void;
  selectAll: () => void;
  clear: () => void;
  setFocus: (path: string | null) => void;
  /** Arrow keys. `delta` is in rows; `extend` mirrors Shift. */
  moveFocus: (delta: number, extend?: boolean) => void;
  /** Home / End. */
  focusEdge: (edge: "start" | "end", extend?: boolean) => void;
  /** The whole of §8.2's click table in one call. */
  handleRowClick: (path: string, modifiers?: SelectionModifiers) => void;
}

export function useSelection(visiblePaths: readonly string[]): UseSelectionResult {
  const [state, setState] = useState<SelectionState>(EMPTY);

  // Rows disappear (delete, move, filter, navigation): drop what is gone
  // instead of sending stale paths to a batch RPC.
  const pathsRef = useRef(visiblePaths);
  pathsRef.current = visiblePaths;
  useEffect(() => {
    setState((previous) => {
      if (previous.selected.size === 0 && previous.anchor === null && previous.focus === null) {
        return previous;
      }
      const visible = new Set(visiblePaths);
      const kept = new Set<string>();
      for (const path of previous.selected) if (visible.has(path)) kept.add(path);
      const anchor = previous.anchor !== null && visible.has(previous.anchor) ? previous.anchor : null;
      const focus = previous.focus !== null && visible.has(previous.focus) ? previous.focus : null;
      if (kept.size === previous.selected.size && anchor === previous.anchor && focus === previous.focus) {
        return previous;
      }
      return { selected: kept, anchor, focus };
    });
  }, [visiblePaths]);

  const select = useCallback((path: string) => {
    setState({ selected: new Set([path]), anchor: path, focus: path });
  }, []);

  const toggle = useCallback((path: string) => {
    setState((previous) => {
      const next = new Set(previous.selected);
      if (next.has(path)) next.delete(path);
      else next.add(path);
      return { selected: next, anchor: path, focus: path };
    });
  }, []);

  const extendTo = useCallback((path: string) => {
    setState((previous) => {
      const paths = pathsRef.current;
      const anchor = previous.anchor ?? path;
      const from = paths.indexOf(anchor);
      const to = paths.indexOf(path);
      if (from === -1 || to === -1) {
        return { selected: new Set([path]), anchor: path, focus: path };
      }
      const [start, end] = from <= to ? [from, to] : [to, from];
      const next = new Set<string>();
      for (let index = start; index <= end; index += 1) {
        const candidate = paths[index];
        if (candidate !== undefined) next.add(candidate);
      }
      return { selected: next, anchor, focus: path };
    });
  }, []);

  const selectOnly = useCallback((paths: readonly string[]) => {
    const next = new Set(paths);
    const last = paths.length > 0 ? paths[paths.length - 1] ?? null : null;
    setState({ selected: next, anchor: last, focus: last });
  }, []);

  const selectAll = useCallback(() => {
    const paths = pathsRef.current;
    setState((previous) => ({
      selected: new Set(paths),
      anchor: previous.anchor ?? paths[0] ?? null,
      focus: previous.focus ?? paths[paths.length - 1] ?? null,
    }));
  }, []);

  const clear = useCallback(() => {
    setState((previous) =>
      previous.selected.size === 0 && previous.anchor === null && previous.focus === null
        ? previous
        : EMPTY,
    );
  }, []);

  const setFocus = useCallback((path: string | null) => {
    setState((previous) => (previous.focus === path ? previous : { ...previous, focus: path }));
  }, []);

  const moveFocus = useCallback(
    (delta: number, extend = false) => {
      setState((previous) => {
        const paths = pathsRef.current;
        if (paths.length === 0) return previous;
        const currentIndex = previous.focus === null ? -1 : paths.indexOf(previous.focus);
        const base = currentIndex === -1 ? (delta > 0 ? -1 : paths.length) : currentIndex;
        const nextIndex = Math.min(paths.length - 1, Math.max(0, base + delta));
        const target = paths[nextIndex];
        if (target === undefined) return previous;
        if (!extend) return { selected: new Set([target]), anchor: target, focus: target };
        const anchor = previous.anchor ?? target;
        const from = paths.indexOf(anchor);
        const [start, end] = from <= nextIndex ? [from, nextIndex] : [nextIndex, from];
        const next = new Set<string>();
        for (let index = Math.max(0, start); index <= end; index += 1) {
          const candidate = paths[index];
          if (candidate !== undefined) next.add(candidate);
        }
        return { selected: next, anchor, focus: target };
      });
    },
    [],
  );

  const focusEdge = useCallback(
    (edge: "start" | "end", extend = false) => {
      const paths = pathsRef.current;
      if (paths.length === 0) return;
      const target = edge === "start" ? paths[0] : paths[paths.length - 1];
      if (target === undefined) return;
      if (extend) extendTo(target);
      else select(target);
    },
    [extendTo, select],
  );

  const handleRowClick = useCallback(
    (path: string, modifiers: SelectionModifiers = {}) => {
      if (modifiers.shiftKey === true) extendTo(path);
      else if (modifiers.ctrlKey === true || modifiers.metaKey === true) toggle(path);
      else select(path);
    },
    [extendTo, select, toggle],
  );

  const selectedPaths = useMemo(
    () => visiblePaths.filter((path) => state.selected.has(path)),
    [visiblePaths, state.selected],
  );

  const isSelected = useCallback((path: string) => state.selected.has(path), [state.selected]);

  return {
    selected: state.selected,
    selectedPaths,
    count: state.selected.size,
    anchor: state.anchor,
    focus: state.focus,
    isSelected,
    select,
    toggle,
    extendTo,
    selectOnly,
    selectAll,
    clear,
    setFocus,
    moveFocus,
    focusEdge,
    handleRowClick,
  };
}
