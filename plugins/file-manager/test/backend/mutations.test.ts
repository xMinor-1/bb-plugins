// Mutations: createFolder, renameEntry, deleteEntries, moveEntries,
// copyEntries, conflict policies, uniqueName, and the `fs` realtime signal.
import { lstat, mkdir, mkdtemp, readFile, readlink, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createFakePluginHost, type FakePluginHarness } from "@get-bb/plugin-sdk/testing";

import { FS_CHANNEL, PLUGIN_ID } from "../../contract";
import { isFileManagerError } from "../../src/errors";
import {
  copyEntries,
  createFolder,
  deleteEntries,
  moveEntries,
  numberedName,
  renameEntry,
  splitName,
  uniqueName,
} from "../../src/mutations";
import { initRoot } from "../../src/root";

let root = "";
let outside = "";
let bb: BbPluginApi;
let harness: FakePluginHarness;

interface FsSignalPayload {
  paths: string[];
  reason: string;
}

function fsSignals(): FsSignalPayload[] {
  return harness.realtimeSignals
    .filter((signal) => signal.channel === FS_CHANNEL)
    .map((signal) => signal.payload as FsSignalPayload);
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

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "fm-mut-")));
  outside = await realpath(await mkdtemp(path.join(tmpdir(), "fm-outside-")));
  await initRoot(root);
  const host = createFakePluginHost({ pluginId: PLUGIN_ID });
  bb = host.bb;
  harness = host.harness;
});

