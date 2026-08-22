import { describe, expect, it } from "vitest";

import {
  baseName,
  directoryName,
  isPdfPath,
  joinPath,
  previewUrlFor,
} from "./pdf-paths";

describe("isPdfPath", () => {
  it("matches the extension case-insensitively", () => {
    expect(isPdfPath("/a/b.pdf")).toBe(true);
    expect(isPdfPath("REPORT.PDF")).toBe(true);
    expect(isPdfPath("/a/b.pdf.txt")).toBe(false);
    expect(isPdfPath("/a/pdf")).toBe(false);
  });
});

describe("baseName / directoryName", () => {
  it("splits an absolute path", () => {
    expect(baseName("/home/me/docs/a.pdf")).toBe("a.pdf");
    expect(directoryName("/home/me/docs/a.pdf")).toBe("/home/me/docs");
  });

  it("handles a root-level file and a bare name", () => {
    expect(directoryName("/a.pdf")).toBe("/");
    expect(baseName("a.pdf")).toBe("a.pdf");
    expect(directoryName("a.pdf")).toBe(".");
  });
});

describe("joinPath", () => {
  it("joins without doubling separators", () => {
    expect(joinPath("/root", "docs/a.pdf")).toBe("/root/docs/a.pdf");
    expect(joinPath("/root/", "/docs/a.pdf")).toBe("/root/docs/a.pdf");
    expect(joinPath("/root", "")).toBe("/root");
  });
});

describe("previewUrlFor", () => {
  it("encodes the file name as one path segment", () => {
    expect(previewUrlFor("/api/previews/abc", "ЭПД с Х5.pdf")).toBe(
      `/api/previews/abc/${encodeURIComponent("ЭПД с Х5.pdf")}`,
    );
    expect(previewUrlFor("/api/previews/abc/", "a b.pdf")).toBe(
      "/api/previews/abc/a%20b.pdf",
    );
  });
});
