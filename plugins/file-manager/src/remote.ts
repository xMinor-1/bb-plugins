import { posix, win32 } from "node:path";
import type { BbPluginApi, PluginRpcHandlers } from "@get-bb/plugin-sdk";

import {
  MAX_LIST_ENTRIES,
  PREVIEW_TTL_MS,
  type FileManagerContract,
} from "../contract";
import { previewUrl } from "../lib/preview";
import { fmError } from "./errors";

type RemoteHandlers = Pick<
  PluginRpcHandlers<FileManagerContract>,
  "remoteMachines" | "remoteDirectory" | "remotePreview"
>;

/** Remote paths use the enrolled host's spelling, independent of the hub OS. */
function pathFlavor(absolutePath: string): typeof posix {
  return /^[a-z]:[\\/]|^\\\\/iu.test(absolutePath) ? win32 : posix;
}

function isInside(root: string, candidate: string): boolean {
  const flavor = pathFlavor(root);
  if (candidate.includes("\0") || pathFlavor(candidate) !== flavor || !flavor.isAbsolute(candidate)) {
    return false;
  }
  const relative = flavor.relative(root, candidate);
  return relative !== ".." && !relative.startsWith(`..${flavor.sep}`) && !flavor.isAbsolute(relative);
}

function isCanonicalInside(root: string, candidate: string): boolean {
  const flavor = pathFlavor(root);
  if (!isInside(root, candidate)) return false;
  const canonicalRoot = flavor.normalize(root);
  const canonicalPath = flavor.normalize(candidate);
  const prefix = canonicalRoot.endsWith(flavor.sep) ? canonicalRoot : canonicalRoot + flavor.sep;
  // Windows can have case-sensitive folders even though win32.relative folds case.
  return canonicalPath === canonicalRoot || canonicalPath.startsWith(prefix);
}

export function createRemoteHandlers(
  bb: BbPluginApi,
  primaryHostId: () => Promise<string | null>,
): RemoteHandlers {
  async function listHosts() {
    const hosts = bb.sdk.hosts;
    if (
      typeof hosts?.list !== "function" ||
      typeof hosts.directory !== "function" ||
      typeof bb.sdk.files?.createPreview !== "function"
    ) {
      return [];
    }
    const localId = await primaryHostId();
    if (localId === null) return [];
    return (await hosts.list()).filter((host) =>
      host.id !== localId &&
      host.status === "connected" &&
      host.lifecycle.phase === "active",
    );
  }

  async function resolveDirectory(hostId: string, requested?: string) {
    const hosts = await listHosts().catch(() => []);
    const host = hosts.find(({ id }) => id === hostId);
    if (host === undefined) {
      throw fmError("unsupported", "This machine is unavailable");
    }
    const home = await bb.sdk.hosts.directory({ hostId });
    const homePath = home.directory;
    const flavor = pathFlavor(homePath);
    if (!flavor.isAbsolute(homePath) || homePath.includes("\0")) {
      throw fmError("invalid_path", "The host did not return an absolute home directory");
    }
    const rootPath = host.maxPermissionMode === "full" ? flavor.parse(homePath).root : homePath;

    if (requested !== undefined && !isInside(rootPath, requested)) {
      throw fmError("path_escape", "The folder is outside this machine's browsing root");
    }
    const target = requested === undefined ? homePath : flavor.normalize(requested);
    const directory = flavor.relative(homePath, target) === ""
      ? home
      : await bb.sdk.hosts.directory({ hostId, path: target });
    if (!isCanonicalInside(rootPath, directory.directory)) {
      throw fmError("path_escape", "The folder is outside this machine's browsing root");
    }

    return { directory, homePath, rootPath, flavor };
  }

  return {
    async remoteMachines() {
      const hosts = await listHosts().catch(() => []);
      return { machines: hosts.map(({ id, name }) => ({ id, label: name })) };
    },

    async remoteDirectory({ hostId, path }) {
      const { directory, rootPath, flavor } = await resolveDirectory(hostId, path);
      const entries = directory.entries.slice(0, MAX_LIST_ENTRIES).flatMap(({ name, kind }) => {
        if (
          !name ||
          name === "." ||
          name === ".." ||
          name.includes("\0") ||
          flavor.basename(name) !== name
        ) {
          return [];
        }
        const entryPath = flavor.join(directory.directory, name);
        return [{ name, path: entryPath, kind }];
      });
      return {
        path: directory.directory,
        rootPath,
        parentPath: flavor.relative(rootPath, directory.directory) === ""
          ? null
          : flavor.dirname(directory.directory),
        entries,
        truncated: directory.entries.length > MAX_LIST_ENTRIES,
      };
    },

    async remotePreview({ hostId, path }) {
      const { directory, homePath, flavor } = await resolveDirectory(hostId, path);
      // Keep the home boundary on streamed reads, and grant only the viewed folder above it.
      const previewRoot = isCanonicalInside(homePath, directory.directory) ? homePath : directory.directory;
      const segments = flavor.relative(previewRoot, directory.directory).split(flavor.sep);
      if (segments.some((segment) => segment.includes("\\"))) {
        throw fmError("unsupported", "This folder's name cannot be used in a preview URL");
      }
      const preview = await bb.sdk.files.createPreview({ hostId, rootPath: previewRoot, ttlMs: PREVIEW_TTL_MS });
      return {
        baseUrl: previewUrl(preview.baseUrl, segments.join("/")),
        path: directory.directory,
        expiresAtMs: preview.expiresAtMs,
      };
    },
  };
}
