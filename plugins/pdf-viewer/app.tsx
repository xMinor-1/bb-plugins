// bb-plugin-pdf-viewer — frontend entry.
//
// Two surfaces over one viewer: a file opener so any .pdf opened in bb renders
// here instead of downloading, and a nav panel for browsing a host's folders
// and reopening recent documents.
import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import {
  definePluginApp,
  useRpc,
  type PluginFileOpenerProps,
} from "@get-bb/plugin-sdk/app";
import type { rpcContract } from "./server";
import { Button } from "@/components/ui/button";
import { Icon } from "@/components/ui/icon";

/** Refresh the preview URL well before its one-hour lease expires. */
const URL_REFRESH_MS = 45 * 60 * 1000;

interface LoadedDocument {
  url: string;
  name: string;
  path: string;
  hostId: string | null;
}

function errorMessage(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function Centered({ children }: { children: React.ReactNode }) {
  return (
    <div className="flex h-full w-full items-center justify-center p-6 text-center text-sm text-muted-foreground">
      <div className="max-w-md space-y-2">{children}</div>
    </div>
  );
}

/**
 * The viewer itself. bb's preview URL is served from the app's own origin, so
 * the embedded document renders in the browser's PDF viewer with its own
 * paging, zoom, search and print controls.
 */
function DocumentFrame({
  document: loaded,
  onBack,
  reload,
}: {
  document: LoadedDocument;
  onBack?: () => void;
  reload?: () => void;
}) {
  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex h-10 shrink-0 items-center gap-2 border-b border-border px-2">
        {onBack ? (
          <Button
            size="sm"
            variant="ghost"
            onClick={onBack}
            aria-label="Back to files"
          >
            <Icon name="ChevronLeft" aria-hidden />
          </Button>
        ) : null}
        <Icon
          name="FileText"
          className="size-4 shrink-0 text-muted-foreground"
          aria-hidden
        />
        <span className="truncate text-sm font-medium" title={loaded.path}>
          {loaded.name}
        </span>
        <div className="ml-auto flex items-center gap-1">
          {reload ? (
            <Button
              size="sm"
              variant="ghost"
              onClick={reload}
              aria-label="Reload document"
            >
              <Icon name="RotateCcw" aria-hidden />
            </Button>
          ) : null}
          <Button size="sm" variant="ghost" asChild>
            <a
              href={loaded.url}
              target="_blank"
              rel="noreferrer"
              aria-label="Open in a new tab"
            >
              <Icon name="ExternalLink" aria-hidden />
            </a>
          </Button>
          <Button size="sm" variant="ghost" asChild>
            <a href={loaded.url} download={loaded.name} aria-label="Download">
              <Icon name="Download" aria-hidden />
            </a>
          </Button>
        </div>
      </div>
      <iframe
        key={loaded.url}
        src={loaded.url}
        title={loaded.name}
        className="min-h-0 w-full flex-1 border-0 bg-muted"
      />
    </div>
  );
}

/** Loads a document URL and keeps it fresh while the surface stays open. */
function useDocumentUrl(
  load: () => Promise<LoadedDocument>,
  dependencies: readonly unknown[],
): {
  document: LoadedDocument | null;
  error: string | null;
  isLoading: boolean;
  reload: () => void;
} {
  const [document, setDocument] = useState<LoadedDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isLoading, setIsLoading] = useState(true);
  const [nonce, setNonce] = useState(0);
  const loadRef = useRef(load);
  loadRef.current = load;

  useEffect(() => {
    let cancelled = false;
    setIsLoading(true);
    setError(null);
    loadRef
      .current()
      .then((next) => {
        if (cancelled) return;
        setDocument(next);
        setIsLoading(false);
      })
      .catch((cause: unknown) => {
        if (cancelled) return;
        setError(errorMessage(cause));
        setIsLoading(false);
      });
    return () => {
      cancelled = true;
    };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [...dependencies, nonce]);

  useEffect(() => {
    const timer = setInterval(() => setNonce((value) => value + 1), URL_REFRESH_MS);
    return () => clearInterval(timer);
  }, []);

  const reload = useCallback(() => setNonce((value) => value + 1), []);
  return { document, error, isLoading, reload };
}

/** File-opener surface: bb hands us a path and where it lives. */
function PdfFileOpener({ path, source }: PluginFileOpenerProps) {
  const rpc = useRpc<typeof rpcContract>();
  const load = useCallback(
    () => rpc.call("openedDocumentUrl", { path, source }),
    [rpc, path, source],
  );
  const { document, error, isLoading, reload } = useDocumentUrl(load, [
    path,
    source.kind,
    source.environmentId,
    source.threadId,
  ]);

  if (error) {
    return (
      <Centered>
        <p className="text-destructive">Could not open this PDF.</p>
        <p>{error}</p>
      </Centered>
    );
  }
  if (isLoading || !document) {
    return <Centered>Opening {path}…</Centered>;
  }
  return <DocumentFrame document={document} reload={reload} />;
}

interface BrowseEntry {
  name: string;
  path: string;
  kind: "directory" | "file";
}

