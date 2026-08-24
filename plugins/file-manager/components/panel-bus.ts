// components/panel-bus.ts — the only way the title-bar and sidebar slots can
// talk to the panel body.
//
// `headerContent` and `experimental_sidebarAccessory` are mounted by the host
// in *different* React subtrees from the panel component (§10), so React
// context cannot reach them. This is a module-level store instead: the panel
// publishes what the header needs to render, and the header dispatches
// commands back. Both live for as long as the plugin bundle does.
import { useSyncExternalStore } from "react";

export interface PanelSnapshot {
  /** Absolute directory the panel is showing; "" before it mounts. */
  currentPath: string;
  /** False when `listDir` reported the directory as read-only. */
  writable: boolean;
  /** True when the panel is mounted and bootstrapped. */
  ready: boolean;
  showHidden: boolean;
  selectionCount: number;
  canPaste: boolean;
}

export type PanelCommand =
  | { type: "upload" }
  | { type: "new-folder" }
  | { type: "refresh" }
  | { type: "toggle-hidden" }
  | { type: "select-all" }
  | { type: "paste" }
  | { type: "copy-path" }
  | { type: "set-start-folder" }
  /** Toolbar-only in the nav panel; the bus carries it for a panel tab. */
  | { type: "collapse-all" };

const INITIAL: PanelSnapshot = {
  currentPath: "",
  writable: false,
  ready: false,
  showHidden: false,
  selectionCount: 0,
  canPaste: false,
};

let snapshot: PanelSnapshot = INITIAL;
const snapshotListeners = new Set<() => void>();
const commandListeners = new Set<(command: PanelCommand) => void>();

function sameSnapshot(a: PanelSnapshot, b: PanelSnapshot): boolean {
  return (
    a.currentPath === b.currentPath &&
    a.writable === b.writable &&
    a.ready === b.ready &&
    a.showHidden === b.showHidden &&
    a.selectionCount === b.selectionCount &&
    a.canPaste === b.canPaste
  );
}

/** Called by the panel on every meaningful state change. */
export function publishPanelSnapshot(next: PanelSnapshot): void {
  if (sameSnapshot(snapshot, next)) return;
  snapshot = next;
  for (const listener of snapshotListeners) listener();
}

/** Called when the panel unmounts, so the header stops offering dead actions. */
export function resetPanelSnapshot(): void {
  publishPanelSnapshot(INITIAL);
}

function subscribeSnapshot(listener: () => void): () => void {
  snapshotListeners.add(listener);
  return () => {
    snapshotListeners.delete(listener);
  };
}

function readSnapshot(): PanelSnapshot {
  return snapshot;
}

export function usePanelSnapshot(): PanelSnapshot {
  return useSyncExternalStore(subscribeSnapshot, readSnapshot, readSnapshot);
}

/** Header → panel. Dispatched synchronously so `input.click()` keeps its user gesture. */
export function sendPanelCommand(command: PanelCommand): void {
  for (const listener of [...commandListeners]) listener(command);
}

export function subscribePanelCommands(listener: (command: PanelCommand) => void): () => void {
  commandListeners.add(listener);
  return () => {
    commandListeners.delete(listener);
  };
}
