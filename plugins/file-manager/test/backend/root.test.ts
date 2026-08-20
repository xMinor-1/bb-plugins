// Path safety — the security core (§6). Everything here is an escape attempt.
// (§11.1 calls this table `paths.test.ts`; it is `root.test.ts` because the
// module under test is src/root.ts.)
import { mkdtemp, mkdir, realpath, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";

import { isFileManagerError } from "../../src/errors";
import {
  assertInside,
  assertNotInsideSelf,
  getRoot,
  getStagingDir,
  initRoot,
  isInside,
  isStagingPath,
  normalize,
  parentOf,
  resolveExisting,
  resolveExistingDir,
  resolveLink,
  resolveNew,
  validateName,
} from "../../src/root";

let root = "";
let outside = "";

/** Assert a rejection is a FileManagerError carrying exactly this code. */
async function expectCode(promise: Promise<unknown>, code: string): Promise<void> {
  const error: unknown = await promise.then(
    () => {
      throw new Error(`expected the call to reject with ${code}`);
    },
    (reason: unknown) => reason,
  );
  expect(isFileManagerError(error)).toBe(true);
  expect((error as { code: string }).code).toBe(code);
  expect((error as Error).message.startsWith(`${code}: `)).toBe(true);
}

beforeEach(async () => {
  root = await realpath(await mkdtemp(path.join(tmpdir(), "fm-root-")));
  outside = await realpath(await mkdtemp(path.join(tmpdir(), "fm-outside-")));
  await initRoot(root);
});

afterEach(async () => {
  await rm(root, { recursive: true, force: true });
  await rm(outside, { recursive: true, force: true });
});

describe("initRoot / getRoot", () => {
  it("realpaths the configured root once and exposes it", async () => {
    const linkToRoot = path.join(outside, "link-to-root");
    await symlink(root, linkToRoot);
    const resolved = await initRoot(linkToRoot);
    expect(resolved).toBe(root);
    expect(getRoot()).toBe(root);
  });

  it("derives the staging directory from the resolved root", () => {
    expect(getStagingDir()).toBe(path.join(root, ".bb-file-manager"));
    expect(isStagingPath(path.join(root, ".bb-file-manager"))).toBe(true);
    expect(isStagingPath(path.join(root, ".bb-file-manager", "uploads", "x.part"))).toBe(true);
    expect(isStagingPath(path.join(root, ".bb-file-manager-other"))).toBe(false);
  });
});

describe("assertInside", () => {
  it("accepts the root itself and anything below it", () => {
    expect(assertInside(root)).toBe(root);
    expect(assertInside(path.join(root, "a", "b"))).toBe(path.join(root, "a", "b"));
    expect(isInside(root)).toBe(true);
  });

  it("rejects a sibling that merely shares the root's string prefix", () => {
    expect(() => assertInside(`${root}-evil`)).toThrow(/^path_escape: /);
    expect(isInside(`${root}-evil`)).toBe(false);
  });

  it("rejects the parent directory and unrelated absolute paths", () => {
    expect(() => assertInside(path.dirname(root))).toThrow(/^path_escape: /);
    expect(() => assertInside("/etc")).toThrow(/^path_escape: /);
  });
});

describe("validateName", () => {
  it("accepts ordinary single components", () => {
    expect(validateName("report.txt")).toBe("report.txt");
    expect(validateName(".bashrc")).toBe(".bashrc");
    expect(validateName("тест 2024.tar.gz")).toBe("тест 2024.tar.gz");
  });

  it.each([
    ["", "empty"],
    [".", "dot"],
    ["..", "dot dot"],
    ["a/b", "separator"],
    ["/abs", "leading separator"],
    ["nul\u0000byte", "NUL"],
    ["tab\tname", "control character"],
    ["nl\nname", "newline"],
  ])("rejects %j (%s)", (name) => {
    expect(() => validateName(name)).toThrow(/^invalid_name: /);
  });

  it("counts UTF-8 bytes, not code units, for the 255-byte limit", () => {
    expect(() => validateName("a".repeat(255))).not.toThrow();
    expect(() => validateName("a".repeat(256))).toThrow(/^invalid_name: /);
    expect(() => validateName("a".repeat(300))).toThrow(/^invalid_name: /);
    // 127 two-byte characters = 254 bytes: fits. 128 = 256 bytes: does not.
    expect(() => validateName("é".repeat(127))).not.toThrow();
    expect(() => validateName("é".repeat(128))).toThrow(/^invalid_name: /);
  });

  it("does not fold unicode: NFC and NFD are different names", () => {
    const nfc = "é".normalize("NFC");
    const nfd = "é".normalize("NFD");
    expect(nfc).not.toBe(nfd);
    expect(validateName(nfc)).toBe(nfc);
    expect(validateName(nfd)).toBe(nfd);
  });
});

describe("normalize", () => {
  it("maps the empty string and ~ to the root", () => {
    expect(normalize("")).toBe(root);
    expect(normalize("~")).toBe(root);
  });

  it("expands ~/ under the root", () => {
    expect(normalize("~/docs/a.txt")).toBe(path.join(root, "docs", "a.txt"));
  });

  it("resolves relative input under the root and collapses . and ..", () => {
    expect(normalize("docs/../notes/a.txt")).toBe(path.join(root, "notes", "a.txt"));
    expect(normalize("./docs")).toBe(path.join(root, "docs"));
  });

  it("keeps absolute input absolute so that assertInside can reject it", () => {
    expect(normalize("/etc/passwd")).toBe("/etc/passwd");
    expect(normalize("../..")).toBe(path.resolve(root, "../.."));
  });
});

describe("resolveExisting", () => {
  it("accepts the root itself", async () => {
    await expect(resolveExisting("")).resolves.toBe(root);
    await expect(resolveExisting(root)).resolves.toBe(root);
    await expect(resolveExisting("~")).resolves.toBe(root);
  });

  it("resolves a real child", async () => {
    await mkdir(path.join(root, "docs"));
    await expect(resolveExisting("docs")).resolves.toBe(path.join(root, "docs"));
    await expect(resolveExisting(path.join(root, "docs"))).resolves.toBe(path.join(root, "docs"));
  });

  it("rejects an absolute path outside the root", async () => {
    await expectCode(resolveExisting("/etc"), "path_escape");
    await expectCode(resolveExisting("/etc/passwd"), "path_escape");
    await expectCode(resolveExisting(outside), "path_escape");
  });

  it("rejects .. segments that climb out of the root", async () => {
    await expectCode(resolveExisting("../.."), "path_escape");
    await expectCode(resolveExisting("docs/../../.."), "path_escape");
    await expectCode(resolveExisting("~/../.."), "path_escape");
  });

  it("does not decode percent-encoding — ~/..%2f is just a name", async () => {
    // The HTTP layer decodes; this layer must not, or %2f would turn into a
    // second separator after validation.
    expect(normalize("~/..%2f")).toBe(path.join(root, "..%2f"));
    await expectCode(resolveExisting("~/..%2f"), "not_found");
  });

  it("rejects a symlink inside the root that points at /etc", async () => {
    await symlink("/etc", path.join(root, "etc-link"));
    await expectCode(resolveExisting("etc-link"), "path_escape");
    await expectCode(resolveExisting("etc-link/passwd"), "path_escape");
  });

  it("rejects a symlink inside the root that points at another temp dir", async () => {
    await writeFile(path.join(outside, "secret.txt"), "s");
    await symlink(outside, path.join(root, "out-link"));
    await expectCode(resolveExisting("out-link"), "path_escape");
    await expectCode(resolveExisting("out-link/secret.txt"), "path_escape");
  });

  it("rejects escaping through a symlinked ancestor", async () => {
    await mkdir(path.join(outside, "deep"));
    await writeFile(path.join(outside, "deep", "anything"), "a");
    await symlink(path.join(outside, "deep"), path.join(root, "deep-link"));
    await expectCode(resolveExisting("deep-link/anything"), "path_escape");
  });

  it("accepts a symlink that stays inside the root, returning the target", async () => {
    await mkdir(path.join(root, "real"));
    await symlink(path.join(root, "real"), path.join(root, "alias"));
    await expect(resolveExisting("alias")).resolves.toBe(path.join(root, "real"));
  });

  it("reports missing paths as not_found and symlink loops as io_error", async () => {
    await expectCode(resolveExisting("nope"), "not_found");
    await symlink(path.join(root, "loop-b"), path.join(root, "loop-a"));
    await symlink(path.join(root, "loop-a"), path.join(root, "loop-b"));
    await expectCode(resolveExisting("loop-a"), "io_error");
  });

  it("resolveExistingDir refuses a regular file", async () => {
    await writeFile(path.join(root, "a.txt"), "x");
    await expectCode(resolveExistingDir("a.txt"), "not_a_directory");
  });
});

describe("resolveLink", () => {
  it("returns the link itself, never its target", async () => {
    await symlink("/etc", path.join(root, "etc-link"));
    const resolved = await resolveLink("etc-link");
    expect(resolved.path).toBe(path.join(root, "etc-link"));
    expect(resolved.lstat.isSymbolicLink()).toBe(true);
  });

  it("realpaths the parent chain, so a symlinked ancestor cannot escape", async () => {
    await mkdir(path.join(outside, "deep"));
    await writeFile(path.join(outside, "deep", "victim.txt"), "v");
    await symlink(path.join(outside, "deep"), path.join(root, "deep-link"));
    await expectCode(resolveLink("deep-link/victim.txt"), "path_escape");
  });

  it("refuses the root itself (§6 rule 5)", async () => {
    await expectCode(resolveLink(""), "path_escape");
    await expectCode(resolveLink(root), "path_escape");
    await expectCode(resolveLink("~"), "path_escape");
  });

  it("refuses .. as the final component and rejects absolute escapes", async () => {
    await mkdir(path.join(root, "docs"));
    await expectCode(resolveLink("docs/.."), "path_escape");
    await expectCode(resolveLink("/etc/passwd"), "path_escape");
  });

  it("reports a missing entry as not_found", async () => {
    await expectCode(resolveLink("ghost.txt"), "not_found");
  });
});

describe("resolveNew", () => {
  it("joins a validated name onto a resolved directory", async () => {
    await mkdir(path.join(root, "docs"));
    await expect(resolveNew("docs", "new.txt")).resolves.toBe(path.join(root, "docs", "new.txt"));
  });

  it("rejects names that are really paths", async () => {
    await expectCode(resolveNew("", "../escape"), "invalid_name");
    await expectCode(resolveNew("", ".."), "invalid_name");
    await expectCode(resolveNew("", "sub/child"), "invalid_name");
    await expectCode(resolveNew("", "/etc/passwd"), "invalid_name");
  });

  it("rejects a destination directory outside the root", async () => {
    await expectCode(resolveNew(outside, "new.txt"), "path_escape");
  });

  it("rejects a missing destination directory", async () => {
    await expectCode(resolveNew("ghost", "new.txt"), "not_found");
  });
});

describe("assertNotInsideSelf", () => {
  it("refuses a destination equal to or below the source", () => {
    const source = path.join(root, "src");
    expect(() => assertNotInsideSelf(source, source)).toThrow(/^destination_inside_source: /);
    expect(() => assertNotInsideSelf(source, path.join(source, "deep"))).toThrow(
      /^destination_inside_source: /,
    );
  });

  it("allows a sibling whose name shares the source prefix", () => {
    const source = path.join(root, "src");
    expect(() => assertNotInsideSelf(source, `${source}-2`)).not.toThrow();
    expect(() => assertNotInsideSelf(source, root)).not.toThrow();
  });
});

describe("parentOf", () => {
  it("is null for the root and the directory name otherwise", () => {
    expect(parentOf(root)).toBeNull();
    expect(parentOf(path.join(root, "a", "b"))).toBe(path.join(root, "a"));
  });
});
