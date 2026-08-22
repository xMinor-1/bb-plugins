// Pure path helpers shared by the backend. Kept free of the plugin API so
// they can be unit-tested without a bb server.

/** True when the path ends in a PDF extension (case-insensitive). */
export function isPdfPath(path: string): boolean {
  return /\.pdf$/i.test(path);
}

/** The last segment of a POSIX-ish path, or the path itself when it has none. */
export function baseName(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const index = Math.max(
    normalized.lastIndexOf("/"),
    normalized.lastIndexOf("\\"),
  );
  return index === -1 ? normalized : normalized.slice(index + 1);
}

/** Everything before the last segment; "." when the path has no directory. */
export function directoryName(path: string): string {
  const normalized = path.replace(/[\\/]+$/, "");
  const index = Math.max(
    normalized.lastIndexOf("/"),
    normalized.lastIndexOf("\\"),
  );
  if (index === -1) return ".";
  if (index === 0) return "/";
  return normalized.slice(0, index);
}

/** Joins a root with a relative path, tolerating a trailing slash on the root. */
export function joinPath(root: string, relative: string): string {
  const left = root.replace(/\/+$/, "");
  const right = relative.replace(/^\/+/, "");
  return right.length === 0 ? left : `${left}/${right}`;
}

/**
 * Appends one file name to a file-preview base URL. Preview URLs are
 * path-shaped, so each segment is encoded individually.
 */
export function previewUrlFor(baseUrl: string, fileName: string): string {
  return `${baseUrl.replace(/\/+$/, "")}/${encodeURIComponent(fileName)}`;
}
