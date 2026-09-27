import { describe, expect, it } from "vitest";
import { BRIDGE_SCRIPT, declaredCharset, injectIntoHtml } from "./html-bridge";
import { buildHandoffMessage } from "./message";
import { docKindFor, type ReviewComment } from "./types";

const BASE = "/api/v1/file-previews/abc/";

function inject(html: string | Buffer, baseHref: string | null = BASE) {
  const source = typeof html === "string" ? Buffer.from(html, "utf8") : html;
  const page = injectIntoHtml(source, { baseHref, script: "window.x=1" });
  return { ...page, text: page.body.toString("utf8") };
}

describe("injectIntoHtml", () => {
  it("puts the base first in the head and the bridge at the end of the body", () => {
    const { text } = inject('<!doctype html><html><head><link rel="stylesheet" href="a.css"></head><body><p>Hi</p></body></html>');
    expect(text).toBe(
      `<!doctype html><html><head><base href="${BASE}"><link rel="stylesheet" href="a.css"></head><body><p>Hi</p><script data-doc-review-bridge>window.x=1</script></body></html>`,
    );
  });

  it("handles a fragment with no head or body", () => {
    const { text } = inject("<!DOCTYPE html>\n<h1>Report</h1>");
    expect(text).toBe(`<!DOCTYPE html><base href="${BASE}">\n<h1>Report</h1><script data-doc-review-bridge>window.x=1</script>`);
  });

  it("keeps a relative base of the page under the preview folder", () => {
    const { text } = inject('<head><base href="assets/"></head><body></body>');
    expect(text).toContain(`<base href="${BASE}assets/">`);
    expect(text.match(/<base /g)).toHaveLength(1);
  });

  it("leaves an absolute base alone", () => {
    const { text } = inject('<head><base href="https://example.com/site/"></head><body></body>');
    expect(text).toContain('<base href="https://example.com/site/">');
    expect(text).not.toContain(BASE);
  });

  it("names the charset the page declares", () => {
    expect(inject('<meta charset="windows-1251"><p>x</p>').contentType).toBe("text/html; charset=windows-1251");
    expect(declaredCharset(Buffer.from('<meta http-equiv="Content-Type" content="text/html; charset=KOI8-R">'))).toBe("koi8-r");
  });

  it("falls back to UTF-8 only when the bytes are UTF-8", () => {
    expect(inject("<p>Привет</p>").contentType).toBe("text/html; charset=utf-8");
    const cp1251 = Buffer.from([0x3c, 0x70, 0x3e, 0xcf, 0xf0, 0xe8, 0x3c, 0x2f, 0x70, 0x3e]);
    expect(inject(cp1251).contentType).toBe("text/html");
  });

  it("keeps non-UTF-8 bytes untouched", () => {
    const cp1251 = Buffer.from([0x3c, 0x62, 0x6f, 0x64, 0x79, 0x3e, 0xcf, 0xf0, 0xe8, 0x3c, 0x2f, 0x62, 0x6f, 0x64, 0x79, 0x3e]);
    const page = injectIntoHtml(cp1251, { baseHref: null, script: "1" });
    expect([...page.body.subarray(6, 9)]).toEqual([0xcf, 0xf0, 0xe8]);
  });

  it("keeps a byte order mark first", () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("<head></head><body>x</body>")]);
    const page = injectIntoHtml(withBom, { baseHref: BASE, script: "1" });
    expect([...page.body.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(page.body.subarray(3).toString("utf8")).toBe(`<head><base href="${BASE}"></head><body>x<script data-doc-review-bridge>1</script></body>`);
  });
});

describe("the bridge script", () => {
  it("parses as a script", () => {
    expect(() => new Function(BRIDGE_SCRIPT)).not.toThrow();
  });

  it("cannot close its own script tag", () => {
    expect(BRIDGE_SCRIPT.toLowerCase()).not.toContain("</script");
  });
});

describe("HTML comments", () => {
  it("open .html and .htm files", () => {
    expect(docKindFor("/tmp/report.html")).toBe("html");
    expect(docKindFor("/tmp/INDEX.HTM")).toBe("html");
  });

  it("reach the agent with the quote, the selector, and the element's HTML", () => {
    const base = { docId: "d_1", status: "draft", docVersion: "v", createdAt: 0, updatedAt: 0, note: null, threadId: null, sentAt: null } as const;
    const comments = [
      {
        ...base,
        id: "c_text",
        seq: 1,
        body: "Say 15%.",
        anchor: { kind: "html-text", quote: "20% discount", prefix: "", suffix: "", selector: "main > p:nth-of-type(2)" },
      },
      {
        ...base,
        id: "c_elem",
        seq: 2,
        body: "Make it green.",
        anchor: { kind: "html-element", selector: "#buy", tag: "button", text: "Buy now", html: '<button id="buy" class="cta">Buy now</button>' },
      },
    ] as unknown as ReviewComment[];
    const message = buildHandoffMessage({
      kind: "html",
      absPath: "/tmp/landing.html",
      comments,
      imageNumbers: new Map(),
      imagePaths: new Map(),
    });
    expect(message).toContain("[c_text] Text · «20% discount» · `main > p:nth-of-type(2)`");
    expect(message).toContain("[c_elem] Element <button> · text: «Buy now» · `#buy`");
    expect(message).toContain('HTML: `<button id="buy" class="cta">Buy now</button>`');
    expect(message).toContain("HTML page");
  });
});
