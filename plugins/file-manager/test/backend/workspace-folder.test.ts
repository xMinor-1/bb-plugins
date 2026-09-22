// `$WORKTREE` start folder — resolving it to a folder the panel may open.
//
// Every miss must come back as null rather than a throw, because the panel
// reads null as "use the ordinary rules". The worktree beats the project, the
// default project source beats the others, and nothing outside the hard root
// is ever returned.
import { mkdir, mkdtemp, realpath, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

import type { BbPluginApi } from "@get-bb/plugin-sdk";

import { resolveWorkspaceFolder } from "../../src/locate";
import { initRoot } from "../../src/root";

let root = "";
let outside = "";

interface FakeSource {
  path: string;
  isDefault: boolean;
}

function fakeBb(options: {
  environmentId?: string | null;
  environmentPath?: string | null;
  threadProjectId?: string;
  threadFails?: boolean;
  sources?: FakeSource[];
  projectFails?: boolean;
}): BbPluginApi & { projectsGet: ReturnType<typeof vi.fn> } {
  const projectsGet = vi.fn(async () => {
    if (options.projectFails === true) throw new Error("project not found");
    return { sources: options.sources ?? [] };
  });
  return {
    projectsGet,
    log: { warn: vi.fn(), info: vi.fn(), error: vi.fn(), debug: vi.fn() },
    sdk: {
      threads: {
        get: vi.fn(async () => {
          if (options.threadFails === true) throw new Error("thread not found");
          return {
            projectId: options.threadProjectId ?? "prj_thread",
            environmentId: "environmentId" in options ? options.environmentId : "env_1",
          };
        }),
      },
      environments: {
        get: vi.fn(async () => ({ path: options.environmentPath ?? null })),
      },
      projects: { get: projectsGet },
    },
  } as unknown as BbPluginApi & { projectsGet: ReturnType<typeof vi.fn> };
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "fm-follow-")));
  outside = await realpath(await mkdtemp(path.join(tmpdir(), "fm-follow-out-")));
  await initRoot(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe("resolveWorkspaceFolder", () => {
  it("answers with the thread's worktree first", async () => {
    const worktree = path.join(root, "wt", "feature");
    const project = path.join(root, "repo");
    await mkdir(worktree, { recursive: true });
    await mkdir(project, { recursive: true });
    const bb = fakeBb({
      environmentPath: worktree,
      sources: [{ path: project, isDefault: true }],
    });

    const answer = await resolveWorkspaceFolder(bb, { threadId: "thr_1", projectId: null });

    expect(answer).toEqual({ path: worktree, source: "worktree" });
    expect(bb.projectsGet).not.toHaveBeenCalled();
  });

  it("falls back to the thread's own project when the worktree is gone", async () => {
    const project = path.join(root, "repo");
    await mkdir(project, { recursive: true });
    const bb = fakeBb({
      environmentPath: path.join(root, "destroyed"),
      threadProjectId: "prj_from_thread",
      sources: [{ path: project, isDefault: true }],
    });

    const answer = await resolveWorkspaceFolder(bb, { threadId: "thr_1", projectId: null });

    expect(answer).toEqual({ path: project, source: "project" });
    expect(bb.projectsGet).toHaveBeenCalledWith({ projectId: "prj_from_thread" });
  });

  it("uses the project alone when there is no thread", async () => {
    const other = path.join(root, "other");
    const main = path.join(root, "main");
    await mkdir(other, { recursive: true });
    await mkdir(main, { recursive: true });
    const bb = fakeBb({
      sources: [
        { path: other, isDefault: false },
        { path: main, isDefault: true },
      ],
    });

    const answer = await resolveWorkspaceFolder(bb, { threadId: null, projectId: "prj_1" });

    expect(answer).toEqual({ path: main, source: "project" });
  });

  it("never returns a folder outside the home folder", async () => {
    const bb = fakeBb({
      environmentPath: outside,
      sources: [{ path: outside, isDefault: true }],
    });

    const answer = await resolveWorkspaceFolder(bb, { threadId: "thr_1", projectId: null });

    expect(answer).toEqual({ path: null, source: null });
  });

  it("answers null instead of throwing when bb cannot find anything", async () => {
    const bb = fakeBb({ threadFails: true, projectFails: true });

    await expect(
      resolveWorkspaceFolder(bb, { threadId: "thr_1", projectId: "prj_1" }),
    ).resolves.toEqual({ path: null, source: null });
    await expect(
      resolveWorkspaceFolder(bb, { threadId: null, projectId: null }),
    ).resolves.toEqual({ path: null, source: null });
  });
});
