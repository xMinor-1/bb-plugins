// @vitest-environment jsdom
import { describe, expect, it } from "vitest";

import {
  absoluteToSubPath,
  basename,
  breadcrumbs,
  decodeSubPath,
  dirname,
  encodeSubPath,
  isDescendant,
  isHiddenName,
  isInsideRoot,
  isRootPath,
  isSameOrDescendant,
  isSamePath,
  joinPath,
  normalizePath,
  parentPath,
  relativeDirOf,
  splitFileName,
  subPathToAbsolute,
  setClientRoot,
  toAbsolute,
  toRelative,
} from "../../lib/fm-paths";

/** The panel publishes the backend's root at bootstrap; tests do it by hand. */
const ROOT_PATH = "/home/coder";
setClientRoot(ROOT_PATH);

describe("normalizePath", () => {
  it("collapses separators and dot segments", () => {
    expect(normalizePath("/home//coder/./docs/")).toBe("/home/coder/docs");
    expect(normalizePath("/home/coder/docs/../notes")).toBe("/home/coder/notes");
    expect(normalizePath("/")).toBe("/");
    expect(normalizePath("/..")).toBe("/");
  });

  it("keeps relative input relative", () => {
    expect(normalizePath("docs/../notes")).toBe("notes");
    expect(normalizePath("../up")).toBe("../up");
  });
});

describe("toAbsolute", () => {
  it("mirrors the backend's normalize() rules (§6)", () => {
    expect(toAbsolute("")).toBe(ROOT_PATH);
    expect(toAbsolute("~")).toBe(ROOT_PATH);
    expect(toAbsolute("~/docs")).toBe(`${ROOT_PATH}/docs`);
    expect(toAbsolute("docs")).toBe(`${ROOT_PATH}/docs`);
    expect(toAbsolute("/etc")).toBe("/etc");
    expect(toAbsolute("/home/coder/docs/")).toBe(`${ROOT_PATH}/docs`);
  });

  it("resolves traversal lexically before anything else sees it", () => {
    expect(toAbsolute("../..")).toBe("/");
    expect(toAbsolute("docs/../../coder")).toBe("/home/coder");
  });
});

describe("toRelative", () => {
  it("is empty at the root and has no leading slash below it", () => {
    expect(toRelative(ROOT_PATH)).toBe("");
    expect(toRelative(`${ROOT_PATH}/a/b`)).toBe("a/b");
  });

  it("refuses to describe a path outside the root", () => {
    expect(toRelative("/etc/passwd")).toBe("");
    expect(toRelative("/home/coder2/x")).toBe("");
  });
});

describe("subPath round trip", () => {
  it("decodes per segment, as §8 requires", () => {
    expect(decodeSubPath("my%20docs/a%2Bb")).toBe("my docs/a+b");
    // A literal "/" inside a name is impossible, so per-segment decoding is safe.
    expect(decodeSubPath("%D0%BF%D0%B0%D0%BF%D0%BA%D0%B0/%23hash")).toBe("папка/#hash");
  });

  it("tolerates a malformed escape instead of throwing", () => {
    expect(decodeSubPath("100%/x")).toBe("100%/x");
  });

  it("round-trips names with ? # % and spaces", () => {
    const relative = "we ird/na#me?x/100%";
    expect(decodeSubPath(encodeSubPath(relative))).toBe(relative);
    expect(subPathToAbsolute(encodeSubPath(relative))).toBe(`${ROOT_PATH}/${relative}`);
    expect(absoluteToSubPath(`${ROOT_PATH}/${relative}`)).toBe(relative);
  });

  it("maps the empty subPath to the root", () => {
    expect(subPathToAbsolute("")).toBe(ROOT_PATH);
    expect(absoluteToSubPath(ROOT_PATH)).toBe("");
  });
});

describe("join / basename / dirname / parentPath", () => {
  it("joins and trims", () => {
    expect(joinPath(ROOT_PATH, "docs")).toBe(`${ROOT_PATH}/docs`);
    expect(joinPath(`${ROOT_PATH}/`, "docs", "a.txt")).toBe(`${ROOT_PATH}/docs/a.txt`);
    expect(joinPath(ROOT_PATH, "")).toBe(ROOT_PATH);
  });

  it("splits", () => {
    expect(basename("/home/coder/docs/a.txt")).toBe("a.txt");
    expect(basename("/home/coder/docs/")).toBe("docs");
    expect(basename("/")).toBe("/");
    expect(dirname("/home/coder/docs/a.txt")).toBe("/home/coder/docs");
    expect(dirname("/home")).toBe("/");
  });

  it("stops at the root", () => {
    expect(parentPath(`${ROOT_PATH}/a/b`)).toBe(`${ROOT_PATH}/a`);
    expect(parentPath(`${ROOT_PATH}/a`)).toBe(ROOT_PATH);
    expect(parentPath(ROOT_PATH)).toBeNull();
    expect(parentPath("/etc/passwd")).toBeNull();
  });
});

describe("containment", () => {
  it("knows the root", () => {
    expect(isRootPath(ROOT_PATH)).toBe(true);
    expect(isRootPath(`${ROOT_PATH}/a`)).toBe(false);
    expect(isInsideRoot(`${ROOT_PATH}/a`)).toBe(true);
    expect(isInsideRoot(ROOT_PATH)).toBe(true);
    expect(isInsideRoot("/home/coder2")).toBe(false);
    expect(isInsideRoot("/etc")).toBe(false);
  });

  it("does not treat a sibling with a shared prefix as a descendant", () => {
    expect(isDescendant("/home/coder/abc", "/home/coder/ab")).toBe(false);
    expect(isDescendant("/home/coder/ab/c", "/home/coder/ab")).toBe(true);
    expect(isDescendant("/home/coder/ab", "/home/coder/ab")).toBe(false);
    expect(isSameOrDescendant("/home/coder/ab", "/home/coder/ab")).toBe(true);
    expect(isSamePath("/home/coder/ab/", "/home/coder/ab")).toBe(true);
  });
});

describe("breadcrumbs", () => {
  it("starts at the root and walks down", () => {
    expect(breadcrumbs(`${ROOT_PATH}/a/b`)).toEqual([
      { name: "Home", path: ROOT_PATH, isRoot: true },
      { name: "a", path: `${ROOT_PATH}/a`, isRoot: false },
      { name: "b", path: `${ROOT_PATH}/a/b`, isRoot: false },
    ]);
    expect(breadcrumbs(ROOT_PATH)).toHaveLength(1);
  });
});

describe("splitFileName", () => {
  it("keeps dot-files whole and archives together", () => {
    expect(splitFileName("notes.txt")).toEqual({ stem: "notes", extension: ".txt" });
    expect(splitFileName(".bashrc")).toEqual({ stem: ".bashrc", extension: "" });
    expect(splitFileName("archive.tar.gz")).toEqual({ stem: "archive", extension: ".tar.gz" });
    expect(splitFileName("no-extension")).toEqual({ stem: "no-extension", extension: "" });
  });
});

describe("misc", () => {
  it("detects hidden names and folder-drop sub-paths", () => {
    expect(isHiddenName(".config")).toBe(true);
    expect(isHiddenName("config")).toBe(false);
    expect(relativeDirOf("photos/2024/a.jpg")).toBe("photos/2024");
    expect(relativeDirOf("a.jpg")).toBe("");
  });
});
