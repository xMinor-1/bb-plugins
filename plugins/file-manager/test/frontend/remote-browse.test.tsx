// @vitest-environment jsdom
import { act, cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";

import type { FileManagerContract, RemoteDirectory } from "../../contract";

const saveFile = vi.hoisted(() => vi.fn<(request: { fileName: string; url: string }) => Promise<"started" | "failed">>());
vi.mock("@get-bb/plugin-sdk/app", async (importOriginal) => ({
  ...(await importOriginal<typeof import("@get-bb/plugin-sdk/app")>()),
  experimental_saveFile: saveFile,
}));

const app = await loadPluginApp(() => import("../../app"));
const ROOT = "/home/viewer";
const SUBFOLDER = `${ROOT}/samples`;
const HOST_A = { id: "host_a", label: "First machine" };
const HOST_B = { id: "host_b", label: "Second machine" };
const LEASE_TTL = 10 * 60_000;

class TestResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= TestResizeObserver as unknown as typeof ResizeObserver;

function directory(path: string, entries: RemoteDirectory["entries"]): RemoteDirectory {
  return { path, rootPath: ROOT, parentPath: path === ROOT ? null : ROOT, entries, truncated: false };
}

function mount(overrides: Partial<PluginRpcTestHandlers<FileManagerContract>> = {}, subPath = "") {
  saveFile.mockResolvedValue("started");
  const handlers: Partial<PluginRpcTestHandlers<FileManagerContract>> = {
    getState: () => ({
      root: ROOT,
      startFolder: ROOT,
      preferences: {
        showHiddenFiles: false, confirmOnDelete: true, restoreLastFolder: false,
        openThreadWorkspace: false, sortField: "name", sortDirection: "asc", viewMode: "list",
      },
      chunkSizeBytes: 8192,
      maxListEntries: 5000,
      archiveSupport: { zip: true, tar: true, sevenZip: false, rar: false },
      pluginVersion: "0.11.3",
      primaryHostId: "host_local",
    }),
    listDir: ({ path }) => ({ path, parentPath: null, isRoot: true, entries: [], truncated: false,
      totalEntries: 0, hiddenCount: 0, writable: true, volume: null }),
    remoteMachines: () => ({ machines: [HOST_A, HOST_B] }),
    remotePreview: ({ hostId, path }) => ({ baseUrl: `/preview/${hostId}`, path, expiresAtMs: Date.now() + LEASE_TTL }),
    ...overrides,
  };
  return renderSlot({ component: app.navPanels[0]!.component }, { subPath }, {
    rpc: handlers as PluginRpcTestHandlers<FileManagerContract>,
  });
}

afterEach(() => {
  cleanup();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  saveFile.mockReset();
  window.localStorage.clear();
});

describe("connected-machine browsing", () => {
  it("opens the parent of remote home and stops at the machine root", async () => {
    const remoteDirectory = vi.fn(({ path = ROOT }: { hostId: string; path?: string }) => ({
      path, rootPath: "/", parentPath: path === "/" ? null : path === "/home" ? "/" : "/home",
      entries: [], truncated: false,
    }));
    const slot = mount({ remoteDirectory });
    fireEvent.click(await slot.findByRole("tab", { name: HOST_A.label }));
    await slot.findByRole("button", { name: "viewer" });
    const up = slot.getByRole("button", { name: "Parent folder" });
    expect(up).toHaveProperty("disabled", false);
    fireEvent.click(up);
    await slot.findByRole("button", { name: "home" });
    await waitFor(() => expect(up).toHaveProperty("disabled", false));
    expect(remoteDirectory).toHaveBeenLastCalledWith({ hostId: HOST_A.id, path: "/home" });
    fireEvent.click(up);
    await slot.findByText("This folder is empty.");
    expect(up).toHaveProperty("disabled", true);
    fireEvent.click(slot.getByRole("button", { name: "Home folder" }));
    await slot.findByRole("button", { name: "viewer" });
    expect(remoteDirectory).toHaveBeenLastCalledWith({ hostId: HOST_A.id });
  });

  it("drops late results, keeps folders per machine, and targets remote preview URLs", async () => {
    let issuedLeases = 0;
    const remotePreview = vi.fn(({ hostId, path }: { hostId: string; path: string }) => ({
      baseUrl: `/preview/${hostId}/${++issuedLeases}`,
      path,
      expiresAtMs: Date.now() + LEASE_TTL,
    }));
    let finishFirst: (listing: RemoteDirectory) => void = () => undefined;
    const firstListing = new Promise<RemoteDirectory>((resolve) => { finishFirst = resolve; });
    const remoteDirectory = vi.fn(({ hostId, path }: { hostId: string; path?: string }) => {
      if (hostId === HOST_A.id) return firstListing;
      if (path === SUBFOLDER) return directory(SUBFOLDER, [{ name: "clip.mp4", path: `${SUBFOLDER}/clip.mp4`, kind: "file" }]);
      return directory(ROOT, [{ name: "samples", path: SUBFOLDER, kind: "directory" }]);
    });
    const slot = mount({ remoteDirectory, remotePreview });
    const firstMachine = await slot.findByRole("tab", { name: HOST_A.label });
    const secondMachine = slot.getByRole("tab", { name: HOST_B.label });
    fireEvent.click(firstMachine);
    await waitFor(() => expect(remoteDirectory).toHaveBeenCalledWith({ hostId: HOST_A.id }));
    fireEvent.click(secondMachine);
    fireEvent.click(await slot.findByRole("button", { name: "samples" }));
    const videoRow = await slot.findByRole("button", { name: "clip.mp4" });

    await act(async () => finishFirst(directory(ROOT, [{ name: "stale.txt", path: `${ROOT}/stale.txt`, kind: "file" }])));
    expect(slot.queryByText("stale.txt")).toBeNull();
    fireEvent.click(videoRow);
    await waitFor(() => expect(slot.getByTestId("fm-viewer-video").getAttribute("src")).toBe("/preview/host_b/1/clip.mp4"));
    fireEvent.click(slot.getByRole("button", { name: "Download" }));
    await waitFor(() => expect(saveFile).toHaveBeenCalledExactlyOnceWith({
      url: new URL("/preview/host_b/2/clip.mp4", window.location.href).href,
      fileName: "clip.mp4",
    }));
    expect(remotePreview.mock.calls).toEqual([
      [{ hostId: HOST_B.id, path: SUBFOLDER }],
      [{ hostId: HOST_B.id, path: SUBFOLDER }],
    ]);
    expect(slot.inspection.rpcCalls.some(({ method }) => method === "createPreviewUrl" || method === "readTextFile")).toBe(false);

    fireEvent.click(firstMachine);
    await slot.findByText("stale.txt");
    fireEvent.click(secondMachine);
    await slot.findByRole("button", { name: "clip.mp4" });
    expect(remoteDirectory).toHaveBeenLastCalledWith({ hostId: HOST_B.id, path: SUBFOLDER });
  });

  it.each(["list", "gallery"])("downloads remote files from the %s context menu", async (view) => {
    const name = "Отчёт #2%.png";
    const entry = { name, path: `${ROOT}/${name}`, kind: "file" } as const;
    const remotePreview = vi.fn(({ hostId, path }: { hostId: string; path: string }) => ({
      baseUrl: `/preview/${hostId}`,
      path,
      expiresAtMs: Date.now() + LEASE_TTL,
    }));
    const slot = mount({ remoteDirectory: () => directory(ROOT, [entry]), remotePreview });
    fireEvent.click(await slot.findByRole("tab", { name: HOST_B.label }));
    const row = await slot.findByRole("button", { name });
    if (view === "gallery") fireEvent.click(slot.getByRole("button", { name: "Gallery" }));
    fireEvent.contextMenu(view === "gallery" ? await slot.findByTestId("fm-tile") : row, { button: 2 });
    fireEvent.click(await slot.findByRole("menuitem", { name: "Download" }));

    await waitFor(() => expect(saveFile).toHaveBeenCalledExactlyOnceWith({
      url: new URL(`/preview/host_b/${encodeURIComponent(name)}`, window.location.href).href,
      fileName: name,
    }));
    expect(remotePreview).toHaveBeenLastCalledWith({ hostId: HOST_B.id, path: ROOT });
    expect(slot.queryByTestId("fm-viewer")).toBeNull();
  });

  it("keeps the remote folder open when a download cannot start", async () => {
    const entry = { name: "report.pdf", path: `${ROOT}/report.pdf`, kind: "file" } as const;
    const remotePreview = vi.fn()
      .mockRejectedValueOnce(new Error("unsupported: This machine is unavailable"))
      .mockResolvedValueOnce({ baseUrl: "https://not-bb.invalid/preview", path: ROOT, expiresAtMs: Date.now() + LEASE_TTL })
      .mockResolvedValueOnce({ baseUrl: "/preview/different-folder", path: SUBFOLDER, expiresAtMs: Date.now() + LEASE_TTL })
      .mockResolvedValueOnce({ baseUrl: "/preview/valid-folder", path: ROOT, expiresAtMs: Date.now() + LEASE_TTL });
    const slot = mount({ remoteDirectory: () => directory(ROOT, [entry]), remotePreview });
    saveFile.mockResolvedValueOnce("failed");
    fireEvent.click(await slot.findByRole("tab", { name: HOST_B.label }));
    const download = async (): Promise<void> => {
      fireEvent.contextMenu(await slot.findByRole("button", { name: entry.name }), { button: 2 });
      fireEvent.click(await slot.findByRole("menuitem", { name: "Download" }));
    };
    for (let request = 1; request <= 3; request += 1) {
      await download();
      await slot.findByText("Could not start download");
      expect(remotePreview).toHaveBeenCalledTimes(request);
      fireEvent.click(slot.getByRole("button", { name: "Dismiss" }));
    }
    expect(saveFile).not.toHaveBeenCalled();
    await download();
    await slot.findByText("Could not start download");
    expect(saveFile).toHaveBeenCalledExactlyOnceWith({
      fileName: entry.name,
      url: new URL("/preview/valid-folder/report.pdf", window.location.href).href,
    });
    expect(slot.getByRole("button", { name: entry.name })).toBeDefined();
  });

  it("retries a failed remote directory and reads text through its host grant", async () => {
    const note = { name: "sample.txt", path: `${ROOT}/sample.txt`, kind: "file" } as const;
    const list = vi.fn()
      .mockRejectedValueOnce(new Error("unsupported: This machine is unavailable"))
      .mockResolvedValueOnce(directory(ROOT, [note]));
    const fetch = vi.fn(async () => new Response("remote text", {
      status: 206,
      headers: { "Content-Range": "bytes 0-10/11" },
    }));
    vi.stubGlobal("fetch", fetch);
    const slot = mount({ remoteDirectory: list });
    fireEvent.click(await slot.findByRole("tab", { name: HOST_B.label }));
    await slot.findByText("This machine is unavailable.");
    fireEvent.click(slot.getByRole("button", { name: "Retry" }));
    fireEvent.click(await slot.findByRole("button", { name: note.name }));
    await waitFor(() => expect(slot.getByTestId("fm-viewer-text").textContent).toContain("remote text"));
    expect(fetch).toHaveBeenCalledWith("/preview/host_b/sample.txt", expect.objectContaining({
      headers: { Range: "bytes=0-1048575" },
    }));
    expect(slot.inspection.rpcCalls.some(({ method }) => method === "readTextFile")).toBe(false);
  });

  it("retries a preview if the lease resolves to a different folder", async () => {
    const entry = { name: "clip.mp4", path: `${ROOT}/clip.mp4`, kind: "file" } as const;
    const remotePreview = vi.fn()
      .mockResolvedValueOnce({ baseUrl: "/preview/other", path: SUBFOLDER, expiresAtMs: Date.now() + LEASE_TTL })
      .mockResolvedValueOnce({ baseUrl: "/preview/fresh", path: ROOT, expiresAtMs: Date.now() + LEASE_TTL });
    const slot = mount({ remoteDirectory: () => directory(ROOT, [entry]), remotePreview });
    fireEvent.click(await slot.findByRole("tab", { name: HOST_B.label }));
    fireEvent.click(await slot.findByRole("button", { name: entry.name }));
    await slot.findByText("Could not open this preview");
    expect(slot.queryByTestId("fm-viewer-video")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Retry" }));
    expect((await slot.findByTestId("fm-viewer-video")).getAttribute("src")).toBe("/preview/fresh/clip.mp4");
  });

  it("restores the selected machine, its confirmed folder, and gallery after the panel unmounts", async () => {
    const remoteDirectory = vi.fn(({ path = ROOT }: { hostId: string; path?: string }) =>
      directory(path, path === ROOT ? [{ name: "samples", path: SUBFOLDER, kind: "directory" }] : []));
    const slot = mount({ remoteDirectory });
    // The tabs are a single keyboard stop. ArrowRight activates the next machine.
    await slot.findByRole("tablist", { name: "Machine" });
    const local = slot.getByRole("tab", { name: "This machine", selected: true });
    fireEvent.keyDown(local, { key: "ArrowRight" });
    expect(slot.getByRole("tab", { name: HOST_A.label, selected: true })).toBe(document.activeElement);
    fireEvent.click(await slot.findByRole("button", { name: "samples" }));
    await slot.findByText("This folder is empty.");
    fireEvent.click(slot.getByRole("button", { name: "Gallery" }));
    slot.unmount();

    // Discovery can be slow or the selected machine can be temporarily absent.
    const restored = mount({ remoteDirectory, remoteMachines: () => ({ machines: [] }) });
    expect(restored.getByRole("tab", { name: HOST_A.label, selected: true })).toBeDefined();
    await restored.findByText("This folder is empty.");
    expect(restored.getByRole("button", { name: "Gallery" }).getAttribute("aria-pressed")).toBe("true");
    expect(remoteDirectory).toHaveBeenLastCalledWith({ hostId: HOST_A.id, path: SUBFOLDER });
    restored.unmount();

    // A different explicit local deep link still wins over the saved machine.
    const linked = mount({ remoteDirectory }, "local-docs");
    expect(await linked.findByRole("tab", { name: "This machine", selected: true })).toBeDefined();
    expect(linked.queryByTestId("fm-remote-panel")).toBeNull();
  });
});
