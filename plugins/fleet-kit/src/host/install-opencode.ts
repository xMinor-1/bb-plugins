// Puts the OpenCode version the manifest names on this machine: downloads the package file the manifest lists, checks
// it against the manifest's integrity hash, takes the one program out of it and runs it once.
//
// When the system refuses to run the program, that is an answer, not a failure to work around: the sync reports it with
// the program's path and a text for an IT request, and does not try any other way of starting it.
import { spawn, type ChildProcess } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { chmod, mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { Readable, Transform } from "node:stream";
import { pipeline } from "node:stream/promises";
import { createGunzip } from "node:zlib";
import { normalizeVersion } from "./find-opencode.js";

export interface OpenCodeFile {
  url: string;
  /** Subresource integrity of the file: sha512-<base64>. */
  integrity: string;
  /** Path of the program inside the .tgz. */
  entry: string;
}

export type RunOutcome =
  | { kind: "ok"; version: string }
  /** The system would not start it, or stopped it at once. */
  | { kind: "denied"; detail: string }
  /** Started and failed on this processor: a build without AVX2 may work. */
  | { kind: "unsupported-cpu"; detail: string }
  | { kind: "broken"; detail: string };

export type InstallOutcome =
  | { state: "current" | "installed"; path: string; version: string }
  | { state: "failed"; reason: InstallFailure; path: string; detail: string };

export type InstallFailure = "download" | "integrity" | "unpack" | "disk" | "broken" | "denied" | "no-file" | "paused";

/** Next to the program. The ACP wrapper starts only the file recorded here, and shows `message` while there is none. */
export const PROGRAM_STATE_FILE = "bb-acp-state.json";

interface ProgramState {
  verified: { version: string; size: number; mtimeMs: number } | null;
  message: string | null;
  /** The settings could not be written: without them OpenCode opens every provider, so the wrapper starts nothing. */
  blocked: boolean;
}

export interface InstallDeps {
  directory: string;
  version: string;
  files: Record<string, OpenCodeFile>;
  platform?: NodeJS.Platform;
  arch?: string;
  signal: AbortSignal;
  /** For tests. */
  download?: (url: string, file: string, signal: AbortSignal) => Promise<void>;
  run?: (path: string) => Promise<RunOutcome>;
  delays?: number[];
  move?: (from: string, to: string) => Promise<void>;
  /** False: too many failed downloads lately. The program on disk is still checked; nothing is fetched. */
  mayDownload?: boolean;
}

const DOWNLOAD_MS = 20 * 60_000;
const RUN_MS = 60_000;
const DEFAULT_DELAYS = [5_000, 20_000];
const BLOCK = 512;
/** STATUS_ILLEGAL_INSTRUCTION as a signed exit code on Windows. */
const WINDOWS_ILLEGAL_INSTRUCTION = -1073741795;

export function programName(platform: NodeJS.Platform = process.platform): string {
  return platform === "win32" ? "opencode.exe" : "opencode";
}

export function openCodeProgram(directory: string, platform: NodeJS.Platform = process.platform): string {
  return join(directory, programName(platform));
}

async function downloadFile(url: string, file: string, signal: AbortSignal): Promise<void> {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.any([signal, AbortSignal.timeout(DOWNLOAD_MS)]) });
  if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`);
  if (response.url !== "" && !response.url.startsWith("https://") && url.startsWith("https://")) {
    throw new Error("the download was redirected away from https");
  }
  await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(file, { mode: 0o600 }), { signal });
}

async function fileIntegrity(file: string): Promise<string> {
  const hash = createHash("sha512");
  await pipeline(createReadStream(file), hash);
  return `sha512-${hash.digest("base64")}`;
}

function tarName(header: Buffer): string {
  const text = (start: number, length: number) => {
    const end = header.indexOf(0, start);
    return header.toString("utf8", start, end >= 0 && end < start + length ? end : start + length);
  };
  const prefix = header.toString("latin1", 257, 263).startsWith("ustar") ? text(345, 155) : "";
  return prefix === "" ? text(0, 100) : `${prefix}/${text(0, 100)}`;
}

function tarSize(header: Buffer): number {
  // Sizes above 8 GiB use a binary form; nothing here is that big.
  return Number.parseInt(header.toString("latin1", 124, 136).replace(/[^0-7]/g, "") || "0", 8);
}

/** Copies one file out of a .tgz. False: the archive has no such file. */
export async function extractEntry(archive: string, entry: string, target: string): Promise<boolean> {
  let pending: Buffer = Buffer.alloc(0);
  let skip = 0;
  let copy = 0;
  let found = false;
  const finder = new Transform({
    transform(chunk: Buffer, _encoding, done) {
      pending = pending.length === 0 ? chunk : Buffer.concat([pending, chunk]);
      while (pending.length > 0) {
        if (copy > 0) {
          const part = pending.subarray(0, Math.min(copy, pending.length));
          this.push(part);
          copy -= part.length;
          pending = pending.subarray(part.length);
        } else if (skip > 0) {
          const part = Math.min(skip, pending.length);
          skip -= part;
          pending = pending.subarray(part);
        } else {
          if (pending.length < BLOCK) break;
          const header = pending.subarray(0, BLOCK);
          pending = pending.subarray(BLOCK);
          if (header.every((byte) => byte === 0)) continue;
          const size = tarSize(header);
          const padded = Math.ceil(size / BLOCK) * BLOCK;
          const regular = header[156] === 0 || header[156] === 0x30;
          if (!found && regular && tarName(header) === entry) {
            found = true;
            copy = size;
            skip = padded - size;
          } else {
            skip = padded;
          }
        }
      }
      done();
    },
  });
  await pipeline(createReadStream(archive), createGunzip(), finder, createWriteStream(target, { mode: 0o755 }));
  return found;
}

/** Runs `<program> --version`. `spawn` is direct: no shell, and no second way of starting it. */
export function runProgram(path: string, platform: NodeJS.Platform = process.platform): Promise<RunOutcome> {
  return new Promise((resolve) => {
    let out = "";
    let finished = false;
    const finish = (outcome: RunOutcome) => {
      if (finished) return;
      finished = true;
      clearTimeout(timer);
      resolve(outcome);
    };
    let child: ChildProcess;
    try {
      child = spawn(path, ["--version"], { stdio: ["ignore", "pipe", "ignore"], windowsHide: true, shell: false, env: withoutNodeMode(process.env) });
    } catch (error) {
      // On Windows a refused start (ERROR_ACCESS_DENIED, a policy) throws here instead of emitting "error".
      resolve({ kind: "denied", detail: (error as NodeJS.ErrnoException).code ?? String(error) });
      return;
    }
    const timer = setTimeout(() => {
      child.kill("SIGKILL");
      finish({ kind: "broken", detail: `no answer in ${RUN_MS / 1000} s` });
    }, RUN_MS);
    child.stdout!.on("data", (chunk: Buffer) => {
      if (out.length < 4096) out += chunk.toString("utf8");
    });
    child.on("error", (error: NodeJS.ErrnoException) => finish({ kind: "denied", detail: error.code ?? error.message }));
    child.on("close", (code, signal) => {
      if (code === 0) return finish({ kind: "ok", version: normalizeVersion(out.trim().split(/\r?\n/).pop() ?? "") });
      if (signal === "SIGILL" || code === WINDOWS_ILLEGAL_INSTRUCTION) return finish({ kind: "unsupported-cpu", detail: `code ${code}, signal ${signal}` });
      // A killed new program on a Mac is what the system does to something it refuses to run.
      if (platform === "darwin" && signal === "SIGKILL") return finish({ kind: "denied", detail: "stopped by the system (SIGKILL)" });
      finish({ kind: "broken", detail: `code ${code}, signal ${signal}` });
    });
  });
}

/** bb's own processes run in the app's Node mode; a program started from them must not inherit that. */
export function withoutNodeMode(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  const copy = { ...env };
  delete copy.ELECTRON_RUN_AS_NODE;
  return copy;
}

const sleep = (ms: number, signal: AbortSignal) =>
  new Promise<void>((resolve) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => {
      clearTimeout(timer);
      resolve();
    }, { once: true });
  });

async function exists(path: string): Promise<boolean> {
  return stat(path).then(() => true, () => false);
}

async function readProgramState(directory: string): Promise<ProgramState> {
  try {
    const saved = JSON.parse(await readFile(join(directory, PROGRAM_STATE_FILE), "utf8")) as Partial<ProgramState>;
    return { verified: saved.verified ?? null, message: saved.message ?? null, blocked: saved.blocked === true };
  } catch {
    return { verified: null, message: null, blocked: false };
  }
}

async function writeProgramState(directory: string, state: ProgramState): Promise<void> {
  const fresh = join(directory, `${PROGRAM_STATE_FILE}.${randomUUID().slice(0, 8)}.tmp`);
  await writeFile(fresh, JSON.stringify(state), "utf8");
  await rename(fresh, join(directory, PROGRAM_STATE_FILE));
}

async function markVerified(path: string, version: string): Promise<void> {
  const directory = dirname(path);
  const file = await stat(path);
  const state = await readProgramState(directory);
  await writeProgramState(directory, { ...state, verified: { version, size: file.size, mtimeMs: file.mtimeMs }, message: null });
}

/** What the wrapper tells the person while it has nothing to start. Null: the build's ordinary "not ready yet" text. */
export async function setProgramMessage(directory: string, message: string | null, blocked = false): Promise<void> {
  const state = await readProgramState(directory);
  if (state.message === message && state.blocked === blocked) return;
  await mkdir(directory, { recursive: true });
  await writeProgramState(directory, { ...state, message, blocked });
}

/** The settings are written again: the wrapper may start the program, and its reason not to is gone. */
export async function unblockProgram(directory: string): Promise<void> {
  if ((await readProgramState(directory)).blocked) await setProgramMessage(directory, null, false);
}

/** Copies left by earlier updates go when nothing holds them: a running program can be renamed on Windows, not deleted. */
async function removeOldCopies(directory: string): Promise<void> {
  const names = await readdir(directory).catch(() => [] as string[]);
  for (const name of names) {
    if (name.includes(".old-")) await rm(join(directory, name), { force: true }).catch(() => undefined);
  }
}

/**
 * An update stopped on the way leaves the previous program under an old name, and maybe an unchecked one on the path. Only
 * the copy that passed the check comes back: a failed update can leave other old copies around.
 */
async function restoreVerified(path: string): Promise<void> {
  const directory = dirname(path);
  const { verified } = await readProgramState(directory);
  if (verified === null) return;
  const isVerified = async (file: string) => {
    const found = await stat(file).catch(() => null);
    return found !== null && found.size === verified.size && found.mtimeMs === verified.mtimeMs;
  };
  if (await isVerified(path)) return;
  const base = path.slice(directory.length + 1);
  for (const name of await readdir(directory).catch(() => [] as string[])) {
    if (!name.startsWith(`${base}.old-`) || !(await isVerified(join(directory, name)))) continue;
    if (await exists(path)) await removeUnverified(path);
    await rename(join(directory, name), path);
    return;
  }
}

/** Takes the unverified program off its path; a file that cannot be deleted right now is renamed instead. */
async function removeUnverified(path: string): Promise<void> {
  try {
    await rm(path, { force: true });
  } catch {
    await rename(path, `${path}.old-${randomUUID().slice(0, 8)}`);
  }
}

async function fetchChecked(deps: InstallDeps, file: OpenCodeFile, archive: string): Promise<{ reason: "download" | "integrity"; detail: string } | null> {
  const delays = deps.delays ?? DEFAULT_DELAYS;
  const download = deps.download ?? downloadFile;
  let problem: { reason: "download" | "integrity"; detail: string } = { reason: "download", detail: "" };
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    if (attempt > 0) await sleep(delays[attempt - 1]!, deps.signal);
    if (deps.signal.aborted) break;
    try {
      await download(file.url, archive, deps.signal);
      if ((await fileIntegrity(archive)) === file.integrity) return null;
      problem = { reason: "integrity", detail: "the file does not match the manifest's hash" };
    } catch (error) {
      problem = { reason: "download", detail: error instanceof Error ? error.message : String(error) };
    }
  }
  return problem;
}

async function installFile(deps: InstallDeps, file: OpenCodeFile, path: string, run: (p: string) => Promise<RunOutcome>): Promise<InstallOutcome | "unsupported-cpu"> {
  const work = join(deps.directory, `.install-${randomUUID().slice(0, 8)}`);
  await mkdir(work, { recursive: true });
  try {
    const archive = join(work, "package.tgz");
    const problem = await fetchChecked(deps, file, archive);
    if (problem !== null) return { state: "failed", path, ...problem };
    const fresh = join(work, programName(deps.platform));
    try {
      if (!(await extractEntry(archive, file.entry, fresh))) return { state: "failed", reason: "unpack", path, detail: `no ${file.entry} in the package` };
      await chmod(fresh, 0o755);
    } catch (error) {
      return { state: "failed", reason: "unpack", path, detail: error instanceof Error ? error.message : String(error) };
    }
    // The previous program stays until the new one has answered, and comes back on any failure.
    const previous = (await exists(path)) ? `${path}.old-${randomUUID().slice(0, 8)}` : null;
    if (previous !== null) await rename(path, previous);
    try {
      await (deps.move ?? rename)(fresh, path);
    } catch (error) {
      if (previous !== null) await rename(previous, path);
      return { state: "failed", reason: "disk", path, detail: error instanceof Error ? error.message : String(error) };
    }
    // Run at its final path: that is the path an IT rule or the person's request names.
    const ran = await run(path);
    if (ran.kind === "ok" && ran.version === deps.version) {
      try {
        await markVerified(path, ran.version);
      } catch (error) {
        // Without the record the wrapper would not start it: the previous program stays the one in use.
        await removeUnverified(path);
        if (previous !== null) await rename(previous, path);
        return { state: "failed", reason: "disk", path, detail: error instanceof Error ? error.message : String(error) };
      }
      await removeOldCopies(deps.directory);
      return { state: "installed", path, version: ran.version };
    }
    if (previous !== null) {
      await removeUnverified(path);
      await rename(previous, path);
    } else if (ran.kind !== "denied") {
      await removeUnverified(path);
    } // A refused program stays where the IT request says; without a record the wrapper does not start it.
    if (ran.kind === "unsupported-cpu") return "unsupported-cpu";
    if (ran.kind === "denied") return { state: "failed", reason: "denied", path, detail: ran.detail };
    if (ran.kind === "broken") return { state: "failed", reason: "broken", path, detail: ran.detail };
    return { state: "failed", reason: "broken", path, detail: `it reports ${ran.version}, the build has ${deps.version}` };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function ensure(deps: InstallDeps, platform: NodeJS.Platform, path: string): Promise<InstallOutcome> {
  const run = deps.run ?? ((program: string) => runProgram(program, platform));
  await mkdir(deps.directory, { recursive: true });
  await restoreVerified(path);
  if (await exists(path)) {
    const ran = await run(path);
    if (ran.kind === "ok" && ran.version === deps.version) {
      await markVerified(path, ran.version);
      await removeOldCopies(deps.directory);
      return { state: "current", path, version: ran.version };
    }
    if (ran.kind === "denied") return { state: "failed", reason: "denied", path, detail: ran.detail };
  }
  const key = `${platform}-${deps.arch ?? process.arch}`;
  const file = deps.files[key];
  if (file === undefined) return { state: "failed", reason: "no-file", path, detail: key };
  if (deps.mayDownload === false) return { state: "failed", reason: "paused", path, detail: key };
  const outcome = await installFile(deps, file, path, run);
  if (outcome !== "unsupported-cpu") return outcome;
  const baseline = deps.files[`${key}-baseline`];
  if (baseline === undefined) return { state: "failed", reason: "broken", path, detail: "the processor cannot run this build" };
  const second = await installFile(deps, baseline, path, run);
  return second === "unsupported-cpu" ? { state: "failed", reason: "broken", path, detail: "the processor cannot run this build" } : second;
}

/** Never throws: a disk that is full or read-only is a failure the sync reports and retries like any other. */
export async function ensureOpenCode(deps: InstallDeps): Promise<InstallOutcome> {
  const platform = deps.platform ?? process.platform;
  const path = openCodeProgram(deps.directory, platform);
  try {
    return await ensure(deps, platform, path);
  } catch (error) {
    return { state: "failed", reason: "disk", path, detail: error instanceof Error ? error.message : String(error) };
  }
}
