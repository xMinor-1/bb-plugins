import { describe, expect, it } from "vitest";
import { htmlFileLink } from "./html-links";

const report = "/home/me/reports/audit.html";

describe("relative links in an HTML document", () => {
  it("resolve next to the document, with a line when the link names one", () => {
    expect(htmlFileLink("data/rows.csv", report)).toEqual({
      kind: "file",
      path: "/home/me/reports/data/rows.csv",
      location: null,
    });
    expect(htmlFileLink("./src/app.ts#L12C3", report)).toEqual({
      kind: "file",
      path: "/home/me/reports/src/app.ts",
      location: { kind: "line", line: 12, column: 3 },
    });
    expect(htmlFileLink("src/app.ts:40", report)).toEqual({
      kind: "file",
      path: "/home/me/reports/src/app.ts",
      location: { kind: "line", line: 40, column: null },
    });
    expect(htmlFileLink("plan.md:12", report)).toEqual({
      kind: "file",
      path: "/home/me/reports/plan.md",
      location: { kind: "line", line: 12, column: null },
    });
    expect(htmlFileLink("tel:123456", report)).toBeNull();
    expect(htmlFileLink("My%20notes.md?raw=1", report)).toEqual({
      kind: "file",
      path: "/home/me/reports/My notes.md",
      location: null,
    });
  });

  it("work for a document on a Windows host", () => {
    expect(htmlFileLink("sub\\plan.md", "C:/Users/me/audit.html")).toEqual({
      kind: "file",
      path: "C:/Users/me/sub/plan.md",
      location: null,
    });
  });

  it("never leave the document's folder", () => {
    for (const href of ["../secrets.env", "a/../../x", "..%2F..%2Fetc%2Fpasswd", "..\\..\\x"]) {
      expect(htmlFileLink(href, report)).toEqual({ kind: "outside" });
    }
    expect(htmlFileLink("a/../b.md", report)).toEqual({
      kind: "file",
      path: "/home/me/reports/b.md",
      location: null,
    });
  });

  it("ignore what is not a relative file link", () => {
    for (const href of ["#section", "https://example.com", "javascript:alert(1)", "file:///etc/passwd", "//example.com", "/api", "\\\\server\\share", "?q=1", "%ZZ", ".", null, {}, ""]) {
      expect(htmlFileLink(href, report)).toBeNull();
    }
  });
});
