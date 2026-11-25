// @vitest-environment jsdom
//
// §8.12 — the built-in viewer: what opens a file when the surface has no bb
// preview panel to delegate to, which is every surface except a thread split
// view and the right-hand panel host.
//
// The split this file exists to pin down is the transport one. Images, PDFs
// and media are shown from a `createPreviewUrl` URL and their bytes never
// enter JS; everything else arrives as a string from `readTextFile`, which is
// also the only thing that can say "these bytes are not text".
import { cleanup, fireEvent, waitFor } from "@testing-library/react";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginRpcTestHandlers, RenderedSlot, RpcCall } from "@get-bb/plugin-sdk/testing/app";

import { MAX_TEXT_PREVIEW_BYTES, PREVIEW_TTL_MS, type FileEntry, type FileManagerContract } from "../../contract";
import { htmlPreviewDocument } from "../../lib/html-preview";

const toasts = vi.hoisted(() => ({ error: [] as string[], success: [] as string[] }));

vi.mock("sonner", () => ({
  toast: {
    error: (text: string) => void toasts.error.push(text),
    success: (text: string) => void toasts.success.push(text),
    message: () => undefined,
    warning: () => undefined,
    info: () => undefined,
  },
}));

const app = await loadPluginApp(() => import("../../app"));
const { resetUploadManager } = await import("../../hooks/useUploads");
const { resetPanelSnapshot } = await import("../../components/panel-bus");
const { resetLastFolderStore } = await import("../../lib/last-folder");

const registration = app.navPanels[0]!;
const ROOT = "/home/coder";
const HOST_ID = "host_test";
const BASE_URL = "https://bb.test/preview/tok3n";

class TestResizeObserver {
  observe(): void {}
  unobserve(): void {}
  disconnect(): void {}
}
globalThis.ResizeObserver ??= TestResizeObserver as unknown as typeof ResizeObserver;

function makeEntry(partial: Partial<FileEntry> & { name: string }): FileEntry {
  return {
    name: partial.name,
    path: partial.path ?? `${ROOT}/${partial.name}`,
    kind: partial.kind ?? "file",
    targetKind: partial.targetKind ?? null,
    sizeBytes: partial.sizeBytes ?? 24,
    modifiedAtMs: partial.modifiedAtMs ?? Date.UTC(2024, 2, 12),
    isHidden: false,
    isSymlink: partial.isSymlink ?? false,
    escapesRoot: partial.escapesRoot ?? false,
    archiveFormat: partial.archiveFormat ?? null,
  };
}

const README = makeEntry({ name: "readme.md" });
const SCRIPT = makeEntry({ name: "build.sh" });
const MAKEFILE = makeEntry({ name: "Makefile" });
const SHOT = makeEntry({ name: "a b#c.png" });
const CLIP = makeEntry({ name: "clip.mp4" });
const SONG = makeEntry({ name: "song.mp3" });
const MANUAL = makeEntry({ name: "manual.pdf" });
const HTML = makeEntry({ name: "page.HTML" });
const BINARY = makeEntry({ name: "tool.bin" });
const FOLDER = makeEntry({ name: "docs", kind: "directory", path: `${ROOT}/docs` });

const ENTRIES = [FOLDER, MAKEFILE, README, SCRIPT, SHOT, CLIP, SONG, MANUAL, HTML, BINARY];

const PREFERENCES = {
  showHiddenFiles: false,
  confirmOnDelete: true,
  restoreLastFolder: true,
  openThreadWorkspace: false,
  sortField: "name" as const,
  sortDirection: "asc" as const,
  viewMode: "list" as const,
};

type Handlers = Partial<PluginRpcTestHandlers<FileManagerContract>>;

const MARKDOWN = "# Readme\n\nA paragraph.\n";
const HTML_MARKUP = `<!doctype html>
<html><head>
  <title>Sample preview</title>
  <meta http-equiv="refresh" content="30; url=https://example.invalid/next">
  <link rel="stylesheet" href="https://example.invalid/styles.css">
  <style>body { color: red; }</style>
</head><body class="page">
  <h1 id="file-preview-sample">Sample document</h1>
  <a href="https://example.invalid/source">Source link</a>
  <svg><a href="https://example.invalid/source"><text>Sample chart</text></a></svg>
  <script>document.title = "Sample script";</script>
</body></html>`;