afterEach(async () => {
  await harness.dispose();
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe("splitName / numberedName / uniqueName", () => {
  it.each([
    ["report.txt", "report", ".txt"],
    ["archive.tar.gz", "archive", ".tar.gz"],
    ["archive.tar.bz2", "archive", ".tar.bz2"],
    ["no-extension", "no-extension", ""],
    [".bashrc", ".bashrc", ""],
    [".config.json", ".config", ".json"],
    ["a.b.c", "a.b", ".c"],
  ])("splits %s into %s + %s", (name, stem, extension) => {
    expect(splitName(name)).toEqual({ stem, extension });
  });

  it("builds `name (n).ext`", () => {
    expect(numberedName("report.txt", 1)).toBe("report (1).txt");
    expect(numberedName("archive.tar.gz", 3)).toBe("archive (3).tar.gz");
    expect(numberedName(".bashrc", 2)).toBe(".bashrc (2)");
  });

  it("returns the name untouched when it is free", async () => {
    await expect(uniqueName(root, "report.txt")).resolves.toBe("report.txt");
  });

  it("counts up until a free name is found", async () => {
    await writeFile(path.join(root, "report.txt"), "a");
    await expect(uniqueName(root, "report.txt")).resolves.toBe("report (1).txt");
    await writeFile(path.join(root, "report (1).txt"), "b");
    await writeFile(path.join(root, "report (2).txt"), "c");
    await expect(uniqueName(root, "report.txt")).resolves.toBe("report (3).txt");
  });
});

describe("createFolder", () => {
  it("creates the folder, returns its entry and signals the parent", async () => {
    const result = await createFolder(bb, { path: "", name: "New Folder" });
    expect(result.entry).toMatchObject({
      name: "New Folder",
      kind: "directory",
      path: path.join(root, "New Folder"),
      sizeBytes: 0,
    });
    await expect(exists(path.join(root, "New Folder"))).resolves.toBe(true);
    expect(fsSignals()).toEqual([{ paths: [root], reason: "create" }]);
  });

  it("fails with exists on a collision and publishes nothing", async () => {
    await mkdir(path.join(root, "dup"));
    await expectCode(createFolder(bb, { path: "", name: "dup" }), "exists");
    expect(fsSignals()).toEqual([]);
  });

  it("rejects path-like names and escaping parents", async () => {
    await expectCode(createFolder(bb, { path: "", name: "../evil" }), "invalid_name");
    await expectCode(createFolder(bb, { path: "", name: ".." }), "invalid_name");
    await expectCode(createFolder(bb, { path: "/etc", name: "evil" }), "path_escape");
    await expectCode(createFolder(bb, { path: outside, name: "evil" }), "path_escape");
    await expect(exists(path.join(outside, "evil"))).resolves.toBe(false);
  });
});

describe("renameEntry", () => {
  it("renames a file in place and signals its directory", async () => {
    await mkdir(path.join(root, "sub"));
    await writeFile(path.join(root, "sub", "old.txt"), "data");
    const result = await renameEntry(bb, { path: "sub/old.txt", newName: "new.txt" });
    expect(result.entry.path).toBe(path.join(root, "sub", "new.txt"));
    await expect(readFile(path.join(root, "sub", "new.txt"), "utf8")).resolves.toBe("data");
    expect(fsSignals()).toEqual([{ paths: [path.join(root, "sub")], reason: "rename" }]);
  });

  it("refuses to clobber an existing destination", async () => {
    await writeFile(path.join(root, "a.txt"), "a");
    await writeFile(path.join(root, "b.txt"), "b");
    await expectCode(renameEntry(bb, { path: "a.txt", newName: "b.txt" }), "exists");
    await expect(readFile(path.join(root, "b.txt"), "utf8")).resolves.toBe("b");
  });

  it("renames the link, not its target", async () => {
    await writeFile(path.join(root, "target.txt"), "t");
    await symlink(path.join(root, "target.txt"), path.join(root, "link.txt"));
    const result = await renameEntry(bb, { path: "link.txt", newName: "renamed-link.txt" });
    expect(result.entry.kind).toBe("symlink");
    await expect(readlink(path.join(root, "renamed-link.txt"))).resolves.toBe(
      path.join(root, "target.txt"),
    );
    await expect(exists(path.join(root, "target.txt"))).resolves.toBe(true);
  });

  it("refuses the root and invalid names", async () => {
    await expectCode(renameEntry(bb, { path: "", newName: "hacked" }), "path_escape");
    await writeFile(path.join(root, "a.txt"), "a");
    await expectCode(renameEntry(bb, { path: "a.txt", newName: "../a.txt" }), "invalid_name");
    await expectCode(renameEntry(bb, { path: "a.txt", newName: "sub/a.txt" }), "invalid_name");
  });
});

describe("deleteEntries", () => {
  it("deletes files and empty directories and signals once", async () => {
    await writeFile(path.join(root, "a.txt"), "a");
    await mkdir(path.join(root, "empty"));
    const result = await deleteEntries(bb, {
      paths: [path.join(root, "a.txt"), path.join(root, "empty")],
      recursive: true,
    });
    expect(result.succeeded).toEqual([path.join(root, "a.txt"), path.join(root, "empty")]);
    expect(result.failed).toEqual([]);
    expect(fsSignals()).toEqual([{ paths: [root], reason: "delete" }]);
  });

  it("needs recursive for a non-empty directory", async () => {
    await mkdir(path.join(root, "full"));
    await writeFile(path.join(root, "full", "inner.txt"), "i");

    const refused = await deleteEntries(bb, {
      paths: [path.join(root, "full")],
      recursive: false,
    });
    expect(refused.succeeded).toEqual([]);
    expect(refused.failed).toEqual([
      { path: path.join(root, "full"), code: "not_empty", message: expect.any(String) },
    ]);
    await expect(exists(path.join(root, "full"))).resolves.toBe(true);

    const removed = await deleteEntries(bb, {
      paths: [path.join(root, "full")],
      recursive: true,
    });
    expect(removed.succeeded).toEqual([path.join(root, "full")]);
    await expect(exists(path.join(root, "full"))).resolves.toBe(false);
  });

  it("removes a symlink without touching its target", async () => {
    await mkdir(path.join(outside, "victim"));
    await writeFile(path.join(outside, "victim", "keep.txt"), "k");
    await symlink(path.join(outside, "victim"), path.join(root, "victim-link"));

    const result = await deleteEntries(bb, {
      paths: [path.join(root, "victim-link")],
      recursive: true,
    });
    expect(result.succeeded).toEqual([path.join(root, "victim-link")]);
    await expect(exists(path.join(root, "victim-link"))).resolves.toBe(false);
    await expect(readFile(path.join(outside, "victim", "keep.txt"), "utf8")).resolves.toBe("k");
  });

  it("puts escapes and misses in failed[] and still deletes the rest", async () => {
    await writeFile(path.join(root, "ok.txt"), "o");
    const result = await deleteEntries(bb, {
      paths: ["/etc/passwd", path.join(outside, "x"), "ghost.txt", path.join(root, "ok.txt"), root],
      recursive: true,
    });
    expect(result.succeeded).toEqual([path.join(root, "ok.txt")]);
    expect(result.failed.map((failure) => failure.code)).toEqual([
      "path_escape",
      "path_escape",
      "not_found",
      "path_escape",
    ]);
    expect(result.failed[0]?.path).toBe("/etc/passwd");
    await expect(exists(root)).resolves.toBe(true);
  });

  it("publishes nothing when everything failed", async () => {
    const result = await deleteEntries(bb, { paths: ["/etc/passwd"], recursive: true });
    expect(result.succeeded).toEqual([]);
    expect(fsSignals()).toEqual([]);
  });
});

describe("moveEntries", () => {
  beforeEach(async () => {
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, "dst"));
    await writeFile(path.join(root, "src", "a.txt"), "A");
  });

  it("moves a file and signals both directories", async () => {
    const result = await moveEntries(bb, {
      paths: [path.join(root, "src", "a.txt")],
      destinationDir: path.join(root, "dst"),
      conflict: "fail",
    });
    expect(result.succeeded).toEqual([path.join(root, "src", "a.txt")]);
    await expect(readFile(path.join(root, "dst", "a.txt"), "utf8")).resolves.toBe("A");
    await expect(exists(path.join(root, "src", "a.txt"))).resolves.toBe(false);
    expect(fsSignals()).toEqual([
      { paths: [path.join(root, "dst"), path.join(root, "src")], reason: "move" },
    ]);
  });

  it("conflict: fail leaves both sides untouched", async () => {
    await writeFile(path.join(root, "dst", "a.txt"), "existing");
    const result = await moveEntries(bb, {
      paths: [path.join(root, "src", "a.txt")],
      destinationDir: path.join(root, "dst"),
      conflict: "fail",
    });
    expect(result.succeeded).toEqual([]);
    expect(result.failed[0]?.code).toBe("exists");
    await expect(readFile(path.join(root, "dst", "a.txt"), "utf8")).resolves.toBe("existing");
    await expect(readFile(path.join(root, "src", "a.txt"), "utf8")).resolves.toBe("A");
  });

  it("conflict: rename lands as `name (1).ext`", async () => {
    await writeFile(path.join(root, "dst", "a.txt"), "existing");
    const result = await moveEntries(bb, {
      paths: [path.join(root, "src", "a.txt")],
      destinationDir: path.join(root, "dst"),
      conflict: "rename",
    });
    expect(result.failed).toEqual([]);
    await expect(readFile(path.join(root, "dst", "a (1).txt"), "utf8")).resolves.toBe("A");
    await expect(readFile(path.join(root, "dst", "a.txt"), "utf8")).resolves.toBe("existing");
  });

  it("conflict: overwrite replaces the destination", async () => {
    await writeFile(path.join(root, "dst", "a.txt"), "existing");
    const result = await moveEntries(bb, {
      paths: [path.join(root, "src", "a.txt")],
      destinationDir: path.join(root, "dst"),
      conflict: "overwrite",
    });
    expect(result.failed).toEqual([]);
    await expect(readFile(path.join(root, "dst", "a.txt"), "utf8")).resolves.toBe("A");
    await expect(exists(path.join(root, "src", "a.txt"))).resolves.toBe(false);
  });

  it("refuses to move a directory into itself or its own subtree", async () => {
    await mkdir(path.join(root, "src", "deep"));
    const intoSelf = await moveEntries(bb, {
      paths: [path.join(root, "src")],
      destinationDir: path.join(root, "src"),
      conflict: "fail",
    });
    expect(intoSelf.failed[0]?.code).toBe("destination_inside_source");

    const intoChild = await moveEntries(bb, {
      paths: [path.join(root, "src")],
      destinationDir: path.join(root, "src", "deep"),
      conflict: "fail",
    });
    expect(intoChild.failed[0]?.code).toBe("destination_inside_source");
    await expect(exists(path.join(root, "src", "a.txt"))).resolves.toBe(true);
  });

  it("refuses an escaping destination outright", async () => {
    await expectCode(
      moveEntries(bb, {
        paths: [path.join(root, "src", "a.txt")],
        destinationDir: outside,
        conflict: "fail",
      }),
      "path_escape",
    );
    await expectCode(
      moveEntries(bb, {
        paths: [path.join(root, "src", "a.txt")],
        destinationDir: path.join(root, "src", "a.txt"),
        conflict: "fail",
      }),
      "not_a_directory",
    );
  });

  it("puts escaping sources in failed[] and moves the rest", async () => {
    const result = await moveEntries(bb, {
      paths: ["/etc/passwd", path.join(root, "src", "a.txt")],
      destinationDir: path.join(root, "dst"),
      conflict: "fail",
    });
    expect(result.succeeded).toEqual([path.join(root, "src", "a.txt")]);
    expect(result.failed[0]).toMatchObject({ path: "/etc/passwd", code: "path_escape" });
  });

  it("treats a move into the source's own directory as a no-op", async () => {
    const result = await moveEntries(bb, {
      paths: [path.join(root, "src", "a.txt")],
      destinationDir: path.join(root, "src"),
      conflict: "overwrite",
    });
    expect(result.succeeded).toEqual([path.join(root, "src", "a.txt")]);
    await expect(readFile(path.join(root, "src", "a.txt"), "utf8")).resolves.toBe("A");
  });
});

