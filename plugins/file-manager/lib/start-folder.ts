// lib/start-folder.ts — the one implementation of "where does the panel open".
//
// Two surfaces write this setting: the panel's "Set as start folder" action
// (§8.6) and the settings section (components/SettingsSection.tsx). They share
// the RPC call, the wording of the toasts and the little bit of arithmetic that
// turns a stored path into something a human can read — so none of it lives in
// a component.
import { getClientRoot, toRelative } from "./fm-paths";
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
 * True when a raw `startFolder` value delivered by the host is a *change* — the
 * cue the settings section uses to re-read its `getState` snapshot.
 *
 * The host's copy of the settings is a react-query it refetches whenever the
 * server broadcasts `plugins-changed`, so a new value means somebody else (the
 * text field, the panel action, the CLI, another window) wrote the setting. The
 * first delivery is the query resolving, not a write, and `undefined` is
 * "not loaded yet" — neither is a reason to re-read anything.
 */
export function isExternalSettingChange(previous: unknown, next: unknown): boolean {
  return typeof previous === "string" && previous !== next;
}
