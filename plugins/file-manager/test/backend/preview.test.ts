// §8.9 — the gallery's base URL, and the two things that must not leak out of
// it: a folder outside the hard root, and a host failure dressed up as a bug.
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { PREVIEW_TTL_MS } from "../../contract";
import { isFileManagerError } from "../../src/errors";
import { createPreviewUrl } from "../../src/preview";
import { initRoot } from "../../src/root";

let root = "";
let outside = "";

interface FakeBb {
  bb: BbPluginApi;
  createPreview: ReturnType<typeof vi.fn>;
  warnings: string[];
}

/** Only the one SDK area src/preview.ts can reach, plus the logger it warns on. */
function fakeBb(implementation?: () => unknown): FakeBb {
  const warnings: string[] = [];
  const createPreview = vi.fn(
    implementation ??
      (() => ({ baseUrl: "https://bb.test/preview/tok3n", expiresAtMs: 1_700_000_000_000 })),
  );
  return {
    createPreview,
    warnings,
    bb: {
      sdk: { files: { createPreview } },
      log: { warn: (message: string) => void warnings.push(message) },
    } as unknown as BbPluginApi,
  };
}

async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  const error: unknown = await promise.then(
    () => {
      throw new Error(`expected the call to reject with ${code}`);
    },
    (reason: unknown) => reason,
  );
  expect(isFileManagerError(error)).toBe(true);
  expect((error as { code: string }).code).toBe(code);
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "fm-preview-")));
  outside = await realpath(await mkdtemp(path.join(tmpdir(), "fm-outside-")));
  await initRoot(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe("createPreviewUrl", () => {
  it("mints a URL for a folder under the root and echoes the realpath'ed folder", async () => {
    await mkdir(path.join(root, "photos"));
    const host = fakeBb();

    const result = await createPreviewUrl(host.bb, { path: path.join(root, "photos") });

    expect(result).toEqual({
      baseUrl: "https://bb.test/preview/tok3n",
      path: path.join(root, "photos"),
      expiresAtMs: 1_700_000_000_000,
    });
    expect(host.createPreview).toHaveBeenCalledWith({
      rootPath: path.join(root, "photos"),
      ttlMs: PREVIEW_TTL_MS,
    });
  });

  it("resolves the root itself for the empty path", async () => {
    const host = fakeBb();
    const result = await createPreviewUrl(host.bb, { path: "" });
    expect(result.path).toBe(root);
    expect(host.createPreview.mock.calls[0]?.[0]).toMatchObject({ rootPath: root });
  });

  it("hands the host the realpath, never the symlink the caller named", async () => {
    // The whole point of resolving first: a URL rooted at the link would let
    // the host decide what the link means, which is not its job to know.
    await mkdir(path.join(root, "real"));
    await symlink(path.join(root, "real"), path.join(root, "alias"));
    const host = fakeBb();

    const result = await createPreviewUrl(host.bb, { path: path.join(root, "alias") });

    expect(result.path).toBe(path.join(root, "real"));
    expect(host.createPreview.mock.calls[0]?.[0]).toMatchObject({
      rootPath: path.join(root, "real"),
    });
  });

  it("refuses a folder outside the root without asking the host at all", async () => {
    const host = fakeBb();
    await expectCode(createPreviewUrl(host.bb, { path: outside }), "path_escape");
    await expectCode(createPreviewUrl(host.bb, { path: "/etc" }), "path_escape");
    expect(host.createPreview).not.toHaveBeenCalled();
  });

  it("refuses a symlink that leaves the root", async () => {
    await symlink(outside, path.join(root, "escape"));
    const host = fakeBb();
    await expectCode(createPreviewUrl(host.bb, { path: path.join(root, "escape") }), "path_escape");
    expect(host.createPreview).not.toHaveBeenCalled();
  });

  it("refuses a missing folder and a file", async () => {
    await writeFile(path.join(root, "a.png"), "not really a png");
    const host = fakeBb();
    await expectCode(createPreviewUrl(host.bb, { path: path.join(root, "ghost") }), "not_found");
    await expectCode(
      createPreviewUrl(host.bb, { path: path.join(root, "a.png") }),
      "not_a_directory",
    );
    expect(host.createPreview).not.toHaveBeenCalled();
  });

  it("turns a host that cannot mint previews into one stable code, and warns", async () => {
    // A server too old for the preview transport must read as "no thumbnails",
    // not as a broken plugin — the panel branches on this code.
    const host = fakeBb(() => {
      throw new Error("unknown method host.create_file_preview");
    });

    await expectCode(createPreviewUrl(host.bb, { path: "" }), "unsupported");
    expect(host.warnings).toHaveLength(1);
    expect(host.warnings[0]).toContain(root);
  });
});
