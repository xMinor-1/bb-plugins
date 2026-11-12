// lib/download.ts — downloads happen by navigating, never by reading bytes.
//
// The download route is a plain GET with `auth: "local"` (§5.3), so the
// browser's own credentials go with it and the response streams straight to
// disk. Reading it in JS (`await res.blob()`) would buffer a multi-GB file in
// the renderer, which is exactly what this plugin exists to avoid — so this
// module only ever builds a URL and hands it to bb's `experimental_saveFile`.
// That is bb's own download path: an ordinary download in browsers and bb
// Desktop, the share sheet in the bb iOS app, and an error toast when the
// download cannot start.
import { experimental_saveFile } from "@get-bb/plugin-sdk/app";

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
  /** The saved file's name; defaults to the path's base name. */
  fileName?: string;
}

/**
 * Starts one download. Returns the URL that was triggered so callers (and
 * tests) can assert on it.
 */
export function downloadPath(path: string, options: DownloadOptions = {}): string {
  const url = buildDownloadUrl(path, options.disposition ?? "attachment");
  // The server's Content-Disposition still wins on the exact name (incl.
  // non-ASCII); bb reports a download that cannot start with its own toast.
  void experimental_saveFile({ fileName: options.fileName ?? basename(path), url });
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
export function downloadZip(paths: readonly string[]): string | null {
  const url = buildZipDownloadUrl(paths);
  if (url.length > MAX_ZIP_URL_LENGTH) return null;
  void experimental_saveFile({ fileName: zipFileName(paths), url });
  return url;
}

/**
 * Server twin: `zipFileName` in `src/http-routes.ts`, whose Content-Disposition
 * wins on the exact name; this is only the fallback.
 */
export function zipFileName(paths: readonly string[]): string {
  const single = paths.length === 1 ? paths[0] : undefined;
  const base = basename(single ?? commonParent(paths));
  return `${base === "/" ? "files" : base}.zip`;
}
