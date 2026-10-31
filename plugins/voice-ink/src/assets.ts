// Files the whisper.cpp engine needs — the server program and the model —
// fetched from addresses in the settings and kept only once their SHA-256
// matches the one in the settings.
//
// - Content-addressed: each file lives in `<root>/<sha256>/`, so a changed
//   setting never mixes an old file with a new sum, and a file that passed its
//   check once is not hashed again on every start (a marker records it).
// - Resumable: a download in progress is `<name>.part`; the next attempt asks
//   for the rest with a Range request and starts over if the server ignores it.
// - The optional authorization header goes only to the configured origin over
//   https (or plain http on this machine): redirects are followed by hand and a
//   redirect to another origin — object storage behind a package registry —
//   gets no header.
// - `file:` URLs and absolute paths are copied and checked the same way, so a
//   machine without access to the server can be set up from a shared folder.
import { createHash } from "node:crypto";
import { createReadStream, createWriteStream, existsSync, readdirSync, readFileSync } from "node:fs";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, statfs, writeFile } from "node:fs/promises";
import { basename, dirname, isAbsolute, join, normalize, sep } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { fileURLToPath } from "node:url";
import { unzipSync } from "fflate";

export interface AssetSpec {
  url: string;
  sha256: string;
}

export interface AssetProgress {
  /** "model" or "runtime", for the status line. */
  label: string;
  doneBytes: number;
  totalBytes: number | null;
}

export interface FetchOptions {
  /** `Name: value`, sent to the configured origin only. */
  authHeader: string | null;
  signal?: AbortSignal;
  onProgress?: (progress: AssetProgress) => void;
}

export class AssetError extends Error {
  constructor(
    message: string,
    /** Retrying cannot help (wrong sum, refused access, missing file). */
    readonly permanent: boolean,
  ) {
    super(message);
    this.name = "AssetError";
  }
}

const SHA256 = /^[0-9a-f]{64}$/;
const MARKER = ".verified";
const MAX_REDIRECTS = 5;
const ATTEMPTS = 3;
/** Kept free on the disk beyond the file itself. */
const DISK_MARGIN_BYTES = 200 * 1024 * 1024;

export function checkSpec(spec: AssetSpec, label: string): void {
  if (spec.url.trim() === "") throw new AssetError(`no address is set for the ${label}`, true);
  if (!SHA256.test(spec.sha256)) {
    throw new AssetError(`the SHA-256 for the ${label} is not 64 hexadecimal characters`, true);
  }
}

/** The file name a download is stored under: the last path segment, made safe. */
function fileNameFor(url: string): string {
  let name = "";
  try {
    name = decodeURIComponent(basename(new URL(url).pathname));
  } catch {
    name = basename(url);
  }
  name = name.replace(/[^A-Za-z0-9._-]/g, "_");
  return name === "" || name === "." || name === ".." ? "download.bin" : name;
}

export class AssetStore {
  private readonly inFlight = new Map<string, Promise<string>>();

  constructor(private readonly root: string) {}

  /** The verified file, if it is already here; no network, no hashing. */
  presentFile(spec: AssetSpec): string | null {
    if (!SHA256.test(spec.sha256)) return null;
    const dir = join(this.root, spec.sha256);
    const marker = readMarker(dir);
    if (marker === null || marker.kind !== "file") return null;
    const path = join(dir, marker.name);
    return existsSync(path) ? path : null;
  }

  /** The extracted archive's directory, if it is already here. */
  presentArchive(spec: AssetSpec): string | null {
    if (!SHA256.test(spec.sha256)) return null;
    const dir = join(this.root, spec.sha256);
    const marker = readMarker(dir);
    if (marker === null || marker.kind !== "archive") return null;
    const extracted = join(dir, "files");
    return existsSync(extracted) ? extracted : null;
  }

  /** Fetch (or resume) one file and return its path once its sum matches. */
  ensureFile(spec: AssetSpec, label: string, options: FetchOptions): Promise<string> {
    return this.once(`file:${spec.sha256}`, async () => {
      checkSpec(spec, label);
      const present = this.presentFile(spec);
      if (present !== null) return present;
      const dir = join(this.root, spec.sha256);
      await mkdir(dir, { recursive: true });
      const name = fileNameFor(spec.url);
      const target = join(dir, name);
      await this.fetchVerified(spec, label, target, options);
      await writeMarker(dir, { kind: "file", name });
      return target;
    });
  }

  /** Fetch a zip archive, check it, unpack it, and return the directory. */
  ensureArchive(spec: AssetSpec, label: string, options: FetchOptions): Promise<string> {
    return this.once(`archive:${spec.sha256}`, async () => {
      checkSpec(spec, label);
      const present = this.presentArchive(spec);
      if (present !== null) return present;
      const dir = join(this.root, spec.sha256);
      await mkdir(dir, { recursive: true });
      const archive = join(dir, "archive.zip");
      await this.fetchVerified(spec, label, archive, options);
      const extracted = join(dir, "files");
      await rm(extracted, { recursive: true, force: true });
      await extractZip(await readFile(archive), extracted);
      await rm(archive, { force: true });
      await writeMarker(dir, { kind: "archive", name: "files" });
      return extracted;
    });
  }

