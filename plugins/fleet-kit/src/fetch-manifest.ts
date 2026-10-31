// Reads the manifest from where the operator published it.
//
// Supported addresses:
//   - an absolute path, or `~/...` (expanded to the home directory);
//   - `file://` URLs;
//   - `https://` URLs, optionally with a bearer token (private Git hosting raw
//     file APIs accept `Authorization: Bearer <token>`).
// Plain `http://` is refused: the manifest decides which code runs here.
import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { isAbsolute, join } from "node:path";
import { fileURLToPath } from "node:url";

const MAX_BYTES = 1024 * 1024;

export type ManifestLocation =
  | { kind: "file"; path: string; display: string }
  | { kind: "https"; url: URL; display: string };

/** The address with any `user:password@` hidden, for display. */
export function maskManifestUrl(value: string): string {
  return value.replace(/^([a-z][a-z0-9+.-]*:\/\/)[^@/?#]*@/i, "$1***@");
}

export function parseManifestLocation(value: string): ManifestLocation {
  const trimmed = value.trim();
  if (trimmed === "") throw new Error("manifestUrl is empty");
  if (trimmed.startsWith("~/") || trimmed === "~") {
    const path = join(homedir(), trimmed.slice(1));
    return { kind: "file", path, display: trimmed };
  }
  if (isAbsolute(trimmed) && !/^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed)) {
    return { kind: "file", path: trimmed, display: trimmed };
  }
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new Error("manifestUrl must be an absolute path, a file:// URL or an https:// URL");
  }
  if (url.protocol === "file:") return { kind: "file", path: fileURLToPath(url), display: trimmed };
  if (url.protocol === "https:") {
    if (url.username || url.password) throw new Error("put credentials in manifestToken, not in manifestUrl");
    const display = `${url.origin}${url.pathname}`;
    return { kind: "https", url, display };
  }
  throw new Error(`manifestUrl scheme ${url.protocol} is not supported; use https:// or a file path`);
}

export async function fetchManifestText(
  location: ManifestLocation,
  options: { token?: string; signal?: AbortSignal } = {},
): Promise<string> {
  if (location.kind === "file") {
    const text = await readFile(location.path, "utf8");
    if (Buffer.byteLength(text) > MAX_BYTES) throw new Error("the manifest is larger than 1 MiB");
    return text;
  }
  const headers: Record<string, string> = { accept: "application/json, application/vnd.github.raw, text/plain;q=0.5" };
  if (options.token) headers.authorization = `Bearer ${options.token}`;
  const signal = options.signal ? AbortSignal.any([options.signal, AbortSignal.timeout(30_000)]) : AbortSignal.timeout(30_000);
  const response = await fetch(location.url, { headers, signal, redirect: "follow" });
  // A redirect may not leave https: the manifest decides which code runs here.
  if (response.url !== "" && new URL(response.url).protocol !== "https:") {
    await response.body?.cancel().catch(() => undefined);
    throw new Error("the manifest server redirected to a non-https address");
  }
  if (!response.ok) throw new Error(`the manifest server answered ${response.status} ${response.statusText}`.trim());
  const reader = response.body?.getReader();
  if (reader === undefined) return "";
  const chunks: Uint8Array[] = [];
  let size = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    size += value.byteLength;
    if (size > MAX_BYTES) {
      await reader.cancel();
      throw new Error("the manifest is larger than 1 MiB");
    }
    chunks.push(value);
  }
  return Buffer.concat(chunks).toString("utf8");
}

export function parseManifestJson(text: string): unknown {
  const body = text.charCodeAt(0) === 0xfeff ? text.slice(1) : text;
  try {
    return JSON.parse(body);
  } catch (error) {
    throw new Error(`the manifest is not valid JSON: ${(error as Error).message}`);
  }
}
