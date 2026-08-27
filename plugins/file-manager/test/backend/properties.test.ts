// §8.10 — what one path is, and how big a folder really is.
//
// Two halves with different risks. `pathProperties` has to describe the *link*
// and never its target, has to survive a filesystem with no birth time, and
// has to refuse a path outside the hard root like every other read does.
// `directorySize` has to stay bounded: it never follows a symlink (a link to
// an ancestor would loop), it skips the staging directory, and when a limit
// stops it the answer must say so instead of passing a lower bound off as a
// total.
import { chmod, mkdir, mkdtemp, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir, userInfo } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { STAGING_DIR_NAME } from "../../contract";
import { isFileManagerError } from "../../src/errors";
import {
  DIRECTORY_SIZE_MAX_DEPTH,
  contentTypeOf,
  directorySize,
  formatModeOctal,
  formatModeText,
  pathProperties,
} from "../../src/properties";
import { initRoot } from "../../src/root";

let root = "";
let outside = "";

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
  root = await realpath(await mkdtemp(path.join(tmpdir(), "fm-props-")));
  outside = await realpath(await mkdtemp(path.join(tmpdir(), "fm-outside-")));
  await initRoot(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */

describe("formatModeText", () => {
  it.each([
    [0o644, "-", "-rw-r--r--"],
    [0o755, "d", "drwxr-xr-x"],
    [0o777, "l", "lrwxrwxrwx"],
    [0o600, "-", "-rw-------"],
    [0o000, "-", "----------"],
  ])("renders %s as %s", (mode, type, expected) => {
    expect(formatModeText(mode, type)).toBe(expected);
  });

  it("shows setuid, setgid and sticky in the execute columns", () => {
    expect(formatModeText(0o4755, "-")).toBe("-rwsr-xr-x");
    expect(formatModeText(0o2755, "-")).toBe("-rwxr-sr-x");
    expect(formatModeText(0o1777, "d")).toBe("drwxrwxrwt");
    // Uppercase when the matching execute bit is *off* — the case that says
    // "this bit is set but does nothing", which the octal alone hides.
    expect(formatModeText(0o4644, "-")).toBe("-rwSr--r--");
    expect(formatModeText(0o1666, "d")).toBe("drw-rw-rwT");
  });
});

describe("formatModeOctal", () => {
  it("keeps four digits so the special triple is never dropped", () => {
    expect(formatModeOctal(0o100644)).toBe("0644");
    expect(formatModeOctal(0o40755)).toBe("0755");
    expect(formatModeOctal(0o104755)).toBe("4755");
  });
});

describe("contentTypeOf", () => {
  it.each([
    ["notes.md", "text/markdown"],
    ["data.JSON", "application/json"],
    ["photo.png", "image/png"],
    ["bundle.tar.gz", "application/gzip"],
    ["bundle.zip", "application/zip"],
  ])("maps %s to %s", (name, expected) => {
    expect(contentTypeOf(name)).toBe(expected);
  });

  it.each(["Makefile", "LICENSE", ".bashrc", "mystery.qqq"])("returns null for %s", (name) => {
    expect(contentTypeOf(name)).toBeNull();
  });
});

/* ------------------------------------------------------------------ */

describe("pathProperties", () => {
  it("describes a file with size, mode, owner and content type", async () => {
    const file = path.join(root, "notes.md");
    await writeFile(file, "hello");
    await chmod(file, 0o640);

    const properties = await pathProperties({ path: file });

    expect(properties).toMatchObject({
      name: "notes.md",
      path: file,
      parentPath: root,
      kind: "file",
      targetKind: null,
      isSymlink: false,
      escapesRoot: false,
      linkTarget: null,
      linkTargetPath: null,
      sizeBytes: 5,
      modeOctal: "0640",
      modeText: "-rw-r-----",
      contentType: "text/markdown",
      linkCount: 1,
    });
    expect(properties.ownerUid).toBe(userInfo().uid);
    expect(properties.ownerName).toBe(userInfo().username);
    expect(properties.modifiedAtMs).toBeGreaterThan(0);
    expect(properties.accessedAtMs).toBeGreaterThan(0);
  });

  it("describes a directory as a folder with no content type", async () => {
    const dir = path.join(root, "docs");
    await mkdir(dir);

    const properties = await pathProperties({ path: dir });

    expect(properties.kind).toBe("directory");
    expect(properties.contentType).toBeNull();
    expect(properties.modeText.startsWith("d")).toBe(true);
  });

  it("describes the hard root itself, which resolveLink refuses", async () => {
    const properties = await pathProperties({ path: "" });

    expect(properties.path).toBe(root);
    expect(properties.kind).toBe("directory");
    // §6 rule 5 makes the root untouchable for mutations; reading about it is
    // still what the empty-space menu asks for when the panel sits there.
    expect(properties.parentPath).toBeNull();
  });

  it("describes a symlink itself, and reports where it points", async () => {
    await writeFile(path.join(root, "real.txt"), "abc");
    const link = path.join(root, "link.txt");
    await symlink(path.join(root, "real.txt"), link);

    const properties = await pathProperties({ path: link });

    expect(properties.kind).toBe("symlink");
    expect(properties.targetKind).toBe("file");
    expect(properties.isSymlink).toBe(true);
    expect(properties.escapesRoot).toBe(false);
    expect(properties.linkTarget).toBe(path.join(root, "real.txt"));
    expect(properties.linkTargetPath).toBe(path.join(root, "real.txt"));
    // The link's own size is the length of its target string, not the file's.
    expect(properties.sizeBytes).not.toBe(3);
  });

  it("names a link out of the root but never resolves it", async () => {
    await writeFile(path.join(outside, "secret.txt"), "nope");
    const link = path.join(root, "escape");
    await symlink(path.join(outside, "secret.txt"), link);

    const properties = await pathProperties({ path: link });

    expect(properties.escapesRoot).toBe(true);
    expect(properties.targetKind).toBeNull();
    expect(properties.linkTarget).toBe(path.join(outside, "secret.txt"));
    expect(properties.linkTargetPath).toBeNull();
  });

  it("reports a broken link without failing", async () => {
    const link = path.join(root, "dangling");
    await symlink(path.join(root, "gone.txt"), link);

    const properties = await pathProperties({ path: link });

    expect(properties.kind).toBe("symlink");
    expect(properties.targetKind).toBeNull();
    expect(properties.linkTargetPath).toBeNull();
  });

  it("refuses a path outside the hard root", async () => {
    await writeFile(path.join(outside, "secret.txt"), "nope");
    await expectCode(pathProperties({ path: path.join(outside, "secret.txt") }), "path_escape");
  });

  it("reports not_found for a path that is not there", async () => {
    await expectCode(pathProperties({ path: "gone.txt" }), "not_found");
  });
});

/* ------------------------------------------------------------------ */

describe("directorySize", () => {
  it("adds up a whole subtree and counts what it saw", async () => {
    await writeFile(path.join(root, "a.bin"), Buffer.alloc(100));
    await mkdir(path.join(root, "sub", "deeper"), { recursive: true });
    await writeFile(path.join(root, "sub", "b.bin"), Buffer.alloc(200));
    await writeFile(path.join(root, "sub", "deeper", "c.bin"), Buffer.alloc(300));

    const result = await directorySize({ path: "" });

    expect(result.sizeBytes).toBe(600);
    expect(result.fileCount).toBe(3);
    expect(result.directoryCount).toBe(2);
    expect(result.partial).toBe(false);
    expect(result.stoppedBy).toBeNull();
    expect(result.path).toBe(root);
  });

  it("counts hidden files — a folder's size includes its dot-files", async () => {
    await writeFile(path.join(root, ".hidden"), Buffer.alloc(64));

    const result = await directorySize({ path: "" });

    expect(result.sizeBytes).toBe(64);
    expect(result.fileCount).toBe(1);
  });

  it("never follows a symlink, so a link to an ancestor cannot loop", async () => {
    await mkdir(path.join(root, "sub"));
    await writeFile(path.join(root, "sub", "a.bin"), Buffer.alloc(50));
    await symlink(root, path.join(root, "sub", "loop"));
    await symlink(path.join(root, "sub", "a.bin"), path.join(root, "sub", "alias"));

    const result = await directorySize({ path: "" });

    expect(result.sizeBytes).toBe(50);
    expect(result.fileCount).toBe(1);
    expect(result.partial).toBe(false);
  });

  it("skips the staging directory", async () => {
    await mkdir(path.join(root, STAGING_DIR_NAME, "uploads"), { recursive: true });
    await writeFile(path.join(root, STAGING_DIR_NAME, "uploads", "part"), Buffer.alloc(9999));
    await writeFile(path.join(root, "real.bin"), Buffer.alloc(10));

    const result = await directorySize({ path: "" });

    expect(result.sizeBytes).toBe(10);
    expect(result.fileCount).toBe(1);
    expect(result.directoryCount).toBe(0);
  });

  it("stops descending past the depth limit and says the answer is partial", async () => {
    // One level deeper than the walk goes: the file at the bottom is the one
    // thing the total is allowed to miss.
    const depth = DIRECTORY_SIZE_MAX_DEPTH + 1;
    let current = root;
    for (let level = 0; level < depth; level += 1) {
      current = path.join(current, `d${String(level)}`);
    }
    await mkdir(current, { recursive: true });
    await writeFile(path.join(current, "deep.bin"), Buffer.alloc(4096));
    await writeFile(path.join(root, "shallow.bin"), Buffer.alloc(8));

    const result = await directorySize({ path: "" });

    expect(result.partial).toBe(true);
    expect(result.stoppedBy).toBe("depth");
    // The rest of the tree is still counted: depth prunes one branch, it does
    // not abandon the walk.
    expect(result.sizeBytes).toBe(8);
  });

  it("keeps walking the siblings of a branch it could not read", async () => {
    const locked = path.join(root, "locked");
    await mkdir(locked);
    await writeFile(path.join(locked, "inner.bin"), Buffer.alloc(1000));
    await chmod(locked, 0o000);
    await writeFile(path.join(root, "readable.bin"), Buffer.alloc(7));

    const result = await directorySize({ path: "" });
    await chmod(locked, 0o755); // so afterEach can remove it

    // Running as root defeats the point of the fixture: it can read anything.
    if (userInfo().uid === 0) {
      expect(result.sizeBytes).toBe(1007);
      return;
    }
    expect(result.sizeBytes).toBe(7);
    expect(result.directoryCount).toBe(1);
  });

  it("refuses a file, and a path outside the hard root", async () => {
    await writeFile(path.join(root, "a.txt"), "x");
    await expectCode(directorySize({ path: "a.txt" }), "not_a_directory");
    await expectCode(directorySize({ path: outside }), "path_escape");
  });
});
