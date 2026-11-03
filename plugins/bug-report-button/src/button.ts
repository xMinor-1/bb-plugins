// A fixed link in the top bar of the window that opens the configured bug report form.
export const BUTTON_ID = "bb-bug-report-button";
export const DEFAULT_LABEL = "Report a bug";
export const MAX_URL_LENGTH = 2048;
export const MAX_LABEL_LENGTH = 80;
// A build's settings can arrive after the plugin starts, while a window is already open.
const RECHECK_MS = 30_000;

// The same picture as icon.svg; a test keeps them equal.
export const BUG_SVG =
  '<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32"><rect width="32" height="32" rx="7" fill="#000"/><g fill="none" stroke="#fff" stroke-width="1.8" stroke-linecap="round" stroke-linejoin="round"><path d="M12.5 11.5a3.5 3.5 0 0 1 7 0"/><path d="M13.4 8.6 11.4 6.4M18.6 8.6l2-2.2"/><path d="M16 11.5c-4 0-6.5 3-6.5 7s2.7 7 6.5 7 6.5-3 6.5-7-2.5-7-6.5-7z"/><path d="M16 11.5v14"/><path d="M9.8 15.4 6.6 13.4M9.5 19H5.8M10.4 22.6 7 24.8M22.2 15.4l3.2-2M22.5 19h3.7M21.6 22.6l3.4 2.2"/></g><g fill="#fff"><circle cx="12.9" cy="16.6" r="1.2"/><circle cx="12.9" cy="21.2" r="1.2"/><circle cx="19.1" cy="16.6" r="1.2"/><circle cx="19.1" cy="21.2" r="1.2"/></g></svg>';

// In the top bar, in the free space between the thread title and the actions on the right. bb draws that bar on every
// route and keeps its height in a CSS variable; the fallback is its value in bb 0.48. In a narrow window the button
// stays clear of a usual title, and on a phone it stays on screen.
// A modal dialog turns off pointer events on <body>, so the link turns them back on.
const SIZE_PX = 28;
const BUTTON_CSS = [
  "position:fixed",
  `top:calc((var(--bb-app-chrome-row-height,48px) - ${SIZE_PX}px) / 2 + var(--bb-window-frame-top,0px))`,
  "left:min(max(50%,640px),calc(100% - 120px))",
  "z-index:2147483000",
  `width:${SIZE_PX}px`,
  `height:${SIZE_PX}px`,
  "display:block",
  "border-radius:6px",
  "box-shadow:0 0 0 1px rgba(255,255,255,.35)",
  "pointer-events:auto",
  "-webkit-app-region:no-drag",
].join(";");

export type ButtonConfig = { url: string; label: string };

/** Only an http(s) address can be the form: a `javascript:` value from settings would run in the app. */
export function readFormUrl(value: unknown): string {
  if (typeof value !== "string" || value.length > MAX_URL_LENGTH) return "";
  try {
    const url = new URL(value.trim());
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : "";
  } catch {
    return "";
  }
}

export function readConfig(values: Record<string, unknown>): ButtonConfig {
  const label = typeof values.label === "string" ? values.label.trim().slice(0, MAX_LABEL_LENGTH) : "";
  return { url: readFormUrl(values.formUrl), label: label || DEFAULT_LABEL };
}

/** Adds the button when the config has an address. Returns the undo. */
export function showButton(doc: Document, { url, label }: ButtonConfig): () => void {
  if (!url) return () => {};
  const link = doc.createElement("a");
  link.id = BUTTON_ID;
  link.href = url;
  // Not bb's openUrl: it can pick the in-app browser, which has no sign-in of the user's own. A new-window link goes to
  // a new tab on the web and to the system browser in the desktop app, whose window-open handler passes it to the OS.
  link.target = "_blank";
  link.rel = "noopener noreferrer";
  link.title = label;
  link.setAttribute("aria-label", label);
  link.style.cssText = BUTTON_CSS;
  link.innerHTML = BUG_SVG; // A constant: the settings only reach attributes.
  doc.body.append(link);
  return () => link.remove();
}

/** Keeps the page on the current settings. Returns the undo. */
export function watchButton(doc: Document, load: () => Promise<Record<string, unknown>>, recheckMs = RECHECK_MS): () => void {
  let shown = "";
  let undo = () => {};
  let stopped = false;
  const check = async () => {
    try {
      const config = readConfig(await load());
      const key = JSON.stringify(config);
      if (stopped || key === shown) return;
      undo();
      undo = showButton(doc, config);
      shown = key;
    } catch {
      // The server is restarting: the next check gets it, and the page keeps what it shows.
    }
  };
  void check();
  const timer = setInterval(() => void check(), recheckMs);
  return () => {
    stopped = true;
    clearInterval(timer);
    undo();
  };
}
