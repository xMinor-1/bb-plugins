// src/protect.ts — protected locations under the hard root, and the delete
// policy (trash vs permanent).
//
// Credentials, agent configs and shell start-up files live in a handful of
// well-known places under home. One stray delete, move or overwrite there can
// lock a user out of every remote machine or silently rewrite their shell, so
// mutations refuse them outright. Reads (listing, preview, download) stay
// allowed — the listing already hides dot-entries by default.
//
// Matching is done on absolute paths whose parent chain has already been
// realpath'ed (resolveLink / resolveNew / resolveExisting), against both the
// lexical protected path and its own realpath — so a symlinked ancestor or a
// protected folder that is itself a symlink into a dotfiles repo is covered.
import { readdir, realpath } from "node:fs/promises";
import path from "node:path";

import { fmError } from "./errors";
import { getRoot } from "./root";

/**
 * Paths relative to the hard root (the user's home). A trailing `*` matches
 * any top-level name with that prefix (`.claude-*` → `.claude-work`). Each
 * entry covers the path itself and everything inside it, never its ancestors.
 */
export const PROTECTED_PATHS: readonly string[] = [
  ".ssh",
  ".gnupg",
  ".aws",
  ".azure",
  ".kube",
  ".docker",
  ".config/gh",
  ".claude",
  ".claude-*",
  ".codex",
  ".bb",
  ".bb-*",
  ".netrc",
  ".npmrc",
  ".pypirc",
  ".git-credentials",
  ".zshrc",
  ".zprofile",
  ".bashrc",
  ".bash_profile",
  ".profile",
  "Library/Keychains",
  "Library/Application Support/com.apple.TCC",
];

export interface SafetyPolicy {
  /** Delete removes permanently instead of moving to the Trash. */
  permanentDelete: boolean;
  /** Extra protected paths relative to home, comma-separated (a setting). */
  extraProtectedPaths: string;
}

let policy: SafetyPolicy = { permanentDelete: false, extraProtectedPaths: "" };

/** Called by the settings module at load and on every settings change. */
export function setSafetyPolicy(next: Partial<SafetyPolicy>): void {
  policy = { ...policy, ...next };
}

export function getSafetyPolicy(): SafetyPolicy {
  return policy;
}

/** Split the `extraProtectedPaths` setting into clean relative entries. */
export function parseExtraProtectedPaths(raw: string): string[] {
  return raw
    .split(",")
    .map((entry) => entry.trim())
    .map((entry) => (entry.startsWith("~/") ? entry.slice(2) : entry))
    .map((entry) => entry.replace(/^\/+|\/+$/gu, ""))
    .filter((entry) => entry !== "" && entry !== "." && !entry.split("/").includes(".."));
}

/** macOS and Windows volumes are case-insensitive by default: compare folded. */
const FOLD_CASE = process.platform === "darwin" || process.platform === "win32";

function fold(value: string): string {
  return FOLD_CASE ? value.toLowerCase() : value;
}

function isSameOrInside(candidate: string, base: string): boolean {
  const c = fold(candidate);
  const b = fold(base);
  return c === b || c.startsWith(b + path.sep);
}

/** Absolute protected locations (lexical plus realpath) for the current root. */
export async function protectedLocations(): Promise<string[]> {
  const root = getRoot();
  const entries = [...PROTECTED_PATHS, ...parseExtraProtectedPaths(policy.extraProtectedPaths)];
  const lexical = new Set<string>();

  let topLevel: string[] | null = null;
  for (const entry of entries) {
    if (entry.endsWith("*") && !entry.slice(0, -1).includes("/")) {
      const prefix = fold(entry.slice(0, -1));
      topLevel ??= await readdir(root).catch(() => [] as string[]);
      for (const name of topLevel) {
        if (fold(name).startsWith(prefix)) lexical.add(path.join(root, name));
      }
      continue;
    }
    lexical.add(path.join(root, entry));
  }

  const all = new Set(lexical);
  await Promise.all(
    [...lexical].map(async (candidate) => {
      try {
        all.add(await realpath(candidate));
      } catch {
        // Missing protected paths are still protected lexically.
      }
    }),
  );
  return [...all];
}

/** The protected location `candidate` falls under, or null. */
export async function findProtected(candidate: string): Promise<string | null> {
  for (const location of await protectedLocations()) {
    if (isSameOrInside(candidate, location)) return location;
  }
  return null;
}

/**
 * Refuse a mutation that touches a protected location. `action` is the verb
 * shown to the user ("delete", "move", "upload into", …).
 */
export async function assertNotProtected(
  candidate: string,
  action: string,
  options: { subtree?: boolean } = {},
): Promise<void> {
  const locations = await protectedLocations();
  const hit = locations.find((location) => isSameOrInside(candidate, location));
  // With `subtree`, the whole entry is removed or replaced (delete, move,
  // rename, overwrite), so a folder that holds a protected location
  // (~/Library, ~/.config) would carry it along: refuse that too.
  const inside =
    hit ?? (options.subtree ? locations.find((location) => isSameOrInside(location, candidate)) : undefined);
  if (inside === undefined) return;
  const relative = path.relative(getRoot(), inside) || inside;
  const reason = hit === undefined ? "contains" : "is";
  throw fmError(
    "protected_path",
    `${candidate}: refusing to ${action} — it ${reason} "~/${relative}", a protected location ` +
      "(credentials or configuration). Change it outside the File Manager if you really mean it.",
  );
}
