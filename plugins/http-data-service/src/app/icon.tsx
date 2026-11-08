// The plugin's mark in the sidebar: a database cylinder, or the short text a build sets in `iconText`.
// bb registers the icon once, when the frontend loads, and settings arrive later over RPC. So the text
// lives in a small store: remembered in the browser for the next load, and pushed to the icon as soon
// as the server answers, so even the first session switches from the cylinder to the text.
import { useSyncExternalStore } from "react";

export const ICON = "HttpDataServiceDatabase";

const STORAGE_KEY = "http-data-service:icon-text";
const listeners = new Set<() => void>();
let current: string | null = readStored();

function readStored(): string | null {
  try {
    return localStorage.getItem(STORAGE_KEY) || null;
  } catch {
    return null;
  }
}

/** Sets the icon text from the server's answer; null brings back the cylinder. */
export function setIconText(text: string | null): void {
  const next = text || null;
  try {
    if (next) localStorage.setItem(STORAGE_KEY, next);
    else localStorage.removeItem(STORAGE_KEY);
  } catch {
    // Without storage the next load starts from the cylinder; this one still switches.
  }
  if (next === current) return;
  current = next;
  for (const listener of listeners) listener();
}

function subscribe(listener: () => void): () => void {
  listeners.add(listener);
  return () => {
    listeners.delete(listener);
  };
}

function useIconText(): string | null {
  return useSyncExternalStore(subscribe, () => current, () => current);
}

export function ServiceIcon({ className }: { className?: string }) {
  const text = useIconText();
  if (text) return <TextMark text={text} className={className} />;
  return <Database className={className} />;
}

/** The text fills the icon box: bold, tighter for longer text, in the sidebar's current color. */
function TextMark({ text, className }: { text: string; className?: string }) {
  const length = Array.from(text).length;
  const size = length <= 1 ? 18 : length === 2 ? 14 : 10;
  return (
    <svg viewBox="0 0 24 24" className={className} aria-hidden="true" data-icon-text={text}>
      <text
        x="12"
        y="12.5"
        textAnchor="middle"
        dominantBaseline="central"
        fill="currentColor"
        fontSize={size}
        fontWeight={700}
        fontFamily="system-ui, -apple-system, 'Segoe UI', Roboto, Arial, sans-serif"
        letterSpacing={length > 1 ? -0.5 : 0}
      >
        {text}
      </text>
    </svg>
  );
}

export function Database({ className }: { className?: string }) {
  return (
    <svg viewBox="0 0 24 24" className={className} fill="none" stroke="currentColor" strokeWidth={2} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
      <ellipse cx="12" cy="5" rx="8" ry="3" />
      <path d="M4 5v14c0 1.7 3.6 3 8 3s8-1.3 8-3V5" />
      <path d="M4 12c0 1.7 3.6 3 8 3s8-1.3 8-3" />
    </svg>
  );
}