describe("copyEntries", () => {
  beforeEach(async () => {
    await mkdir(path.join(root, "src", "nested"), { recursive: true });
    await mkdir(path.join(root, "dst"));
    await writeFile(path.join(root, "src", "a.txt"), "A");
    await writeFile(path.join(root, "src", "nested", "b.txt"), "B");
  });

  it("copies a directory tree and leaves the source alone", async () => {
    const result = await copyEntries(bb, {
      paths: [path.join(root, "src")],
      destinationDir: path.join(root, "dst"),
      conflict: "rename",
    });
    expect(result.failed).toEqual([]);
    await expect(readFile(path.join(root, "dst", "src", "nested", "b.txt"), "utf8")).resolves.toBe(
      "B",
    );
    await expect(readFile(path.join(root, "src", "a.txt"), "utf8")).resolves.toBe("A");
    expect(fsSignals()).toEqual([
      { paths: [path.join(root, "dst"), root], reason: "copy" },
    ]);
  });

  it("conflict: rename produces a numbered sibling", async () => {
    await writeFile(path.join(root, "dst", "a.txt"), "existing");
    const result = await copyEntries(bb, {
      paths: [path.join(root, "src", "a.txt")],
      destinationDir: path.join(root, "dst"),
      conflict: "rename",
    });
    expect(result.failed).toEqual([]);
    await expect(readFile(path.join(root, "dst", "a (1).txt"), "utf8")).resolves.toBe("A");
  });

  it("copies a symlink verbatim instead of dereferencing it", async () => {
    await symlink(path.join(outside, "anything"), path.join(root, "src", "escape-link"));
    const result = await copyEntries(bb, {
      paths: [path.join(root, "src", "escape-link")],
      destinationDir: path.join(root, "dst"),
      conflict: "fail",
    });
    expect(result.failed).toEqual([]);
    const copied = await lstat(path.join(root, "dst", "escape-link"));
    expect(copied.isSymbolicLink()).toBe(true);
    await expect(readlink(path.join(root, "dst", "escape-link"))).resolves.toBe(
      path.join(outside, "anything"),
    );
  });

  it("refuses to copy a directory into its own subtree", async () => {
    const result = await copyEntries(bb, {
      paths: [path.join(root, "src")],
      destinationDir: path.join(root, "src", "nested"),
      conflict: "rename",
    });
    expect(result.failed[0]?.code).toBe("destination_inside_source");
  });
});
