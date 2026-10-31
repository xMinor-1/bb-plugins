// Reading made readable, without Exchange: the text cleanup shared by the host
// and the panel, the EWS answers it reads, and the text of attachments.
import { describe, expect, it } from "vitest";
import { attachmentText, decodeText, readableAs } from "../src/host/extract";
import { htmlToText, parseFindItems, parseGetAttachment, parseGetItem } from "../src/host/ews/parse";
import { createDraft, findItems, getAttachment, getItem } from "../src/host/ews/soap";
import { normalizeText, readableText, safeHref, textParts } from "../src/shared/mail-text";

const wrap = (body: string) =>
  `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types">${body}</s:Body></s:Envelope>`;
const getItemAnswer = (inner: string) =>
  wrap(`<m:GetItemResponse><m:ResponseMessages><m:GetItemResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode><m:Items><t:Message><t:ItemId Id="A" ChangeKey="a"/>${inner}</t:Message></m:Items></m:GetItemResponseMessage></m:ResponseMessages></m:GetItemResponse>`);

describe("the text of a message", () => {
  it("normalizes line breaks, stray spaces and runs of blank lines", () => {
    expect(normalizeText("a\r\nb\rc  \n\n\n\nd e​")).toBe("a\nb\nc\n\nd e");
  });

  it("shows a link whose words repeat its address once", () => {
    expect(textParts("Bob\nbob@example.test<mailto:bob@example.test>\nhttps://example.test<https://example.test/>")).toEqual([
      { kind: "text", text: "Bob\n" },
      { kind: "link", href: "mailto:bob@example.test", label: "bob@example.test" },
      { kind: "text", text: "\n" },
      { kind: "link", href: "https://example.test/", label: "https://example.test" },
    ]);
  });

  it("keeps the words of other links and adds the address as a link after them", () => {
    expect(textParts("See the Report<https://example.test/q3> today")).toEqual([
      { kind: "text", text: "See the Report" },
      { kind: "link", href: "https://example.test/q3", label: " example.test" },
      { kind: "text", text: " today" },
    ]);
  });

  it("links bare addresses and web links, never javascript: or file:", () => {
    expect(textParts("write to a.b@example.test or open https://example.test/x.")).toEqual([
      { kind: "text", text: "write to " },
      { kind: "link", href: "mailto:a.b@example.test", label: "a.b@example.test" },
      { kind: "text", text: " or open " },
      { kind: "link", href: "https://example.test/x", label: "https://example.test/x" },
      { kind: "text", text: "." },
    ]);
    expect(textParts("x<javascript:alert(1)>")).toEqual([{ kind: "text", text: "x<javascript:alert(1)>" }]);
    expect(safeHref("javascript:alert(1)")).toBeNull();
    expect(safeHref("file:///etc/passwd")).toBeNull();
    expect(safeHref(" https://example.test ")).toBe("https://example.test");
  });

  it("gives agents the text without duplicate targets", () => {
    expect(readableText("Bob\r\nbob@example.test<mailto:bob@example.test>\r\nReport<https://example.test/q3>")).toBe("Bob\nbob@example.test\nReport <https://example.test/q3>");
  });
});

