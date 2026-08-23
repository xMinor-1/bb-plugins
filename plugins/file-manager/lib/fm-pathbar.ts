// lib/fm-pathbar.ts — what the path bar makes of what you paste (§4).
//
// Pure, DOM-free and SDK-free on purpose: it is the whole of the path bar's
// judgement, and it is unit-tested the way `lib/fm-tree.ts` is. It imports
// `lib/fm-paths.ts` and nothing else.
//
// Two rules are worth stating up front, because both are easy to get subtly
// wrong:
//
//   * A relative path resolves against the folder **on screen**, like every
//     shell and every address bar. `lib/fm-paths.ts#toAbsolute` resolves it
//     against the *root* on purpose — it mirrors `src/root.ts#normalize` and is
//     what decodes the route's `subPath` — so it is used here for the `~`
//     branch only and is not "fixed" (§4.2).
//   * A path outside the root is refused here, on the client, before any RPC.
//     The backend would refuse it too, but an instant answer beats a round
//     trip and lets the panel promise "no call at all".
import {
  getClientRoot,
  isAbsolutePath,
  isInsideRoot,
  joinPath,
  normalizePath,
  rootPhrase,
  toAbsolute,
} from "./fm-paths";

export type PathInputResult =
  /** Nothing typed: close the bar and change nothing. */
  | { kind: "empty" }
  /** Ready for `statPath`. */
  | { kind: "path"; absolute: string }
  /** Show the message, call nothing. */
  | { kind: "refused"; message: string };

export interface PathInputContext {
  /** `getState().root`. */
  root: string;
  /** The folder the panel is showing — the base for a relative path. */
  currentPath: string;
}

export const PATH_REMOTE_MESSAGE = "That looks like a path on another computer.";
export const PATH_SCHEME_MESSAGE = "Only paths on this computer can be opened here.";
export const PATH_INVALID_MESSAGE = "That path is not valid.";

/** No literal root path in user-facing text — `rootPhrase` is the only source. */
export function windowsPathMessage(root: string = getClientRoot()): string {
  return `That looks like a Windows path. This panel opens paths under ${rootPhrase(root)}.`;
}

export function outsideRootMessage(root: string = getClientRoot()): string {
  return `That path is outside ${rootPhrase(root)}.`;
}

/* ------------------------------------------------------------------ */
/* Cleanup (§4.1)                                                      */
/* ------------------------------------------------------------------ */

type Cleaned =
  | { kind: "empty" }
  | { kind: "value"; value: string }
  | { kind: "refused"; message: string };

/** `C:\…`, `C:/…` or `\\server\share`. */
function isWindowsShaped(value: string): boolean {
  if (/^[a-zA-Z]:[\\/]/u.test(value)) return true;
  if (value.startsWith("\\\\")) return true;
  // A lone backslash-separated path with no forward slash at all can only be
  // Windows: a POSIX path that deep always carries separators.
  return value.includes("\\") && !value.includes("/");
}

const SCHEME = /^([a-zA-Z][a-zA-Z0-9+.-]*):/u;
/** NUL, the C0 block and DEL: refused without asking the backend. */
const CONTROL_CHARS = /[\u0000-\u001F\u007F]/u;

function decodeFileUrl(value: string): Cleaned {
  const rest = value.slice("file:".length);
  let path = rest;
  if (rest.startsWith("//")) {
    const afterAuthority = rest.indexOf("/", 2);
    const authority = afterAuthority === -1 ? rest.slice(2) : rest.slice(2, afterAuthority);
    if (authority !== "" && authority.toLowerCase() !== "localhost") {
      return { kind: "refused", message: PATH_REMOTE_MESSAGE };
    }
    path = afterAuthority === -1 ? "" : rest.slice(afterAuthority);
  }
  // Only this branch percent-decodes: a literal `%` is legal in a file name
  // and must never be decoded out of a plain path.
  try {
    path = decodeURIComponent(path);
  } catch {
    return { kind: "refused", message: PATH_INVALID_MESSAGE };
  }
  if (path === "") return { kind: "empty" };
  return { kind: "value", value: path };
}

