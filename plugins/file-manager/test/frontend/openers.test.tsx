// @vitest-environment jsdom
//
// §10.2 — the two file openers behind "Open with …" on a file link.
//
// The registration order is load-bearing: bb picks an opener automatically per
// extension, and it picks the first match. The preview wrapper therefore has
// to be registered first, or a plain click on a .md link would open a folder
// instead of the file.
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginRpcTestHandlers, RenderedSlot } from "@get-bb/plugin-sdk/testing/app";

import type { PluginFileOpenerProps } from "@get-bb/plugin-sdk/app";

import type { FileEntry, FileManagerContract } from "../../contract";

const HOST_ID = "host_test";

const toasts = vi.hoisted(() => ({
  error: [] as string[],
  success: [] as string[],
  message: [] as string[],
}));

vi.mock("sonner", () => ({
  toast: {
    error: (text: string) => void toasts.error.push(text),
    success: (text: string) => void toasts.success.push(text),
    message: (text: string) => void toasts.message.push(text),
    warning: () => undefined,
    info: () => undefined,
  },
}));

const app = await loadPluginApp(() => import("../../app"));
const { resetUploadManager } = await import("../../hooks/useUploads");
const { resetPanelSnapshot } = await import("../../components/panel-bus");
const { resetLastFolderStore } = await import("../../lib/last-folder");

const previewOpener = app.fileOpeners[0]!;
const locationOpener = app.fileOpeners[1]!;
const ROOT = "/home/coder";
const BACKUPS = `${ROOT}/work/backups`;

class TestResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= TestResizeObserver as unknown as typeof ResizeObserver;

const SOURCE = {
  kind: "workspace" as const,
  threadId: "thr_1",
  environmentId: "env_1",
  projectId: "proj_1",
};

function entryFor(name: string, parent = BACKUPS): FileEntry {
  return {
    name,
    path: `${parent}/${name}`,
    kind: "file",
    targetKind: null,
    sizeBytes: 10,
    modifiedAtMs: Date.UTC(2026, 7, 25),
    isHidden: name.startsWith("."),
    isSymlink: false,
    escapesRoot: false,
    archiveFormat: null,
  };
}

const PREFERENCES = {
  showHiddenFiles: false,
  confirmOnDelete: true,
  restoreLastFolder: true,
  openThreadWorkspace: false,
  sortField: "name" as const,
  sortDirection: "asc" as const,
  viewMode: "list" as const,
};

function baseRpc(
  located: Partial<{
    dirPath: string;
    absolutePath: string;
    name: string;
    exists: boolean;
    isDirectory: boolean;
    matchHint: string | null;
  }> = {},
  entries: readonly FileEntry[] = [
    entryFor("2026-08-25-otlozhena-2026-08-25.md"),
    entryFor("readme.md"),
  ],
): Partial<PluginRpcTestHandlers<FileManagerContract>> {
  return {
    getState: () => ({
      root: ROOT,
      startFolder: ROOT,
      preferences: PREFERENCES,
      chunkSizeBytes: 8 * 1024 * 1024,
      maxListEntries: 5000,
      archiveSupport: { zip: true, tar: true, sevenZip: false },
      pluginVersion: "0.6.0",
      primaryHostId: HOST_ID,
    }),
    resolveFileLocation: () => ({
      dirPath: BACKUPS,
      absolutePath: `${BACKUPS}/readme.md`,
      name: "readme.md",
      exists: true,
      isDirectory: false,
      matchHint: null,
      ...located,
    }),
    listDir: (input) => ({
      path: input.path,
      parentPath: input.path === ROOT ? null : input.path.slice(0, input.path.lastIndexOf("/")),
      isRoot: input.path === ROOT,
      entries: [...entries],
      truncated: false,
      totalEntries: entries.length,
      hiddenCount: 0,
      writable: true,
      volume: null,
    }),
    savePreferences: () => ({
      startFolder: ROOT,
      preferences: PREFERENCES,
      chunkSizeBytes: 8 * 1024 * 1024,
    }),
  };
}

function Original() {
  return <div data-testid="bb-preview">bb preview</div>;
}

function mountOpener(
  registration: { component: React.ComponentType<PluginFileOpenerProps> },
  handlers: Partial<PluginRpcTestHandlers<FileManagerContract>>,
  path = "knowledge-base/backups/readme.md",
): RenderedSlot {
  return renderSlot(
    { component: registration.component },
    { path, source: SOURCE, Original },
    { rpc: handlers as PluginRpcTestHandlers<FileManagerContract> },
  ) as RenderedSlot;
}

