// Mail and attachments come from strangers: no message, HTML body or file may
// keep the machine busy. Each of these inputs took from seconds to hours with
// the regular expressions of 0.2.0; now each must finish well inside a second.
import { describe, expect, it } from "vitest";
import { HTML_TEXT_MAX, htmlToText, parseGetItem, parseResolveNames } from "../src/host/ews/parse";
import { attachmentText } from "../src/host/extract";
import { normalizeText, readableText, textParts } from "../src/shared/mail-text";

/** Generous for a slow CI machine; the quadratic versions took 10–40 s on 100 KB. */
const BUDGET_MS = 1500;

function timed<T>(run: () => T): { value: T; ms: number } {
  const start = performance.now();
  const value = run();
  return { value, ms: performance.now() - start };
}

const MB = 1_000_000;
const repeat = (unit: string, chars: number) => unit.repeat(Math.ceil(chars / unit.length));

describe("HTML from a stranger", () => {
  const inputs: [string, string][] = [
    ["unclosed <head repeated (the reported case)", repeat("<head ", 480_000)],
    ["unclosed <head repeated, 2 MB", repeat("<head ", 2 * MB)],
    ["<head> opened over and over", repeat("<head>", 2 * MB)],
    ["<script> opened over and over", repeat("<script>x", 2 * MB)],
    ["< without >", "<".repeat(2 * MB)],
    ["<a without >", repeat("<a", 2 * MB)],
    ["comments never closed", repeat("<!--", 2 * MB)],
    ["<br followed by spaces", repeat("<br" + " ".repeat(1000), 2 * MB)],
    ["a closing tag with spaces", repeat("</p" + " ".repeat(1000), 2 * MB)],
    ["entities without ;", repeat("&#" + "9".repeat(1000), 2 * MB)],
  ];
  for (const [name, html] of inputs) {
    it(`turns into text quickly: ${name}`, () => {
      const { ms } = timed(() => htmlToText(html));
      expect(ms).toBeLessThan(BUDGET_MS);
    });
  }

  it("reads at most HTML_TEXT_MAX characters of HTML", () => {
    const { value, ms } = timed(() => htmlToText("<p>" + "x".repeat(10 * MB) + "</p>"));
    expect(ms).toBeLessThan(BUDGET_MS);
    expect(value.length).toBeLessThanOrEqual(HTML_TEXT_MAX);
  });

  it("does the same for a message whose server sends no TextBody", () => {
    const html = repeat("&lt;head ", 480_000);
    const xml =
      `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types">` +
      `<m:GetItemResponse><m:ResponseMessages><m:GetItemResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode><m:Items><t:Message><t:ItemId Id="A" ChangeKey="a"/>` +
      `<t:Body BodyType="HTML">${html}</t:Body></t:Message></m:Items></m:GetItemResponseMessage></m:ResponseMessages></m:GetItemResponse></s:Body></s:Envelope>`;
    const { value, ms } = timed(() => parseGetItem(xml));
    expect(ms).toBeLessThan(BUDGET_MS * 2);
    expect(value.body).toBe("");
  });

  it("does the same for an HTML attachment", async () => {
    const start = performance.now();
    await attachmentText("page.html", "text/html", Buffer.from(repeat("<head ", 2 * MB)));
    expect(performance.now() - start).toBeLessThan(BUDGET_MS);
  });

  it("turns references outside Unicode into U+FFFD instead of failing", () => {
    expect(htmlToText("a&#99999999;b&#x110000;c&#0;d&#xD800;e&#" + "9".repeat(400) + ";f")).toBe("a�b�c�d�e�f");
    expect(htmlToText("&#x41F;&#1088;&amp;lt;&APOS;&NBSP;x")).toBe("Пр&lt;' x");
  });

  it("still reads ordinary HTML the way it did", () => {
    expect(htmlToText("<HTML><HEAD><TITLE>t</TITLE></HEAD><BODY><P>One</P><DIV>two<BR/>three</DIV>a < b, c > d<script>x()</SCRIPT>end</BODY></HTML>")).toBe("One\ntwo\nthree\na < b, c > dend");
    expect(htmlToText("<p>cut <b")).toBe("cut");
  });
});

describe("plain text from a stranger", () => {
  const inputs: [string, string][] = [
    ["one long word", "a".repeat(MB)],
    ["a long word of dots", repeat("a.", MB)],
    ["http:// repeated", repeat("http://", MB)],
    ["a link followed by dots", "http://a" + ".".repeat(MB)],
    ["an address part without @", repeat("a", MB) + "@"],
    ["a domain without a dot", "a@" + "a".repeat(MB)],
    ["a domain of dots", "a@" + repeat("a.", MB)],
    ["@ repeated", repeat("a@", MB)],
    ["unclosed link targets", repeat("<http://", MB)],
    ["link targets without words", repeat("<mailto:a>", MB)],
    ["a word before an unclosed target", "a".repeat(MB) + "<http://x"],
    ["spaces before a word", " ".repeat(MB) + "x"],
    ["slashes before a link", "/".repeat(MB) + "<https://example.test/>"],
  ];
  for (const [name, text] of inputs) {
    it(`is made readable quickly: ${name}`, () => {
      for (const run of [() => textParts(text), () => readableText(text), () => normalizeText(text)] as (() => unknown)[]) {
        const { ms } = timed(run);
        expect(ms).toBeLessThan(BUDGET_MS);
      }
    });
  }
});

