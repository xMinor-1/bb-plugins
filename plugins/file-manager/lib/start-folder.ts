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

/**
 * The one fact about the start folder a user cannot see for themselves: the
 * backend is not using the folder the setting names.
 *
 * Both halves come from something that knows. `resolved` is `getState`'s
 * `startFolder` — what `resolveStartFolder()` says the panel will actually
 * open (src/settings.ts). `rawSetting` is the host's copy of the stored
 * setting. The backend never throws over a broken start folder: it logs and
 * hands back the root, so a fallback has exactly one shape — `resolved` is the
 * root while the setting names something else. Returns the configured path in
 * absolute form when that shape is on screen, and null otherwise.
 *
 * Deliberately narrow, because the two values disagree harmlessly all the
 * time:
 *
 *   - a resolved folder that is not the root proves the setting worked,
 *     whatever the host's cached copy still says, so nothing is reported then;
 *   - `~/x`, `x` and `/…/x` are the same folder to the backend
 *     (src/root.ts#normalize), so the setting is compared after `toAbsolute`,
 *     which mirrors that rule.
 *
 * The caller owes it one thing: `resolved` must come from a `getState` read.
 * A value patched in from the caller's own save is newer than the host's
 * cached setting, and comparing the two accuses the save that just succeeded —
 * which is precisely what 0.3.0 did.
 */
export function startFolderNotInUse(
  rawSetting: unknown,
  resolved: string,
  root: string,
): string | null {
  if (typeof rawSetting !== "string" || rawSetting.trim() === "") return null;
  if (!isSamePath(resolved, root)) return null;
  const configured = toAbsolute(rawSetting, root);
  if (isSamePath(configured, root)) return null;
  return configured;
}
