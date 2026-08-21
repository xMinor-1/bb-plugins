// components/SettingsSection.tsx — the `app.slots.settingsSection` body on the
// plugin's detail page in Tools.
//
// It exists because bb's declarative settings form can only render the four
// descriptor types (string / select / boolean / project) and none of them is a
// path picker: `startFolder` therefore shows up above this section as a bare
// text field. This section is the same setting with a folder browser attached —
// it writes through the very same `savePreferences` method the panel uses
// (lib/start-folder.ts), so the CLI, the panel action and this form can never
// disagree.
//
// Slot props are deliberately empty in V1, and the host mounts this outside the
// panel's subtree, so everything it needs comes from `getState` and
// `useSettings()`.
import { useCallback, useEffect, useRef, useState } from "react";
import { useSettings, type PluginSettingsSectionProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";

import { errorToastText } from "../lib/errors";
import { getClientRoot, isSamePath } from "../lib/fm-paths";
import { useFmRpc, type RpcOutput } from "../lib/fm-rpc";
import {
  isStartFolderFallback,
  saveStartFolder,
  startFolderLabel,
  START_FOLDER_SAVED_TEXT,
  START_FOLDER_SAVE_FAILED_TEXT,
} from "../lib/start-folder";
import { FolderPickerDialog } from "./dialogs/FolderPickerDialog";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";

type PanelState = RpcOutput<"getState">;

export function SettingsSection(_props: PluginSettingsSectionProps) {
  const rpc = useFmRpc();
  // Read-only view of the raw descriptor values; the host keeps it live, so it
  // also reflects a change made from the CLI or the form above this section.
  const settings = useSettings();

  const [state, setState] = useState<PanelState | null>(null);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [saveError, setSaveError] = useState<string | null>(null);
  const [saving, setSaving] = useState(false);
  const [pickerOpen, setPickerOpen] = useState(false);
  // Mounted-guard: a settings page can be navigated away from mid-request, and
  // a setState on an unmounted section is a console warning nobody can act on.
  const activeRef = useRef(true);

  useEffect(() => {
    activeRef.current = true;
    return () => {
      activeRef.current = false;
    };
  }, []);

  const load = useCallback(async (): Promise<void> => {
    try {
      const result = await rpc.call("getState", null);
      if (!activeRef.current) return;
      setState(result);
      setLoadError(null);
    } catch (failure) {
      if (!activeRef.current) return;
      setLoadError(errorToastText(failure, "Could not read the File Manager settings."));
    }
  }, [rpc]);

  useEffect(() => {
    void load();
  }, [load]);

  const root = state?.root ?? getClientRoot();
  const startFolder = state?.startFolder ?? null;
  const atRoot = startFolder !== null && isSamePath(startFolder, root);
  const busy = saving || state === null;
  const fellBackToRoot =
    startFolder !== null &&
    isStartFolderFallback(settings.values?.startFolder, startFolder, root);

  const choose = useCallback(
    (path: string): void => {
      setSaveError(null);
      setSaving(true);
      void (async () => {
        try {
          const resolved = await saveStartFolder(rpc, path);
          if (!activeRef.current) return;
          // The backend realpaths and re-validates; render its answer, and keep
          // the rest of the cached state so nothing else flickers.
          setState((previous) =>
            previous === null ? previous : { ...previous, startFolder: resolved },
          );
          toast.success(START_FOLDER_SAVED_TEXT);
        } catch (failure) {
          if (!activeRef.current) return;
          setSaveError(errorToastText(failure, START_FOLDER_SAVE_FAILED_TEXT));
        } finally {
          if (activeRef.current) setSaving(false);
        }
      })();
    },
    [rpc],
  );

  return (
    <div className="w-full space-y-3" data-testid="fm-settings-section">
      <div className="flex items-start justify-between gap-6">
        <div className="min-w-0">
          <h3 className="text-sm font-medium text-foreground">Start folder</h3>
          <p className="mt-1 text-xs leading-relaxed text-muted-foreground">
            The File Manager panel opens here every time. Everything stays inside{" "}
            {root}.
          </p>
        </div>
        <div className="flex shrink-0 items-center gap-2">
          <Button
            type="button"
            variant="outline"
            size="sm"
            disabled={busy || loadError !== null}
            data-testid="fm-settings-browse"
            onClick={() => {
              setSaveError(null);
              setPickerOpen(true);
            }}
          >
            <Icon name="FolderOpen" className="size-4" aria-hidden="true" />
            Browse…
          </Button>
          <Button
            type="button"
            variant="ghost"
            size="sm"
            disabled={busy || loadError !== null || atRoot}
            data-testid="fm-settings-reset"
            onClick={() => choose(root)}
          >
            Reset to {root}
          </Button>
        </div>
      </div>

      <div className="flex min-h-9 items-center gap-2 rounded-md border border-border/60 bg-muted/20 px-3 py-2">
        <Icon
          name="Folder"
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden="true"
        />
        {startFolder === null ? (
          <span className="text-sm text-muted-foreground">
            {loadError === null ? "Loading…" : "Unavailable"}
          </span>
        ) : (
          <>
            <span
              className="min-w-0 flex-1 truncate font-mono text-sm text-foreground"
              title={startFolder}
              data-testid="fm-settings-start-folder"
            >
              {startFolder}
            </span>
            <span className="shrink-0 text-xs text-muted-foreground">
              {startFolderLabel(startFolder, root)}
            </span>
          </>
        )}
      </div>

      <div className="flex min-h-5 items-start justify-between gap-4">
        {fellBackToRoot ? (
          <p className="text-xs text-muted-foreground" role="status">
            The saved path{" "}
            <span className="font-mono">{String(settings.values?.startFolder)}</span> could
            not be opened — it was moved, deleted, or is outside {root}. The panel opens{" "}
            {root} until you pick another folder.
          </p>
        ) : (
          <span />
        )}
        <div className="flex shrink-0 items-center gap-3" aria-live="polite">
          {loadError !== null ? (
            <>
              <span className="text-xs text-destructive" role="alert">
                {loadError}
              </span>
              <Button
                type="button"
                variant="ghost"
                size="sm"
                data-testid="fm-settings-retry"
                onClick={() => void load()}
              >
                Try again
              </Button>
            </>
          ) : saveError !== null ? (
            <span className="text-xs text-destructive" role="alert">
              {saveError}
            </span>
          ) : (
            <span className="text-xs text-muted-foreground" role="status">
              {saving ? "Saving…" : state === null ? "Loading…" : "Saved"}
            </span>
          )}
        </div>
      </div>

      {/* The same browser the panel opens for "Move to…" / "Copy to…" (§8.6):
          one picker, one listDir path, no second implementation. */}
      <FolderPickerDialog
        open={pickerOpen}
        title="Start folder"
        description="Pick the folder the File Manager panel opens in."
        initialPath={startFolder ?? root}
        root={root}
        showHidden={state?.preferences.showHiddenFiles ?? false}
        confirmLabel="Use this folder"
        onOpenChange={setPickerOpen}
        onChoose={choose}
      />
    </div>
  );
}
