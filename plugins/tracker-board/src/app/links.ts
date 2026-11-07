// A task opens in the tracker in the person's own browser, where they are signed in.
// bb's `openUrl` follows the "Open links in the in-app browser" preference, and bb's
// built-in browser has no tracker session. The desktop app exposes its own "open in the
// external browser" (the built-in browser's button uses it); the web app has no built-in
// browser, so `openUrl` opens a new tab of the person's browser there.

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
