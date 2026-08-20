// src/listing.ts — read-only views of the tree: listDir, statPath, searchDir.
// Never recursive except searchDir, which is depth-limited and never follows
// symlinks (§6 rule 3: listing marks symlinks, it does not resolve them).
import { constants as fsConstants } from "node:fs";
import { access, lstat, readdir, realpath, stat, statfs } from "node:fs/promises";
import path from "node:path";
import type { Stats } from "node:fs";

import {
  MAX_LIST_ENTRIES,
  MAX_SEARCH_RESULTS,
  STAGING_DIR_NAME,
  type ArchiveFormat,
  type EntryKind,
  type FileEntry,
} from "../contract";
import { mapNodeError } from "./errors";
import {
  getRoot,
  isInside,
  isStagingPath,
  normalize,
  parentOf,
  resolveExistingDir,
  resolveLink,
} from "./root";

/* ------------------------------------------------------------------ */
/* Archive detection (by extension only — see entrySchema.archiveFormat) */
/* ------------------------------------------------------------------ */

/** Longest suffix first: `.tar.gz` must win over `.gz`-style single matches. */
const ARCHIVE_EXTENSIONS: ReadonlyArray<readonly [string, ArchiveFormat]> = [
  [".tar.gz", "tar.gz"],
  [".tar.bz2", "tar.bz2"],
  [".tar.xz", "tar.xz"],
  [".tgz", "tar.gz"],
  [".tbz2", "tar.bz2"],
  [".tbz", "tar.bz2"],
  [".txz", "tar.xz"],
  [".zip", "zip"],
  [".tar", "tar"],
  [".7z", "7z"],
];

/** `null` when the name does not end in a supported archive extension. */
export function detectArchiveFormat(name: string): ArchiveFormat | null {
  const lower = name.toLowerCase();
  for (const [suffix, format] of ARCHIVE_EXTENSIONS) {
    // A name that is *only* the extension (".zip") is a dotfile, not an archive.
    if (lower.length > suffix.length && lower.endsWith(suffix)) return format;
  }
  return null;
}

/* ------------------------------------------------------------------ */
/* Entry mapping                                                       */
/* ------------------------------------------------------------------ */

export function kindOf(st: Stats): EntryKind {
  if (st.isSymbolicLink()) return "symlink";
  if (st.isDirectory()) return "directory";
  if (st.isFile()) return "file";
  return "other";
}

/**
 * Build one `FileEntry` from an already-resolved absolute path and its lstat.
 * §6 rule 3: symlinks get `targetKind`/`escapesRoot` from a *guarded* realpath;
 * a link that resolves outside the root (or not at all) is marked, not followed.
 */
export async function entryFrom(absolutePath: string, st: Stats): Promise<FileEntry> {
  const name = path.basename(absolutePath);
  const kind = kindOf(st);
  const isSymlink = kind === "symlink";

  let targetKind: EntryKind | null = null;
  let escapesRoot = false;
  if (isSymlink) {
    escapesRoot = true;
    try {
      const real = await realpath(absolutePath);
      if (isInside(real)) {
        targetKind = kindOf(await stat(real));
        escapesRoot = false;
      }
    } catch {
      // Broken or looping link: targetKind stays null, escapesRoot stays true.
    }
  }

  return {
    name,
    path: absolutePath,
    kind,
    targetKind,
    sizeBytes: kind === "directory" ? 0 : st.size,
    modifiedAtMs: Math.floor(st.mtimeMs),
    isHidden: name.startsWith("."),
    isSymlink,
    escapesRoot,
    archiveFormat: detectArchiveFormat(name),
  };
}

/** lstat + entryFrom for a path that is already resolved and inside the root. */
export async function buildEntry(absolutePath: string): Promise<FileEntry> {
  let st: Stats;
  try {
    st = await lstat(absolutePath);
  } catch (error) {
    throw mapNodeError(error, absolutePath);
  }
  return entryFrom(absolutePath, st);
}

/* ------------------------------------------------------------------ */
/* Volume + writability                                                */
/* ------------------------------------------------------------------ */

export interface VolumeInfo {
  totalBytes: number;
  freeBytes: number;
}

export async function readVolume(absolutePath: string): Promise<VolumeInfo | null> {
  try {
    const fsInfo = await statfs(absolutePath);
    const blockSize = Number(fsInfo.bsize);
    return {
      totalBytes: Number(fsInfo.blocks) * blockSize,
      freeBytes: Number(fsInfo.bavail) * blockSize,
    };
  } catch {
    return null;
  }
}

export async function isWritable(absolutePath: string): Promise<boolean> {
  try {
    await access(absolutePath, fsConstants.W_OK);
    return true;
  } catch {
    return false;
  }
}

