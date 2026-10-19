// src/trash.ts — move an entry to the Trash instead of removing it.
//
// No native dependencies and no shelling out (no osascript, no gio):
//   * macOS: rename into `<ROOT>/.Trash` with a non-colliding name. Finder's
//     "Put Back" metadata cannot be written without private APIs, so items are
//     restored by dragging them out of the Trash.
//   * Linux and other Unix: the freedesktop.org Trash spec —
//     `$XDG_DATA_HOME/Trash/files` plus `info/<name>.trashinfo`, the info file
//     created first with O_EXCL as the spec's atomic name reservation.
//   * Fallback (no usable system Trash, e.g. it resolves outside the root or
//     macOS refuses access): the plugin's own `<ROOT>/.bb-file-manager/trash`,
//     same files/info layout.
//
// The entry is never followed: rename moves a symlink as a link, and the
// cross-device fallback copies with `dereference: false` before removing.
// Every trash directory is realpath'ed and must sit inside the hard root.
import { cp, lstat, mkdir, open, realpath, rename, rm, unlink } from "node:fs/promises";
import path from "node:path";

import { fmError, mapNodeError } from "./errors";
import { getRoot, getStagingDir, isInside } from "./root";

export type TrashKind = "macos" | "freedesktop" | "plugin";

export interface TrashLocation {
  kind: TrashKind;
  /** realpath'ed directory the entries land in. */
  files: string;
  /** realpath'ed `.trashinfo` directory, null on macOS. */
  info: string | null;
}

interface TrashOverrides {
  platform?: NodeJS.Platform;
  /** `$XDG_DATA_HOME`; `null` means unset. */
  dataHome?: string | null;
}

let overrides: TrashOverrides = {};

/** Tests only: pretend to be another platform / XDG setup. */
export function setTrashOverrides(next: TrashOverrides): void {
  overrides = { ...next };
}

/** mkdir -p (0700) under the root, then realpath and re-check containment. */
async function usableDir(candidate: string): Promise<string | null> {
  if (!isInside(candidate)) return null;
  try {
    await mkdir(candidate, { recursive: true, mode: 0o700 });
    const real = await realpath(candidate);
    if (!isInside(real) || real === getRoot()) return null;
    const st = await lstat(real);
    return st.isDirectory() ? real : null;
  } catch {
    return null;
  }
}

async function layout(kind: TrashKind, base: string): Promise<TrashLocation | null> {
  const files = await usableDir(path.join(base, "files"));
  const info = files === null ? null : await usableDir(path.join(base, "info"));
  if (files === null || info === null) return null;
  return { kind, files, info };
}

export async function pluginTrash(): Promise<TrashLocation> {
  const found = await layout("plugin", path.join(getStagingDir(), "trash"));
  if (found === null) throw fmError("permission_denied", path.join(getStagingDir(), "trash"));
  return found;
}

/** Where a trashed entry goes on this host. */
export async function locateTrash(): Promise<TrashLocation> {
  const root = getRoot();
  const platform = overrides.platform ?? process.platform;

  if (platform === "darwin") {
    const files = await usableDir(path.join(root, ".Trash"));
    if (files !== null) return { kind: "macos", files, info: null };
  } else if (platform !== "win32") {
    const dataHome =
      overrides.dataHome !== undefined ? overrides.dataHome : (process.env.XDG_DATA_HOME ?? null);
    const bases: string[] = [];
    if (dataHome !== null && path.isAbsolute(dataHome)) bases.push(path.join(dataHome, "Trash"));
    bases.push(path.join(root, ".local", "share", "Trash"));
    for (const base of bases) {
      const found = await layout("freedesktop", base);
      if (found !== null) return found;
    }
  }
  return pluginTrash();
}

function isSameOrInside(candidate: string, base: string): boolean {
  return candidate === base || candidate.startsWith(base + path.sep);
}

