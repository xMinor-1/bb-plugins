// lib/fm-paths.ts — POSIX path arithmetic for the panel.
//
// Browser-only: `node:path` is not available in the app bundle, and every path
// the backend speaks is a POSIX absolute path under the hard root (§4, §6). The
// panel route carries the *root-relative* form, URL-encoded per segment
// (§8): decode with `decodeSubPath`, and hand the raw relative path to
// `navigate.toPluginPanel` — the host encodes each segment itself.
export const SEPARATOR = "/";

/**
 * The hard root, as reported by the backend bootstrap (`state.root`). The panel
 * cannot know it up front — it is the home directory of whoever runs bb — so
 * FileManagerPanel publishes it here once and the helpers below default to it.
 */
let clientRoot = SEPARATOR;

export function setClientRoot(root: string): void {
  clientRoot = root;
}

export function getClientRoot(): string {
  return clientRoot;
}

export function isAbsolutePath(path: string): boolean {
  return path.startsWith(SEPARATOR);
}

/**
 * Lexical normalization: collapses repeated separators, drops `.`, resolves
 * `..` where it can, and strips the trailing separator (except for "/").
 * Never touches the filesystem — this is presentation-side only; the backend
 * re-resolves and re-checks everything it is handed (§6).
 */
export function normalizePath(path: string): string {
  const absolute = isAbsolutePath(path);
  const out: string[] = [];
  for (const segment of path.split(SEPARATOR)) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      const last = out[out.length - 1];
      if (out.length > 0 && last !== "..") out.pop();
      else if (!absolute) out.push("..");
      continue;
    }
    out.push(segment);
  }
  const joined = out.join(SEPARATOR);
  if (absolute) return SEPARATOR + joined;
  return joined;
}

/**
 * Turn user/route input into an absolute path. Mirrors the backend's
 * `normalize()` (§6): "" and "~" are the root, "~/x" is root-relative, an
 * absolute input stays absolute, anything else resolves under the root.
 */
export function toAbsolute(input: string, root: string = getClientRoot()): string {
  const rootPath = normalizePath(root);
  const trimmed = input.trim();
  if (trimmed === "" || trimmed === "~") return rootPath;
  if (trimmed === "~/") return rootPath;
  if (trimmed.startsWith("~/")) return normalizePath(`${rootPath}/${trimmed.slice(2)}`);
  if (isAbsolutePath(trimmed)) return normalizePath(trimmed);
  return normalizePath(`${rootPath}/${trimmed}`);
}

/**
 * Root-relative form of an absolute path; "" for the root itself. Paths
 * outside the root have no relative form — they yield "" so the caller falls
 * back to the root instead of building a nonsense route.
 */
export function toRelative(absolute: string, root: string = getClientRoot()): string {
  const rootPath = normalizePath(root);
  const path = normalizePath(absolute);
  if (path === rootPath) return "";
  if (!path.startsWith(`${rootPath}${SEPARATOR}`)) return "";
  return path.slice(rootPath.length + 1);
}

export function isRootPath(path: string, root: string = getClientRoot()): boolean {
  return normalizePath(path) === normalizePath(root);
}

export function isInsideRoot(path: string, root: string = getClientRoot()): boolean {
  const rootPath = normalizePath(root);
  const candidate = normalizePath(path);
  return candidate === rootPath || candidate.startsWith(`${rootPath}${SEPARATOR}`);
}

/** Per-segment `decodeURIComponent`, tolerating segments that are not valid escapes. */
export function decodeSubPath(subPath: string): string {
  if (subPath === "") return "";
  return subPath
    .split(SEPARATOR)
    .map((segment) => {
      try {
        return decodeURIComponent(segment);
      } catch {
        return segment;
      }
    })
    .join(SEPARATOR);
}

/**
 * Per-segment `encodeURIComponent`. Only needed when building a URL string by
 * hand; `navigate.toPluginPanel(path, { subPath })` wants the *raw* relative
 * path and encodes it itself.
 */
export function encodeSubPath(relative: string): string {
  if (relative === "") return "";
  return relative.split(SEPARATOR).map(encodeURIComponent).join(SEPARATOR);
}

/** Route remainder → absolute directory path. */
export function subPathToAbsolute(subPath: string, root: string = getClientRoot()): string {
  return toAbsolute(decodeSubPath(subPath), root);
}

