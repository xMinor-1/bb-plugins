// bb-plugin-pdf-viewer — backend entry.
//
// The frontend never reads PDF bytes through rpc. Instead this backend mints
// a short-lived file-preview URL confined to the document's own directory,
// and the viewer streams it straight from bb — which keeps large documents
// out of the rpc envelope and works the same on remote hosts.
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";
import {
  baseName,
  directoryName,
  isPdfPath,
  joinPath,
  previewUrlFor,
} from "./lib/pdf-paths.js";
import { DocumentRegistry } from "./src/documents.js";
import { DOCUMENT_ROUTE, handleDocumentRequest } from "./src/http-routes.js";

const PREVIEW_TTL_MS = 60 * 60 * 1000;
/**
 * bb's file-preview route reads a whole file into memory and refuses anything
 * past this size, so bigger documents fall back to this plugin's own ranged
 * stream. Preview is preferred below the ceiling because it is bb's native
 * transport: it reaches other hosts and keeps working when the app is open
 * remotely through bb connect.
 */
const PREVIEW_MAX_BYTES = 25 * 1024 * 1024;
const RECENTS_KEY = "recent-documents";
const RECENTS_LIMIT = 12;

const fileOpenerSourceSchema = z
  .object({
    kind: z.enum(["host", "thread-storage", "workspace"]),
    threadId: z.string().nullable(),
    environmentId: z.string().nullable(),
    projectId: z.string().nullable(),
  })
  .strict();

const documentSchema = z.object({
  url: z.string(),
  name: z.string(),
  path: z.string(),
  hostId: z.string().nullable(),
  expiresAtMs: z.number(),
  /**
   * "stream" is this plugin's own route (ranged, no size ceiling); "preview"
   * is bb's file-preview transport, which reaches other hosts but caps at
   * 25 MB.
   */
  transport: z.enum(["stream", "preview"]),
  sizeBytes: z.number().nullable(),
});

const recentSchema = z.object({
  path: z.string(),
  name: z.string(),
  hostId: z.string().nullable(),
  openedAtMs: z.number(),
});

export const rpcContract = defineRpcContract({
  hosts: {
    input: z.null(),
    output: z.object({
      hosts: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          status: z.enum(["connected", "disconnected"]),
        }),
      ),
    }),
  },
  browse: {
    input: z
      .object({
        hostId: z.string().nullable().optional(),
        path: z.string().nullable().optional(),
      })
      .strict(),
    output: z.object({
      hostId: z.string(),
      directory: z.string(),
      parent: z.string().nullable(),
      entries: z.array(
        z.object({
          name: z.string(),
          path: z.string(),
          kind: z.enum(["directory", "file"]),
        }),
      ),
    }),
  },
  // Used by the nav panel: an absolute path on a known host.
  documentUrl: {
    input: z
      .object({
        path: z.string().min(1),
        hostId: z.string().nullable().optional(),
      })
      .strict(),
    output: documentSchema,
  },
  // Used by the file opener: a path whose meaning depends on its source.
  openedDocumentUrl: {
    input: z
      .object({ path: z.string().min(1), source: fileOpenerSourceSchema })
      .strict(),
    output: documentSchema,
  },
  recents: {
    input: z.null(),
    output: z.object({ recents: z.array(recentSchema) }),
  },
  forgetRecents: {
    input: z.null(),
    output: z.object({ recents: z.array(recentSchema) }),
  },
});

