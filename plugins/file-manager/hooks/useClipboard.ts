// hooks/useClipboard.ts — cut / copy / paste state for the panel (§8.5).
//
// Deliberately *not* the system clipboard: `navigator.clipboard` cannot carry
// a file handle the server could act on, and the paste target is always a
// directory inside this panel. Cut rows render at opacity-50 (`isCut`), paste
// moves (and clears the clipboard) or copies (and keeps it).
import { useCallback, useMemo, useState } from "react";

import { useFmRpc, type RpcOutput } from "../lib/fm-rpc";
import { dirname, isSameOrDescendant, isSamePath } from "../lib/fm-paths";

export type ClipboardMode = "cut" | "copy";
export type BatchResult = RpcOutput<"moveEntries">;
export type ConflictPolicy = "rename" | "overwrite" | "fail";

export interface ClipboardState {
  mode: ClipboardMode;
  paths: string[];
}

export interface UseClipboardResult {
  clipboard: ClipboardState | null;
  cut: (paths: readonly string[]) => void;
  copy: (paths: readonly string[]) => void;
  clear: () => void;
  isCut: (path: string) => boolean;
  /** False when the destination is a cut source or lives inside one. */
  canPasteInto: (destinationDir: string) => boolean;
  /**
   * Runs the paste. Resolves with the batch result, or null when the clipboard
   * is empty. Rejects (with a `destination_inside_source` coded error) when the
   * destination is not allowed.
   */
  paste: (destinationDir: string, conflict?: ConflictPolicy) => Promise<BatchResult | null>;
  isPasting: boolean;
}

export function useClipboard(): UseClipboardResult {
  const rpc = useFmRpc();
  const [clipboard, setClipboard] = useState<ClipboardState | null>(null);
  const [isPasting, setIsPasting] = useState(false);

  const cut = useCallback((paths: readonly string[]) => {
    setClipboard(paths.length === 0 ? null : { mode: "cut", paths: [...paths] });
  }, []);

  const copy = useCallback((paths: readonly string[]) => {
    setClipboard(paths.length === 0 ? null : { mode: "copy", paths: [...paths] });
  }, []);

  const clear = useCallback(() => {
    setClipboard(null);
  }, []);

  const cutPaths = useMemo(
    () => new Set(clipboard?.mode === "cut" ? clipboard.paths : []),
    [clipboard],
  );

  const isCut = useCallback((path: string) => cutPaths.has(path), [cutPaths]);

  const canPasteInto = useCallback(
    (destinationDir: string) => {
      if (clipboard === null || clipboard.paths.length === 0) return false;
      if (clipboard.mode !== "cut") return true;
      // Moving a folder into itself (or below itself) is rejected on both
      // sides; refusing here keeps the menu item honest.
      return !clipboard.paths.some((source) => isSameOrDescendant(destinationDir, source));
    },
    [clipboard],
  );

  const paste = useCallback(
    async (destinationDir: string, conflict?: ConflictPolicy): Promise<BatchResult | null> => {
      if (clipboard === null || clipboard.paths.length === 0) return null;
      if (!canPasteInto(destinationDir)) {
        throw new Error(`destination_inside_source: ${destinationDir}`);
      }
      const isCutMode = clipboard.mode === "cut";
      // A cut into the source's own directory is a no-op, not an error.
      const paths = isCutMode
        ? clipboard.paths.filter((source) => !isSamePath(dirname(source), destinationDir))
        : clipboard.paths;
      if (paths.length === 0) {
        setClipboard(null);
        return { succeeded: [], failed: [] };
      }
      setIsPasting(true);
      try {
        const result = isCutMode
          ? await rpc.call("moveEntries", {
              paths,
              destinationDir,
              conflict: conflict ?? "fail",
            })
          : await rpc.call("copyEntries", {
              paths,
              destinationDir,
              conflict: conflict ?? "rename",
            });
        if (isCutMode) setClipboard(null);
        return result;
      } finally {
        setIsPasting(false);
      }
    },
    [canPasteInto, clipboard, rpc],
  );

  return { clipboard, cut, copy, clear, isCut, canPasteInto, paste, isPasting };
}
