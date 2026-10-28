// Where a document lives and how to read it. Files on the bb server's own
// machine are read from disk; files on other machines go through bb.sdk.files
// and, for rendering, are copied into the plugin's cache.
import { readFile, stat } from "node:fs/promises";
import { homedir } from "node:os";
import path from "node:path";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import type { z } from "zod";
import type { openerSourceSchema } from "./contract.js";
import type { DocRow } from "./store.js";
import { fileVersion } from "./file-version.js";
import { hostContract, hostSignals } from "./host-contract.js";
import type { PageShot } from "./snapshot.js";

export type OpenerSource = z.infer<typeof openerSourceSchema>;

/** Markdown bigger than this is refused: the panel renders it in one pass. */
export const MARKDOWN_MAX_BYTES = 4 * 1024 * 1024;

export function joinPath(root: string, relative: string): string {
  const normalized = path.posix.normalize(relative.replace(/^\/+/, ""));
  if (normalized.startsWith("..")) {
    throw new Error("The path leaves its workspace.");
  }
  return path.posix.join(root, normalized);
}

export class DocFiles {
  private localHostIdPromise: Promise<string | null> | null = null;
  private readonly versions = new Map<string, string | null>();
  private readonly versionRequests = new Map<string, Promise<string | null>>();
  private revision = 0;
  private versionClient: import("@get-bb/plugin-sdk").ExperimentalHostClient<typeof hostContract, typeof hostSignals> | null = null;

  private remoteVersions() {
    if (this.versionClient) return this.versionClient;
    const client = this.bb.hosts.experimental_client({ contract: hostContract, experimental_signals: hostSignals });
    const invalidate = () => { this.revision++; this.versions.clear(); };
    const subscriptions = [
      client.experimental_onSignal("changed", ({ hostId, payload }) => {
        this.revision++;
        this.versions.delete(JSON.stringify([hostId, payload.path]));
      }),
      client.experimental_onWorkerExit(invalidate),
      this.bb.sdk.subscribe({ event: "host:changed", callback: invalidate }),
      this.bb.sdk.subscribe({ event: "realtime:connection", callback: invalidate }),
    ];
    this.bb.onDispose(() => { subscriptions.forEach((stop) => stop()); invalidate(); });
    this.versionClient = client;
    return client;
  }


  constructor(
    private readonly bb: BbPluginApi,
    private readonly cacheRoot: string,
  ) {}

  /** The enrolled host id of the machine the bb server runs on. */
  localHostId(): Promise<string | null> {
    this.localHostIdPromise ??= this.bb.sdk.system.config().then(
      (config) => config.primaryHostId ?? null,
      () => null,
    );
    return this.localHostIdPromise;
  }

  /** Normalizes a host id: the server's own machine is stored as null. */
  async canonicalHost(hostId: string | null | undefined): Promise<string | null> {
    if (!hostId) return null;
    return hostId === (await this.localHostId()) ? null : hostId;
  }

  /**
   * Resolves a file-opener path to an absolute path and its host.
   * Workspace paths are worktree-relative, thread-storage paths are relative
   * to the thread's storage root, and host paths are already absolute.
   */
  async resolve(
    rawPath: string,
    source: OpenerSource,
  ): Promise<{ absPath: string; hostId: string | null }> {
    if (source.kind === "workspace") {
      if (source.environmentId) {
        const environment = await this.bb.sdk.environments.get({
          environmentId: source.environmentId,
        });
        if (!environment.path) throw new Error("This environment has no checkout on disk yet.");
        return {
          absPath: joinPath(environment.path, rawPath),
          hostId: await this.canonicalHost(environment.hostId),
        };
      }
      // A project's own checkout, opened outside any thread.
      if (source.projectId) {
        const project = await this.bb.sdk.projects.get({ projectId: source.projectId });
        const checkout =
          project.sources.find((candidate) => candidate.hostId === source.experimental_hostId) ??
          project.sources.find((candidate) => candidate.isDefault) ??
          project.sources[0];
        if (!checkout) throw new Error("This project has no checkout on any host.");
        return {
          absPath: joinPath(checkout.path, rawPath),
          hostId: await this.canonicalHost(checkout.hostId),
        };
      }
      throw new Error("This workspace file has no environment.");
    }
    if (source.kind === "thread-storage") {
      if (!source.threadId) throw new Error("This stored file has no thread.");
      // storageLocation names the root and its host without listing entries
      // (storagePaths refuses a request that asks for no entries).
      const storage = await this.bb.sdk.threads.storageLocation({ threadId: source.threadId });
      return {
        absPath: joinPath(storage.storageRootPath, rawPath),
        hostId: await this.canonicalHost(storage.hostId),
      };
    }
    // "~/…" is a convenience for paths typed on the Doc Review page.
    if (rawPath === "~" || rawPath.startsWith("~/")) rawPath = path.posix.join(homedir(), rawPath.slice(1));
    const windowsPath = path.win32.isAbsolute(rawPath) && !path.posix.isAbsolute(rawPath);
    if (!windowsPath && !path.posix.isAbsolute(rawPath)) throw new Error("Expected an absolute path.");
    let hostId: string | null = source.experimental_hostId ?? null;
    if (!hostId && source.environmentId) {
      const environment = await this.bb.sdk.environments.get({
        environmentId: source.environmentId,
      });
      hostId = environment.hostId;
    }
    return {
      absPath: windowsPath ? path.win32.normalize(rawPath).replace(/\\/g, "/") : path.posix.normalize(rawPath),
      hostId: await this.canonicalHost(hostId),
    };
  }