  /** Delete every stored version except the ones named; only directories this store made. */
  async prune(keep: readonly string[]): Promise<void> {
    let entries: string[];
    try {
      entries = await readdir(this.root);
    } catch {
      return;
    }
    for (const entry of entries) {
      if (!SHA256.test(entry) || keep.includes(entry)) continue;
      if (this.inFlight.has(`file:${entry}`) || this.inFlight.has(`archive:${entry}`)) continue;
      await rm(join(this.root, entry), { recursive: true, force: true }).catch(() => {});
    }
  }

  private once(key: string, work: () => Promise<string>): Promise<string> {
    const running = this.inFlight.get(key);
    if (running !== undefined) return running;
    const started = work().finally(() => this.inFlight.delete(key));
    this.inFlight.set(key, started);
    return started;
  }

  private async fetchVerified(spec: AssetSpec, label: string, target: string, options: FetchOptions): Promise<void> {
    const part = `${target}.part`;
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= ATTEMPTS; attempt++) {
      try {
        await fetchTo(spec.url, part, label, options);
        const actual = await sha256File(part);
        if (actual !== spec.sha256) {
          await rm(part, { force: true });
          throw new AssetError(
            `the ${label} downloaded from the configured address does not match its SHA-256 (got ${actual.slice(0, 12)}…)`,
            true,
          );
        }
        await renameWithRetry(part, target);
        return;
      } catch (error) {
        lastError = error;
        if (error instanceof AssetError && error.permanent) throw error;
        if (options.signal?.aborted) throw error;
        if (attempt < ATTEMPTS) await delay(attempt * 3_000);
      }
    }
    throw lastError instanceof Error ? lastError : new Error(String(lastError));
  }
}

// --- fetching --------------------------------------------------------------

function localPath(url: string): string | null {
  if (url.startsWith("file:")) return fileURLToPath(url);
  if (isAbsolute(url) || /^[A-Za-z]:[\\/]/.test(url)) return url;
  return null;
}

/** Download (or copy) into `part`, resuming what is already there. */
async function fetchTo(url: string, part: string, label: string, options: FetchOptions): Promise<void> {
  const local = localPath(url);
  if (local !== null) {
    let size: number;
    try {
      size = (await stat(local)).size;
    } catch {
      throw new AssetError(`the ${label} file ${local} does not exist`, true);
    }
    await ensureDiskSpace(dirname(part), size);
    await pipeline(createReadStream(local), progressCounter(label, 0, size, options), createWriteStream(part));
    return;
  }

  let have = 0;
  try {
    have = (await stat(part)).size;
  } catch {
    have = 0;
  }
  const response = await request(url, options, have > 0 ? { range: `bytes=${have}-` } : {});
  if (response.status === 416 && have > 0) {
    // Everything was already here; the sum decides whether it is right.
    await response.body?.cancel().catch(() => {});
    return;
  }
  if (response.status !== 200 && response.status !== 206) {
    await response.body?.cancel().catch(() => {});
    throw httpError(response.status, label);
  }
  const append = response.status === 206 && contentRangeStart(response) === have;
  const length = Number(response.headers.get("content-length"));
  const remaining = Number.isFinite(length) && length > 0 ? length : null;
  const already = append ? have : 0;
  if (remaining !== null) await ensureDiskSpace(dirname(part), remaining);
  if (response.body === null) throw new AssetError(`the ${label} download returned no body`, false);
  await pipeline(
    Readable.fromWeb(response.body as never),
    progressCounter(label, already, remaining === null ? null : already + remaining, options),
    createWriteStream(part, { flags: append ? "a" : "w" }),
    { signal: options.signal },
  );
}

/** One GET with redirects followed by hand, so the header stays with its origin. */
async function request(url: string, options: FetchOptions, extra: Record<string, string>): Promise<Response> {
  const origin = new URL(url).origin;
  const header = parseHeader(options.authHeader);
  if (header !== null && !headerAllowed(url)) {
    throw new AssetError("the authorization header is only sent over https", true);
  }
  let current = url;
  for (let hop = 0; hop <= MAX_REDIRECTS; hop++) {
    const headers: Record<string, string> = { ...extra };
    if (header !== null && new URL(current).origin === origin) headers[header.name] = header.value;
    let response: Response;
    try {
      response = await fetch(current, { headers, redirect: "manual", signal: options.signal });
    } catch (error) {
      if (options.signal?.aborted) throw error;
      // undici says "fetch failed" and keeps the reason in `cause`.
      const cause = (error as { cause?: { code?: string; message?: string } }).cause;
      const reason = cause?.code ?? cause?.message ?? (error instanceof Error ? error.message : String(error));
      throw new AssetError(`could not reach the download server (${reason})`, false);
    }
    if (response.status < 300 || response.status >= 400 || !response.headers.has("location")) return response;
    await response.body?.cancel().catch(() => {});
    const next = new URL(response.headers.get("location") as string, current);
    if (next.protocol !== "https:" && next.protocol !== "http:") {
      throw new AssetError("the download redirected to an address that is not http or https", true);
    }
    current = next.toString();
  }
  throw new AssetError("the download was redirected too many times", true);
}

