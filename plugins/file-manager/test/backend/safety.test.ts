// test/backend/safety.test.ts — delete goes to the Trash, overwrite trashes the
// old entry, and protected locations (~/.ssh, ~/.claude, …) refuse mutations.
//
// Every test runs against an mkdtemp root (initRoot) and setTrashOverrides, so
// the "home" Trash is `<tmp>/.Trash` or `<tmp>/.local/share/Trash` — the real
// home and the real Trash are never touched.
import {
  lstat,
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  readlink,
  realpath,
  rm,
  symlink,
  writeFile,
} from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { createFakePluginHost, type FakePluginHarness } from "@get-bb/plugin-sdk/testing";

import { PLUGIN_ID, STAGING_DIR_NAME } from "../../contract";
import { createArchives, type ArchivesModule } from "../../src/archives";
import { isFileManagerError } from "../../src/errors";
import { createJobs, type JobsModule } from "../../src/jobs";
import { listDir } from "../../src/listing";
import {
  copyEntries,
  createFolder,
  deleteEntries,
  moveEntries,
  renameEntry,
} from "../../src/mutations";
import { PROTECTED_PATHS, parseExtraProtectedPaths, setSafetyPolicy } from "../../src/protect";
import { initRoot } from "../../src/root";
import { setTrashOverrides } from "../../src/trash";
import { createUploads, type UploadsModule } from "../../src/uploads";
import { makeZip } from "./zip-writer";

let root = "";
let outside = "";
let bb: BbPluginApi;
let harness: FakePluginHarness;
let uploads: UploadsModule;
let jobs: JobsModule;
let archives: ArchivesModule;

async function exists(target: string): Promise<boolean> {
  try {
    await lstat(target);
    return true;
  } catch {
    return false;
  }
}

async function rejection(promise: Promise<unknown>): Promise<{ code: string; message: string }> {
  const error: unknown = await promise.then(
    () => {
      throw new Error("expected the call to reject");
    },
    (reason: unknown) => reason,
  );
  expect(isFileManagerError(error)).toBe(true);
  return error as { code: string; message: string };
}

async function expectProtected(promise: Promise<unknown>): Promise<void> {
  const error = await rejection(promise);
  expect(error.code).toBe("protected_path");
  expect(error.message).toMatch(/protected location/u);
}

function body(data: Uint8Array): ReadableStream<Uint8Array> {
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(data);
      controller.close();
    },
  });
}

async function upload(dirPath: string, fileName: string, text: string) {
  const bytes = new TextEncoder().encode(text);
  const created = await uploads.uploadCreate({
    dirPath,
    fileName,
    sizeBytes: bytes.length,
    lastModifiedMs: Date.now(),
    relativeDir: "",
  });
  await uploads.writeChunk({ uploadId: created.uploadId, offset: 0, body: body(bytes) });
  return created.uploadId;
}

const macTrash = (): string => path.join(root, ".Trash");

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "fm-safety-")));
  outside = await realpath(await mkdtemp(path.join(tmpdir(), "fm-safety-out-")));
  await initRoot(root);
  setTrashOverrides({ platform: "darwin" });
  setSafetyPolicy({ permanentDelete: false, extraProtectedPaths: "" });
  const host = createFakePluginHost({ pluginId: PLUGIN_ID });
  bb = host.bb;
  harness = host.harness;
  uploads = await createUploads(bb, { settings: { chunkSizeBytes: () => 8 * 1024 * 1024 } });
  jobs = createJobs(bb);
  archives = await createArchives(bb, { jobs });
});

