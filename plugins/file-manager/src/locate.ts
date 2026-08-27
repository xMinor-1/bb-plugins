// src/locate.ts — turning a bb reference into a folder under the hard root.
//
// Two questions, one chain. "Where does this file link actually live?"
// (`locateFile`, §10.2) and "where does this thread's code live?"
// (`resolveThreadWorkspace`, §10.3) both start from an id the host handed the
// panel and end at an absolute path the §6 clamp has approved, so they share
// this module and the environment lookup inside it.
//
// bb hands a file opener a path that is relative to whatever surface produced
// it: a worktree, a thread's storage directory, or nothing at all for a host
// path. This turns that pair into an absolute path under the hard root, and
// answers the question the panel asks next: which folder should open.
//
// It never fails just because the file is missing. Agents write paths that do
// not exist verbatim — a glob (`backups/*-2026-08-25.md`), a file that has
// since been renamed, an output that was never written — and "the folder it
// would have been in" is still the useful answer. So a missing target walks up
// to the nearest folder that does exist, and reports the name it was looking
// for so the panel can filter on it.
import { realpath, stat } from "node:fs/promises";
import path from "node:path";

import type { BbPluginApi } from "@get-bb/plugin-sdk";

import type { ThreadWorkspaceReason } from "../contract";
import { fmError, isFileManagerError } from "./errors";
import { assertInside, getRoot, isInside, normalize, resolveExisting } from "./root";

export interface FileOpenerSource {
  kind: "host" | "thread-storage" | "workspace";
  threadId: string | null;
  environmentId: string | null;
  projectId: string | null;
}

export interface LocateFileInput {
  path: string;
  source: FileOpenerSource;
}

export interface LocateFileOutput {
  /** Folder the panel should open: the target's own, or the nearest existing. */
  dirPath: string;
  /** Absolute path the link named. May not exist. */
  absolutePath: string;
  /** Base name of the link target; "" when it named a folder. */
  name: string;
  /** True when `absolutePath` is really on disk. */
  exists: boolean;
  /** True when the link named a directory that exists. */
  isDirectory: boolean;
  /**
   * What to type into the filter when the target is missing: the longest
   * literal run of a glob-ish name (`*-otlozhena-2026-08-25.md` →
   * `-otlozhena-2026-08-25.md`). Null when there is nothing useful to filter
   * on — an exact name that is simply gone filters to an empty folder, which
   * says less than the folder itself.
   */
  matchHint: string | null;
}

/** `*` and `?` are legal in a POSIX file name, so this is a hint, not a parse. */
const GLOB_CHARACTERS = /[*?[\]]/u;

function globMatchHint(name: string): string | null {
  if (!GLOB_CHARACTERS.test(name)) return null;
  const literals = name.split(GLOB_CHARACTERS).filter((part) => part.length > 0);
  if (literals.length === 0) return null;
  return literals.reduce((longest, part) => (part.length > longest.length ? part : longest), "");
}

/**
 * The checkout directory bb records for an environment, or null when it has
 * none: an environment that is unprovisioned, still provisioning or destroyed
 * answers with no path at all.
 *
 * Shared by both questions this module answers — a workspace file link and a
 * thread's own folder resolve through exactly the same SDK call.
 */
async function environmentCheckoutPath(
  bb: BbPluginApi,
  environmentId: string,
): Promise<string | null> {
  const environment = await bb.sdk.environments.get({ environmentId });
  return environment.path === null || environment.path === "" ? null : environment.path;
}

/**
 * Absolute path for an opener's `(path, source)` pair.
 *
 * Workspace paths are worktree-relative, thread-storage paths are relative to
 * the thread's storage root, and host paths are already absolute.
 */
async function toAbsolutePath(bb: BbPluginApi, input: LocateFileInput): Promise<string> {
  const { source } = input;

  if (source.kind === "workspace") {
    if (source.environmentId === null) {
      throw fmError("unsupported", "this workspace file has no environment");
    }
    const checkout = await environmentCheckoutPath(bb, source.environmentId);
    if (checkout === null) {
      throw fmError("unsupported", "this environment has no checkout on disk yet");
    }
    return path.resolve(checkout, input.path);
  }

  if (source.kind === "thread-storage") {
    if (source.threadId === null) {
      throw fmError("unsupported", "this stored file has no thread");
    }
    // Only the storage root matters, so ask for no entries at all.
    const storage = await bb.sdk.threads.storagePaths({
      threadId: source.threadId,
      includeFiles: "false",
      includeDirectories: "false",
    });
    return path.resolve(storage.storageRootPath, input.path);
  }

  // A host path is absolute by contract. A relative one would otherwise land
  // against the server process's cwd — `normalize()` resolves it under the
  // root instead, which is the only base this plugin has any business using.
  return input.path;
}

