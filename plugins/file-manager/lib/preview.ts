// lib/preview.ts — what the gallery can show, and where to fetch it from.
//
// Pure string work on purpose: the tile component stays a renderer, and both
// rules below are the kind that only a table of cases can prove right.
import type { FileEntry } from "../contract";

/**
 * Extensions a browser will paint from an <img> without help.
 *
 * Deliberately narrower than "image formats": `tiff`, `heic`, `psd` and `ico`
 * are images that most browsers will not decode, and a tile that requests one
 * pays for the bytes and then falls back to the icon anyway. `svg` is in
 * because it renders everywhere — and because it arrives through bb's preview
 * transport, not from this page's origin, so a hostile file cannot script the
 * panel it is displayed in.
 */
const IMAGE_EXTENSIONS: ReadonlySet<string> = new Set([
  "png",
  "jpg",
  "jpeg",
  "gif",
  "webp",
  "avif",
  "bmp",
  "svg",
]);

/** Lowercased extension after the last dot, or "" for a dotfile / no dot. */
function extensionOf(name: string): string {
  const dot = name.lastIndexOf(".");
  return dot > 0 ? name.slice(dot + 1).toLowerCase() : "";
}

/** True when a browser can be expected to paint this name in an <img>. */
export function isImageName(name: string): boolean {
  return IMAGE_EXTENSIONS.has(extensionOf(name));
}

/**
 * True for an entry the gallery should try to show rather than iconify.
 *
 * A symlink to an image counts (it is presented as what it points at, like
 * everywhere else in the panel), but one that leaves the root never does: the
 * whole plugin refuses to read through those.
 */
export function isImageEntry(entry: FileEntry): boolean {
  if (entry.escapesRoot) return false;
  const kind = entry.isSymlink && entry.targetKind !== null ? entry.targetKind : entry.kind;
  if (kind !== "file") return false;
  return isImageName(entry.name);
}

/**
 * `baseUrl` + a relative POSIX path, each segment percent-encoded.
 *
 * Segment by segment, never `encodeURIComponent(relativePath)`: a file name may
 * legally contain `#`, `?` and `%`, and encoding the whole path in one go would
 * also eat the `/` separators that make it a path.
 */
export function previewUrl(baseUrl: string, relativePath: string): string {
  const encoded = relativePath
    .split("/")
    .filter((segment) => segment !== "")
    .map((segment) => encodeURIComponent(segment))
    .join("/");
  if (encoded === "") return baseUrl;
  return baseUrl.endsWith("/") ? `${baseUrl}${encoded}` : `${baseUrl}/${encoded}`;
}
