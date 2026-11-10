// The form opens in the person's own browser, where they are signed in to the tracker.
// bb's `openUrl` follows the "Open links in the in-app browser" preference, and bb's built-in
// browser has no tracker session. The desktop app exposes its own "open in the external browser"
// (the built-in browser's button uses it); the web app has no built-in browser, so `openUrl`
// opens a new tab of the person's browser there.

type Desktop = { openExternalUrl?: (url: string) => unknown };

export function openInOwnBrowser(url: string, openUrl: (url: string) => boolean, host: { bbDesktop?: Desktop | null } = window as never): boolean {
  if (!/^https?:\/\//i.test(url)) return false;
  const desktop = host.bbDesktop;
  if (desktop && typeof desktop.openExternalUrl === "function") {
    try {
      desktop.openExternalUrl(url);
      return true;
    } catch {
      // An app that changed its bridge: fall back to bb's own rule.
    }
  }
  return openUrl(url);
}

/**
 * bb has no sidebar item that is a link: the bug opens the plugin page, and the page opens the form as it mounts.
 * The same page can mount twice for one click (React's strict mode, bb remounting it when the window narrows), so a
 * second mount within this window opens nothing.
 */
export const REOPEN_AFTER_MS = 3000;
let lastAutoOpen = Number.NEGATIVE_INFINITY;

export function shouldAutoOpen(now = Date.now()): boolean {
  if (now - lastAutoOpen < REOPEN_AFTER_MS) return false;
  lastAutoOpen = now;
  return true;
}

/** Tests only. */
export function resetAutoOpen() {
  lastAutoOpen = Number.NEGATIVE_INFINITY;
}