/** The nearest ancestor that exists and is a directory, root included. */
async function nearestExistingDir(startFrom: string): Promise<string> {
  const root = getRoot();
  let candidate = startFrom;
  while (isInside(candidate)) {
    try {
      const real = await resolveExisting(candidate);
      const stats = await stat(real);
      if (stats.isDirectory()) return real;
    } catch {
      // Missing, unreadable, or not a directory — keep walking up. The root
      // is the floor, and it exists by construction (src/root.ts realpaths it
      // at load), so this loop always terminates with an answer.
    }
    const parent = path.dirname(candidate);
    if (parent === candidate) break;
    candidate = parent;
  }
  return root;
}

export async function locateFile(
  bb: BbPluginApi,
  input: LocateFileInput,
): Promise<LocateFileOutput> {
  const absolute = normalize(await toAbsolutePath(bb, input));
  // Lexical first, so a path that is plainly outside the root never reaches
  // the filesystem — the same order §6 uses everywhere else.
  assertInside(absolute);

  const name = absolute === getRoot() ? "" : path.basename(absolute);

  try {
    const real = await resolveExisting(absolute);
    const stats = await stat(real);
    if (stats.isDirectory()) {
      return {
        dirPath: real,
        absolutePath: real,
        name: "",
        exists: true,
        isDirectory: true,
        matchHint: null,
      };
    }
    const parent = path.dirname(real);
    return {
      dirPath: parent,
      absolutePath: real,
      name: path.basename(real),
      exists: true,
      isDirectory: false,
      matchHint: null,
    };
  } catch (error) {
    // A path that escapes the root is a refusal, not a missing file: walking
    // up from it would answer with a folder the caller never named.
    if (isFileManagerError(error) && error.code === "path_escape") throw error;
  }

  return {
    dirPath: await nearestExistingDir(path.dirname(absolute)),
    absolutePath: absolute,
    name,
    exists: false,
    isDirectory: false,
    matchHint: globMatchHint(name),
  };
}

/* ------------------------------------------------------------------ */
/* §10.3 — the folder a thread's code lives in                         */
/* ------------------------------------------------------------------ */

export interface ThreadWorkspaceInput {
  threadId: string;
}

export interface ThreadWorkspaceOutput {
  /** Realpath'ed checkout, non-null exactly when it is a directory on disk. */
  path: string | null;
  /** True only when `path` is the hard root or below it. */
  insideRoot: boolean;
  /** Null exactly when the panel may open `path`. */
  reason: ThreadWorkspaceReason | null;
}

/**
 * `thread → environment → checkout`, clamped by §6.
 *
 * It answers "you cannot go there" instead of throwing it. A thread with no
 * environment, an environment with no checkout and a checkout outside the home
 * folder are ordinary states of a healthy bb, and the toolbar renders each of
 * them differently — a rejection would flatten all three into one toast. Only
 * a thread bb itself cannot answer for rejects.
 */
export async function resolveThreadWorkspace(
  bb: BbPluginApi,
  input: ThreadWorkspaceInput,
): Promise<ThreadWorkspaceOutput> {
  const thread = await bb.sdk.threads.get({ threadId: input.threadId });
  if (thread.environmentId === null) {
    return { path: null, insideRoot: false, reason: "no_environment" };
  }

  const checkout = await environmentCheckoutPath(bb, thread.environmentId);
  if (checkout === null) {
    return { path: null, insideRoot: false, reason: "no_checkout" };
  }

  // §6's order, done by hand rather than through resolveExisting: realpath
  // BEFORE the prefix test, but a path outside the root is an *answer* here,
  // not a refusal, and the panel has to be able to tell the two apart.
  let real: string | null = null;
  try {
    const resolved = await realpath(normalize(checkout));
    if ((await stat(resolved)).isDirectory()) real = resolved;
  } catch {
    // bb keeps the recorded path of a worktree that has since been destroyed,
    // so a directory that is no longer there is still just "no checkout".
  }
  if (real === null) {
    return { path: null, insideRoot: false, reason: "no_checkout" };
  }

  if (!isInside(real)) {
    // Reported rather than hidden: bb can run threads on checkouts anywhere,
    // and "outside your home folder" is a better answer than silence.
    return { path: real, insideRoot: false, reason: "outside_root" };
  }
  return { path: real, insideRoot: true, reason: null };
}
