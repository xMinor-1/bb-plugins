// Bookmarks (§8.11): the kv row, the two strengths of root clamping, and the
// rules that keep a list of folders from turning into a list of dead paths.
import { mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { createFakePluginHost, type FakePluginHost } from "@get-bb/plugin-sdk/testing";

import { MAX_BOOKMARKS, MAX_BOOKMARK_NAME_LENGTH, PLUGIN_ID } from "../../contract";
import { BOOKMARKS_KEY, createBookmarks, type BookmarksModule } from "../../src/bookmarks";
import { isFileManagerError } from "../../src/errors";
import { initRoot } from "../../src/root";

let root = "";
let outside = "";
let host: FakePluginHost;
let bookmarks: BookmarksModule;

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

/** What the kv row holds, straight from the fake host's Map. */
async function storedRow(): Promise<unknown> {
  return host.bb.storage.kv.get<unknown>(BOOKMARKS_KEY);
}

async function seedRow(value: unknown): Promise<void> {
  await host.bb.storage.kv.set(BOOKMARKS_KEY, value);
}

/** Make `count` directories under the root and bookmark every one of them. */
async function fill(count: number): Promise<void> {
  for (let index = 0; index < count; index += 1) {
    const folder = path.join(root, `p${String(index)}`);
    await mkdir(folder);
    await bookmarks.add({ path: folder, name: null });
  }
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "fm-bm-")));
  outside = await realpath(await mkdtemp(path.join(tmpdir(), "fm-bm-outside-")));
  await initRoot(root);
  host = createFakePluginHost({ pluginId: PLUGIN_ID });
  bookmarks = createBookmarks(host.bb);
});

