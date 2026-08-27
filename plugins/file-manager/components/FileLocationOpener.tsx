// components/FileLocationOpener.tsx — "show me where this file is".
//
// bb offers every registered `fileOpener` in the right-click menu of a file
// link in a rendered message ("Open with <title>"), and opens the chosen one
// as a tab in the side panel. That is exactly the surface a reveal wants, so
// the file manager registers two of them (§10.2):
//
//   - `FileLocationOpener` — opens the file's folder with the file selected.
//     This is the menu entry the user clicks to reveal something.
//   - `FilePreviewOpener` — bb's own preview with one extra strip on top,
//     carrying the same reveal as a button. It exists because bb also picks an
//     opener *automatically* for every matching extension, and the automatic
//     pick has to keep looking like the preview it replaced.
//
// A path that does not exist is not a failure. Agents write globs
// (`backups/*-2026-08-25.md`) and paths that have since moved; the backend
// answers with the nearest folder that does exist, and the panel opens there
// with the name pre-filtered.
import { useEffect, useState } from "react";
import type { PluginFileOpenerProps } from "@get-bb/plugin-sdk/app";
import { toast } from "sonner";

import { useLocalLocation } from "../hooks/useFmLocation";
import { parseRpcError } from "../lib/errors";
import { basename } from "../lib/fm-paths";
import { useFmRpc, type RpcOutput } from "../lib/fm-rpc";
import { FileManagerSurface } from "./FileManagerPanel";
import { Button } from "./ui/button";
import { Icon } from "./ui/icon";

type Located = RpcOutput<"resolveFileLocation">;

type LocateState =
  | { status: "loading" }
  | { status: "ready"; located: Located }
  | { status: "failed"; message: string };

/**
 * The folder half of an opener path, as the link itself spelled it, or null
 * when there is none — a thread-storage file is named without a folder, and
 * "This folder" said nothing while taking up the whole strip.
 */
function folderLabel(path: string): string | null {
  const cut = path.replace(/\/+$/u, "").lastIndexOf("/");
  return cut <= 0 ? null : path.slice(0, cut);
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full w-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
      <div className="max-w-md space-y-2">{children}</div>
    </div>
  );
}

/** Resolves the link, then hands the folder to the ordinary panel body. */
function LocationView({ path, source }: Pick<PluginFileOpenerProps, "path" | "source">) {
  const rpc = useFmRpc();
  const [state, setState] = useState<LocateState>({ status: "loading" });
  // The host rebuilds `source` every render, so the effect depends on its
  // fields instead — an object identity here would re-resolve forever.
  const { kind, threadId, environmentId, projectId } = source;

  useEffect(() => {
    let cancelled = false;
    setState({ status: "loading" });
    void (async () => {
      try {
        const located = await rpc.call("resolveFileLocation", {
          path,
          source: { kind, threadId, environmentId, projectId },
        });
        if (cancelled) return;
        setState({ status: "ready", located });
        if (!located.exists) {
          // Say it once, and say which folder opened instead — a panel that
          // silently lands somewhere else reads as the wrong folder.
          toast.message(
            `${basename(path)} is not there. Opened ${located.dirPath} instead.`,
          );
        }
      } catch (failure) {
        if (cancelled) return;
        setState({
          status: "failed",
          message: parseRpcError(failure).rawMessage,
        });
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [environmentId, kind, path, projectId, rpc, threadId]);

  const location = useLocalLocation("");

  if (state.status === "loading") {
    return <Centered>Finding this file…</Centered>;
  }

  if (state.status === "failed") {
    return (
      <Centered>
        <p className="font-medium text-foreground">Could not open this location</p>
        <p>{state.message}</p>
      </Centered>
    );
  }

  const { located } = state;
  return (
    <FileManagerSurface
      location={location}
      chrome="inline"
      initialPath={located.dirPath}
      revealPath={located.exists && !located.isDirectory ? located.absolutePath : null}
      initialQuery={located.exists ? "" : (located.matchHint ?? "")}
    />
  );
}

/** `fileOpener` #2: the reveal itself, chosen from the link's context menu. */
export function FileLocationOpener({ path, source }: PluginFileOpenerProps) {
  return <LocationView path={path} source={source} />;
}

/**
 * `fileOpener` #1: bb's preview, plus one strip that reveals the file.
 *
 * Registered first, so bb's automatic per-extension pick lands here rather
 * than on the reveal — opening a file link with a plain click must still show
 * the file.
 */
export function FilePreviewOpener({ path, source, Original }: PluginFileOpenerProps) {
  const [showLocation, setShowLocation] = useState(false);
  const folder = folderLabel(path);

  if (showLocation) {
    return <LocationView path={path} source={source} />;
  }

  return (
    <div className="@container flex h-full min-h-0 flex-1 flex-col overflow-hidden">
      {/* Kept to one thin line: BB's preview already has a header of its own
          with the file name and its actions, so this adds the one thing it
          does not have — where the file lives, and a way to go there. */}
      <div className="flex h-8 shrink-0 items-center gap-2 border-b border-border px-2">
        {folder === null ? (
          <span className="flex-1" />
        ) : (
          <>
            <Icon name="Folder" className="size-3.5 shrink-0 text-muted-foreground" aria-hidden />
            <span
              className="min-w-0 flex-1 truncate text-xs text-muted-foreground"
              title={path}
              data-testid="fm-opener-folder"
            >
              {folder}
            </span>
          </>
        )}
        <Button
          type="button"
          size="sm"
          variant="ghost"
          className="h-6 shrink-0 gap-1.5 px-2 text-xs"
          data-testid="fm-open-location"
          // LocationView owns the lookup, its loading state and its failure
          // text, so this only has to switch to it.
          onClick={() => setShowLocation(true)}
        >
          <Icon name="FolderOpen" className="size-4" aria-hidden />
          <span className="hidden @md:inline">Open location</span>
        </Button>
      </div>
      {/*
       * This wrapper is the scroller, and that is not a detail: BB's preview
       * picks its layout per file type. Code, CSV and iframes take
       * `h-full min-h-0` and scroll inside themselves; a rendered markdown
       * document takes `min-h-full` and grows to its content, expecting
       * whatever holds it to scroll. BB's own opener frame is
       * `overflow-hidden`, so with no scroller of our own a long document
       * simply had nowhere to go — the bug reported against 0.6 and 0.7.
       * `overflow-auto` serves both: the self-scrolling kinds never overflow
       * it, the growing kind finally can.
       */}
      <div className="flex min-h-0 flex-1 flex-col overflow-auto" data-testid="fm-opener-body">
        <Original />
      </div>
    </div>
  );
}
