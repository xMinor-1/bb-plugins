// src/root.ts — the security core. §6 of SPEC.md, implemented literally.
//
// Nothing else in this plugin is allowed to build a filesystem path from user
// input: every path that reaches node:fs must come out of resolveExisting,
// resolveLink or resolveNew, all of which realpath BEFORE the prefix test.
import { lstat, realpath, stat } from "node:fs/promises";
import path from "node:path";
import type { Stats } from "node:fs";

import { ROOT_PATH, STAGING_DIR_NAME } from "../contract";
import { fmError, mapNodeError } from "./errors";

/** The configured root before realpath resolution. */
export const DEFAULT_ROOT = ROOT_PATH;

/**
 * The realpath'ed hard root. Resolved once at factory time by initRoot(); the
 * default keeps the module usable (and typed as a plain string) before that.
 * Tests point it at an mkdtemp tree.
 */
let root: string = DEFAULT_ROOT;

/**
 * Resolve and remember the hard root. Called once from the plugin factory
 * (`await initRoot()`), and from tests with a temp directory. Returns the
 * realpath'ed value, which is what every later check compares against.
 */
export async function initRoot(input: string = DEFAULT_ROOT): Promise<string> {
  root = await realpath(input);
  return root;
}

/** The realpath'ed hard root. Never outside this prefix. */
export function getRoot(): string {
  return root;
}

/** `<ROOT>/.bb-file-manager` — staging area, filtered from every listing. */
export function getStagingDir(): string {
  return path.join(root, STAGING_DIR_NAME);
}

/** Uploads live in `<ROOT>/.bb-file-manager/uploads`. */
export function getUploadsDir(): string {
  return path.join(getStagingDir(), "uploads");
}

/** True for the staging directory itself and anything beneath it. */
export function isStagingPath(candidate: string): boolean {
  const staging = getStagingDir();
  return candidate === staging || candidate.startsWith(staging + path.sep);
}

/** §6: the prefix test. Always applied to a realpath'ed value. */
export function assertInside(candidate: string): string {
  if (candidate === root) return candidate;
  if (candidate.startsWith(root + path.sep)) return candidate;
  throw fmError("path_escape", candidate);
}

/** True when `candidate` is the root or inside it. Non-throwing assertInside. */
export function isInside(candidate: string): boolean {
  return candidate === root || candidate.startsWith(root + path.sep);
}

/**
 * §6 validateName — one path component, exactly the listed rules. No unicode
 * normalization: on Linux a name is a byte string, so folding NFC/NFD here
 * would silently address a different file than the one the user named.
 */
export function validateName(name: string): string {
  if (name === "" || name === "." || name === "..") {
    throw fmError("invalid_name", name === "" ? "(empty)" : name);
  }
  if (name.includes("/") || name.includes("\0")) throw fmError("invalid_name", name);
  // eslint-disable-next-line no-control-regex -- deliberate: reject control chars
  if (/[\x00-\x1f]/u.test(name)) throw fmError("invalid_name", name);
  if (Buffer.byteLength(name, "utf8") > 255) throw fmError("invalid_name", `${name.slice(0, 32)}…`);
  return name;
}

/** §6 normalize — lexical only, never touches the filesystem. */
export function normalize(input: string): string {
  if (input === "" || input === "~") return root;
  const expanded = input.startsWith("~/") ? root + input.slice(1) : input;
  // Absolute inputs stay absolute (and are then rejected by assertInside);
  // relative inputs resolve under the root.
  return path.resolve(root, expanded);
}

/**
 * (A) The target must already exist and MAY be followed through symlinks.
 * Used by: listDir, statPath, searchDir, download, extract source, destination
 * directories, upload destination directory.
 */
export async function resolveExisting(input: string): Promise<string> {
  const abs = normalize(input);
  assertInside(abs); // cheap lexical pre-check
  let real: string;
  try {
    real = await realpath(abs);
  } catch (error) {
    throw mapNodeError(error, abs);
  }
  assertInside(real); // THE check: realpath BEFORE the prefix test
  return real;
}

/** resolveExisting + "must be a directory". */
export async function resolveExistingDir(input: string): Promise<string> {
  const real = await resolveExisting(input);
  let st: Stats;
  try {
    st = await stat(real);
  } catch (error) {
    throw mapNodeError(error, real);
  }
  if (!st.isDirectory()) throw fmError("not_a_directory", real);
  return real;
}

export interface ResolvedLink {
  path: string;
  lstat: Stats;
}

/**
 * (B) The target must NOT be followed — operate on the link itself.
 * Used by: delete, and the source of move / copy / rename.
 * The parent chain is still realpath'ed, so a symlinked ancestor cannot escape.
 */
export async function resolveLink(input: string): Promise<ResolvedLink> {
  const abs = normalize(input);
  assertInside(abs);
  // §6 rule 5: the root itself is never a mutation target. resolveExisting on
  // its parent would throw path_escape anyway; this is the explicit guard.
  if (abs === root) throw fmError("path_escape", root);
  const parentReal = await resolveExisting(path.dirname(abs));
  const target = path.join(parentReal, validateName(path.basename(abs)));
  assertInside(target);
  if (target === root) throw fmError("path_escape", root);
  let st: Stats;
  try {
    st = await lstat(target);
  } catch (error) {
    throw mapNodeError(error, target);
  }
  return { path: target, lstat: st };
}

/**
 * (C) The target does not exist yet.
 * Used by: createFolder, rename destination, upload commit, move/copy dest.
 */
export async function resolveNew(dirInput: string, name: string): Promise<string> {
  const dirReal = await resolveExisting(dirInput);
  const target = path.join(dirReal, validateName(name));
  assertInside(target);
  return target;
}

/** §6: refuse moving/copying a directory into itself or its own subtree. */
export function assertNotInsideSelf(source: string, destinationDir: string): void {
  if (destinationDir === source || destinationDir.startsWith(source + path.sep)) {
    throw fmError("destination_inside_source", destinationDir);
  }
}

/** Parent directory of an absolute path, or null when it is the root. */
export function parentOf(absolutePath: string): string | null {
  if (absolutePath === root) return null;
  return path.dirname(absolutePath);
}
