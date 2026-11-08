// A relative link in an HTML document, resolved to a file next to it.
//
// The bridge hands the panel the link's raw href; the page's own scripts can
// post the same message, so nothing here trusts it: the result stays inside
// the document's folder — files the page can already load through its
// <base> — and is only ever opened in bb's own file preview.
import type { ExperimentalFileLocation } from "@get-bb/plugin-sdk/app";

export type HtmlFileLink =
  | { kind: "file"; path: string; location: ExperimentalFileLocation | null }
  | { kind: "outside" };

const MAX_HREF = 4096;

/** `a/./b/../c` → `a/c`; null when `..` climbs above the start. */
function collapse(segments: readonly string[]): string[] | null {
  const out: string[] = [];
  for (const segment of segments) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      if (out.length === 0) return null;
      out.pop();
    } else {
      out.push(segment);
    }
  }
  return out;
}

/** `#L12`, `#L12C3`, or a `:12` / `:12:3` suffix on the path. */
function lineOf(hash: string, filePath: string): { path: string; location: ExperimentalFileLocation | null } | null {
  const fromHash = /^#L([1-9]\d{0,8})(?:C([1-9]\d{0,8}))?$/.exec(hash);
  const fromSuffix = fromHash ? null : /:([1-9]\d{0,8})(?::([1-9]\d{0,8}))?$/.exec(filePath);
  const match = fromHash ?? fromSuffix;
  const bare = fromSuffix ? filePath.slice(0, fromSuffix.index) : filePath;
  if (!bare) return null;
  if (!match) return { path: bare, location: null };
  return {
    path: bare,
    location: { kind: "line", line: Number(match[1]), column: match[2] ? Number(match[2]) : null },
  };
}

/**
 * `href` against `documentPath` (absolute, forward slashes: Windows paths are
 * stored as `C:/…`). Null for anything that is not a relative file link.
 */
export function htmlFileLink(href: unknown, documentPath: string): HtmlFileLink | null {
  if (typeof href !== "string" || href.length > MAX_HREF) return null;
  const link = href.trim();
  // "plan.md:12" parses as a URL scheme; a name with an extension and a line
  // number is a file link, as the bridge reads it too.
  const lineLink = /^[^/\\:?#]+\.[^/\\:?#]+:\d+(?::\d+)?$/.test(link);
  if (!link || /^[#?/\\]/.test(link) || (!lineLink && /^[a-z][a-z0-9+.-]*:/i.test(link))) return null;
  if (/[\u0000-\u001f]/.test(link)) return null;

  const hashAt = link.indexOf("#");
  const hash = hashAt >= 0 ? link.slice(hashAt) : "";
  let relative = hashAt >= 0 ? link.slice(0, hashAt) : link;
  const queryAt = relative.indexOf("?");
  if (queryAt >= 0) relative = relative.slice(0, queryAt);
  try {
    relative = decodeURIComponent(relative);
  } catch {
    return null;
  }
  if (!relative || relative.includes("\u0000")) return null;

  const slash = documentPath.lastIndexOf("/");
  if (slash < 0) return null;
  const folder = documentPath.slice(0, slash);
  // Browsers read a backslash in a URL as a slash.
  const inside = collapse(relative.replace(/\\/g, "/").split("/"));
  if (inside === null) return { kind: "outside" };
  if (inside.length === 0) return null;

  const target = lineOf(hash, `${folder}/${inside.join("/")}`);
  return target ? { kind: "file", ...target } : null;
}
