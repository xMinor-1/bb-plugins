// lib/download.ts — downloads happen by navigating, never by reading bytes.
//
// The download route is a plain GET with `auth: "local"` (§5.3), so an
// `<a download>` click carries the browser's own credentials and the response
// streams straight to disk. Reading it in JS (`await res.blob()`) would buffer
// a multi-GB file in the renderer, which is exactly what this plugin exists to
// avoid — so this module only ever builds a URL and clicks a link.
import { DOWNLOAD_URL, DOWNLOAD_ZIP_URL, type FileEntry } from "../contract";
import { basename, dirname } from "./fm-paths";

export type DownloadDisposition = "attachment" | "inline";

/** Server twin: `src/http-routes.ts` reads `path` and `disposition`. */
export function buildDownloadUrl(
  path: string,
  disposition: DownloadDisposition = "attachment",
): string {
  const query = new URLSearchParams({ path });
  if (disposition !== "attachment") query.set("disposition", disposition);
  return `${DOWNLOAD_URL}?${query.toString()}`;
}

export interface DownloadOptions {
  disposition?: DownloadDisposition;
  /** Overrides the `download` attribute; defaults to the path's base name. */
  fileName?: string;
  /** Test seam. */
  document?: Document;
}

/**
 * Starts one download. Returns the URL that was triggered so callers (and
 * tests) can assert on it without stubbing the DOM.
 */
export function downloadPath(path: string, options: DownloadOptions = {}): string {
  const url = buildDownloadUrl(path, options.disposition ?? "attachment");
  const doc = options.document ?? (typeof document === "undefined" ? undefined : document);
  if (doc === undefined) return url;

  const anchor = doc.createElement("a");
  anchor.href = url;
  // Same-origin, so the browser honours `download`; the server's
  // Content-Disposition still wins on the exact name (incl. non-ASCII).
  anchor.download = options.fileName ?? basename(path);
  anchor.rel = "noopener";
  anchor.style.display = "none";
  doc.body.append(anchor);
  anchor.click();
  anchor.remove();
  return url;
}

/** Convenience for a row: refuses directories and links that leave the root. */
export function downloadEntry(entry: FileEntry, options: DownloadOptions = {}): string | null {
  if (entry.escapesRoot) return null;
  const kind = entry.isSymlink ? entry.targetKind : entry.kind;
  if (kind !== "file") return null;
  return downloadPath(entry.path, { fileName: entry.name, ...options });
}

/**
 * Past this a request line risks the server's header limit, and the answer
 * would be a failed download with no word on why.
 */
export const MAX_ZIP_URL_LENGTH = 8000;

/** The deepest folder that holds every path. */
export function commonParent(paths: readonly string[]): string {
  let common = dirname(paths[0] ?? "/");
  for (const path of paths.slice(1)) {
    while (common !== "/" && !path.startsWith(`${common}/`)) common = dirname(common);
  }
  return common;
}

/** Server twin: `src/http-routes.ts` reads `dir` and every `name`. */
export function buildZipDownloadUrl(paths: readonly string[]): string {
  const dir = commonParent(paths);
  const query = new URLSearchParams({ dir });
  const prefix = dir === "/" ? "/" : `${dir}/`;
  for (const path of paths) query.append("name", path.slice(prefix.length));
  return `${DOWNLOAD_ZIP_URL}?${query.toString()}`;
}

/**
 * Several files, or any folder, as one zip. A burst of separate downloads is
 * what browsers block after the first and phones never start at all, so
 * anything that is not a single file goes out as one response (§5.3).
 * `paths` must already be top-level (`topLevelPaths`). Returns `null` when
 * the selection is too long to fit in a URL.
 */
export function downloadZip(paths: readonly string[], options: Pick<DownloadOptions, "document"> = {}): string | null {
  const url = buildZipDownloadUrl(paths);
  if (url.length > MAX_ZIP_URL_LENGTH) return null;
  const doc = options.document ?? (typeof document === "undefined" ? undefined : document);
  if (doc === undefined) return url;
  const anchor = doc.createElement("a");
  anchor.href = url;
  // The server names the archive; this is only the fallback.
  anchor.download = "";
  anchor.rel = "noopener";
  anchor.style.display = "none";
  doc.body.append(anchor);
  anchor.click();
  anchor.remove();
  return url;
}
