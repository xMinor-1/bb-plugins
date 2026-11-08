// Finds the masking proxy binary: a path from settings, or a download from a
// URL template checked against the `.sha256` file published next to it.

import { createHash } from "node:crypto";
import { chmod, mkdir, readFile, rename, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";

/** Nothing to run until the settings change. */
export class NotConfiguredError extends Error {
  constructor(
    message: string,
    readonly problem: "no-source" | "no-file",
  ) {
    super(message);
  }
}

/** The release host did not give a binary that matches its checksum. */
export class DownloadError extends Error {}

export interface BinarySource {
  binaryPath: string;
  downloadUrl: string;
}

export interface PlatformInfo {
  platform: string;
  arch: string;
}

const OS: Record<string, string> = { darwin: "darwin", linux: "linux", win32: "windows" };
const ARCH: Record<string, string> = { x64: "amd64", arm64: "arm64" };

/** Fills `{os}`, `{arch}` and `{ext}` in a download URL template. */
export function expandDownloadUrl(template: string, { platform, arch }: PlatformInfo): string {
  const os = OS[platform];
  const cpu = ARCH[arch];
  if (os === undefined || cpu === undefined) throw new Error(`No proxy build for ${platform}/${arch}.`);
  return template
    .replaceAll("{os}", os)
    .replaceAll("{arch}", cpu)
    .replaceAll("{ext}", platform === "win32" ? ".exe" : "");
}

/** The hex digest from a `.sha256` file: `<hex>` or `<hex>  <file name>`. */
export function parseSha256File(text: string): string | null {
  const match = /^\s*([0-9a-f]{64})\b/iu.exec(text);
  return match ? match[1]!.toLowerCase() : null;
}

function sha256(data: Uint8Array): string {
  return createHash("sha256").update(data).digest("hex");
}

async function exists(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile();
  } catch {
    return false;
  }
}

async function fetchBytes(doFetch: typeof fetch, url: string, signal?: AbortSignal): Promise<Uint8Array> {
  const response = await doFetch(url, { redirect: "follow", signal });
  if (!response.ok) throw new DownloadError(`HTTP ${response.status} for ${url}`);
  return new Uint8Array(await response.arrayBuffer());
}

/** A network failure is a download failure; an abort stays an abort. */
function asDownloadError(cause: unknown, signal?: AbortSignal): unknown {
  if (cause instanceof DownloadError || signal?.aborted) return cause;
  const detail = cause instanceof Error ? (cause.cause instanceof Error ? cause.cause.message : cause.message) : String(cause);
  return new DownloadError(detail);
}

export interface EnsureBinaryOptions {
  source: BinarySource;
  /** Plugin-owned directory for downloads. */
  dir: string;
  platform?: PlatformInfo;
  fetch?: typeof fetch;
  signal?: AbortSignal;
}

export async function ensureBinary(options: EnsureBinaryOptions): Promise<string> {
  const binaryPath = options.source.binaryPath.trim();
  if (binaryPath !== "") {
    if (!(await exists(binaryPath))) throw new NotConfiguredError(binaryPath, "no-file");
    return binaryPath;
  }
  const template = options.source.downloadUrl.trim();
  if (template === "") throw new NotConfiguredError("Set the proxy binary path or download URL in the plugin settings.", "no-source");
  const platform = options.platform ?? { platform: process.platform, arch: process.arch };
  const url = expandDownloadUrl(template, platform);
  const doFetch = options.fetch ?? fetch;
  const name = basename(new URL(url).pathname) || "masking-proxy";
  const target = join(options.dir, name);
  const digestFile = `${target}.sha256`;

  // A copy downloaded earlier, still matching the digest it was checked against.
  const local = async (): Promise<string | null> => {
    if (!(await exists(target))) return null;
    const stored = (await readFile(digestFile, "utf8").catch(() => "")).trim();
    if (stored === "" || sha256(await readFile(target)) !== stored) return null;
    return stored;
  };

  let expected: string | null;
  try {
    expected = parseSha256File(new TextDecoder().decode(await fetchBytes(doFetch, `${url}.sha256`, options.signal)));
  } catch (cause) {
    // Offline or the release host is down: keep using the verified copy.
    if ((await local()) !== null) return target;
    throw asDownloadError(cause, options.signal);
  }
  if (expected === null) throw new DownloadError(`${url}.sha256 has no SHA-256 digest`);
  if ((await local()) === expected) return target;
  const data = await fetchBytes(doFetch, url, options.signal).catch((cause: unknown) => {
    throw asDownloadError(cause, options.signal);
  });
  const actual = sha256(data);
  if (actual !== expected) throw new DownloadError(`Checksum mismatch for ${url}: expected ${expected}, got ${actual}`);
  await mkdir(options.dir, { recursive: true });
  const partial = `${target}.partial`;
  await writeFile(partial, data, { mode: 0o755 });
  await chmod(partial, 0o755);
  await rename(partial, target);
  await writeFile(digestFile, `${expected}\n`);
  return target;
}