function baseRpc(extra: Handlers = {}): Handlers {
  return {
    getState: () => ({
      root: ROOT,
      startFolder: ROOT,
      preferences: PREFERENCES,
      chunkSizeBytes: 8 * 1024 * 1024,
      maxListEntries: 5000,
      archiveSupport: { zip: true, tar: true, sevenZip: false, rar: false },
      pluginVersion: "0.8.0",
      primaryHostId: HOST_ID,
    }),
    listDir: (input) => ({
      path: input.path,
      parentPath: input.path === ROOT ? null : ROOT,
      isRoot: input.path === ROOT,
      entries: input.path === ROOT ? ENTRIES : [],
      truncated: false,
      totalEntries: input.path === ROOT ? ENTRIES.length : 0,
      hiddenCount: 0,
      writable: true,
      volume: null,
    }),
    createPreviewUrl: (input) => ({
      baseUrl: BASE_URL,
      path: input.path,
      expiresAtMs: Date.now() + PREVIEW_TTL_MS,
    }),
    readTextFile: (input) => ({
      path: input.path,
      text: input.path.endsWith(".md") ? MARKDOWN : "#!/bin/sh\necho hi\n",
      sizeBytes: 24,
      readBytes: 24,
      truncated: false,
    }),
    savePreferences: () => ({
      startFolder: ROOT,
      preferences: PREFERENCES,
      chunkSizeBytes: 8 * 1024 * 1024,
    }),
    ...extra,
  };
}

/** The host declines previews — the standalone panel's permanent situation. */
function mount(handlers: Handlers = baseRpc()): RenderedSlot {
  return renderSlot(
    { component: registration.component },
    { subPath: "" },
    { rpc: handlers as PluginRpcTestHandlers<FileManagerContract> },
  ) as RenderedSlot;
}

function rowFor(slot: RenderedSlot, path: string): HTMLElement {
  const row = slot.getAllByTestId("fm-row").find((element) => element.getAttribute("data-fm-path") === path);
  if (row === undefined) throw new Error(`no row for ${path}`);
  return row;
}

function callsTo(slot: RenderedSlot, method: string): RpcCall[] {
  return slot.inspection.rpcCalls.filter((call) => call.method === method);
}

/** Double-click a row and wait for the viewer that must follow. */
async function openViewer(slot: RenderedSlot, entry: FileEntry): Promise<HTMLElement> {
  await slot.findByText(entry.name);
  fireEvent.doubleClick(rowFor(slot, entry.path));
  return slot.findByTestId("fm-viewer");
}

beforeEach(() => {
  toasts.error.length = 0;
  toasts.success.length = 0;
  resetUploadManager();
  resetPanelSnapshot();
  resetLastFolderStore();
});

afterEach(() => {
  cleanup();
  vi.restoreAllMocks();
});

describe("built-in viewer — text (§8.12)", () => {
  it("renders markdown through bb's document renderer, with the source one click away", async () => {
    const slot = mount();
    const viewer = await openViewer(slot, README);

    expect(viewer).toBeTruthy();
    expect(callsTo(slot, "readTextFile")[0]?.input).toEqual({ path: README.path });
    expect(slot.getByTestId("bb-markdown").textContent).toBe(MARKDOWN);

    fireEvent.click(slot.getByTestId("fm-viewer-toggle-source"));

    const source = await slot.findByTestId("bb-source-code");
    expect(source.textContent).toBe(MARKDOWN);
    // Language detection is the host's, from the name we hand it.
    expect(source.getAttribute("data-path")).toBe("readme.md");
    expect(slot.queryByTestId("bb-markdown")).toBeNull();
  });

  it("renders every other text file through bb's source viewer", async () => {
    const slot = mount();
    await openViewer(slot, SCRIPT);

    expect(slot.getByTestId("bb-source-code").getAttribute("data-path")).toBe("build.sh");
    // No Markdown toggle: there is no second way to read a shell script.
    expect(slot.queryByTestId("fm-viewer-toggle-source")).toBeNull();
  });

  it("opens a name that carries no extension at all", async () => {
    // The reason the server decides and the file name does not: `Makefile`
    // matches no extension list anyone would write.
    const slot = mount();
    await openViewer(slot, MAKEFILE);
    expect(slot.getByTestId("bb-source-code").getAttribute("data-path")).toBe("Makefile");
  });

  it("never mints a preview URL for a text file", async () => {
    const slot = mount();
    await openViewer(slot, SCRIPT);
    expect(callsTo(slot, "createPreviewUrl")).toHaveLength(0);
  });

  it("says how much of a long file it is showing", async () => {
    const slot = mount(
      baseRpc({
        readTextFile: (input) => ({
          path: input.path,
          text: "x".repeat(64),
          sizeBytes: 40 * 1024 * 1024,
          readBytes: 1024 * 1024,
          truncated: true,
        }),
      }),
    );
    await openViewer(slot, SCRIPT);

    expect(slot.getByTestId("fm-viewer-truncated").textContent).toContain("first");
  });

  it("offers the download instead when the bytes are not text", async () => {
    const slot = mount(
      baseRpc({
        readTextFile: () => {
          throw new Error("unsupported: /home/coder/tool.bin is not a text file");
        },
      }),
    );
    const viewer = await openViewer(slot, BINARY);

    await waitFor(() => {
      expect(viewer.textContent).toContain("No preview for this kind of file");
    });
    expect(slot.getByTestId("fm-viewer-download")).toBeTruthy();
  });

  it("shows a real read failure as a failure, not as 'no preview'", async () => {
    const slot = mount(
      baseRpc({
        readTextFile: () => {
          throw new Error("permission_denied: /home/coder/build.sh");
        },
      }),
    );
    const viewer = await openViewer(slot, SCRIPT);

    await waitFor(() => {
      expect(viewer.textContent).toContain("Could not read this file");
    });
  });
});

