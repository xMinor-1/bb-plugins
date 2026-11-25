import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { describe, expect, it, vi } from "vitest";

import { MAX_LIST_ENTRIES, PREVIEW_TTL_MS } from "../../contract";
import { createRemoteHandlers } from "../../src/remote";

type Directory = Awaited<ReturnType<BbPluginApi["sdk"]["hosts"]["directory"]>>;
type PermissionMode = Awaited<ReturnType<BbPluginApi["sdk"]["hosts"]["list"]>>[number]["maxPermissionMode"];

function listing(directory: string, entries: Directory["entries"] = []): Directory {
  return { directory, entries, parent: null, roots: [] };
}

function fixture(home = "/home/dev", maxPermissionMode?: PermissionMode) {
  const list = vi.fn(async () => [
    { id: "local", name: "Local", type: "persistent", status: "connected", lifecycle: { phase: "active" } },
    { id: "remote", name: "Remote", type: "persistent", status: "connected", lifecycle: { phase: "active" }, maxPermissionMode },
    { id: "offline", name: "Offline", type: "persistent", status: "disconnected", lifecycle: { phase: "active" } },
    { id: "temporary", name: "Temp", type: "ephemeral", status: "connected", lifecycle: { phase: "active" } },
    { id: "suspended", name: "Suspended", type: "ephemeral", status: "connected", lifecycle: { phase: "suspended" } },
  ]);
  const directory = vi.fn(async ({ path }: { hostId: string; path?: string }) =>
    listing(path ?? home),
  );
  const createPreview = vi.fn(async () => ({ baseUrl: "/api/preview/lease/", expiresAtMs: 1234 }));
  const bb = { sdk: { hosts: { list, directory }, files: { createPreview } } } as unknown as BbPluginApi;
  return {
    handlers: createRemoteHandlers(bb, async () => "local"),
    directory,
    createPreview,
  };
}

