// src/mutations.ts — createFolder, renameEntry, deleteEntries, moveEntries,
// copyEntries. Every source is resolved with resolveLink (never follow the
// final symlink); every destination with resolveNew (§6 A/B/C).
//
// Batch methods echo back the caller's own path strings in `succeeded` and
// `failed[].path` so the panel can match rows 1:1 with what it sent (§4.1).
import { cp, lstat, mkdir, rename, rm, rmdir, unlink } from "node:fs/promises";
import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";

import type { FileEntry } from "../contract";
import { fmError, isFileManagerError, mapNodeError, toBatchFailure, type BatchFailure } from "./errors";
import { buildEntry } from "./listing";
import {
  assertInside,
  assertNotInsideSelf,
  getRoot,
  resolveExistingDir,
  resolveLink,
  resolveNew,
  validateName,
} from "./root";
import { publishFs } from "./signals";

export type ConflictPolicy = "rename" | "overwrite" | "fail";

export interface BatchResult {
  succeeded: string[];
  failed: BatchFailure[];
}

/* ------------------------------------------------------------------ */
/* uniqueName                                                          */
/* ------------------------------------------------------------------ */

/** Compound archive suffixes keep their whole tail: `a.tar.gz` → `a (1).tar.gz`. */
const COMPOUND_EXTENSION = /\.tar\.(gz|bz2|xz|zst|lz|lzma)$/iu;

/** Split a base name into the stem and the extension the copy suffix goes before. */
export function splitName(name: string): { stem: string; extension: string } {
  const compound = COMPOUND_EXTENSION.exec(name);
  if (compound && compound.index > 0) {
    return { stem: name.slice(0, compound.index), extension: compound[0] };
  }
  const extension = path.extname(name);
  // path.extname(".bashrc") === "" — dotfiles keep their whole name as the stem.
  if (extension === "" || extension === name) return { stem: name, extension: "" };
  return { stem: name.slice(0, name.length - extension.length), extension };
}

/** `report.txt` + 2 → `report (2).txt`. Pure; used by uniqueName and by tests. */
export function numberedName(name: string, counter: number): string {
  const { stem, extension } = splitName(name);
  return `${stem} (${counter})${extension}`;
}

async function exists(absolutePath: string): Promise<boolean> {
  try {
    await lstat(absolutePath);
    return true;
  } catch {
    return false;
  }
}

/**
 * First free name in `dirReal` derived from `name`: the name itself when free,
 * otherwise `name (1)`, `name (2)`, … Returns the *name*, not the full path.
 */
export async function uniqueName(dirReal: string, name: string): Promise<string> {
  validateName(name);
  if (!(await exists(path.join(dirReal, name)))) return name;
  for (let counter = 1; counter < 10_000; counter += 1) {
    const candidate = numberedName(name, counter);
    if (!(await exists(path.join(dirReal, candidate)))) return candidate;
  }
  throw fmError("exists", path.join(dirReal, name));
}

/**
 * Apply the conflict policy for a destination directory + desired name.
 * Returns the absolute target path, or null when the caller should skip the
 * item because target and source are the same file.
 */
async function applyConflictPolicy(
  destDirReal: string,
  desiredName: string,
  conflict: ConflictPolicy,
  sourcePath: string,
): Promise<string | null> {
  const naive = path.join(destDirReal, validateName(desiredName));
  assertInside(naive);
  if (!(await exists(naive))) return naive;
  if (naive === sourcePath) return null; // moving/copying onto itself: no-op
  if (conflict === "fail") throw fmError("exists", naive);
  if (conflict === "rename") {
    const free = await uniqueName(destDirReal, desiredName);
    return assertInside(path.join(destDirReal, free));
  }
  // overwrite
  try {
    await rm(naive, { recursive: true, force: true });
  } catch (error) {
    throw mapNodeError(error, naive);
  }
  return naive;
}

/* ------------------------------------------------------------------ */
/* createFolder                                                        */
/* ------------------------------------------------------------------ */

export async function createFolder(
  bb: BbPluginApi,
  input: { path: string; name: string },
): Promise<{ entry: FileEntry }> {
  const target = await resolveNew(input.path, input.name);
  try {
    await mkdir(target);
  } catch (error) {
    throw mapNodeError(error, target);
  }
  publishFs(bb, [path.dirname(target)], "create");
  return { entry: await buildEntry(target) };
}

/* ------------------------------------------------------------------ */
/* renameEntry                                                         */
/* ------------------------------------------------------------------ */

