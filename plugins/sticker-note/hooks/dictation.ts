// The dictation hotkey. A setting holds it as text ("Alt+S", "Ctrl+Shift+Space");
// one window-wide listener toggles whichever dictation bar is active: the open
// card's, else the board's. Pressed anywhere else in bb, it opens the board and
// starts recording there.

export const DEFAULT_HOTKEY = "Alt+S";

export interface Hotkey {
  code: string;
  alt: boolean;
  ctrl: boolean;
  shift: boolean;
  meta: boolean;
}

function isMac(): boolean {
  return typeof navigator !== "undefined" && /Mac|iPhone|iPad/i.test(navigator.platform || navigator.userAgent);
}

const NAMED_CODES: Record<string, string> = {
  space: "Space",
  enter: "Enter",
  "`": "Backquote",
  ".": "Period",
  ",": "Comma",
  "/": "Slash",
  ";": "Semicolon",
  "'": "Quote",
  "[": "BracketLeft",
  "]": "BracketRight",
  "-": "Minus",
  "=": "Equal",
};

function codeOf(key: string): string | null {
  if (/^[a-z]$/i.test(key)) return `Key${key.toUpperCase()}`;
  if (/^\d$/.test(key)) return `Digit${key}`;
  if (/^f([1-9]|1[0-2])$/i.test(key)) return key.toUpperCase();
  return NAMED_CODES[key.toLowerCase()] ?? null;
}

/**
 * Parses "Alt+S", "Option+S", "Ctrl+Shift+Space", "Cmd+J", "Mod+J", "F2".
 * Letters match by physical key, so the hotkey works in any keyboard layout.
 * A key without Alt, Ctrl or Cmd would fire while typing, so only F-keys may
 * go alone. Returns null for an empty or unusable value.
 */
export function parseHotkey(spec: string): Hotkey | null {
  const parts = spec.split("+").map((p) => p.trim()).filter(Boolean);
  if (spec.trim().endsWith("+") && !parts.includes("+")) return null;
  const hotkey: Hotkey = { code: "", alt: false, ctrl: false, shift: false, meta: false };
  for (const part of parts) {
    const p = part.toLowerCase();
    if (["alt", "option", "opt", "⌥"].includes(p)) hotkey.alt = true;
    else if (["ctrl", "control", "⌃"].includes(p)) hotkey.ctrl = true;
    else if (["shift", "⇧"].includes(p)) hotkey.shift = true;
    else if (["cmd", "command", "meta", "win", "⌘"].includes(p)) hotkey.meta = true;
    else if (p === "mod") {
      if (isMac()) hotkey.meta = true;
      else hotkey.ctrl = true;
    } else if (!hotkey.code) {
      const code = codeOf(part);
      if (!code) return null;
      hotkey.code = code;
    } else return null;
  }
  if (!hotkey.code) return null;
  if (!hotkey.alt && !hotkey.ctrl && !hotkey.meta && !/^F\d+$/.test(hotkey.code)) return null;
  return hotkey;
}

/** "⌥S" on a Mac, "Alt+S" elsewhere. */
export function hotkeyLabel(hotkey: Hotkey): string {
  const key = hotkey.code.replace(/^Key|^Digit/, "");
  const name = Object.entries(NAMED_CODES).find(([, code]) => code === hotkey.code)?.[0];
  const shown = name === "space" ? "Space" : name === "enter" ? "Enter" : (name ?? key);
  if (isMac()) {
    return `${hotkey.ctrl ? "⌃" : ""}${hotkey.alt ? "⌥" : ""}${hotkey.shift ? "⇧" : ""}${hotkey.meta ? "⌘" : ""}${shown}`;
  }
  return [hotkey.ctrl && "Ctrl", hotkey.alt && "Alt", hotkey.shift && "Shift", hotkey.meta && "Win", shown]
    .filter(Boolean)
    .join("+");
}

export function matchesHotkey(event: KeyboardEvent, hotkey: Hotkey): boolean {
  return (
    event.code === hotkey.code &&
    event.altKey === hotkey.alt &&
    event.ctrlKey === hotkey.ctrl &&
    event.shiftKey === hotkey.shift &&
    event.metaKey === hotkey.meta
  );
}

// ---------- which bar the hotkey drives ----------

export interface DictationTarget {
  toggle(): void;
}

const targets: DictationTarget[] = [];
/** When the hotkey opened the board, the bar that mounts next starts recording. */
let pendingAt = 0;
const PENDING_MS = 4000;

export function registerDictationTarget(target: DictationTarget): () => void {
  targets.push(target);
  if (pendingAt && Date.now() - pendingAt < PENDING_MS) {
    pendingAt = 0;
    window.setTimeout(() => target.toggle(), 0);
  }
  return () => {
    const i = targets.lastIndexOf(target);
    if (i !== -1) targets.splice(i, 1);
  };
}

/** Toggles the active bar; returns false when no board is on screen. */
export function toggleDictation(): boolean {
  const target = targets[targets.length - 1];
  if (!target) return false;
  target.toggle();
  return true;
}

export function startDictationOnNextBar(): void {
  pendingAt = Date.now();
}
