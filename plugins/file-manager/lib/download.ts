// lib/download.ts — downloads happen by navigating, never by reading bytes.
//
// The download route is a plain GET with `auth: "local"` (§5.3), so an
// `<a download>` click carries the browser's own credentials and the response
// streams straight to disk. Reading it in JS (`await res.blob()`) would buffer
// a multi-GB file in the renderer, which is exactly what this plugin exists to
// avoid — so this module only ever builds a URL and clicks a link.
import { DOWNLOAD_URL, type FileEntry } from "../contract";
import { basename } from "./fm-paths";

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
 * Several files at once. Browsers throttle back-to-back navigations, so the
 * clicks are staggered; the returned promise resolves once all are issued.
 */
export async function downloadPaths(
  paths: readonly string[],
  options: DownloadOptions & { delayMs?: number } = {},
): Promise<string[]> {
  const { delayMs = 250, ...rest } = options;
  const urls: string[] = [];
  for (const [index, path] of paths.entries()) {
    if (index > 0 && delayMs > 0) {
      await new Promise<void>((resolve) => setTimeout(resolve, delayMs));
    }
    urls.push(downloadPath(path, rest));
  }
  return urls;
}