afterEach(async () => {
  setTrashOverrides({});
  setSafetyPolicy({ permanentDelete: false, extraProtectedPaths: "" });
  await harness.dispose();
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

/* ------------------------------------------------------------------ */
/* delete → Trash                                                      */
/* ------------------------------------------------------------------ */

describe("delete moves to the Trash", () => {
  it("moves a file and a folder into <home>/.Trash on macOS, contents intact", async () => {
    await writeFile(path.join(root, "notes.txt"), "keep me");
    await mkdir(path.join(root, "docs", "deep"), { recursive: true });
    await writeFile(path.join(root, "docs", "deep", "a.md"), "a");

    const result = await deleteEntries(bb, {
      paths: [path.join(root, "notes.txt"), path.join(root, "docs")],
      recursive: true,
    });

    expect(result.failed).toEqual([]);
    expect(await exists(path.join(root, "notes.txt"))).toBe(false);
    expect(await exists(path.join(root, "docs"))).toBe(false);
    expect(await readFile(path.join(macTrash(), "notes.txt"), "utf8")).toBe("keep me");
    expect(await readFile(path.join(macTrash(), "docs", "deep", "a.md"), "utf8")).toBe("a");
  });

  it("never overwrites something already in the Trash: collisions get a new name", async () => {
    for (const content of ["one", "two", "three"]) {
      await writeFile(path.join(root, "report.txt"), content);
      const result = await deleteEntries(bb, {
        paths: [path.join(root, "report.txt")],
        recursive: true,
      });
      expect(result.failed).toEqual([]);
    }
    for (const dotfile of ["first", "second"]) {
      await writeFile(path.join(root, ".hidden"), dotfile);
      await deleteEntries(bb, { paths: [path.join(root, ".hidden")], recursive: true });
    }

    expect((await readdir(macTrash())).sort()).toEqual(
      [".hidden", ".hidden 2", "report 2.txt", "report 3.txt", "report.txt"].sort(),
    );
    expect(await readFile(path.join(macTrash(), "report.txt"), "utf8")).toBe("one");
    expect(await readFile(path.join(macTrash(), "report 2.txt"), "utf8")).toBe("two");
    expect(await readFile(path.join(macTrash(), "report 3.txt"), "utf8")).toBe("three");
    expect(await readFile(path.join(macTrash(), ".hidden 2"), "utf8")).toBe("second");
  });

  it("trashes a symlink as a link and never follows it", async () => {
    await writeFile(path.join(outside, "target.txt"), "outside");
    await mkdir(path.join(root, "real-dir"));
    await writeFile(path.join(root, "real-dir", "inner.txt"), "inner");
    await symlink(path.join(outside, "target.txt"), path.join(root, "file-link"));
    await symlink(path.join(root, "real-dir"), path.join(root, "dir-link"));

    const result = await deleteEntries(bb, {
      paths: [path.join(root, "file-link"), path.join(root, "dir-link")],
      recursive: true,
    });

    expect(result.failed).toEqual([]);
    expect((await lstat(path.join(macTrash(), "file-link"))).isSymbolicLink()).toBe(true);
    expect(await readlink(path.join(macTrash(), "file-link"))).toBe(path.join(outside, "target.txt"));
    expect((await lstat(path.join(macTrash(), "dir-link"))).isSymbolicLink()).toBe(true);
    expect(await readFile(path.join(outside, "target.txt"), "utf8")).toBe("outside");
    expect(await readFile(path.join(root, "real-dir", "inner.txt"), "utf8")).toBe("inner");
  });

  it("keeps the non-recursive contract: a non-empty folder is refused", async () => {
    await mkdir(path.join(root, "full"));
    await writeFile(path.join(root, "full", "x"), "x");
    await mkdir(path.join(root, "empty"));

    const result = await deleteEntries(bb, {
      paths: [path.join(root, "full"), path.join(root, "empty")],
      recursive: false,
    });

    expect(result.failed.map((row) => row.code)).toEqual(["not_empty"]);
    expect(result.succeeded).toEqual([path.join(root, "empty")]);
    expect(await exists(path.join(root, "full", "x"))).toBe(true);
    expect(await exists(path.join(macTrash(), "empty"))).toBe(true);
  });

  it("refuses to trash something already in the Trash, or the Trash itself", async () => {
    await writeFile(path.join(root, "gone.txt"), "x");
    await deleteEntries(bb, { paths: [path.join(root, "gone.txt")], recursive: true });

    const again = await deleteEntries(bb, {
      paths: [path.join(macTrash(), "gone.txt"), macTrash()],
      recursive: true,
    });
    expect(again.failed.map((row) => row.code)).toEqual(["unsupported", "unsupported"]);
    expect(await exists(path.join(macTrash(), "gone.txt"))).toBe(true);
  });

  it("follows the freedesktop spec on Linux: files/ plus an info/*.trashinfo", async () => {
    setTrashOverrides({ platform: "linux", dataHome: null });
    await writeFile(path.join(root, "a b%.txt"), "data");

    const result = await deleteEntries(bb, {
      paths: [path.join(root, "a b%.txt")],
      recursive: true,
    });

    expect(result.failed).toEqual([]);
    const trash = path.join(root, ".local", "share", "Trash");
    expect(await readFile(path.join(trash, "files", "a b%.txt"), "utf8")).toBe("data");
    const info = await readFile(path.join(trash, "info", "a b%.txt.trashinfo"), "utf8");
    expect(info).toMatch(/^\[Trash Info\]\n/u);
    expect(info).toContain(`Path=${root.split("/").map(encodeURIComponent).join("/")}/a%20b%25.txt\n`);
    expect(info).toMatch(/\nDeletionDate=\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\n$/u);
  });

  it("reserves a free name through the info file on Linux", async () => {
    setTrashOverrides({ platform: "linux", dataHome: path.join(root, "xdg") });
    const trash = path.join(root, "xdg", "Trash");
    await mkdir(path.join(trash, "info"), { recursive: true });
    // A stale info file with no payload still claims the name.
    await writeFile(path.join(trash, "info", "x.txt.trashinfo"), "[Trash Info]\n");
    await writeFile(path.join(root, "x.txt"), "x");

    await deleteEntries(bb, { paths: [path.join(root, "x.txt")], recursive: true });

    expect(await readdir(path.join(trash, "files"))).toEqual(["x 2.txt"]);
    expect(await exists(path.join(trash, "info", "x 2.txt.trashinfo"))).toBe(true);
  });

  it("never uses a Trash outside the root: XDG_DATA_HOME outside falls back to ~/.local/share", async () => {
    setTrashOverrides({ platform: "linux", dataHome: outside });
    await writeFile(path.join(root, "y.txt"), "y");

    await deleteEntries(bb, { paths: [path.join(root, "y.txt")], recursive: true });

    expect(await readdir(outside)).toEqual([]);
    expect(await exists(path.join(root, ".local", "share", "Trash", "files", "y.txt"))).toBe(true);
  });

  it("ignores a ~/.Trash symlinked outside the root and uses the plugin trash", async () => {
    await symlink(outside, path.join(root, ".Trash"));
    await writeFile(path.join(root, "z.txt"), "z");

    const result = await deleteEntries(bb, { paths: [path.join(root, "z.txt")], recursive: true });

    expect(result.failed).toEqual([]);
    expect(await readdir(outside)).toEqual([]);
    const pluginTrash = path.join(root, STAGING_DIR_NAME, "trash");
    expect(await readFile(path.join(pluginTrash, "files", "z.txt"), "utf8")).toBe("z");
    expect(await exists(path.join(pluginTrash, "info", "z.txt.trashinfo"))).toBe(true);
  });

  it("deletes permanently, as before, when permanentDelete is on", async () => {
    setSafetyPolicy({ permanentDelete: true });
    await mkdir(path.join(root, "old", "sub"), { recursive: true });
    await writeFile(path.join(root, "old", "sub", "f"), "f");

    const result = await deleteEntries(bb, { paths: [path.join(root, "old")], recursive: true });

    expect(result.failed).toEqual([]);
    expect(await exists(path.join(root, "old"))).toBe(false);
    expect(await exists(macTrash())).toBe(false);
  });
});

/* ------------------------------------------------------------------ */
/* overwrite → Trash                                                   */
/* ------------------------------------------------------------------ */

describe("overwrite moves the old entry to the Trash", () => {
  it("move with conflict: overwrite", async () => {
    await mkdir(path.join(root, "src"));
    await mkdir(path.join(root, "dst", "same"), { recursive: true });
    await writeFile(path.join(root, "src", "same"), "new");
    await writeFile(path.join(root, "dst", "same", "old.txt"), "old folder");

    const result = await moveEntries(bb, {
      paths: [path.join(root, "src", "same")],
      destinationDir: path.join(root, "dst"),
      conflict: "overwrite",
    });

    expect(result.failed).toEqual([]);
    expect(await readFile(path.join(root, "dst", "same"), "utf8")).toBe("new");
    expect(await readFile(path.join(macTrash(), "same", "old.txt"), "utf8")).toBe("old folder");
  });

  it("copy with conflict: overwrite", async () => {
    await mkdir(path.join(root, "dst"));
    await writeFile(path.join(root, "a.txt"), "new");
    await writeFile(path.join(root, "dst", "a.txt"), "old");

    const result = await copyEntries(bb, {
      paths: [path.join(root, "a.txt")],
      destinationDir: path.join(root, "dst"),
      conflict: "overwrite",
    });

    expect(result.failed).toEqual([]);
    expect(await readFile(path.join(root, "dst", "a.txt"), "utf8")).toBe("new");
    expect(await readFile(path.join(macTrash(), "a.txt"), "utf8")).toBe("old");
  });

  it("upload with conflict: overwrite", async () => {
    await writeFile(path.join(root, "same.txt"), "old");
    const uploadId = await upload(root, "same.txt", "xyz");

    await uploads.uploadFinish({ uploadId, conflict: "overwrite" });

    expect(await readFile(path.join(root, "same.txt"), "utf8")).toBe("xyz");
    expect(await readFile(path.join(macTrash(), "same.txt"), "utf8")).toBe("old");
  });

  it("extract with conflict: overwrite", async () => {
    await writeFile(path.join(root, "bundle.zip"), makeZip([{ name: "hello.txt", content: "new" }]));
    await writeFile(path.join(root, "hello.txt"), "old");

    const { job } = await archives.extractArchive({
      archivePath: path.join(root, "bundle.zip"),
      destinationDir: null,
      createSubfolder: false,
      conflict: "overwrite",
    });
    await archives.idle();

    expect(jobs.jobStatus({ jobId: job.jobId }).job?.state).toBe("done");
    expect(await readFile(path.join(root, "hello.txt"), "utf8")).toBe("new");
    expect(await readFile(path.join(macTrash(), "hello.txt"), "utf8")).toBe("old");
  });
});

/* ------------------------------------------------------------------ */
/* protected locations                                                 */
/* ------------------------------------------------------------------ */

describe("protected locations", () => {
  beforeEach(async () => {
    await mkdir(path.join(root, ".ssh"));
    await writeFile(path.join(root, ".ssh", "id_ed25519"), "secret");
    await mkdir(path.join(root, ".aws"));
    await writeFile(path.join(root, ".aws", "credentials"), "aws");
    await mkdir(path.join(root, ".claude"));
    await mkdir(path.join(root, ".claude-work"));
    await writeFile(path.join(root, ".zshrc"), "export PATH");
    await mkdir(path.join(root, "Library", "Keychains"), { recursive: true });
    await writeFile(path.join(root, "Library", "Keychains", "login.keychain-db"), "k");
    await mkdir(path.join(root, ".config", "gh"), { recursive: true });
    await writeFile(path.join(root, ".config", "gh", "hosts.yml"), "token");
    await writeFile(path.join(root, "notes.txt"), "plain");
  });

  it("covers the requested list", () => {
    for (const entry of [
      ".ssh", ".gnupg", ".aws", ".azure", ".kube", ".docker", ".config/gh", ".claude",
      ".claude-*", ".codex", ".bb", ".bb-*", ".netrc", ".npmrc", ".pypirc",
      ".git-credentials", ".zshrc", ".zprofile", ".bashrc", ".bash_profile", ".profile",
      "Library/Keychains", "Library/Application Support/com.apple.TCC",
    ]) {
      expect(PROTECTED_PATHS).toContain(entry);
    }
  });

  it("refuses delete of a protected path and of anything inside it", async () => {
    const result = await deleteEntries(bb, {
      paths: [
        path.join(root, ".ssh"),
        path.join(root, ".ssh", "id_ed25519"),
        path.join(root, ".zshrc"),
        path.join(root, ".claude-work"),
        path.join(root, "Library", "Keychains", "login.keychain-db"),
        path.join(root, ".config", "gh", "hosts.yml"),
      ],
      recursive: true,
    });
    expect(result.succeeded).toEqual([]);
    expect(result.failed.map((row) => row.code)).toEqual(Array(6).fill("protected_path"));
    expect(await readFile(path.join(root, ".ssh", "id_ed25519"), "utf8")).toBe("secret");
    expect(await exists(macTrash())).toBe(false);
  });

  it("refuses delete even when permanentDelete is on", async () => {
    setSafetyPolicy({ permanentDelete: true });
    const result = await deleteEntries(bb, { paths: [path.join(root, ".aws")], recursive: true });
    expect(result.failed.map((row) => row.code)).toEqual(["protected_path"]);
    expect(await exists(path.join(root, ".aws", "credentials"))).toBe(true);
  });

  it("refuses rename of a protected path, and renaming something onto one", async () => {
    await expectProtected(renameEntry(bb, { path: path.join(root, ".zshrc"), newName: "zshrc.bak" }));
    await expectProtected(
      renameEntry(bb, { path: path.join(root, ".ssh", "id_ed25519"), newName: "x" }),
    );
    await expectProtected(renameEntry(bb, { path: path.join(root, "notes.txt"), newName: ".bashrc" }));
    expect(await exists(path.join(root, "notes.txt"))).toBe(true);
  });

  it("refuses move out of, move into and copy into a protected path", async () => {
    const out = await moveEntries(bb, {
      paths: [path.join(root, ".aws", "credentials"), path.join(root, ".claude")],
      destinationDir: root + "/Library",
      conflict: "fail",
    });
    expect(out.failed.map((row) => row.code)).toEqual(["protected_path", "protected_path"]);

    const into = await moveEntries(bb, {
      paths: [path.join(root, "notes.txt")],
      destinationDir: path.join(root, ".claude"),
      conflict: "fail",
    });
    expect(into.failed.map((row) => row.code)).toEqual(["protected_path"]);

    const copied = await copyEntries(bb, {
      paths: [path.join(root, "notes.txt")],
      destinationDir: path.join(root, ".ssh"),
      conflict: "rename",
    });
    expect(copied.failed.map((row) => row.code)).toEqual(["protected_path"]);
    expect(await readdir(path.join(root, ".ssh"))).toEqual(["id_ed25519"]);
  });

  it("refuses delete, move and rename of a folder that contains a protected location", async () => {
    const del = await deleteEntries(bb, {
      paths: [path.join(root, "Library"), path.join(root, ".config")],
      recursive: true,
    });
    expect(del.failed.map((row) => row.code)).toEqual(["protected_path", "protected_path"]);
    expect(await exists(path.join(root, "Library", "Keychains", "login.keychain-db"))).toBe(true);

    await mkdir(path.join(root, "elsewhere"));
    const moved = await moveEntries(bb, {
      paths: [path.join(root, "Library")],
      destinationDir: path.join(root, "elsewhere"),
      conflict: "fail",
    });
    expect(moved.failed.map((row) => row.code)).toEqual(["protected_path"]);
    await expectProtected(renameEntry(bb, { path: path.join(root, ".config"), newName: "config-old" }));
    expect(await exists(path.join(root, ".config", "gh", "hosts.yml"))).toBe(true);
  });

  it("still deletes an ordinary folder beside protected ones", async () => {
    await mkdir(path.join(root, "Library", "Caches", "x"), { recursive: true });
    const result = await deleteEntries(bb, { paths: [path.join(root, "Library", "Caches")], recursive: true });
    expect(result.failed).toEqual([]);
    expect(await exists(path.join(root, "Library", "Caches"))).toBe(false);
  });

  it("refuses an overwrite of a protected file", async () => {
    await mkdir(path.join(root, "incoming"));
    await writeFile(path.join(root, "incoming", ".zshrc"), "rm -rf ~");

    const result = await moveEntries(bb, {
      paths: [path.join(root, "incoming", ".zshrc")],
      destinationDir: root,
      conflict: "overwrite",
    });

    expect(result.failed.map((row) => row.code)).toEqual(["protected_path"]);
    expect(await readFile(path.join(root, ".zshrc"), "utf8")).toBe("export PATH");
    expect(await exists(macTrash())).toBe(false);
  });

  it("refuses creating a folder inside a protected path", async () => {
    await expectProtected(createFolder(bb, { path: path.join(root, ".ssh"), name: "new" }));
  });

  it("refuses an upload into a protected path, at create and at finish", async () => {
    await expectProtected(
      uploads.uploadCreate({
        dirPath: path.join(root, ".ssh"),
        fileName: "authorized_keys",
        sizeBytes: 3,
        lastModifiedMs: 1,
        relativeDir: "",
      }),
    );
    await expectProtected(
      uploads.uploadCreate({
        dirPath: root,
        fileName: ".npmrc",
        sizeBytes: 3,
        lastModifiedMs: 1,
        relativeDir: "",
      }),
    );
    // A session created before the setting changed is refused at finish.
    const uploadId = await upload(root, "later.txt", "abc");
    setSafetyPolicy({ extraProtectedPaths: "later.txt" });
    await expectProtected(uploads.uploadFinish({ uploadId, conflict: "overwrite" }));
    expect(await exists(path.join(root, "later.txt"))).toBe(false);
  });

  it("refuses extracting into a protected path, or an archive member landing on one", async () => {
    await writeFile(path.join(root, "keys.zip"), makeZip([{ name: "id_ed25519", content: "evil" }]));
    await expectProtected(
      archives.extractArchive({
        archivePath: path.join(root, "keys.zip"),
        destinationDir: path.join(root, ".claude-work"),
        createSubfolder: false,
        conflict: "overwrite",
      }),
    );

    await writeFile(path.join(root, "dots.zip"), makeZip([{ name: ".zshrc", content: "evil" }]));
    const { job } = await archives.extractArchive({
      archivePath: path.join(root, "dots.zip"),
      destinationDir: null,
      createSubfolder: false,
      conflict: "overwrite",
    });
    await archives.idle();
    const settled = jobs.jobStatus({ jobId: job.jobId }).job;
    expect(settled?.state).toBe("failed");
    expect(settled?.errorCode).toBe("protected_path");
    expect(await readFile(path.join(root, ".zshrc"), "utf8")).toBe("export PATH");
  });

  it("matches on the realpath: a symlinked alias cannot reach inside", async () => {
    await symlink(path.join(root, ".ssh"), path.join(root, "ssh-alias"));
    const result = await deleteEntries(bb, {
      paths: [path.join(root, "ssh-alias", "id_ed25519")],
      recursive: true,
    });
    expect(result.failed.map((row) => row.code)).toEqual(["protected_path"]);

    // The alias itself is just a link: trashing it leaves ~/.ssh alone.
    const link = await deleteEntries(bb, { paths: [path.join(root, "ssh-alias")], recursive: true });
    expect(link.failed).toEqual([]);
    expect(await readFile(path.join(root, ".ssh", "id_ed25519"), "utf8")).toBe("secret");
  });

  it("protects the real folder behind a protected symlink (dotfiles repos)", async () => {
    await mkdir(path.join(root, "dotfiles", "gnupg"), { recursive: true });
    await writeFile(path.join(root, "dotfiles", "gnupg", "pubring.kbx"), "ring");
    await symlink(path.join(root, "dotfiles", "gnupg"), path.join(root, ".gnupg"));

    const result = await deleteEntries(bb, {
      paths: [path.join(root, "dotfiles", "gnupg", "pubring.kbx")],
      recursive: true,
    });
    expect(result.failed.map((row) => row.code)).toEqual(["protected_path"]);
  });

  it.runIf(process.platform === "darwin")("matches case-insensitively on macOS", async () => {
    // APFS is case-insensitive by default; ~/.SSH is ~/.ssh.
    const result = await deleteEntries(bb, {
      paths: [path.join(root, ".SSH", "id_ed25519")],
      recursive: true,
    });
    expect(result.failed.map((row) => row.code)).toEqual(["protected_path"]);
  });

  it("honours extraProtectedPaths", async () => {
    await mkdir(path.join(root, "secrets"));
    await writeFile(path.join(root, "secrets", "vault.txt"), "v");
    setSafetyPolicy({ extraProtectedPaths: " secrets , ~/.config/op/ ,../escape" });

    const result = await deleteEntries(bb, {
      paths: [path.join(root, "secrets", "vault.txt")],
      recursive: true,
    });
    expect(result.failed.map((row) => row.code)).toEqual(["protected_path"]);
    expect(parseExtraProtectedPaths(" secrets , ~/.config/op/ ,../escape")).toEqual([
      "secrets",
      ".config/op",
    ]);
  });

  it("leaves ordinary paths and reads alone", async () => {
    const listing = await listDir({ path: path.join(root, ".ssh"), showHidden: true });
    expect(listing.entries.map((entry) => entry.name)).toEqual(["id_ed25519"]);

    // Only the protected path and its descendants: a sibling under .config is fine.
    await writeFile(path.join(root, ".config", "other.toml"), "x");
    const result = await deleteEntries(bb, {
      paths: [path.join(root, ".config", "other.toml"), path.join(root, "notes.txt")],
      recursive: true,
    });
    expect(result.failed).toEqual([]);
  });
});
