import type { ExperimentalFileLocation } from "@get-bb/plugin-sdk/app";

/** Resolve local links against the report, independently of its preview URL. */
export function htmlFileLink(href: unknown, documentPath: string): { path: string; location: ExperimentalFileLocation | null } | null {
  if (typeof href !== "string" || href.length > 8192) return null;
  const link = href.trim();
  if (!link || /^[#?\/\\]|^[a-z][a-z0-9+.-]*:/i.test(link) || /[\u0000-\u001f]/.test(link)) return null;
  try {
    const source = documentPath.replace(/\\/g, "/");
    const base = new URL(`file://${source.startsWith("/") ? "" : "/"}${source.split("/").map(encodeURIComponent).join("/")}`);
    const url = new URL(link, base);
    let path = decodeURIComponent(url.pathname);
    if (/^\/[a-z]:\//i.test(path)) path = path.slice(1);
    const line = /#L([1-9]\d*)(?:C([1-9]\d*))?$/.exec(url.hash);
    const suffix = /:([1-9]\d*)(?::([1-9]\d*))?$/.exec(path);
    if (suffix) path = path.slice(0, suffix.index);
    const position = line ?? suffix;
    const number = position ? Number(position[1]) : null;
    const column = position?.[2] ? Number(position[2]) : null;
    if ((number !== null && !Number.isSafeInteger(number)) || (column !== null && !Number.isSafeInteger(column))) return null;
    return { path, location: number === null ? null : { kind: "line", line: number, column } };
  } catch {
    return null;
  }
}