afterEach(async () => {
  await host.harness.dispose();
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */

describe("list", () => {
  it("starts empty and never touches storage to say so", async () => {
    await expect(bookmarks.list()).resolves.toEqual({ bookmarks: [] });
    await expect(storedRow()).resolves.toBeUndefined();
  });

  it("marks a folder that is gone instead of dropping it", async () => {
    const folder = path.join(root, "projects");
    await mkdir(folder);
    await bookmarks.add({ path: folder, name: null });
    await rm(folder, { recursive: true });

    const listed = await bookmarks.list();
    expect(listed.bookmarks).toEqual([
      { path: folder, name: "projects", order: 0, available: false },
    ]);
    // …and the row is still on disk: nothing self-deletes behind the user.
    expect(await storedRow()).toEqual([{ path: folder, name: "projects" }]);
  });

  it("drops a row that now points outside the root", async () => {
    // The same bb data directory carried to a host with a different home. A
    // path that can never be opened from here is not "unavailable", it is not
    // this machine's bookmark at all.
    await seedRow([
      { path: outside, name: "elsewhere" },
      { path: root, name: "home" },
    ]);
    const listed = await bookmarks.list();
    expect(listed.bookmarks.map((bookmark) => bookmark.path)).toEqual([root]);
  });

  it("degrades a corrupt row to an empty list rather than throwing", async () => {
    await seedRow({ not: "an array" });
    await expect(bookmarks.list()).resolves.toEqual({ bookmarks: [] });

    await seedRow([42, null, { name: "no path" }, { path: "" }]);
    await expect(bookmarks.list()).resolves.toEqual({ bookmarks: [] });
  });

  it("repairs a stored name instead of failing over it", async () => {
    const folder = path.join(root, "docs");
    await mkdir(folder);
    await seedRow([
      { path: folder, name: "   " },
      { path: path.join(root, "gone"), name: 7 },
    ]);
    const listed = await bookmarks.list();
    expect(listed.bookmarks.map((bookmark) => bookmark.name)).toEqual(["docs", "gone"]);
  });

  it("dedupes by path and caps the list at MAX_BOOKMARKS", async () => {
    const folder = path.join(root, "docs");
    await mkdir(folder);
    const oversized = [
      { path: folder, name: "first" },
      { path: `${folder}/`, name: "same folder, trailing slash" },
      ...Array.from({ length: MAX_BOOKMARKS + 10 }, (_, index) => ({
        path: path.join(root, `p${String(index)}`),
        name: `p${String(index)}`,
      })),
    ];
    await seedRow(oversized);

    const listed = await bookmarks.list();
    expect(listed.bookmarks).toHaveLength(MAX_BOOKMARKS);
    expect(listed.bookmarks[0]).toMatchObject({ path: folder, name: "first" });
  });

  it("numbers the list in insertion order", async () => {
    await fill(3);
    const listed = await bookmarks.list();
    expect(listed.bookmarks.map((bookmark) => [bookmark.name, bookmark.order])).toEqual([
      ["p0", 0],
      ["p1", 1],
      ["p2", 2],
    ]);
  });
});

describe("add", () => {
  it("stores the realpath'ed folder and its base name", async () => {
    await mkdir(path.join(root, "real"));
    await symlink(path.join(root, "real"), path.join(root, "alias"));

    const result = await bookmarks.add({ path: path.join(root, "alias"), name: null });

    expect(result.bookmarks).toEqual([
      { path: path.join(root, "real"), name: "real", order: 0, available: true },
    ]);
    expect(await storedRow()).toEqual([{ path: path.join(root, "real"), name: "real" }]);
  });

  it("takes a chosen name, trimmed", async () => {
    await mkdir(path.join(root, "projects"));
    const result = await bookmarks.add({
      path: path.join(root, "projects"),
      name: "  Work  ",
    });
    expect(result.bookmarks[0]).toMatchObject({ name: "Work" });
  });

  it("is a no-op for a folder already bookmarked", async () => {
    const folder = path.join(root, "docs");
    await mkdir(folder);
    await bookmarks.add({ path: folder, name: "Docs" });
    const again = await bookmarks.add({ path: folder, name: null });

    expect(again.bookmarks).toHaveLength(1);
    // The name it already had survives — a second click of a toggle is not a
    // request to rename anything.
    expect(again.bookmarks[0]).toMatchObject({ name: "Docs" });
  });

  it("updates the name when the repeat add carries one", async () => {
    const folder = path.join(root, "docs");
    await mkdir(folder);
    await bookmarks.add({ path: folder, name: null });
    const renamed = await bookmarks.add({ path: folder, name: "Specs" });

    expect(renamed.bookmarks).toEqual([
      { path: folder, name: "Specs", order: 0, available: true },
    ]);
  });

  it("refuses a folder outside the root, a missing one, and a file", async () => {
    await writeFile(path.join(root, "a.txt"), "a");
    await symlink(outside, path.join(root, "escape"));

    await expectCode(bookmarks.add({ path: outside, name: null }), "path_escape");
    await expectCode(bookmarks.add({ path: "/etc", name: null }), "path_escape");
    await expectCode(bookmarks.add({ path: path.join(root, "escape"), name: null }), "path_escape");
    await expectCode(bookmarks.add({ path: path.join(root, "ghost"), name: null }), "not_found");
    await expectCode(
      bookmarks.add({ path: path.join(root, "a.txt"), name: null }),
      "not_a_directory",
    );

    await expect(storedRow()).resolves.toBeUndefined();
  });

  it("refuses an empty, control-laden or over-long name", async () => {
    const folder = path.join(root, "docs");
    await mkdir(folder);

    await expectCode(bookmarks.add({ path: folder, name: "   " }), "invalid_name");
    await expectCode(bookmarks.add({ path: folder, name: "a\u0007b" }), "invalid_name");
    await expectCode(
      bookmarks.add({ path: folder, name: "x".repeat(MAX_BOOKMARK_NAME_LENGTH + 1) }),
      "invalid_name",
    );
    await expect(storedRow()).resolves.toBeUndefined();
  });

  it("counts the name in code points, not bytes", async () => {
    const folder = path.join(root, "docs");
    await mkdir(folder);
    // 80 non-Latin characters are 160 bytes; a byte budget would refuse them.
    const name = "я".repeat(MAX_BOOKMARK_NAME_LENGTH);
    await expect(bookmarks.add({ path: folder, name })).resolves.toMatchObject({
      bookmarks: [{ name }],
    });
  });

  it("refuses the one past the ceiling with `unsupported`", async () => {
    await fill(MAX_BOOKMARKS);
    await mkdir(path.join(root, "one-too-many"));

    await expectCode(
      bookmarks.add({ path: path.join(root, "one-too-many"), name: null }),
      "unsupported",
    );
    const listed = await bookmarks.list();
    expect(listed.bookmarks).toHaveLength(MAX_BOOKMARKS);
  });
});

describe("remove", () => {
  it("removes a bookmark whose folder is gone", async () => {
    const folder = path.join(root, "projects");
    await mkdir(folder);
    await bookmarks.add({ path: folder, name: null });
    await rm(folder, { recursive: true });

    // The whole reason removal clamps lexically: `resolveExistingDir` cannot
    // answer for a folder that is not there any more.
    await expect(bookmarks.remove({ path: folder })).resolves.toEqual({ bookmarks: [] });
    expect(await storedRow()).toEqual([]);
  });

  it("is a no-op for a path that is not bookmarked", async () => {
    const folder = path.join(root, "docs");
    await mkdir(folder);
    await bookmarks.add({ path: folder, name: null });

    const result = await bookmarks.remove({ path: path.join(root, "other") });
    expect(result.bookmarks).toHaveLength(1);
  });

  it("still refuses a path outside the root", async () => {
    await expectCode(bookmarks.remove({ path: outside }), "path_escape");
    await expectCode(bookmarks.remove({ path: `${root}/../..` }), "path_escape");
  });

  it("closes the gap in the order", async () => {
    await fill(3);
    const result = await bookmarks.remove({ path: path.join(root, "p1") });
    expect(result.bookmarks.map((bookmark) => [bookmark.name, bookmark.order])).toEqual([
      ["p0", 0],
      ["p2", 1],
    ]);
  });
});

describe("rename", () => {
  it("renames without touching the path or the order", async () => {
    await fill(2);
    const result = await bookmarks.rename({ path: path.join(root, "p0"), name: "Work" });

    expect(result.bookmarks).toEqual([
      { path: path.join(root, "p0"), name: "Work", order: 0, available: true },
      { path: path.join(root, "p1"), name: "p1", order: 1, available: true },
    ]);
  });

  it("renames a bookmark whose folder is gone", async () => {
    const folder = path.join(root, "projects");
    await mkdir(folder);
    await bookmarks.add({ path: folder, name: null });
    await rm(folder, { recursive: true });

    const result = await bookmarks.rename({ path: folder, name: "Old project" });
    expect(result.bookmarks[0]).toMatchObject({ name: "Old project", available: false });
  });

  it("refuses an unknown path, a bad name and an escaping path", async () => {
    await fill(1);
    await expectCode(
      bookmarks.rename({ path: path.join(root, "nope"), name: "x" }),
      "not_found",
    );
    await expectCode(bookmarks.rename({ path: path.join(root, "p0"), name: "" }), "invalid_name");
    await expectCode(bookmarks.rename({ path: outside, name: "x" }), "path_escape");
  });
});