describe("EWS answers", () => {
  it("decodes &#xD; and other character references Exchange writes", () => {
    const message = parseGetItem(getItemAnswer(`<t:Subject>S</t:Subject><t:Body BodyType="Text">Hi&#xD;\nthere&#xD;\n&#x41F;&#1088;&#1080;&#1074;&#1077;&#1090; &amp;#xD;</t:Body>`));
    expect(message.body).toBe("Hi\nthere\nПривет &#xD;");
    const page = parseFindItems(
      wrap(
        `<m:FindItemResponse><m:ResponseMessages><m:FindItemResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode><m:RootFolder TotalItemsInView="1" IncludesLastItemInRange="true"><t:Items>` +
          `<t:Message><t:ItemId Id="A" ChangeKey="a"/><t:ConversationId Id="C1"/><t:Preview>Bob&#xD;\nbob@x.test&lt;mailto:bob@x.test&gt; ok</t:Preview></t:Message>` +
          `</t:Items></m:RootFolder></m:FindItemResponseMessage></m:ResponseMessages></m:FindItemResponse>`,
      ),
    );
    expect(page.items[0]).toMatchObject({ preview: "Bob bob@x.test ok", conversationId: "C1" });
  });

  it("reads an HTML body with its text next to it, and the attachments' details", () => {
    const message = parseGetItem(
      getItemAnswer(
        `<t:Body BodyType="HTML">&lt;p&gt;Hi&lt;/p&gt;</t:Body><t:TextBody BodyType="Text">Hi&#xD;\n</t:TextBody><t:ConversationId Id="C1"/>` +
          `<t:Attachments><t:FileAttachment><t:AttachmentId Id="X1"/><t:Name>logo.png</t:Name><t:ContentType>image/png</t:ContentType><t:ContentId>logo@x</t:ContentId><t:Size>5</t:Size><t:IsInline>true</t:IsInline></t:FileAttachment>` +
          `<t:ReferenceAttachment><t:AttachmentId Id="X2"/><t:Name>plan</t:Name></t:ReferenceAttachment></t:Attachments>`,
      ),
    );
    expect(message).toMatchObject({ html: "<p>Hi</p>", body: "Hi\n", conversationId: "C1" });
    expect(message.attachments).toEqual([
      { id: "X1", name: "logo.png", size: 5, kind: "file", contentType: "image/png", contentId: "logo@x", isInline: true },
      { id: "X2", name: "plan", size: null, kind: "reference", contentType: null, contentId: null, isInline: false },
    ]);
  });

  it("makes text of the HTML itself when the server has no TextBody", () => {
    const message = parseGetItem(getItemAnswer(`<t:Body BodyType="HTML">&lt;style&gt;p{}&lt;/style&gt;&lt;p&gt;One&amp;nbsp;two&lt;/p&gt;&lt;div&gt;three&lt;br&gt;four&lt;/div&gt;</t:Body>`));
    expect(message.body).toBe("One two\nthree\nfour");
    expect(htmlToText("<script>x()</script><p>a &amp; b &#1087;</p>")).toBe("a & b п");
  });

  it("reads a downloaded attachment", () => {
    const file = parseGetAttachment(
      wrap(
        `<m:GetAttachmentResponse><m:ResponseMessages><m:GetAttachmentResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode><m:Attachments>` +
          `<t:FileAttachment><t:AttachmentId Id="X1"/><t:Name>a.txt</t:Name><t:ContentType>text/plain</t:ContentType><t:Content>aGVs\nbG8=</t:Content></t:FileAttachment>` +
          `</m:Attachments></m:GetAttachmentResponseMessage></m:ResponseMessages></m:GetAttachmentResponse>`,
      ),
    );
    expect(file).toMatchObject({ name: "a.txt", contentType: "text/plain" });
    expect(file.content.toString()).toBe("hello");
  });

  it("asks for HTML with TextBody only when reading for the panel, and forwards by ForwardItem", () => {
    expect(getItem({ id: "A" })).toContain("<t:BodyType>Text</t:BodyType>");
    expect(getItem({ id: "A" })).not.toContain("item:TextBody");
    expect(getItem({ id: "A" }, { html: true })).toContain("<t:BodyType>HTML</t:BodyType>");
    expect(getItem({ id: "A" }, { html: true })).toContain('FieldURI="item:TextBody"');
    expect(getAttachment("X&1")).toContain('<t:AttachmentId Id="X&amp;1"/>');
    expect(findItems({ folder: "inbox", offset: 0, limit: 5, conversationId: "C1" })).toContain(
      '<t:IsEqualTo><t:FieldURI FieldURI="item:ConversationId"/><t:FieldURIOrConstant><t:Constant Value="C1"/>',
    );
    const forward = createDraft({ kind: "forward", reference: { id: "A", changeKey: "a" }, to: [{ name: null, email: "d@x.test" }], body: "FYI" });
    expect(forward).toMatch(/<t:ForwardItem><t:ToRecipients>.*<t:ReferenceItemId Id="A" ChangeKey="a"\/><t:NewBodyContent BodyType="Text">FYI<\/t:NewBodyContent><\/t:ForwardItem>/);
  });
});

describe("the text of an attachment", () => {
  it("tells which files it can read", () => {
    expect(readableAs("Agenda.PDF", null)).toBe("pdf");
    expect(readableAs("x.bin", "application/pdf")).toBe("pdf");
    expect(readableAs("notes.txt", null)).toBe("text");
    expect(readableAs("page.htm", null)).toBe("html");
    expect(readableAs("data", "text/csv")).toBe("text");
    expect(readableAs("slides.pptx", "application/octet-stream")).toBeNull();
  });

  it("reads UTF-8, UTF-16 and Windows-1251 text", () => {
    expect(decodeText(Buffer.from("Привет", "utf8"))).toBe("Привет");
    expect(decodeText(Buffer.concat([Buffer.from([0xff, 0xfe]), Buffer.from("Привет", "utf16le")]))).toBe("Привет");
    expect(decodeText(Buffer.from([0xcf, 0xf0, 0xe8, 0xe2, 0xe5, 0xf2]))).toBe("Привет");
  });

  it("refuses formats it cannot read, and says so", async () => {
    await expect(attachmentText("slides.pptx", null, Buffer.from("PK"))).rejects.toThrow(/not a text file or a PDF/);
    await expect(attachmentText("broken.pdf", null, Buffer.from("%PDF-1.4 garbage"))).rejects.toThrow(/could not be read as PDF/);
    expect(await attachmentText("page.html", null, Buffer.from("<p>One</p><p>Two</p>"))).toBe("One\nTwo");
  });
});
