// @vitest-environment jsdom
//
// `$WORKTREE` start folder — the panel opens the worktree of whatever bb is
// showing.
//
// The rules this holds: the worktree beats the remembered folder; a deep link
// or a requested folder still beats the worktree; the surface's own thread
// and project win over the app-wide context; and "nothing to follow" falls
// back to the ordinary rules instead of failing.
import { cleanup, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginRpcTestHandlers, RenderedSlot } from "@get-bb/plugin-sdk/testing/app";

import type { FileEntry, FileManagerContract } from "../../contract";

const toasts = vi.hoisted(() => ({
  error: [] as string[],
  message: [] as string[],
}));

vi.mock("sonner", () => ({
  toast: {
    error: (text: string) => void toasts.error.push(text),
    success: () => undefined,
    message: (text: string) => void toasts.message.push(text),
    warning: () => undefined,
    info: () => undefined,
  },
}));

const app = await loadPluginApp(() => import("../../app"));
const { resetUploadManager } = await import("../../hooks/useUploads");
const { resetPanelSnapshot } = await import("../../components/panel-bus");
const { resetLastFolderStore, writeLastFolder } = await import("../../lib/last-folder");

const threadAction = app.threadPanelActions[0]!;
const newThreadAction = app.newThreadPanelActions[0]!;
const ROOT = "/home/coder";
const WORKTREE = `${ROOT}/work/bb-plugins`;
const PROJECT = `${ROOT}/work/repo`;
const REMEMBERED = `${ROOT}/Downloads`;

class TestResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= TestResizeObserver as unknown as typeof ResizeObserver;

function entryFor(name: string, kind: FileEntry["kind"] = "file", parent = ROOT): FileEntry {
  return {
    name,
    path: `${parent}/${name}`,
    kind,
    targetKind: null,
    sizeBytes: 12,
    modifiedAtMs: Date.UTC(2024, 2, 12),
    isHidden: false,
    isSymlink: false,
    escapesRoot: false,
    archiveFormat: null,
  };
}

const PREFERENCES = {
  showHiddenFiles: false,
  confirmOnDelete: true,
  restoreLastFolder: true,
  sortField: "name" as const,
  sortDirection: "asc" as const,
  viewMode: "list" as const,
};

function listing(path: string, entries: readonly FileEntry[]) {
  return {
    path,
    parentPath: path === ROOT ? null : path.slice(0, path.lastIndexOf("/")),
    isRoot: path === ROOT,
    entries: [...entries],
    truncated: false,
    totalEntries: entries.length,
    hiddenCount: 0,
    writable: true,
    volume: null,
  };
}

function baseRpc(
  overrides: Partial<PluginRpcTestHandlers<FileManagerContract>> = {},
): Partial<PluginRpcTestHandlers<FileManagerContract>> {
  const tree: Record<string, ReturnType<typeof listing>> = {
    [ROOT]: listing(ROOT, [entryFor("notes.txt")]),
    [WORKTREE]: listing(WORKTREE, [entryFor("README.md", "file", WORKTREE)]),
    [PROJECT]: listing(PROJECT, [entryFor("package.json", "file", PROJECT)]),
    [REMEMBERED]: listing(REMEMBERED, [entryFor("invoice.pdf", "file", REMEMBERED)]),
  };
  return {
    getState: () => ({
      root: ROOT,
      startFolder: ROOT,
      startFolderFollowsWorkspace: true,
      preferences: PREFERENCES,
      chunkSizeBytes: 8 * 1024 * 1024,
      maxListEntries: 5000,
      archiveSupport: { zip: true, tar: true, sevenZip: false },
      pluginVersion: "0.6.3",
      primaryHostId: "host_test",
    }),
    listDir: (input) => {
      const found = tree[input.path];
      if (found === undefined) throw new Error(`not_found: ${input.path}`);
      return found;
    },
    threadWorkspace: () => ({ path: WORKTREE, insideRoot: true, reason: null }),
    workspaceFolder: (input) =>
      input.threadId !== null
        ? { path: WORKTREE, source: "worktree" as const }
        : input.projectId !== null
          ? { path: PROJECT, source: "project" as const }
          : { path: null, source: null },
    ...overrides,
  };
}

