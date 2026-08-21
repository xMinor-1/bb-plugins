// lib/panel-link.ts — one way into the Usage page from anywhere in the plugin.
//
// The rings live in a content script, outside React, so they cannot call
// useBbNavigate() to open the page. The sidebar accessory can, and it is
// mounted whenever bb draws the plugin's sidebar row, so it leaves a function
// behind for the content script to use. When it is not mounted — a compact
// viewport, where the host does not render accessories — the link falls back to
// an ordinary URL. Slower (a full app load), but it always works.
import { PANEL_URL } from "./limits";

/** Where the opener is parked. A string key, because two bundles share it. */
const OPENER_KEY = "__bbUsageMeterOpenPanel";

type Opener = (subPath?: string) => void;

function holder(): Record<string, unknown> {
  return globalThis as unknown as Record<string, unknown>;
}

/** Called by the React side while it is mounted; pass null on unmount. */
export function setPanelOpener(open: Opener | null): void {
  if (open === null) delete holder()[OPENER_KEY];
  else holder()[OPENER_KEY] = open;
}

/** Open the Usage page: in-app when React is there to do it, by URL otherwise. */
export function openUsagePanel(subPath?: string): void {
  const open = holder()[OPENER_KEY];
  if (typeof open === "function") {
    (open as Opener)(subPath);
    return;
  }
  window.location.assign(subPath ? `${PANEL_URL}/${subPath}` : PANEL_URL);
}

/** The href a plain link should carry, so middle click and copy still work. */
export function usagePanelHref(subPath?: string): string {
  return subPath ? `${PANEL_URL}/${subPath}` : PANEL_URL;
}
