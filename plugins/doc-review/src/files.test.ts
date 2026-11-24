import type { BbPluginApi } from "@get-bb/plugin-sdk";
import { describe, expect, it } from "vitest";
import { DocFiles, joinPath, normalizeAbsolute } from "./files";

const bb = {
  sdk: { system: { config: async () => ({ primaryHostId: "host-linux" }) } },
} as unknown as BbPluginApi;

describe("Windows paths", () => {
  it("get one spelling: forward slashes and an upper-case drive", () => {
    expect(normalizeAbsolute("c:\\Users\\me\\Reports\\..\\audit.html")).toBe("C:/Users/me/audit.html");
    expect(normalizeAbsolute("D:/Docs/./plan.md")).toBe("D:/Docs/plan.md");
  });

  it("leave POSIX paths, backslashes in names included, as they were", () => {
    expect(normalizeAbsolute("/home/me/a/../notes.md")).toBe("/home/me/notes.md");
    expect(joinPath("/home/me/repo", "odd\\name.md")).toBe("/home/me/repo/odd\\name.md");
  });

  it("join under a Windows checkout without leaving it", () => {
    expect(joinPath("C:\\Users\\me\\repo", "docs\\plan.md")).toBe("C:/Users/me/repo/docs/plan.md");
    expect(() => joinPath("C:\\Users\\me\\repo", "..\\secrets.txt")).toThrow("leaves its workspace");
  });

  it("open from a Windows host on a Linux or macOS server", async () => {
    const files = new DocFiles(bb, "/tmp/unused");
    const resolved = await files.resolve("d:\\Documents\\reports\\..\\audit.html", {
      kind: "host",
      experimental_hostId: "host-windows",
      threadId: null,
      environmentId: null,
      projectId: null,
    });
    expect(resolved).toEqual({ absPath: "D:/Documents/audit.html", hostId: "host-windows" });
  });

  it("still refuses a relative path", async () => {
    const files = new DocFiles(bb, "/tmp/unused");
    await expect(
      files.resolve("Documents\\audit.html", {
        kind: "host",
        experimental_hostId: "host-windows",
        threadId: null,
        environmentId: null,
        projectId: null,
      }),
    ).rejects.toThrow("Expected an absolute path");
  });
});

describe("files on another machine", () => {
  function remote() {
    let reads = 0;
    const content = Buffer.from("<p>report</p>").toString("base64");
    const remoteBb = {
      sdk: {
        system: { config: async () => ({ primaryHostId: "host-linux" }) },
        files: {
          read: async () => {
            reads += 1;
            return { content, contentEncoding: "base64", sizeBytes: 13, sha256: "a".repeat(64) };
          },
        },
      },
    } as unknown as BbPluginApi;
    return { files: new DocFiles(remoteBb, "/tmp/unused"), reads: () => reads };
  }
  const doc = { id: "d_1", hostId: "host-mac", absPath: "/Users/me/report.html", kind: "html" as const };

  it("are read once for the version and the bytes of one open", async () => {
    const { files, reads } = remote();
    expect(await files.version(doc)).toBe(`h${"a".repeat(16)}`);
    expect((await files.readBytes(doc, 1024)).toString()).toBe("<p>report</p>");
    expect(await files.version(doc)).toBe(`h${"a".repeat(16)}`);
    expect(reads()).toBe(1);
  });

  it("are read again a moment later, so a change shows up", async () => {
    const { files, reads } = remote();
    const realNow = Date.now;
    try {
      let now = 1_000_000;
      Date.now = () => now;
      await files.version(doc);
      now += 2500;
      await files.version(doc);
      expect(reads()).toBe(2);
    } finally {
      Date.now = realNow;
    }
  });
});