describe("remote File Manager", () => {
  it("offers all active connected hosts without duplicating the local machine", async () => {
    const { handlers } = fixture();
    await expect(handlers.remoteMachines(null)).resolves.toEqual({
      machines: [{ id: "remote", label: "Remote" }, { id: "temporary", label: "Temp" }],
    });
  });

  it("preserves local-only operation on a runtime without the remote SDK methods", async () => {
    const bb = { sdk: {} } as BbPluginApi;
    const handlers = createRemoteHandlers(bb, async () => "local");
    await expect(handlers.remoteMachines(null)).resolves.toEqual({ machines: [] });
  });

  it("resolves the remote home, reports only direct children and caps the listing", async () => {
    const { handlers, directory } = fixture();
    const directoryEntry = { name: "clips", path: "/home/dev/clips", kind: "directory" } as const;
    directory.mockResolvedValueOnce(listing("/home/dev", [
      directoryEntry,
      { name: "another/folder", path: "/home/dev/another/folder", kind: "directory" },
      ...Array.from({ length: MAX_LIST_ENTRIES }, (_, index) =>
        ({ name: `log-${index}`, path: `/home/dev/log-${index}`, kind: "file" as const }),
      ),
    ]));
    const result = await handlers.remoteDirectory({ hostId: "remote" });
    expect(result).toMatchObject({ path: "/home/dev", rootPath: "/home/dev", parentPath: null, truncated: true });
    expect(result.entries[0]).toEqual(directoryEntry);
    expect(result.entries).toHaveLength(MAX_LIST_ENTRIES - 1);
    expect(result.entries.some(({ name }) => name === "another/folder")).toBe(false);
    expect(directory.mock.calls).toEqual([[{ hostId: "remote" }]]);
  });

  it("does not ask local, unknown or offline machines for a directory or grant", async () => {
    const { handlers, directory, createPreview } = fixture();
    for (const hostId of ["local", "unknown", "offline", "suspended"]) {
      await expect(handlers.remoteDirectory({ hostId })).rejects.toMatchObject({ code: "unsupported" });
      await expect(handlers.remotePreview({ hostId, path: "/home/dev" })).rejects.toMatchObject({ code: "unsupported" });
    }
    expect(directory).not.toHaveBeenCalled();
    expect(createPreview).not.toHaveBeenCalled();
  });

  it("checks a requested path against home before asking the daemon to list it", async () => {
    const { handlers, directory } = fixture();
    await expect(handlers.remoteDirectory({ hostId: "remote", path: "/home/dev-other" }))
      .rejects.toMatchObject({ code: "path_escape" });
    expect(directory.mock.calls).toEqual([[{ hostId: "remote" }]]);
  });

  it("starts a full-access host in home and can ascend to its filesystem root", async () => {
    const { handlers, directory } = fixture("/home/dev", "full");
    await expect(handlers.remoteDirectory({ hostId: "remote" })).resolves.toMatchObject({
      path: "/home/dev", rootPath: "/", parentPath: "/home",
    });
    await expect(handlers.remoteDirectory({ hostId: "remote", path: "/home" })).resolves.toMatchObject({
      path: "/home", rootPath: "/", parentPath: "/",
    });
    await expect(handlers.remoteDirectory({ hostId: "remote", path: "/" })).resolves.toMatchObject({
      path: "/", rootPath: "/", parentPath: null,
    });
    expect(directory.mock.calls).toContainEqual([{ hostId: "remote", path: "/home" }]);
  });

  it("scopes a full-access preview outside home to the selected folder", async () => {
    const { handlers, createPreview } = fixture("/home/dev", "full");
    await expect(handlers.remotePreview({ hostId: "remote", path: "/home" })).resolves.toMatchObject({
      path: "/home", baseUrl: "/api/preview/lease/",
    });
    expect(createPreview).toHaveBeenCalledExactlyOnceWith({
      hostId: "remote", rootPath: "/home", ttlMs: PREVIEW_TTL_MS,
    });
  });

  it("stops a full-access Windows host at its home volume root", async () => {
    const { handlers } = fixture(String.raw`D:\Users\Dev`, "full");
    await expect(handlers.remoteDirectory({ hostId: "remote", path: "D:\\" })).resolves.toMatchObject({
      path: "D:\\", rootPath: "D:\\", parentPath: null,
    });
    await expect(handlers.remoteDirectory({ hostId: "remote", path: "C:\\" }))
      .rejects.toMatchObject({ code: "path_escape" });
  });

  it("keeps a restricted host in its home and refuses an outside preview", async () => {
    const { handlers, directory, createPreview } = fixture("/home/dev", "auto");
    await expect(handlers.remoteDirectory({ hostId: "remote" })).resolves.toMatchObject({
      path: "/home/dev", rootPath: "/home/dev", parentPath: null,
    });
    await expect(handlers.remotePreview({ hostId: "remote", path: "/home" }))
      .rejects.toMatchObject({ code: "path_escape" });
    expect(directory.mock.calls).toEqual([[{ hostId: "remote" }], [{ hostId: "remote" }]]);
    expect(createPreview).not.toHaveBeenCalled();
  });

  it("returns neither entries nor a lease if the resolved directory leaves home", async () => {
    const { handlers, directory, createPreview } = fixture();
    directory.mockImplementation(async ({ path }) => listing(path ? "/srv/shared" : "/home/dev"));
    const input = { hostId: "remote", path: "/home/dev/shared" };
    await expect(handlers.remoteDirectory(input)).rejects.toMatchObject({ code: "path_escape" });
    await expect(handlers.remotePreview(input)).rejects.toMatchObject({ code: "path_escape" });
    expect(createPreview).not.toHaveBeenCalled();
  });

  it("preserves Windows directory paths while using an encoded POSIX-shaped preview URL", async () => {
    const home = String.raw`D:\Projects\Dev`;
    const folder = String.raw`D:\Projects\Dev\Recordings #1\Old %`;
    const { handlers, directory, createPreview } = fixture(home);
    directory.mockImplementation(async ({ path }) => listing(path ? folder : home));
    const input = { hostId: "remote", path: folder.toLowerCase() };
    await expect(handlers.remoteDirectory(input)).resolves.toMatchObject({
      path: folder,
      parentPath: String.raw`D:\Projects\Dev\Recordings #1`,
    });
    await expect(handlers.remotePreview(input)).resolves.toEqual({
      path: folder,
      baseUrl: "/api/preview/lease/Recordings%20%231/Old%20%25",
      expiresAtMs: 1234,
    });
    expect(createPreview).toHaveBeenCalledExactlyOnceWith({
      hostId: "remote",
      rootPath: home,
      ttlMs: PREVIEW_TTL_MS,
    });
  });

  it("rejects a differently cased canonical sibling on Windows", async () => {
    const { handlers, directory } = fixture(String.raw`C:\Users\Dev`);
    directory.mockResolvedValueOnce(listing(String.raw`C:\Users\Dev`));
    directory.mockResolvedValueOnce(listing(String.raw`C:\Users\DEV\Clips`));
    await expect(handlers.remoteDirectory({ hostId: "remote", path: String.raw`C:\Users\Dev\Clips` }))
      .rejects.toMatchObject({ code: "path_escape" });
  });
});