export default async function plugin(bb: BbPluginApi) {
  const registry = new DocumentRegistry({ ttlMs: PREVIEW_TTL_MS });
  bb.onDispose(() => registry.clear());

  bb.http.route(
    "GET",
    DOCUMENT_ROUTE,
    (context) => handleDocumentRequest(context, registry),
  );

  const settings = bb.settings.define({
    rememberRecents: {
      type: "boolean",
      label: "Remember recently opened documents",
      default: true,
    },
  });

  /** The host the nav panel browses when the user has not picked one. */
  async function defaultHostId(): Promise<string> {
    const hosts = await bb.sdk.hosts.list();
    const connected = hosts.find((host) => host.status === "connected");
    const host = connected ?? hosts[0];
    if (!host) throw new Error("No host is available to browse.");
    return host.id;
  }

  /**
   * The id of the host the server itself runs on, read once from its data
   * directory. Only a document on that host can be streamed from local disk.
   */
  let localHostIdPromise: Promise<string | null> | null = null;
  function localHostId(): Promise<string | null> {
    localHostIdPromise ??= (async () => {
      try {
        const config = await bb.sdk.system.config();
        const raw = await readFile(path.join(config.dataDir, "host-id"), "utf8");
        return raw.trim() || null;
      } catch (cause: unknown) {
        bb.log.warn(`could not resolve the local host id: ${String(cause)}`);
        return null;
      }
    })();
    return localHostIdPromise;
  }

  /** Mints a URL for one file: local disk when possible, bb preview otherwise. */
  async function mintUrl(
    absolutePath: string,
    hostId: string | undefined,
  ): Promise<z.infer<typeof documentSchema>> {
    if (!isPdfPath(absolutePath)) {
      throw new Error(`Not a PDF file: ${absolutePath}`);
    }
    const name = baseName(absolutePath);

    // Streaming from local disk lets the browser fetch page ranges and has no
    // size ceiling, so it carries the documents preview cannot.
    const isLocal = !hostId || hostId === (await localHostId());
    if (isLocal) {
      const stats = await stat(absolutePath).catch(() => null);
      if (stats?.isFile() && stats.size > PREVIEW_MAX_BYTES) {
        const { id, expiresAtMs } = registry.register({
          path: absolutePath,
          name,
          sizeBytes: stats.size,
        });
        return {
          url: `/api/v1/plugins/${bb.pluginId}/http${DOCUMENT_ROUTE}?id=${id}`,
          name,
          path: absolutePath,
          hostId: hostId ?? null,
          expiresAtMs,
          transport: "stream",
          sizeBytes: stats.size,
        };
      }
    }

    const preview = await bb.sdk.files.createPreview({
      ...(hostId ? { hostId } : {}),
      rootPath: directoryName(absolutePath),
      ttlMs: PREVIEW_TTL_MS,
    });
    return {
      url: previewUrlFor(preview.baseUrl, name),
      name,
      path: absolutePath,
      hostId: hostId ?? null,
      expiresAtMs: preview.expiresAtMs,
      transport: "preview",
      sizeBytes: null,
    };
  }

  async function readRecents(): Promise<z.infer<typeof recentSchema>[]> {
    return (
      (await bb.storage.kv.get<z.infer<typeof recentSchema>[]>(RECENTS_KEY)) ??
      []
    );
  }

  async function rememberDocument(document: {
    path: string;
    name: string;
    hostId: string | null;
  }): Promise<void> {
    const { rememberRecents } = await settings.get();
    if (!rememberRecents) return;
    const previous = await readRecents();
    const next = [
      { ...document, openedAtMs: Date.now() },
      ...previous.filter(
        (entry) =>
          entry.path !== document.path || entry.hostId !== document.hostId,
      ),
    ].slice(0, RECENTS_LIMIT);
    await bb.storage.kv.set(RECENTS_KEY, next);
  }

  /**
   * Resolves a file-opener path to an absolute path plus the host it lives on.
   * Workspace paths are worktree-relative, thread-storage paths are relative to
   * the thread's storage root, and host paths are already absolute.
   */
  async function resolveOpenedPath(
    path: string,
    source: z.infer<typeof fileOpenerSourceSchema>,
  ): Promise<{ absolutePath: string; hostId: string | undefined }> {
    if (source.kind === "workspace") {
      if (!source.environmentId) {
        throw new Error("This workspace file has no environment.");
      }
      const environment = await bb.sdk.environments.get({
        environmentId: source.environmentId,
      });
      if (!environment.path) {
        throw new Error("This environment has no checkout on disk yet.");
      }
      return {
        absolutePath: joinPath(environment.path, path),
        hostId: environment.hostId,
      };
    }

    if (source.kind === "thread-storage") {
      if (!source.threadId) {
        throw new Error("This stored file has no thread.");
      }
      // Only the storage root matters here, so ask for no entries at all.
      const storage = await bb.sdk.threads.storagePaths({
        threadId: source.threadId,
        includeFiles: "false",
        includeDirectories: "false",
      });
      return {
        absolutePath: joinPath(storage.storageRootPath, path),
        hostId: undefined,
      };
    }

    // A host path is absolute already; the environment only names its host.
    if (!source.environmentId) return { absolutePath: path, hostId: undefined };
    const environment = await bb.sdk.environments.get({
      environmentId: source.environmentId,
    });
    return { absolutePath: path, hostId: environment.hostId };
  }

  bb.rpc.register(rpcContract, {
    async hosts() {
      const hosts = await bb.sdk.hosts.list();
      return {
        hosts: hosts.map((host) => ({
          id: host.id,
          name: host.name,
          status: host.status,
        })),
      };
    },

    async browse({ hostId, path }) {
      const targetHost = hostId ?? (await defaultHostId());
      const listing = await bb.sdk.hosts.directory({
        hostId: targetHost,
        ...(path ? { path } : {}),
      });
      return {
        hostId: targetHost,
        directory: listing.directory,
        parent: listing.parent,
        entries: listing.entries
          .filter(
            (entry) => entry.kind === "directory" || isPdfPath(entry.name),
          )
          .sort((left, right) => {
            if (left.kind !== right.kind) {
              return left.kind === "directory" ? -1 : 1;
            }
            return left.name.localeCompare(right.name);
          }),
      };
    },

    async documentUrl({ path, hostId }) {
      const targetHost = hostId ?? (await defaultHostId());
      const document = await mintUrl(path, targetHost);
      await rememberDocument({
        path: document.path,
        name: document.name,
        hostId: document.hostId,
      });
      return document;
    },

    async openedDocumentUrl({ path, source }) {
      const { absolutePath, hostId } = await resolveOpenedPath(path, source);
      return await mintUrl(absolutePath, hostId);
    },

    async recents() {
      return { recents: await readRecents() };
    },

    async forgetRecents() {
      await bb.storage.kv.set(RECENTS_KEY, []);
      return { recents: [] };
    },
  });

  bb.log.info("pdf-viewer ready");
}