describe("built-in viewer — HTML documents", () => {
  it("prepares a bounded document with a long malformed tag within the parsing budget", () => {
    const markup = `<!doctype html><main>Visible</main><${"a".repeat(MAX_TEXT_PREVIEW_BYTES - 40)}`;
    const start = performance.now();
    const document = htmlPreviewDocument(markup);
    expect(performance.now() - start).toBeLessThan(3_000);
    expect(document).toContain("<main>Visible</main>");
  });

  it.each([false, true])("uses the static HTML sandbox when the host preview is available: %s", async (available) => {
    const slot = renderSlot(
      { component: registration.component },
      { subPath: "" },
      {
        rpc: baseRpc({
          readTextFile: ({ path }) => ({
            path, text: HTML_MARKUP, sizeBytes: HTML_MARKUP.length, readBytes: HTML_MARKUP.length, truncated: false,
          }),
        }) as PluginRpcTestHandlers<FileManagerContract>,
        openFilePreview: () => available,
      },
    ) as RenderedSlot;
    await openViewer(slot, HTML);
    const frame = await slot.findByTestId("fm-viewer-html");
    expect(frame.getAttribute("sandbox")).toBe("");
    expect(frame.getAttribute("referrerpolicy")).toBe("no-referrer");
    expect(frame.hasAttribute("src")).toBe(false);
    expect(slot.inspection.navigateCalls).toHaveLength(0);
    expect(callsTo(slot, "createPreviewUrl")).toHaveLength(0);
    expect(callsTo(slot, "readTextFile")[0]?.input).toEqual({ path: HTML.path });

    const markup = new DOMParser().parseFromString(frame.getAttribute("srcdoc") ?? "", "text/html");
    expect(markup.head.firstElementChild?.getAttribute("http-equiv")).toBe("Content-Security-Policy");
    expect(markup.head.firstElementChild?.getAttribute("content")).toContain("default-src 'none'");
    expect(markup.body.className).toBe("page");
    expect(markup.querySelector("h1")?.textContent).toBe("Sample document");
    expect(markup.querySelector("style")?.textContent).toContain("color: red");
    expect(markup.querySelector("meta[http-equiv='refresh'], link, script, a")).toBeNull();
    expect(markup.querySelector("svg g text")?.textContent).toBe("Sample chart");
    expect(markup.body.textContent).toContain("Source link");
    expect(document.getElementById("file-preview-sample")).toBeNull();

    fireEvent.click(slot.getByRole("button", { name: "Source" }));
    expect(slot.getByTestId("bb-source-code").textContent).toBe(HTML_MARKUP);
    expect(slot.queryByTestId("fm-viewer-html")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Rendered" }));
    expect(slot.getByTestId("fm-viewer-html")).toBeTruthy();
  });

  it("keeps partial HTML available as source without rendering a truncated document", async () => {
    const slot = mount(baseRpc({
      readTextFile: ({ path }) => ({
        path, text: HTML_MARKUP, sizeBytes: 2_000_000, readBytes: HTML_MARKUP.length, truncated: true,
      }),
    }));
    await openViewer(slot, HTML);

    await slot.findByText(/too large for a rendered preview/);
    expect(slot.queryByTestId("fm-viewer-html")).toBeNull();
    fireEvent.click(slot.getByRole("button", { name: "Source" }));
    expect(slot.getByTestId("bb-source-code").textContent).toBe(HTML_MARKUP);
    expect(slot.getByTestId("fm-viewer-truncated").textContent).toContain("first");
  });
});

describe("built-in viewer — bytes a browser paints (§8.12)", () => {
  it("keeps loading until the image from the percent-encoded preview URL is ready", async () => {
    const slot = mount();
    await openViewer(slot, SHOT);

    const image = await slot.findByTestId("fm-viewer-image");
    expect(image.getAttribute("src")).toBe(`${BASE_URL}/a%20b%23c.png`);
    expect(image.classList.contains("invisible")).toBe(true);
    expect(slot.getByRole("status").textContent).toContain("Loading");
    fireEvent.load(image);
    expect(image.classList.contains("invisible")).toBe(false);
    expect(slot.queryByRole("status")).toBeNull();
    // One mint for the folder, and no attempt to read the bytes as text.
    expect(callsTo(slot, "createPreviewUrl")[0]?.input).toEqual({ path: ROOT });
    expect(callsTo(slot, "readTextFile")).toHaveLength(0);
  });

  it("shows an already decoded image without waiting for a load event", async () => {
    vi.spyOn(HTMLImageElement.prototype, "complete", "get").mockReturnValue(true);
    vi.spyOn(HTMLImageElement.prototype, "naturalWidth", "get").mockReturnValue(1920);
    const slot = mount();
    await openViewer(slot, SHOT);

    const image = await slot.findByRole("img", { name: SHOT.name });
    expect(image.classList.contains("invisible")).toBe(false);
    expect(slot.queryByRole("status")).toBeNull();
  });

  it("shows a PDF in a frame and media in their players", async () => {
    const slot = mount();

    const pdf = await openViewer(slot, MANUAL).then(() => slot.findByTestId("fm-viewer-pdf"));
    expect(pdf.getAttribute("src")).toBe(`${BASE_URL}/manual.pdf`);
    fireEvent.keyDown(document, { key: "Escape" });

    const cleanupAndOpen = async (entry: FileEntry, testId: string): Promise<void> => {
      cleanup();
      const next = mount();
      await openViewer(next, entry);
      expect((await next.findByTestId(testId)).getAttribute("src")).toBe(`${BASE_URL}/${entry.name}`);
    };
    await cleanupAndOpen(CLIP, "fm-viewer-video");
    await cleanupAndOpen(SONG, "fm-viewer-audio");
  });

  it("offers a fresh preview URL when the browser refuses the image", async () => {
    const replacementUrl = `${BASE_URL}-retry`;
    const slot = mount(baseRpc({
      createPreviewUrl: vi.fn()
        .mockReturnValueOnce({ path: ROOT, baseUrl: BASE_URL, expiresAtMs: Date.now() + PREVIEW_TTL_MS })
        .mockReturnValueOnce({ path: ROOT, baseUrl: replacementUrl, expiresAtMs: Date.now() + PREVIEW_TTL_MS }),
    }));
    const viewer = await openViewer(slot, SHOT);

    fireEvent.error(await slot.findByTestId("fm-viewer-image"));

    await waitFor(() => {
      expect(viewer.textContent).toContain("could not be displayed");
    });
    fireEvent.click(slot.getByRole("button", { name: "Retry" }));
    const replacement = await slot.findByTestId("fm-viewer-image");
    expect(replacement.getAttribute("src")).toBe(`${replacementUrl}/a%20b%23c.png`);
    expect(callsTo(slot, "createPreviewUrl")).toHaveLength(2);
    fireEvent.load(replacement);
    expect(slot.getByRole("img", { name: SHOT.name })).toBe(replacement);
  });

  it("offers retry when the image preview URL could not be minted", async () => {
    const slot = mount(baseRpc({
      createPreviewUrl: vi.fn()
        .mockRejectedValueOnce(new Error("Preview unavailable"))
        .mockReturnValueOnce({ path: ROOT, baseUrl: BASE_URL, expiresAtMs: Date.now() + PREVIEW_TTL_MS }),
    }));
    await openViewer(slot, SHOT);

    fireEvent.click(await slot.findByRole("button", { name: "Retry" }));
    expect(await slot.findByTestId("fm-viewer-image")).toBeTruthy();
    expect(callsTo(slot, "createPreviewUrl")).toHaveLength(2);
  });
});

describe("built-in viewer — what never reaches it", () => {
  it("hands the file to bb's preview panel when this surface has one", async () => {
    const slot = renderSlot(
      { component: registration.component },
      { subPath: "" },
      {
        rpc: baseRpc() as PluginRpcTestHandlers<FileManagerContract>,
        openFilePreview: () => true,
      },
    ) as RenderedSlot;
    await slot.findByText("readme.md");

    fireEvent.doubleClick(rowFor(slot, README.path));

    expect(slot.inspection.navigateCalls).toEqual([
      {
        method: "experimental_openFilePreview",
        options: { target: { kind: "host", hostId: HOST_ID, path: README.path }, location: null },
      },
    ]);
    expect(slot.queryByTestId("fm-viewer")).toBeNull();
    expect(callsTo(slot, "readTextFile")).toHaveLength(0);
  });

  it("walks into a folder instead of viewing it", async () => {
    const slot = mount();
    await slot.findByText("docs");

    fireEvent.doubleClick(rowFor(slot, FOLDER.path));

    expect(slot.queryByTestId("fm-viewer")).toBeNull();
    expect(slot.inspection.navigateCalls).toEqual([
      { method: "toPluginPanel", path: "files", options: { subPath: "docs" } },
    ]);
  });
});
