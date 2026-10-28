import { describe, expect, it } from "vitest";
import { htmlFileLink } from "./html-links";

const report = "D:/Documents/Projects/peptides/.tmp/reports/audit.html";

describe("HTML report file links", () => {
  it("resolves sibling reports, parent folders, spaces and encoded Cyrillic", () => {
    expect(htmlFileLink("../screens/a%20b.png", report)).toEqual({ path: "D:/Documents/Projects/peptides/.tmp/screens/a b.png", location: null });
    expect(htmlFileLink("%D0%BE%D1%82%D1%87%D1%91%D1%82.html", report)?.path).toBe("D:/Documents/Projects/peptides/.tmp/reports/отчёт.html");
    expect(htmlFileLink("./next.html", report.replaceAll("/", "\\"))?.path).toBe("D:/Documents/Projects/peptides/.tmp/reports/next.html");
    expect(htmlFileLink("../../src/app.ts#L12C3", "/work/.tmp/reports/a.html")).toEqual({ path: "/work/src/app.ts", location: { kind: "line", line: 12, column: 3 } });
    expect(htmlFileLink("../../src/app.ts:12:3", report)?.location).toEqual({ kind: "line", line: 12, column: 3 });
  });

  it("does not treat anchors, external URLs or malformed messages as file links", () => {
    for (const href of ["#section", "https://example.com", "javascript:alert(1)", "file:///etc/passwd", "//example.com", "/api", "?q=1", "%ZZ", null, {}, ""]) {
      expect(htmlFileLink(href, report)).toBeNull();
    }
  });
});