/** `report.txt`, 1 → `report 2.txt`; dotfiles keep their whole name. */
function trashName(name: string, counter: number): string {
  if (counter === 0) return name;
  const extension = path.extname(name);
  const hasExtension = extension !== "" && extension !== name;
  const stem = hasExtension ? name.slice(0, -extension.length) : name;
  const suffix = counter < 100 ? String(counter + 1) : `${String(Date.now())}-${String(counter)}`;
  return `${stem} ${suffix}${hasExtension ? extension : ""}`;
}

async function exists(candidate: string): Promise<boolean> {
  try {
    await lstat(candidate);
    return true;
  } catch {
    return false;
  }
}

function pad(value: number): string {
  return String(value).padStart(2, "0");
}

/** freedesktop `DeletionDate`: local time, `YYYY-MM-DDThh:mm:ss`. */
function deletionDate(date: Date): string {
  return (
    `${String(date.getFullYear())}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}` +
    `T${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
  );
}

/** freedesktop `Path`: absolute, URL-escaped per component. */
function encodeTrashPath(absolute: string): string {
  return absolute.split("/").map(encodeURIComponent).join("/");
}

/** rename, or copy (never following links) + remove across devices. */
async function relocate(source: string, target: string): Promise<void> {
  try {
    await rename(source, target);
    return;
  } catch (error) {
    const mapped = mapNodeError(error, source);
    if (mapped.code !== "cross_device") throw mapped;
  }
  try {
    await cp(source, target, {
      recursive: true,
      dereference: false,
      verbatimSymlinks: true,
      preserveTimestamps: true,
      force: false,
      errorOnExist: true,
    });
  } catch (error) {
    await rm(target, { recursive: true, force: true }).catch(() => undefined);
    throw mapNodeError(error, source);
  }
  try {
    await rm(source, { recursive: true, force: false });
  } catch (error) {
    throw mapNodeError(error, source);
  }
}

async function trashInto(location: TrashLocation, source: string): Promise<string> {
  const baseName = path.basename(source);
  for (let counter = 0; counter < 10_000; counter += 1) {
    const name = trashName(baseName, counter);
    const target = path.join(location.files, name);

    if (location.info === null) {
      if (await exists(target)) continue;
      await relocate(source, target);
      return target;
    }

    // freedesktop: reserve the name by creating the info file exclusively.
    const infoPath = path.join(location.info, `${name}.trashinfo`);
    let handle;
    try {
      handle = await open(infoPath, "wx", 0o600);
    } catch (error) {
      if ((error as { code?: unknown }).code === "EEXIST") continue;
      throw mapNodeError(error, infoPath);
    }
    try {
      if (await exists(target)) {
        await handle.close();
        await unlink(infoPath).catch(() => undefined);
        continue;
      }
      await handle.writeFile(
        `[Trash Info]\nPath=${encodeTrashPath(source)}\nDeletionDate=${deletionDate(new Date())}\n`,
        "utf8",
      );
      await handle.close();
      await relocate(source, target);
      return target;
    } catch (error) {
      await handle.close().catch(() => undefined);
      await unlink(infoPath).catch(() => undefined);
      throw mapNodeError(error, source);
    }
  }
  throw fmError("exists", path.join(location.files, baseName));
}

/**
 * Move `source` (an absolute path whose parent chain is already realpath'ed;
 * the entry itself is not followed) to the Trash. Returns where it landed.
 */
export async function moveToTrash(source: string): Promise<string> {
  try {
    await lstat(source);
  } catch (error) {
    throw mapNodeError(error, source);
  }
  const location = await locateTrash();
  if (isSameOrInside(location.files, source)) {
    throw fmError("unsupported", `${source}: contains the Trash folder and cannot be trashed`);
  }
  if (isSameOrInside(source, location.files) || (location.info && isSameOrInside(source, location.info))) {
    throw fmError("unsupported", `${source}: already in the Trash; empty the Trash to remove it`);
  }
  try {
    return await trashInto(location, source);
  } catch (error) {
    const mapped = mapNodeError(error, source);
    // macOS can deny access to ~/.Trash (privacy protection); keep the item
    // recoverable in the plugin's own trash rather than failing or deleting.
    if (location.kind === "macos" && mapped.code === "permission_denied") {
      return trashInto(await pluginTrash(), source);
    }
    throw mapped;
  }
}