beforeEach(() => {
  toasts.error.length = 0;
  toasts.success.length = 0;
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

describe("file opener registration (§10.2)", () => {
  it("registers the preview wrapper first, so the automatic pick still previews", () => {
    expect(app.fileOpeners.map((opener) => opener.id)).toEqual(["preview", "location"]);
    expect(previewOpener.title).toBe("Preview + location");
    expect(locationOpener.title).toBe("File location");
  });

  it("claims what a message link actually points at, but leaves pdf to the pdf viewer", () => {
    for (const extension of [
      "md", "txt", "json", "ts", "py", "png", "svg", // text, code, images
      "zip", "tar", "gz", "7z", "deb", "dmg", // archives and packages
      "mp4", "mp3", "docx", "xlsx", "sqlite", "ttf", "exe", // media, office, binaries
    ]) {
      expect(previewOpener.extensions).toContain(extension);
    }
    expect(previewOpener.extensions).not.toContain("pdf");
    // A duplicate is dead weight bb would match twice over.
    expect(new Set(previewOpener.extensions).size).toBe(previewOpener.extensions.length);
    // Both openers must claim the same set, or the context menu would offer
    // the reveal for files the automatic pick never covers.
    expect([...locationOpener.extensions].sort()).toEqual([...previewOpener.extensions].sort());
  });
});

describe("File location opener", () => {
  it("opens the file's folder and selects the file", async () => {
    const slot = mountOpener(locationOpener, baseRpc());

    await slot.findByText("readme.md");
    expect(slot.getByTestId("fm-panel").getAttribute("data-current-path")).toBe(BACKUPS);
    await waitFor(() => {
      const row = slot
        .getAllByTestId("fm-row")
        .find((candidate) => candidate.getAttribute("data-fm-path") === `${BACKUPS}/readme.md`);
      expect(row?.getAttribute("data-selected")).toBe("true");
    });
    expect(toasts.message).toHaveLength(0);
  });

  it("resolves the link through the backend, source and all", async () => {
    const slot = mountOpener(locationOpener, baseRpc());
    await slot.findByText("readme.md");

    expect(slot.inspection.rpcCalls[0]).toEqual({
      method: "resolveFileLocation",
      input: { path: "knowledge-base/backups/readme.md", source: SOURCE },
    });
  });

  it("opens the folder and pre-filters when the path was a glob", async () => {
    // The case from the field: an agent wrote `backups/*-otlozhena-2026-08-25.md`.
    const slot = mountOpener(
      locationOpener,
      baseRpc({
        absolutePath: `${BACKUPS}/*-otlozhena-2026-08-25.md`,
        name: "*-otlozhena-2026-08-25.md",
        exists: false,
        matchHint: "-otlozhena-2026-08-25.md",
      }),
      "knowledge-base/backups/*-otlozhena-2026-08-25.md",
    );

    await slot.findByText("2026-08-25-otlozhena-2026-08-25.md");
    expect(slot.getByTestId("fm-panel").getAttribute("data-current-path")).toBe(BACKUPS);
    // The filter is unfolded and holds the hint, so only the match is listed.
    expect((slot.getByTestId("fm-search") as HTMLInputElement).value).toBe(
      "-otlozhena-2026-08-25.md",
    );
    await waitFor(() => {
      expect(slot.getAllByTestId("fm-row")).toHaveLength(1);
    });
    expect(toasts.message[0]).toContain("is not there");
  });

  it("says why when the backend refuses the path", async () => {
    const slot = mountOpener(locationOpener, {
      ...baseRpc(),
      resolveFileLocation: () => {
        throw new Error("path_escape: /etc/passwd");
      },
    });

    expect(await slot.findByText("Could not open this location")).toBeDefined();
    expect(slot.queryByTestId("fm-panel")).toBeNull();
  });
});

describe("Preview + location opener", () => {
  it("renders bb's own preview until the location is asked for", async () => {
    const slot = mountOpener(previewOpener, baseRpc());

    expect(await slot.findByTestId("bb-preview")).toBeDefined();
    expect(slot.queryByTestId("fm-panel")).toBeNull();
    // Nothing is resolved until the button is pressed.
    expect(slot.inspection.rpcCalls).toHaveLength(0);
  });

  it("gives BB's preview the flex frame it sizes itself against", async () => {
    // The regression that shipped in 0.6: the preview was wrapped in a plain
    // block, so its own `flex-1` resolved against nothing. It grew to content
    // height with no scrollbar — the document would not scroll and a tall file
    // looked like an empty tab. BB mounts an opener in
    // `flex h-full min-h-0 flex-1 flex-col overflow-hidden`; anything holding
    // the preview has to be a flex column too.
    const slot = mountOpener(previewOpener, baseRpc());
    await slot.findByTestId("bb-preview");

    const body = slot.getByTestId("fm-opener-body");
    for (const className of ["flex", "flex-col", "flex-1", "min-h-0"]) {
      expect(body.className).toContain(className);
    }
    // And it scrolls: a rendered markdown document grows to its content and
    // expects its container to be the scroller, while BB's own opener frame is
    // overflow-hidden. Without this the document had nowhere to scroll.
    expect(body.className).toContain("overflow-auto");
    expect(body.querySelector("[data-testid='bb-preview']")).not.toBeNull();
  });

  it("switches to the file manager on the location button", async () => {
    const slot = mountOpener(previewOpener, baseRpc());
    await slot.findByTestId("bb-preview");

    fireEvent.click(slot.getByTestId("fm-open-location"));

    await slot.findByText("readme.md");
    expect(slot.getByTestId("fm-panel").getAttribute("data-current-path")).toBe(BACKUPS);
    expect(slot.queryByTestId("bb-preview")).toBeNull();
  });
});