/* ------------------------------------------------------------------ */
/* listDir                                                             */
/* ------------------------------------------------------------------ */

/** Names that never appear in a listing, in either hidden mode (§6 rule 4). */
function stripAlwaysHidden(dirReal: string, names: string[]): string[] {
  if (dirReal !== getRoot()) return names;
  return names.filter((name) => name !== STAGING_DIR_NAME);
}

export interface ListDirInput {
  path: string;
  showHidden: boolean;
}

export interface ListDirOutput {
  path: string;
  parentPath: string | null;
  isRoot: boolean;
  entries: FileEntry[];
  truncated: boolean;
  totalEntries: number;
  hiddenCount: number;
  writable: boolean;
  volume: VolumeInfo | null;
}

export async function listDir(input: ListDirInput): Promise<ListDirOutput> {
  const dirReal = await resolveExistingDir(input.path);

  let names: string[];
  try {
    names = await readdir(dirReal);
  } catch (error) {
    throw mapNodeError(error, dirReal);
  }
  names = stripAlwaysHidden(dirReal, names).sort();

  const totalEntries = names.length;
  const visible = input.showHidden ? names : names.filter((name) => !name.startsWith("."));
  const hiddenCount = totalEntries - visible.length;
  const truncated = visible.length > MAX_LIST_ENTRIES;
  const kept = truncated ? visible.slice(0, MAX_LIST_ENTRIES) : visible;

  const entries: FileEntry[] = [];
  for (const name of kept) {
    const absolutePath = path.join(dirReal, name);
    let st: Stats;
    try {
      st = await lstat(absolutePath);
    } catch {
      continue; // vanished between readdir and lstat — simply not listed
    }
    entries.push(await entryFrom(absolutePath, st));
  }

  const [writable, volume] = await Promise.all([isWritable(dirReal), readVolume(dirReal)]);

  return {
    path: dirReal,
    parentPath: parentOf(dirReal),
    isRoot: dirReal === getRoot(),
    entries,
    truncated,
    totalEntries,
    hiddenCount,
    writable,
    volume,
  };
}

/* ------------------------------------------------------------------ */
/* statPath                                                            */
/* ------------------------------------------------------------------ */

export interface StatPathOutput {
  entry: FileEntry;
  parentPath: string | null;
}

/**
 * Stat a single path without following its final component (the entry contract
 * describes the link, not its target). The root is the one path resolveLink
 * refuses, so it is handled explicitly.
 */
export async function statPath(input: { path: string }): Promise<StatPathOutput> {
  const abs = normalize(input.path);
  const root = getRoot();
  if (abs === root) {
    const entry = await buildEntry(root);
    return { entry, parentPath: null };
  }
  const resolved = await resolveLink(input.path);
  const entry = await entryFrom(resolved.path, resolved.lstat);
  return { entry, parentPath: parentOf(entry.path) };
}

/* ------------------------------------------------------------------ */
/* searchDir                                                           */
/* ------------------------------------------------------------------ */

export interface SearchDirInput {
  path: string;
  query: string;
  showHidden: boolean;
  maxDepth: number;
}

export interface SearchDirOutput {
  entries: FileEntry[];
  truncated: boolean;
}

/**
 * Breadth-first, depth-limited, case-insensitive substring match on the entry
 * name. Symlinked directories are never descended into (loop safety and §6
 * rule 3), and unreadable directories are skipped instead of failing the call.
 */
export async function searchDir(input: SearchDirInput): Promise<SearchDirOutput> {
  const rootDir = await resolveExistingDir(input.path);
  const needle = input.query.toLowerCase();
  const entries: FileEntry[] = [];
  let truncated = false;

  let frontier: string[] = [rootDir];
  for (let depth = 1; depth <= input.maxDepth && frontier.length > 0 && !truncated; depth += 1) {
    const next: string[] = [];
    for (const dir of frontier) {
      let names: string[];
      try {
        names = await readdir(dir);
      } catch {
        continue; // unreadable directory: skip, do not fail the search
      }
      for (const name of names.sort()) {
        const absolutePath = path.join(dir, name);
        if (isStagingPath(absolutePath)) continue;
        if (!input.showHidden && name.startsWith(".")) continue;
        let st: Stats;
        try {
          st = await lstat(absolutePath);
        } catch {
          continue;
        }
        if (name.toLowerCase().includes(needle)) {
          if (entries.length >= MAX_SEARCH_RESULTS) {
            truncated = true;
            break;
          }
          entries.push(await entryFrom(absolutePath, st));
        }
        if (st.isDirectory() && !st.isSymbolicLink() && depth < input.maxDepth) {
          next.push(absolutePath);
        }
      }
      if (truncated) break;
    }
    frontier = next;
  }

  return { entries, truncated };
}
