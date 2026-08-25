// §10.2 — resolving a file link into "which folder should open".
//
// The interesting half is the missing target: an agent writes a glob or a path
// that has since moved, and answering "not found" would be useless. These
// cover the walk up to the nearest existing folder, the glob hint the panel
// filters on, and the one case that is still a refusal — a path outside the
// hard root.
import { mkdir, mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { isFileManagerError } from "../../src/errors";
import { locateFile, type FileOpenerSource } from "../../src/locate";
import { initRoot } from "../../src/root";

let root = "";
let outside = "";

const HOST_SOURCE: FileOpenerSource = {
  kind: "host",
  threadId: null,
  environmentId: null,
  projectId: null,
};

/** Only the two SDK areas locate.ts can reach, stubbed per test. */
function fakeBb(overrides: {
  environmentPath?: string | null;
  storageRootPath?: string;
}): BbPluginApi {
  return {
    sdk: {
      environments: {
        get: vi.fn(async () => ({
          path: overrides.environmentPath ?? null,
          hostId: "host_1",
        })),
      },
      threads: {
        storagePaths: vi.fn(async () => ({
          storageRootPath: overrides.storageRootPath ?? root,
        })),
      },
    },
  } as unknown as BbPluginApi;
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "fm-locate-")));
  outside = await realpath(await mkdtemp(path.join(tmpdir(), "fm-outside-")));
  await initRoot(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe("locateFile", () => {
  it("answers a file that exists with its own folder and name", async () => {
    await mkdir(path.join(root, "notes"), { recursive: true });
    await writeFile(path.join(root, "notes", "todo.md"), "# todo\n");

    const located = await locateFile(fakeBb({}), {
      path: path.join(root, "notes", "todo.md"),
      source: HOST_SOURCE,
    });

    expect(located).toEqual({
      dirPath: path.join(root, "notes"),
      absolutePath: path.join(root, "notes", "todo.md"),
      name: "todo.md",
      exists: true,
      isDirectory: false,
      matchHint: null,
    });
  });

  it("answers a folder link with the folder itself and nothing to select", async () => {
    await mkdir(path.join(root, "notes"), { recursive: true });

    const located = await locateFile(fakeBb({}), {
      path: path.join(root, "notes"),
      source: HOST_SOURCE,
    });

    expect(located.dirPath).toBe(path.join(root, "notes"));
    expect(located.isDirectory).toBe(true);
    expect(located.exists).toBe(true);
    expect(located.name).toBe("");
  });

  it("walks up to the nearest existing folder when the file is gone", async () => {
    await mkdir(path.join(root, "backups"), { recursive: true });

    const located = await locateFile(fakeBb({}), {
      path: path.join(root, "backups", "gone.md"),
      source: HOST_SOURCE,
    });

    expect(located.dirPath).toBe(path.join(root, "backups"));
    expect(located.exists).toBe(false);
    expect(located.name).toBe("gone.md");
    // An exact name that is simply missing filters to an empty folder, which
    // says less than the folder does.
    expect(located.matchHint).toBeNull();
  });

  it("resolves a relative host path under the root, not the server's cwd", async () => {
    await mkdir(path.join(root, "notes"), { recursive: true });

    const located = await locateFile(fakeBb({}), {
      path: "notes/todo.md",
      source: HOST_SOURCE,
    });

    expect(located.absolutePath).toBe(path.join(root, "notes", "todo.md"));
    expect(located.dirPath).toBe(path.join(root, "notes"));
  });

  it("keeps walking past folders that do not exist either", async () => {
    const located = await locateFile(fakeBb({}), {
      path: path.join(root, "no", "such", "tree", "file.txt"),
      source: HOST_SOURCE,
    });

    expect(located.dirPath).toBe(root);
    expect(located.exists).toBe(false);
  });

  it("turns a glob name into a filter the panel can use", async () => {
    await mkdir(path.join(root, "backups"), { recursive: true });

    const located = await locateFile(fakeBb({}), {
      path: path.join(root, "backups", "*-otlozhena-2026-08-25.md"),
      source: HOST_SOURCE,
    });

    expect(located.dirPath).toBe(path.join(root, "backups"));
    expect(located.exists).toBe(false);
    expect(located.matchHint).toBe("-otlozhena-2026-08-25.md");
  });

  it("picks the longest literal run out of a multi-glob name", async () => {
    const located = await locateFile(fakeBb({}), {
      path: path.join(root, "*-report-2026*.csv"),
      source: HOST_SOURCE,
    });

    expect(located.matchHint).toBe("-report-2026");
  });

  it("refuses a path outside the hard root instead of walking up to it", async () => {
    const error: unknown = await locateFile(fakeBb({}), {
      path: path.join(outside, "secrets.txt"),
      source: HOST_SOURCE,
    }).then(
      () => {
        throw new Error("expected path_escape");
      },
      (reason: unknown) => reason,
    );

    expect(isFileManagerError(error)).toBe(true);
    expect((error as { code: string }).code).toBe("path_escape");
  });

  it("resolves a workspace path against the environment's checkout", async () => {
    const checkout = path.join(root, "worktree");
    await mkdir(path.join(checkout, "src"), { recursive: true });
    await writeFile(path.join(checkout, "src", "index.ts"), "export {};\n");

    const located = await locateFile(fakeBb({ environmentPath: checkout }), {
      path: "src/index.ts",
      source: {
        kind: "workspace",
        threadId: "thr_1",
        environmentId: "env_1",
        projectId: "proj_1",
      },
    });

    expect(located.absolutePath).toBe(path.join(checkout, "src", "index.ts"));
    expect(located.dirPath).toBe(path.join(checkout, "src"));
    expect(located.exists).toBe(true);
  });

  it("says so when the environment has no checkout on disk", async () => {
    const error: unknown = await locateFile(fakeBb({ environmentPath: null }), {
      path: "src/index.ts",
      source: {
        kind: "workspace",
        threadId: "thr_1",
        environmentId: "env_1",
        projectId: null,
      },
    }).then(
      () => {
        throw new Error("expected unsupported");
      },
      (reason: unknown) => reason,
    );

    expect((error as { code: string }).code).toBe("unsupported");
  });

  it("resolves a thread-storage path against the thread's storage root", async () => {
    const storage = path.join(root, "storage");
    await mkdir(path.join(storage, "Attachments"), { recursive: true });
    await writeFile(path.join(storage, "Attachments", "shot.png"), "png");

    const located = await locateFile(fakeBb({ storageRootPath: storage }), {
      path: "Attachments/shot.png",
      source: {
        kind: "thread-storage",
        threadId: "thr_1",
        environmentId: null,
        projectId: null,
      },
    });

    expect(located.dirPath).toBe(path.join(storage, "Attachments"));
    expect(located.name).toBe("shot.png");
    expect(located.exists).toBe(true);
  });
});
