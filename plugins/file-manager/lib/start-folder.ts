// lib/start-folder.ts — the one implementation of "where does the panel open".
//
// Two surfaces write this setting: the panel's "Set as start folder" action
// (§8.6) and the settings section (components/SettingsSection.tsx). They share
// the RPC call, the wording of the toasts and the little bit of arithmetic that
// turns a stored path into something a human can read — so none of it lives in
// a component.
import { getClientRoot, isSamePath, toAbsolute, toRelative } from "./fm-paths";
import type { FileManagerRpc } from "./fm-rpc";

export const START_FOLDER_SAVED_TEXT = "Start folder saved";
export const START_FOLDER_SAVE_FAILED_TEXT = "Could not save the start folder.";

/**
 * Persist the start folder. Returns the value the *backend* settled on: it
 * realpaths the input, re-checks it against the root and stores that form
 * (src/settings.ts#validateStartFolder), so the caller must render what comes
 * back rather than what it sent.
 *
 * Rejects with `FileManagerRpcError` — `path_escape`, `not_found` and
 * `not_a_directory` are the codes worth wording for.
 */
export async function saveStartFolder(rpc: FileManagerRpc, path: string): Promise<string> {
  const result = await rpc.call("savePreferences", { startFolder: path });
  return result.startFolder;
}

/** Short label for a start folder: `rootLabel` at the root, else root-relative. */
export function startFolderLabel(
  absolute: string,
  root: string = getClientRoot(),
  rootLabel = "Home",
): string {
  const relative = toRelative(absolute, root);
  return relative === "" ? rootLabel : relative;
}

/**
 * True when the *stored* setting points somewhere the backend could not use, so
 * `getState` handed back the root instead.
 *
 * The backend never throws on a bad `startFolder` — it logs and falls back to
 * the root (§7.1), which is what keeps a stale value from bricking the panel.
 * The only visible trace is exactly this: a stored path that is not the root
 * while the effective one is. Comparison goes through `toAbsolute` so the
 * `~`-relative forms the CLI accepts do not read as a mismatch.
 */
export function isStartFolderFallback(
  storedValue: unknown,
  effective: string,
  root: string = getClientRoot(),
): boolean {
  if (typeof storedValue !== "string" || storedValue.trim() === "") return false;
  if (!isSamePath(effective, root)) return false;
  return !isSamePath(toAbsolute(storedValue, root), root);
}