  /** Metadata only, on the machine that owns the file. */
  async version(doc: DocRow): Promise<string | null> {
    if (doc.hostId === null) return fileVersion(doc.absPath);
    const host = await this.bb.sdk.hosts.get({ hostId: doc.hostId });
    if (host.status !== "connected") {
      this.versions.clear();
      throw new Error("The file's host is not connected.");
    }
    const client = this.remoteVersions();
    const key = JSON.stringify([doc.hostId, doc.absPath]);
    if (this.versions.has(key)) return this.versions.get(key)!;
    let pending = this.versionRequests.get(key);
    if (!pending) {
      const revision = this.revision;
      pending = client.call("fileVersion", { path: doc.absPath }, { hostId: doc.hostId }).then((version) => {
        if (this.revision === revision) {
          if (this.versions.size >= 64) this.versions.delete(this.versions.keys().next().value!);
          this.versions.set(key, version);
        }
        return version;
      }).finally(() => { this.versionRequests.delete(key); });
      this.versionRequests.set(key, pending);
    }
    return pending;
  }

  /** Capture the drawing where the document's local assets and browser live. */
  async drawing(doc: DocRow, shot: PageShot): Promise<Buffer> {
    if (!doc.hostId || !shot.folder) throw new Error("Expected a remote drawing's host and folder.");
    if (!shot.label) throw new Error("Expected a drawing's comment label.");
    const data = await this.remoteVersions().call("drawing", { ...shot, label: shot.label, folder: shot.folder }, { hostId: doc.hostId });
    return Buffer.from(data, "base64");
  }

  /** The file's bytes, from this machine or the host it lives on. */
  async readBytes(doc: DocRow, maxBytes: number): Promise<Buffer> {
    if (doc.hostId === null) {
      const info = await stat(doc.absPath);
      if (info.size > maxBytes) throw new Error("This file is too large to review.");
      return readFile(doc.absPath);
    }
    const file = await this.bb.sdk.files.read({ hostId: doc.hostId, path: doc.absPath });
    if (file.sizeBytes > maxBytes) throw new Error("This file is too large to review.");
    return Buffer.from(file.content, file.contentEncoding === "base64" ? "base64" : "utf8");
  }

  async readText(doc: DocRow): Promise<string> {
    if (doc.hostId === null) {
      const info = await stat(doc.absPath);
      if (info.size > MARKDOWN_MAX_BYTES) throw new Error("This file is too large to review.");
      return readFile(doc.absPath, "utf8");
    }
    const file = await this.bb.sdk.files.read({ hostId: doc.hostId, path: doc.absPath });
    if (file.sizeBytes > MARKDOWN_MAX_BYTES) throw new Error("This file is too large to review.");
    return file.contentEncoding === "base64"
      ? Buffer.from(file.content, "base64").toString("utf8")
      : file.content;
  }

  /**
   * A short-lived URL serving the document's directory, so relative images in
   * Markdown resolve. Null when bb cannot mint one.
   */
  async assetBaseUrl(doc: DocRow): Promise<string | null> {
    try {
      // Name this machine explicitly: bb refuses a preview without a host.
      const hostId = doc.hostId ?? (await this.localHostId());
      const preview = await this.bb.sdk.files.createPreview({
        ...(hostId ? { hostId } : {}),
        rootPath: path.posix.dirname(doc.absPath),
        // bb caps a preview lease at one hour.
        ttlMs: 60 * 60 * 1000,
      });
      return preview.baseUrl;
    } catch (error) {
      this.bb.log.warn(`no preview for ${path.posix.dirname(doc.absPath)}: ${String(error)}`);
      return null;
    }
  }
}
