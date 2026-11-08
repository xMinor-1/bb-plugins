// Puts a program a build's plugin needs on this machine, in the person's own folder and without administrator
// rights: downloads the package the manifest lists (in parts, each checked against its sha256, then the whole file),
// unpacks it with the system's own tools and records what is installed. The plugin learns the program's path from
// the setting the manifest names.
//
// Formats: "zip" is unpacked whole; "dmg" (macOS) is attached read-only, and the top folder of `program` (for
// example `Office.app`) is copied out with ditto. Nothing is run from the package and nothing is registered with
// the system: no installer, no msiexec, no Gatekeeper prompt for a copy made by the system's own tools.
import { spawn } from "node:child_process";
import { createHash, randomUUID } from "node:crypto";
import { createReadStream, createWriteStream } from "node:fs";
import { mkdir, readdir, readFile, rename, rm, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { Readable } from "node:stream";
import { pipeline } from "node:stream/promises";

export interface AppPart {
  url: string;
  sha256: string;
}

export interface AppFile {
  format: "zip" | "dmg";
  parts: AppPart[];
  /** Of the whole package, the parts joined in order. */
  sha256: string;
  /** The program, relative to the unpacked package, with forward slashes. */
  program: string;
}

export type AppFailure = "download" | "integrity" | "unpack" | "disk" | "paused";

export type AppOutcome =
  | { state: "current" | "installed"; path: string }
  | { state: "failed"; reason: AppFailure; detail: string };

export interface AppInstallDeps {
  /** The app's own folder: versions live under it, with a record of the one in use. */
  directory: string;
  version: string;
  file: AppFile;
  signal: AbortSignal;
  platform?: NodeJS.Platform;
  /** False: too many failed downloads lately. What is on disk is still checked; nothing is fetched. */
  mayDownload?: boolean;
  /** For tests. */
  download?: (url: string, file: string, signal: AbortSignal) => Promise<void>;
  unpack?: (format: AppFile["format"], archive: string, target: string, program: string) => Promise<void>;
  delays?: number[];
}

export const APP_STATE_FILE = "installed.json";
const PART_MS = 20 * 60_000;
const UNPACK_MS = 20 * 60_000;
const DEFAULT_DELAYS = [5_000, 20_000];

interface AppState {
  version: string;
  sha256: string;
  folder: string;
  program: string;
}

async function downloadFile(url: string, file: string, signal: AbortSignal): Promise<void> {
  const response = await fetch(url, { redirect: "follow", signal: AbortSignal.any([signal, AbortSignal.timeout(PART_MS)]) });
  if (!response.ok || response.body === null) throw new Error(`HTTP ${response.status}`);
  if (response.url !== "" && !response.url.startsWith("https://") && url.startsWith("https://")) {
    throw new Error("the download was redirected away from https");
  }
  await pipeline(Readable.fromWeb(response.body as Parameters<typeof Readable.fromWeb>[0]), createWriteStream(file, { mode: 0o600 }), { signal });
}

async function sha256Of(file: string): Promise<string> {
  const hash = createHash("sha256");
  await pipeline(createReadStream(file), hash);
  return hash.digest("hex");
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

/** Runs a system tool directly, without a shell; rejects with its last output lines on failure. */
export function runTool(command: string, args: string[], ms = UNPACK_MS): Promise<void> {
  return new Promise((resolve, reject) => {
    let output = "";
    const child = spawn(command, args, { stdio: ["ignore", "pipe", "pipe"], windowsHide: true, shell: false });
    const keep = (chunk: Buffer) => {
      output = (output + chunk.toString("utf8")).slice(-2000);
    };
    child.stdout!.on("data", keep);
    child.stderr!.on("data", keep);
    const timer = setTimeout(() => child.kill("SIGKILL"), ms);
    child.on("error", (error) => {
      clearTimeout(timer);
      reject(error);
    });
    child.on("close", (code, signal) => {
      clearTimeout(timer);
      if (code === 0) resolve();
      else reject(new Error(`${command} ended with code ${code}${signal ? `, signal ${signal}` : ""}: ${output.trim().split(/\r?\n/).slice(-3).join(" ")}`));
    });
  });
}

/** The system's own unpacking tools: tar.exe on Windows 10 and later, ditto and hdiutil on macOS, unzip elsewhere. */
export async function unpackWithSystemTools(format: AppFile["format"], archive: string, target: string, program: string, platform: NodeJS.Platform = process.platform): Promise<void> {
  await mkdir(target, { recursive: true });
  if (format === "zip") {
    if (platform === "win32") {
      const tar = join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe");
      return runTool(tar, ["-xf", archive, "-C", target]);
    }
    if (platform === "darwin") return runTool("/usr/bin/ditto", ["-x", "-k", archive, target]);
    return runTool("unzip", ["-q", archive, "-d", target]);
  }
  if (platform !== "darwin") throw new Error("a .dmg package unpacks only on macOS");
  const top = program.split("/")[0]!;
  const mount = `${target}.mount`;
  await mkdir(mount, { recursive: true });
  await runTool("/usr/bin/hdiutil", ["attach", archive, "-nobrowse", "-readonly", "-noautoopen", "-mountpoint", mount]);
  try {
    await runTool("/usr/bin/ditto", [join(mount, top), join(target, top)]);
  } finally {
    await runTool("/usr/bin/hdiutil", ["detach", mount, "-force"], 60_000).catch(() => undefined);
    await rm(mount, { recursive: true, force: true }).catch(() => undefined);
  }
}

async function readState(directory: string): Promise<AppState | null> {
  try {
    const saved = JSON.parse(await readFile(join(directory, APP_STATE_FILE), "utf8")) as Partial<AppState>;
    if (typeof saved.version !== "string" || typeof saved.sha256 !== "string" || typeof saved.folder !== "string" || typeof saved.program !== "string") return null;
    return saved as AppState;
  } catch {
    return null;
  }
}

async function writeState(directory: string, state: AppState): Promise<void> {
  const fresh = join(directory, `${APP_STATE_FILE}.${randomUUID().slice(0, 8)}.tmp`);
  await writeFile(fresh, JSON.stringify(state), "utf8");
  await rename(fresh, join(directory, APP_STATE_FILE));
}

/** One part, retried; checked before it joins the package. */
async function fetchPart(deps: AppInstallDeps, part: AppPart, target: string): Promise<{ reason: "download" | "integrity"; detail: string } | null> {
  const delays = deps.delays ?? DEFAULT_DELAYS;
  const download = deps.download ?? downloadFile;
  let problem: { reason: "download" | "integrity"; detail: string } = { reason: "download", detail: "" };
  for (let attempt = 0; attempt <= delays.length; attempt += 1) {
    if (attempt > 0) await sleep(delays[attempt - 1]!, deps.signal);
    if (deps.signal.aborted) break;
    try {
      await download(part.url, target, deps.signal);
      if ((await sha256Of(target)) === part.sha256) return null;
      problem = { reason: "integrity", detail: `${part.url} does not match the manifest's hash` };
    } catch (error) {
      problem = { reason: "download", detail: error instanceof Error ? error.message : String(error) };
    }
  }
  return problem;
}

async function appendFile(from: string, to: string): Promise<void> {
  await pipeline(createReadStream(from), createWriteStream(to, { flags: "a", mode: 0o600 }));
}

/** Versions other than the one in use go; a folder a running program holds on Windows stays until the next sync. */
async function removeOthers(directory: string, keep: string): Promise<void> {
  for (const name of await readdir(directory).catch(() => [] as string[])) {
    if (name === keep || name === APP_STATE_FILE) continue;
    await rm(join(directory, name), { recursive: true, force: true }).catch(() => undefined);
  }
}

function programPath(directory: string, folder: string, program: string): string {
  return join(directory, folder, ...program.split("/"));
}

async function install(deps: AppInstallDeps): Promise<AppOutcome> {
  const { directory, file, version } = deps;
  await mkdir(directory, { recursive: true });
  const saved = await readState(directory);
  if (saved !== null && saved.version === version && saved.sha256 === file.sha256 && saved.program === file.program) {
    const path = programPath(directory, saved.folder, saved.program);
    if (await exists(path)) {
      await removeOthers(directory, saved.folder);
      return { state: "current", path };
    }
  }
  if (deps.mayDownload === false) return { state: "failed", reason: "paused", detail: version };

  const work = join(directory, `.download-${randomUUID().slice(0, 8)}`);
  await mkdir(work, { recursive: true });
  try {
    const archive = join(work, `package.${file.format}`);
    const part = join(work, "part");
    for (const each of file.parts) {
      deps.signal.throwIfAborted();
      const problem = await fetchPart(deps, each, part);
      if (problem !== null) return { state: "failed", ...problem };
      await appendFile(part, archive);
      await rm(part, { force: true });
    }
    if ((await sha256Of(archive)) !== file.sha256) return { state: "failed", reason: "integrity", detail: "the joined package does not match the manifest's hash" };

    // A fresh folder per install: a running copy of the previous version is never written over.
    const folder = `${version.replace(/[^A-Za-z0-9._-]/g, "_")}-${file.sha256.slice(0, 8)}-${randomUUID().slice(0, 4)}`;
    const target = join(directory, folder);
    try {
      await (deps.unpack ?? ((format, from, to, program) => unpackWithSystemTools(format, from, to, program, deps.platform)))(file.format, archive, target, file.program);
    } catch (error) {
      await rm(target, { recursive: true, force: true }).catch(() => undefined);
      return { state: "failed", reason: "unpack", detail: error instanceof Error ? error.message : String(error) };
    }
    const path = programPath(directory, folder, file.program);
    if (!(await exists(path))) {
      await rm(target, { recursive: true, force: true }).catch(() => undefined);
      return { state: "failed", reason: "unpack", detail: `no ${file.program} in the package` };
    }
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
    await writeState(directory, { version, sha256: file.sha256, folder, program: file.program });
    await removeOthers(directory, folder);
    return { state: "installed", path };
  } finally {
    await rm(work, { recursive: true, force: true }).catch(() => undefined);
  }
}

/** Never throws: a full or read-only disk is a failure the sync reports and retries like any other. */
export async function ensureApp(deps: AppInstallDeps): Promise<AppOutcome> {
  try {
    return await install(deps);
  } catch (error) {
    return { state: "failed", reason: "disk", detail: error instanceof Error ? error.message : String(error) };
  }
}