function mountTab(
  handlers: Partial<PluginRpcTestHandlers<FileManagerContract>> = baseRpc(),
): RenderedSlot {
  return renderSlot(
    { component: threadAction.component },
    { threadId: "thr_1", params: null },
    { rpc: handlers as PluginRpcTestHandlers<FileManagerContract> },
  ) as RenderedSlot;
}

function followCalls(slot: RenderedSlot) {
  return slot.inspection.rpcCalls.filter((call) => call.method === "workspaceFolder");
}

function currentPath(slot: RenderedSlot): string | null {
  return slot.getByTestId("fm-panel").getAttribute("data-current-path");
}

beforeEach(() => {
  toasts.error.length = 0;
  toasts.message.length = 0;
  resetUploadManager();
  resetPanelSnapshot();
  window.localStorage.clear();
  resetLastFolderStore();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

/* ------------------------------------------------------------------ */

describe("$WORKTREE start folder", () => {
  it("opens the thread's worktree, ahead of the remembered folder", async () => {
    writeLastFolder({ path: REMEMBERED, root: ROOT });
    const slot = mountTab();

    expect(await slot.findByText("README.md")).toBeDefined();
    expect(currentPath(slot)).toBe(WORKTREE);
    expect(followCalls(slot)).toEqual([
      { method: "workspaceFolder", input: { threadId: "thr_1", projectId: null } },
    ]);
  });

  it("opens the selected project's folder on the New thread launcher", async () => {
    const slot = renderSlot(
      { component: newThreadAction.component },
      { projectId: "prj_1", params: null },
      { rpc: baseRpc() as PluginRpcTestHandlers<FileManagerContract> },
    ) as RenderedSlot;

    expect(await slot.findByText("package.json")).toBeDefined();
    expect(currentPath(slot)).toBe(PROJECT);
  });

  it("follows the thread bb is showing when the surface names none", async () => {
    const navPanel = app.navPanels[0]!;
    const slot = renderSlot(
      { component: navPanel.component },
      { subPath: "" },
      {
        rpc: baseRpc() as PluginRpcTestHandlers<FileManagerContract>,
        context: { threadId: "thr_app", projectId: null },
      },
    ) as RenderedSlot;

    await waitFor(() => {
      expect(followCalls(slot)).toEqual([
        { method: "workspaceFolder", input: { threadId: "thr_app", projectId: null } },
      ]);
    });
  });

  it("falls back to the remembered folder when there is nothing to follow", async () => {
    writeLastFolder({ path: REMEMBERED, root: ROOT });
    const slot = mountTab(baseRpc({ workspaceFolder: () => ({ path: null, source: null }) }));

    expect(await slot.findByText("invoice.pdf")).toBeDefined();
    expect(currentPath(slot)).toBe(REMEMBERED);
  });

  it("falls back to the ordinary rules when the lookup fails", async () => {
    const slot = mountTab(
      baseRpc({
        workspaceFolder: () => {
          throw new Error("bb is down");
        },
      }),
    );

    expect(await slot.findByText("notes.txt")).toBeDefined();
    expect(currentPath(slot)).toBe(ROOT);
  });

  it("does not look anything up when the setting is an ordinary folder", async () => {
    const base = baseRpc();
    const slot = mountTab({
      ...base,
      getState: (input) => ({
        ...(base.getState as (i: null) => Record<string, unknown>)(input),
        startFolderFollowsWorkspace: false,
      }) as never,
    });

    expect(await slot.findByText("notes.txt")).toBeDefined();
    expect(followCalls(slot)).toEqual([]);
  });

  it("asks nothing when the surface has no thread or project at all", async () => {
    const navPanel = app.navPanels[0]!;
    const slot = renderSlot(
      { component: navPanel.component },
      { subPath: "" },
      { rpc: baseRpc() as PluginRpcTestHandlers<FileManagerContract> },
    ) as RenderedSlot;

    expect(await slot.findByText("notes.txt")).toBeDefined();
    expect(followCalls(slot)).toEqual([]);
  });
});