/** Absolute directory path → the raw (unencoded) `subPath` for `toPluginPanel`. */
export function absoluteToSubPath(absolute: string, root: string = getClientRoot()): string {
  return toRelative(absolute, root);
}

export function joinPath(base: string, ...segments: string[]): string {
  const tail = segments.filter((segment) => segment !== "").join(SEPARATOR);
  if (tail === "") return normalizePath(base);
  return normalizePath(`${base}${SEPARATOR}${tail}`);
}

export function basename(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === SEPARATOR) return SEPARATOR;
  const index = normalized.lastIndexOf(SEPARATOR);
  return index === -1 ? normalized : normalized.slice(index + 1);
}

export function dirname(path: string): string {
  const normalized = normalizePath(path);
  if (normalized === SEPARATOR) return SEPARATOR;
  const index = normalized.lastIndexOf(SEPARATOR);
  if (index <= 0) return index === 0 ? SEPARATOR : ".";
  return normalized.slice(0, index);
}

/** Parent directory, or null at (or above) the root. */
export function parentPath(path: string, root: string = getClientRoot()): string | null {
  const normalized = normalizePath(path);
  if (!isInsideRoot(normalized, root) || isRootPath(normalized, root)) return null;
  return dirname(normalized);
}

export function isSamePath(a: string, b: string): boolean {
  return normalizePath(a) === normalizePath(b);
}

/** True when `candidate` sits strictly below `ancestor`. */
export function isDescendant(candidate: string, ancestor: string): boolean {
  const child = normalizePath(candidate);
  const parent = normalizePath(ancestor);
  if (child === parent) return false;
  const prefix = parent === SEPARATOR ? SEPARATOR : `${parent}${SEPARATOR}`;
  return child.startsWith(prefix);
}

export function isSameOrDescendant(candidate: string, ancestor: string): boolean {
  return isSamePath(candidate, ancestor) || isDescendant(candidate, ancestor);
}

export interface Breadcrumb {
  /** Label to render. The root segment uses `rootLabel`. */
  name: string;
  /** Absolute path of this segment. */
  path: string;
  isRoot: boolean;
}

/** Root-first crumb list for the current directory (§8 Toolbar/Breadcrumbs). */
export function breadcrumbs(
  absolute: string,
  root: string = getClientRoot(),
  rootLabel = "Home",
): Breadcrumb[] {
  const rootPath = normalizePath(root);
  const crumbs: Breadcrumb[] = [{ name: rootLabel, path: rootPath, isRoot: true }];
  const relative = toRelative(absolute, rootPath);
  if (relative === "") return crumbs;
  let current = rootPath;
  for (const segment of relative.split(SEPARATOR)) {
    if (segment === "") continue;
    current = `${current}${SEPARATOR}${segment}`;
    crumbs.push({ name: segment, path: current, isRoot: false });
  }
  return crumbs;
}

export interface SplitName {
  /** Everything before the extension; the whole name when there is none. */
  stem: string;
  /** Extension *with* its leading dot, or "" when there is none. */
  extension: string;
}

/**
 * Splits a base name for the rename dialog (which pre-selects the stem).
 * Dot-files without a second dot are all stem: ".bashrc" → stem ".bashrc".
 * Known two-part archive suffixes stay together: "a.tar.gz" → ".tar.gz".
 */
export function splitFileName(name: string): SplitName {
  const doubleSuffix = /\.tar\.(gz|bz2|xz)$/iu.exec(name);
  if (doubleSuffix !== null && doubleSuffix.index > 0) {
    return { stem: name.slice(0, doubleSuffix.index), extension: name.slice(doubleSuffix.index) };
  }
  const index = name.lastIndexOf(".");
  if (index <= 0) return { stem: name, extension: "" };
  return { stem: name.slice(0, index), extension: name.slice(index) };
}

export function isHiddenName(name: string): boolean {
  return name.startsWith(".");
}

/** POSIX sub-path of a `webkitRelativePath` / drag-and-drop entry, minus the file name. */
export function relativeDirOf(relativePath: string): string {
  const normalized = normalizePath(relativePath.replace(/^\/+/u, ""));
  const index = normalized.lastIndexOf(SEPARATOR);
  return index === -1 ? "" : normalized.slice(0, index);
}