export async function renameEntry(
  bb: BbPluginApi,
  input: { path: string; newName: string },
): Promise<{ entry: FileEntry }> {
  const source = await resolveLink(input.path);
  validateName(input.newName);
  const parentDir = path.dirname(source.path);
  const target = assertInside(path.join(parentDir, input.newName));

  if (target === source.path) return { entry: await buildEntry(source.path) };
  // fs.rename silently replaces an existing destination — refuse instead.
  if (await exists(target)) throw fmError("exists", target);

  try {
    await rename(source.path, target);
  } catch (error) {
    throw mapNodeError(error, source.path);
  }
  publishFs(bb, [parentDir], "rename");
  return { entry: await buildEntry(target) };
}

/* ------------------------------------------------------------------ */
/* deleteEntries                                                       */
/* ------------------------------------------------------------------ */

export async function deleteEntries(
  bb: BbPluginApi,
  input: { paths: string[]; recursive: boolean },
): Promise<BatchResult> {
  const succeeded: string[] = [];
  const failed: BatchFailure[] = [];
  const touched: string[] = [];

  for (const requested of input.paths) {
    try {
      const source = await resolveLink(requested);
      if (source.lstat.isDirectory()) {
        // A symlink is never a directory under lstat, so links go to unlink.
        if (input.recursive) {
          await rm(source.path, { recursive: true, force: false });
        } else {
          await rmdir(source.path);
        }
      } else {
        await unlink(source.path);
      }
      succeeded.push(requested);
      touched.push(path.dirname(source.path));
    } catch (error) {
      failed.push(toBatchFailure(requested, error));
    }
  }

  if (succeeded.length > 0) publishFs(bb, touched, "delete");
  return { succeeded, failed };
}

/* ------------------------------------------------------------------ */
/* moveEntries / copyEntries                                           */
/* ------------------------------------------------------------------ */

async function transferEntries(
  bb: BbPluginApi,
  input: { paths: string[]; destinationDir: string; conflict: ConflictPolicy },
  mode: "move" | "copy",
): Promise<BatchResult> {
  const destDirReal = await resolveExistingDir(input.destinationDir);
  const succeeded: string[] = [];
  const failed: BatchFailure[] = [];
  const touched: string[] = [destDirReal];

  for (const requested of input.paths) {
    try {
      const source = await resolveLink(requested);
      if (source.path === getRoot()) throw fmError("path_escape", source.path);
      assertNotInsideSelf(source.path, destDirReal);

      const target = await applyConflictPolicy(
        destDirReal,
        path.basename(source.path),
        input.conflict,
        source.path,
      );
      if (target === null) {
        // Same file, same directory — nothing to do, and reporting success
        // keeps the panel's per-row bookkeeping simple.
        succeeded.push(requested);
        continue;
      }

      if (mode === "move") {
        await moveOne(source.path, target);
      } else {
        await copyOne(source.path, target);
      }
      succeeded.push(requested);
      touched.push(path.dirname(source.path));
    } catch (error) {
      failed.push(toBatchFailure(requested, error));
    }
  }

  if (succeeded.length > 0) publishFs(bb, touched, mode);
  return { succeeded, failed };
}

async function moveOne(source: string, target: string): Promise<void> {
  try {
    await rename(source, target);
    return;
  } catch (error) {
    const mapped = mapNodeError(error, source);
    // §7 risk 7: a future bind-mount under /home/coder would make rename fail
    // with EXDEV. Fall back to copy + remove, which is not atomic but correct.
    if (mapped.code !== "cross_device") throw mapped;
  }
  await copyOne(source, target);
  try {
    await rm(source, { recursive: true, force: true });
  } catch (error) {
    throw mapNodeError(error, source);
  }
}

async function copyOne(source: string, target: string): Promise<void> {
  try {
    await cp(source, target, {
      recursive: true,
      // Copy links as links; never dereference into something outside the root.
      dereference: false,
      verbatimSymlinks: true,
      preserveTimestamps: true,
      force: true,
      errorOnExist: false,
    });
  } catch (error) {
    throw mapNodeError(error, source);
  }
}

export function moveEntries(
  bb: BbPluginApi,
  input: { paths: string[]; destinationDir: string; conflict: ConflictPolicy },
): Promise<BatchResult> {
  return transferEntries(bb, input, "move");
}

export function copyEntries(
  bb: BbPluginApi,
  input: { paths: string[]; destinationDir: string; conflict: ConflictPolicy },
): Promise<BatchResult> {
  return transferEntries(bb, input, "copy");
}

/** Re-exported so callers can special-case an expected failure without regex. */
export { isFileManagerError };