function headerAllowed(url: string): boolean {
  const parsed = new URL(url);
  if (parsed.protocol === "https:") return true;
  return parsed.protocol === "http:" && (parsed.hostname === "127.0.0.1" || parsed.hostname === "localhost");
}

function parseHeader(raw: string | null): { name: string; value: string } | null {
  if (raw === null || raw.trim() === "") return null;
  const colon = raw.indexOf(":");
  const name = colon > 0 ? raw.slice(0, colon).trim() : "";
  const value = colon > 0 ? raw.slice(colon + 1).trim() : "";
  if (!/^[A-Za-z0-9-]+$/.test(name) || value === "") {
    throw new AssetError("the download authorization header must look like `Name: value`", true);
  }
  return { name, value };
}

function contentRangeStart(response: Response): number | null {
  const range = response.headers.get("content-range");
  const match = range === null ? null : /^bytes (\d+)-/.exec(range);
  return match === null ? null : Number(match[1]);
}

function httpError(status: number, label: string): AssetError {
  if (status === 401 || status === 403) {
    return new AssetError(
      `the server refused the ${label} download (HTTP ${status}): it needs an authorization header, or the one set has no access`,
      true,
    );
  }
  if (status === 404) {
    return new AssetError(`the ${label} was not found at the configured address (HTTP 404)`, true);
  }
  return new AssetError(`the ${label} download failed with HTTP ${status}`, status < 500 && status !== 429);
}

function progressCounter(label: string, start: number, total: number | null, options: FetchOptions): Transform {
  let done = start;
  let reported = 0;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      done += chunk.length;
      const now = Date.now();
      if (now - reported > 500) {
        reported = now;
        options.onProgress?.({ label, doneBytes: done, totalBytes: total });
      }
      callback(null, chunk);
    },
    flush(callback) {
      options.onProgress?.({ label, doneBytes: done, totalBytes: total ?? done });
      callback();
    },
  });
}

async function ensureDiskSpace(dir: string, needed: number): Promise<void> {
  try {
    const info = await statfs(dir);
    const free = Number(info.bavail) * Number(info.bsize);
    if (free < needed + DISK_MARGIN_BYTES) {
      throw new AssetError(
        `not enough disk space for the download: ${mb(needed)} MB needed, ${mb(free)} MB free`,
        false,
      );
    }
  } catch (error) {
    if (error instanceof AssetError) throw error;
    // statfs is unavailable on some file systems; the write itself will tell.
  }
}

// --- files -----------------------------------------------------------------

export async function sha256File(path: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(path), hash);
  return hash.digest("hex");
}

interface Marker {
  kind: "file" | "archive";
  name: string;
}

function readMarker(dir: string): Marker | null {
  try {
    const parsed = JSON.parse(readFileSync(join(dir, MARKER), "utf8")) as Partial<Marker>;
    if ((parsed.kind === "file" || parsed.kind === "archive") && typeof parsed.name === "string") {
      return { kind: parsed.kind, name: basename(parsed.name) };
    }
  } catch {
    // no marker yet
  }
  return null;
}

async function writeMarker(dir: string, marker: Marker): Promise<void> {
  await writeFile(join(dir, MARKER), JSON.stringify(marker), "utf8");
}

/** Unpack a zip, refusing entries that would land outside `target`. */
export async function extractZip(bytes: Uint8Array, target: string): Promise<void> {
  const entries = unzipSync(bytes);
  await mkdir(target, { recursive: true });
  const root = normalize(target + sep);
  for (const [name, data] of Object.entries(entries)) {
    if (name.endsWith("/")) continue;
    const path = normalize(join(target, name));
    if (!path.startsWith(root) || name.includes("\0")) {
      throw new AssetError(`the archive contains an unsafe path: ${name}`, true);
    }
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, data);
    if (process.platform !== "win32") await chmod(path, 0o755);
  }
}

/** A file named `name` in `dir` or up to two levels below it. */
export function findFile(dir: string, name: string, depth = 2): string | null {
  let entries: import("node:fs").Dirent[];
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return null;
  }
  for (const entry of entries) if (entry.isFile() && entry.name === name) return join(dir, entry.name);
  if (depth === 0) return null;
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    const found = findFile(join(dir, entry.name), name, depth - 1);
    if (found !== null) return found;
  }
  return null;
}

async function renameWithRetry(from: string, to: string): Promise<void> {
  // A virus scanner may hold a fresh file for a moment on Windows.
  for (let attempt = 0; ; attempt++) {
    try {
      await rm(to, { force: true });
      await rename(from, to);
      return;
    } catch (error) {
      if (attempt >= 5) throw error;
      await delay(500 * (attempt + 1));
    }
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function mb(bytes: number): number {
  return Math.round(bytes / (1024 * 1024));
}