/** A PDF with one line of text on each page. */
function pdf(pages: number): Buffer {
  const objects = ["<< /Type /Catalog /Pages 2 0 R >>", "", "<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>"];
  const kids: string[] = [];
  for (let n = 1; n <= pages; n++) {
    const content = `BT /F1 12 Tf 72 720 Td (Page ${n}) Tj ET`;
    const page = objects.length + 1;
    kids.push(`${page} 0 R`);
    objects.push(`<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 3 0 R >> >> /Contents ${page + 1} 0 R >>`);
    objects.push(`<< /Length ${content.length} >>\nstream\n${content}\nendstream`);
  }
  objects[1] = `<< /Type /Pages /Kids [${kids.join(" ")}] /Count ${pages} >>`;
  let out = "%PDF-1.4\n";
  const offsets: number[] = [];
  objects.forEach((body, n) => {
    offsets.push(out.length);
    out += `${n + 1} 0 obj\n${body}\nendobj\n`;
  });
  const xref = out.length;
  out += `xref\n0 ${objects.length + 1}\n0000000000 65535 f \n` + offsets.map((o) => `${String(o).padStart(10, "0")} 00000 n \n`).join("");
  out += `trailer\n<< /Size ${objects.length + 1} /Root 1 0 R >>\nstartxref\n${xref}\n%%EOF\n`;
  return Buffer.from(out, "latin1");
}

describe("a PDF attachment", () => {
  it("is read page by page", async () => {
    expect(await attachmentText("a.pdf", null, pdf(3))).toBe("[page 1]\nPage 1\n\n[page 2]\nPage 2\n\n[page 3]\nPage 3");
  });

  it("is read up to a number of pages, and the agent is told so", async () => {
    const text = await attachmentText("a.pdf", null, pdf(5), { maxPages: 2 });
    expect(text).toBe("[page 1]\nPage 1\n\n[page 2]\nPage 2\n\n(Only the first 2 of 5 pages were read.)");
  });

  it("stops when reading takes too long", async () => {
    let clock = 0;
    const text = await attachmentText("a.pdf", null, pdf(5), { maxMs: 500, now: () => (clock += 600) });
    expect(text).toMatch(/^\[page 1\]\nPage 1\n\n\(Reading stopped after 1 of 5 pages: the file takes too long to read\.\)$/);
  });

  it("stops when the tool call is stopped", async () => {
    const controller = new AbortController();
    controller.abort();
    await expect(attachmentText("a.pdf", null, pdf(2), { signal: controller.signal })).rejects.toThrow(/Reading a\.pdf was stopped/);
  });
});

describe("an address book answer from a stranger", () => {
  const answer = (resolutions: string) =>
    `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types">` +
    `<m:ResolveNamesResponse><m:ResponseMessages><m:ResolveNamesResponseMessage ResponseClass="Warning"><m:ResponseCode>ErrorNameResolutionMultipleResults</m:ResponseCode>` +
    `<m:ResolutionSet TotalItemsInView="100">${resolutions}</m:ResolutionSet></m:ResolveNamesResponseMessage></m:ResponseMessages></m:ResolveNamesResponse></s:Body></s:Envelope>`;
  const resolution = (email: string, entries = "", name = "X") =>
    `<t:Resolution><t:Mailbox><t:Name>${name}</t:Name><t:EmailAddress>${email}</t:EmailAddress></t:Mailbox><t:Contact><t:DisplayName>${name}</t:DisplayName><t:EmailAddresses>${entries}</t:EmailAddresses></t:Contact></t:Resolution>`;

  const inputs: [string, string][] = [
    ["an address of dots without an end", answer(resolution("a@" + repeat("b.", 2 * MB) + ","))],
    ["an address of one long word", answer(resolution("a".repeat(2 * MB)))],
    ["many addresses in one contact", answer(resolution("/o=x", repeat("<t:Entry>SMTP:a@b.c,</t:Entry>", 2 * MB)))],
    ["a hundred long names", answer(repeat(resolution("a@example.test", "", "n".repeat(20_000)), 100 * 20_100))],
  ];
  for (const [name, xml] of inputs) {
    it(`is read quickly: ${name}`, () => {
      const { value, ms } = timed(() => parseResolveNames(xml));
      expect(ms).toBeLessThan(BUDGET_MS * 2);
      expect(value.people.every((person) => person.email.length <= 320)).toBe(true);
    });
  }
});