/** Nav panel: browse folders on a host, or reopen something recent. */
function PdfPanel() {
  const rpc = useRpc<typeof rpcContract>();
  const [hostId, setHostId] = useState<string | null>(null);
  const [directory, setDirectory] = useState<string | null>(null);
  const [parent, setParent] = useState<string | null>(null);
  const [entries, setEntries] = useState<BrowseEntry[]>([]);
  const [recents, setRecents] = useState<
    { path: string; name: string; hostId: string | null }[]
  >([]);
  const [selected, setSelected] = useState<LoadedDocument | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [isBusy, setIsBusy] = useState(true);

  const browse = useCallback(
    async (next: { hostId?: string | null; path?: string | null }) => {
      setIsBusy(true);
      setError(null);
      try {
        const listing = await rpc.call("browse", {
          hostId: next.hostId ?? null,
          path: next.path ?? null,
        });
        setHostId(listing.hostId);
        setDirectory(listing.directory);
        setParent(listing.parent);
        setEntries(listing.entries);
      } catch (cause: unknown) {
        setError(errorMessage(cause));
      } finally {
        setIsBusy(false);
      }
    },
    [rpc],
  );

  const refreshRecents = useCallback(async () => {
    try {
      const { recents: next } = await rpc.call("recents");
      setRecents(next);
    } catch {
      // Recents are a convenience; a failure here must not block browsing.
    }
  }, [rpc]);

  useEffect(() => {
    void browse({});
    void refreshRecents();
  }, [browse, refreshRecents]);

  const open = useCallback(
    async (path: string, host: string | null) => {
      setError(null);
      try {
        const loaded = await rpc.call("documentUrl", { path, hostId: host });
        setSelected(loaded);
        void refreshRecents();
      } catch (cause: unknown) {
        setError(errorMessage(cause));
      }
    },
    [rpc, refreshRecents],
  );

  const crumbs = useMemo(() => {
    if (!directory) return [];
    const segments = directory.split("/").filter(Boolean);
    return segments.map((segment, index) => ({
      name: segment,
      path: `/${segments.slice(0, index + 1).join("/")}`,
    }));
  }, [directory]);

  if (selected) {
    return (
      <DocumentFrame
        document={selected}
        onBack={() => setSelected(null)}
        reload={() => void open(selected.path, selected.hostId)}
      />
    );
  }

  return (
    <div className="flex h-full w-full flex-col">
      <div className="flex shrink-0 flex-wrap items-center gap-1 border-b border-border px-3 py-2 text-xs text-muted-foreground">
        <Button
          size="sm"
          variant="ghost"
          disabled={!parent}
          onClick={() => void browse({ hostId, path: parent })}
          aria-label="Parent folder"
        >
          <Icon name="ChevronLeft" aria-hidden />
        </Button>
        {crumbs.length === 0 ? (
          <span>{directory ?? "…"}</span>
        ) : (
          crumbs.map((crumb, index) => (
            <span key={crumb.path} className="flex items-center gap-1">
              {index > 0 ? <span aria-hidden>/</span> : null}
              <button
                type="button"
                className="cursor-pointer rounded px-1 hover:bg-state-hover hover:text-foreground"
                onClick={() => void browse({ hostId, path: crumb.path })}
              >
                {crumb.name}
              </button>
            </span>
          ))
        )}
      </div>

      <div className="min-h-0 flex-1 overflow-auto p-2">
        {error ? (
          <p className="px-2 py-1 text-sm text-destructive">{error}</p>
        ) : null}

        {recents.length > 0 ? (
          <div className="mb-3">
            <p className="px-2 py-1 text-xs font-medium text-muted-foreground">
              Recent
            </p>
            {recents.slice(0, 5).map((recent) => (
              <button
                key={`${recent.hostId ?? "local"}:${recent.path}`}
                type="button"
                className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-state-hover"
                onClick={() => void open(recent.path, recent.hostId)}
                title={recent.path}
              >
                <Icon
                  name="Clock"
                  className="size-4 shrink-0 text-muted-foreground"
                  aria-hidden
                />
                <span className="truncate">{recent.name}</span>
              </button>
            ))}
          </div>
        ) : null}

        {isBusy ? (
          <p className="px-2 py-1 text-sm text-muted-foreground">Loading…</p>
        ) : entries.length === 0 ? (
          <p className="px-2 py-1 text-sm text-muted-foreground">
            No folders or PDF files here.
          </p>
        ) : (
          entries.map((entry) => (
            <button
              key={entry.path}
              type="button"
              className="flex w-full cursor-pointer items-center gap-2 rounded-md px-2 py-1.5 text-left text-sm hover:bg-state-hover"
              onClick={() => {
                if (entry.kind === "directory") {
                  void browse({ hostId, path: entry.path });
                } else {
                  void open(entry.path, hostId);
                }
              }}
              title={entry.path}
            >
              <Icon
                name={entry.kind === "directory" ? "Folder" : "FileText"}
                className="size-4 shrink-0 text-muted-foreground"
                aria-hidden
              />
              <span className="truncate">{entry.name}</span>
            </button>
          ))
        )}
      </div>
    </div>
  );
}

export default definePluginApp((app) => {
  app.slots.fileOpener({
    id: "pdf",
    title: "PDF viewer",
    extensions: ["pdf"],
    component: PdfFileOpener,
  });

  app.slots.navPanel({
    id: "pdf",
    title: "PDF",
    icon: "FileText",
    path: "pdf",
    component: PdfPanel,
  });
});