function cleanup(raw: string, root: string): Cleaned {
  // 1. Multi-line paste → the first line with anything on it; trim the rest,
  //    including the trailing newline a terminal copy usually carries.
  let value = "";
  for (const line of raw.split(/\r?\n/u)) {
    const trimmed = line.trim();
    if (trimmed !== "") {
      value = trimmed;
      break;
    }
  }
  if (value === "") return { kind: "empty" };

  // 2. One matched pair of wrapping quotes. Windows "Copy as path" and every
  //    shell quote a path that contains a space.
  let quoted = false;
  const first = value.charAt(0);
  if (value.length >= 2 && (first === '"' || first === "'") && value.endsWith(first)) {
    value = value.slice(1, -1);
    quoted = true;
  }

  // 3. Shell escapes, narrowly: only an unquoted value that really contains an
  //    escaped space. A backslash is legal in a POSIX name, so a blanket
  //    un-escape would corrupt a real one. The knowable false positive is a
  //    file whose name contains a backslash followed by a space (§4.1).
  if (!quoted && value.includes("\\ ")) {
    value = value.replace(/\\(.)/gu, "$1");
  }

  // 4/5. A drive letter looks like a URL scheme, so Windows is answered first.
  if (isWindowsShaped(value)) {
    return { kind: "refused", message: windowsPathMessage(root) };
  }

  const scheme = SCHEME.exec(value);
  if (scheme !== null) {
    if (scheme[1]?.toLowerCase() !== "file") {
      return { kind: "refused", message: PATH_SCHEME_MESSAGE };
    }
    const decoded = decodeFileUrl(value);
    if (decoded.kind !== "value") return decoded;
    value = decoded.value;
    // RFC 8089 writes a Windows path as `file:///C:/Users/me`: the drive letter
    // arrives behind a separator that hides it from the check below, which is
    // the very case that check exists for. Drop that one separator first — a
    // POSIX path can only match this shape by starting at a top-level "C:"
    // directory, which is outside the root and refused either way.
    if (/^\/[a-zA-Z]:[\\/]/u.test(value)) value = value.slice(1);
    if (isWindowsShaped(value)) {
      return { kind: "refused", message: windowsPathMessage(root) };
    }
  }

  // 6. Control characters and NUL. `src/root.ts#validateName` would refuse
  //    them anyway; there is no reason to spend a round trip learning that.
  if (CONTROL_CHARS.test(value)) {
    return { kind: "refused", message: PATH_INVALID_MESSAGE };
  }

  if (value === "") return { kind: "empty" };
  return { kind: "value", value };
}

/* ------------------------------------------------------------------ */
/* Resolution (§4.2) and the root check (§4.3)                         */
/* ------------------------------------------------------------------ */

/** Absolute form of a cleaned value. `~` is root-relative; anything else that
 *  is not absolute resolves against the folder on screen. */
function resolve(value: string, context: PathInputContext): string {
  if (value === "~" || value === "~/" || value.startsWith("~/")) {
    return toAbsolute(value, context.root);
  }
  if (isAbsolutePath(value)) return normalizePath(value);
  return joinPath(context.currentPath, value);
}

export function parsePathInput(raw: string, context: PathInputContext): PathInputResult {
  // Every refusal that names the root is built from the *caller's* root, not
  // from the module-level default, so the sentence is right even before
  // `setClientRoot` has ever run.
  const cleaned = cleanup(raw, context.root);
  if (cleaned.kind === "empty") return { kind: "empty" };
  if (cleaned.kind === "refused") return { kind: "refused", message: cleaned.message };

  const absolute = resolve(cleaned.value, context);
  if (!isInsideRoot(absolute, context.root)) {
    return { kind: "refused", message: outsideRootMessage(context.root) };
  }
  return { kind: "path", absolute };
}

/* ------------------------------------------------------------------ */
/* The seam autocomplete will need (§6) — exported and tested now       */
/* ------------------------------------------------------------------ */

export interface CompletionSplit {
  /** Absolute directory whose children would be offered. */
  dir: string;
  /** What has been typed of the child's name so far; "" after a separator. */
  prefix: string;
}

/**
 * `"~/pro"` → `{ dir: "<root>", prefix: "pro" }`;
 * `"~/projects/"` → `{ dir: "<root>/projects", prefix: "" }`.
 *
 * Returns null when there is nothing to complete (empty or refused input).
 * v0.4.0 ships no completion UI — this exists so adding one later is a feature,
 * not a redesign of the parser.
 */
export function splitForCompletion(
  raw: string,
  context: PathInputContext,
): CompletionSplit | null {
  const cleaned = cleanup(raw, context.root);
  if (cleaned.kind !== "value") return null;
  const value = cleaned.value;
  const index = value.lastIndexOf("/");
  if (index === -1) return { dir: normalizePath(context.currentPath), prefix: value };
  const head = value.slice(0, index + 1);
  const prefix = value.slice(index + 1);
  const dir = resolve(head, context);
  if (!isInsideRoot(dir, context.root)) return null;
  return { dir, prefix };
}
