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

const BRIDGE = "<script data-doc-review-bridge>window.x=1</script>";

/** An attribute value as the browser reads it. */
function unescape(value: string): string {
  return value
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/&amp;/g, "&");
}

describe("injectIntoHtml", () => {
  it("puts the base and the bridge first in the head, before the page's own content", () => {
    const { text } = inject('<!doctype html><html><head><link rel="stylesheet" href="a.css"></head><body><p>Hi</p></body></html>');
    expect(text).toBe(
      `<!doctype html><html><head><base data-doc-review-base href="${BASE}">${BRIDGE}<link rel="stylesheet" href="a.css"></head><body><p>Hi</p></body></html>`,
    );
  });

  it("handles a fragment with no head or body", () => {
    const { text } = inject("<!DOCTYPE html>\n<h1>Report</h1>");
    expect(text).toBe(`<!DOCTYPE html><base data-doc-review-base href="${BASE}">${BRIDGE}\n<h1>Report</h1>`);
  });

  it("keeps the doctype first after comments, so the page stays in standards mode", () => {
    const { text } = inject("<!-- built by a script -->\n<!DOCTYPE html><h1>Report</h1>");
    expect(text).toBe(`<!-- built by a script -->\n<!DOCTYPE html><base data-doc-review-base href="${BASE}">${BRIDGE}<h1>Report</h1>`);
  });

  it("gives pages in srcdoc frames the bridge, escaped for the attribute", () => {
    const inner = "&lt;!DOCTYPE html&gt;&lt;html&gt;&lt;head&gt;&lt;title&gt;A&lt;/title&gt;&lt;/head&gt;&lt;body&gt;&lt;p class=&quot;x&quot;&gt;Hi&lt;/p&gt;&lt;/body&gt;&lt;/html&gt;";
    const page = injectIntoHtml(Buffer.from(`<!DOCTYPE html><head></head><body><iframe id="desk" srcdoc="${inner}"></iframe></body>`), {
      baseHref: BASE,
      script: `if (a && b) go("it's")`,
    });
    const text = page.body.toString("utf8");
    const srcdoc = /srcdoc="([^"]*)"/.exec(text)![1]!;
    expect(unescape(srcdoc)).toBe(
      `<!DOCTYPE html><html><head><script data-doc-review-bridge>if (a && b) go("it's")</script><title>A</title></head><body><p class="x">Hi</p></body></html>`,
    );
    // The outer page gets the bridge in its own head, not in the frame's.
    expect(text.startsWith(`<!DOCTYPE html><head><base data-doc-review-base href="${BASE}"><script data-doc-review-bridge>`)).toBe(true);
  });

  it("reads srcdoc in single quotes with raw markup", () => {
    const { text } = inject(`<body><iframe srcdoc='<p class="a">Hi</p>'></iframe></body>`);
    const srcdoc = /srcdoc='([^']*)'/.exec(text)![1]!;
    expect(unescape(srcdoc)).toBe(`${BRIDGE}<p class="a">Hi</p>`);
  });

  it("finds the outer head even when a frame's markup has one and the page does not", () => {
    const { text } = inject('<!DOCTYPE html><iframe srcdoc="<html><head></head><body>x</body></html>"></iframe>');
    expect(text.startsWith(`<!DOCTYPE html><base data-doc-review-base href="${BASE}">${BRIDGE}<iframe`)).toBe(true);
    const srcdoc = /srcdoc="([^"]*)"/.exec(text)![1]!;
    expect(unescape(srcdoc)).toBe(`<html><head>${BRIDGE}</head><body>x</body></html>`);
  });

  it("leaves frames in scripts, comments, and already bridged frames alone", () => {
    const source = [
      "<head></head><body>",
      `<script>const tpl = '<iframe srcdoc="<p>in a script</p>"></iframe>';</script>`,
      `<!-- <iframe srcdoc="<p>in a comment</p>"></iframe> -->`,
      `<iframe srcdoc="&lt;script data-doc-review-bridge&gt;1&lt;/script&gt;&lt;p&gt;done&lt;/p&gt;"></iframe>`,
      "</body>",
    ].join("");
    const { text } = inject(source);
    expect(text).toBe(source.replace("<head>", `<head><base data-doc-review-base href="${BASE}">${BRIDGE}`));
  });

  it("keeps a relative base of the page under the preview folder", () => {
    const { text } = inject('<head><base href="assets/"></head><body></body>');
    expect(text).toContain(`<base data-doc-review-base href="${BASE}assets/">`);
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
    // The bridge goes in front; the page's own bytes follow unchanged.
    expect(page.body.subarray(page.body.length - cp1251.length).equals(cp1251)).toBe(true);
  });

  it("keeps a byte order mark first", () => {
    const withBom = Buffer.concat([Buffer.from([0xef, 0xbb, 0xbf]), Buffer.from("<head></head><body>x</body>")]);
    const page = injectIntoHtml(withBom, { baseHref: BASE, script: "1" });
    expect([...page.body.subarray(0, 3)]).toEqual([0xef, 0xbb, 0xbf]);
    expect(page.body.subarray(3).toString("utf8")).toBe(`<head><base data-doc-review-base href="${BASE}"><script data-doc-review-bridge>1</script></head><body>x</body>`);
  });
});

describe("the bridge script", () => {
  it("parses as a script", () => {
    expect(() => new Function(BRIDGE_SCRIPT)).not.toThrow();
  });

  it("cannot close its own script tag", () => {
    expect(BRIDGE_SCRIPT.toLowerCase()).not.toContain("</script");
  });

  it("is plain ASCII, so it survives any page encoding", () => {
    expect(/^[\x00-\x7f]*$/.test(BRIDGE_SCRIPT)).toBe(true);
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
    expect(message).not.toContain("in frame");
  });

  it("name the frame a comment is in", () => {
    const comment = {
      docId: "d_1",
      status: "draft",
      docVersion: "v",
      createdAt: 0,
      updatedAt: 0,
      note: null,
      threadId: null,
      sentAt: null,
      id: "c_frame",
      seq: 1,
      body: "Shorter title.",
      anchor: { kind: "html-text", quote: "Pickup", prefix: "", suffix: "", selector: "h1", frame: "#desk" },
    } as unknown as ReviewComment;
    const message = buildHandoffMessage({
      kind: "html",
      absPath: "/tmp/prototype.html",
      comments: [comment],
      imageNumbers: new Map(),
      imagePaths: new Map(),
    });
    expect(message).toContain("[c_frame] Text · «Pickup» · in frame `#desk` · `h1`");
    expect(message).toContain("`srcdoc`");
  });
});
