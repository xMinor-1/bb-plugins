// EWS requests and answers, the curl config, and small helpers — no network.
import { describe, expect, it } from "vitest";
import { buildCurlConfig, configString, defaultCurlPath, parseCurlVersion } from "../src/host/curl";
import { normalizeEwsUrl } from "../src/host/ews/client";
import { EwsError, parseCreateItem, parseFindItems, parseGetItem } from "../src/host/ews/parse";
import { createDraft, findItems, sendItem, xml } from "../src/host/ews/soap";
import { formatTime } from "../src/host/format";
import { parseRecipient, refFor } from "../src/host/service";

const wrap = (body: string) =>
  `<?xml version="1.0" encoding="utf-8"?><s:Envelope xmlns:s="http://schemas.xmlsoap.org/soap/envelope/"><s:Body xmlns:m="http://schemas.microsoft.com/exchange/services/2006/messages" xmlns:t="http://schemas.microsoft.com/exchange/services/2006/types">${body}</s:Body></s:Envelope>`;

describe("requests", () => {
  it("are pure ASCII: Cyrillic and emoji become character references", () => {
    expect(xml('Привет <b> & "q" 🙂')).toBe("&#x41f;&#x440;&#x438;&#x432;&#x435;&#x442; &lt;b&gt; &amp; &quot;q&quot; &#x1f642;");
    const request = createDraft({ kind: "new", to: [{ name: "Кэрол", email: "carol@example.test" }], subject: "Тема", body: "Текст\nвторая строка" });
    expect(/^[\x09\x0a\x0d\x20-\x7e]*$/.test(request)).toBe(true);
    expect(request).toContain("&#x422;&#x435;&#x43a;&#x441;&#x442;\n&#x432;");
  });

  it("drop characters XML cannot carry", () => {
    expect(xml("a\u0000b\u0007c\u001bd")).toBe("abcd");
  });

  it("only ever save drafts; sending is a separate call that needs the change key", () => {
    const reply = createDraft({ kind: "replyAll", reference: { id: "ID1", changeKey: "CK1" }, body: "ok" });
    expect(reply).toContain('MessageDisposition="SaveOnly"');
    expect(reply).not.toContain("SendAndSaveCopy");
    expect(reply).toMatch(/<t:ReplyAllToItem><t:ReferenceItemId Id="ID1" ChangeKey="CK1"\/><t:NewBodyContent BodyType="Text">ok<\/t:NewBodyContent><\/t:ReplyAllToItem>/);
    expect(() => sendItem({ id: "ID1" })).toThrow(/change key/);
    expect(sendItem({ id: "ID1", changeKey: "CK2" })).toContain('<t:ItemId Id="ID1" ChangeKey="CK2"/>');
  });

  it("put FindItem parts in schema order", () => {
    const request = findItems({ folder: "inbox", offset: 30, limit: 10, unreadOnly: true });
    const order = ["<m:ItemShape>", "<m:IndexedPageItemView", "<m:Restriction>", "<m:SortOrder>", "<m:ParentFolderIds>"].map((tag) => request.indexOf(tag));
    expect(order.every((at) => at > 0)).toBe(true);
    expect([...order].sort((a, b) => a - b)).toEqual(order);
    expect(findItems({ folder: "inbox", offset: 0, limit: 10, query: 'from:"Иванов"' })).toMatch(/<\/m:ParentFolderIds><m:QueryString>from:&quot;&#x418;/);
  });
});

describe("answers", () => {
  it("read a FindItem page", () => {
    const page = parseFindItems(
      wrap(
        `<m:FindItemResponse><m:ResponseMessages><m:FindItemResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode>` +
          `<m:RootFolder IndexedPagingOffset="2" TotalItemsInView="7" IncludesLastItemInRange="false"><t:Items>` +
          `<t:Message><t:ItemId Id="A" ChangeKey="a"/><t:Subject>123</t:Subject><t:From><t:Mailbox><t:Name>Боб</t:Name><t:EmailAddress>bob@x.test</t:EmailAddress></t:Mailbox></t:From><t:IsRead>false</t:IsRead><t:Preview>  hi\n there </t:Preview></t:Message>` +
          `<t:MeetingRequest><t:ItemId Id="B" ChangeKey="b"/><t:Subject>Sync &amp; plan</t:Subject><t:IsRead>true</t:IsRead><t:HasAttachments>true</t:HasAttachments></t:MeetingRequest>` +
          `</t:Items></m:RootFolder></m:FindItemResponseMessage></m:ResponseMessages></m:FindItemResponse>`,
      ),
    );
    expect(page.total).toBe(7);
    expect(page.last).toBe(false);
    expect(page.items.map((i) => [i.kind, i.subject, i.isRead])).toEqual([
      ["Message", "123", false],
      ["MeetingRequest", "Sync & plan", true],
    ]);
    expect(page.items[0]).toMatchObject({ from: { name: "Боб", email: "bob@x.test" }, preview: "hi there", item: { id: "A", changeKey: "a" } });
  });

  it("read a message with recipients, attachments and a CRLF body", () => {
    const message = parseGetItem(
      wrap(
        `<m:GetItemResponse><m:ResponseMessages><m:GetItemResponseMessage ResponseClass="Success"><m:ResponseCode>NoError</m:ResponseCode><m:Items><t:Message>` +
          `<t:ItemId Id="A" ChangeKey="a"/><t:Subject>S</t:Subject><t:Body BodyType="Text">line 1\r\nline 2</t:Body>` +
          `<t:Attachments><t:FileAttachment><t:Name>a.pdf</t:Name><t:Size>10</t:Size></t:FileAttachment><t:ItemAttachment><t:Name>fwd</t:Name></t:ItemAttachment></t:Attachments>` +
          `<t:ToRecipients><t:Mailbox><t:EmailAddress>one@x.test</t:EmailAddress></t:Mailbox><t:Mailbox><t:Name>Two</t:Name><t:EmailAddress>two@x.test</t:EmailAddress></t:Mailbox></t:ToRecipients>` +
          `</t:Message></m:Items></m:GetItemResponseMessage></m:ResponseMessages></m:GetItemResponse>`,
      ),
    );
    expect(message.body).toBe("line 1\nline 2");
    expect(message.to).toEqual([
      { name: null, email: "one@x.test" },
      { name: "Two", email: "two@x.test" },
    ]);
    expect(message.attachments).toEqual([
      { name: "a.pdf", size: 10 },
      { name: "fwd", size: null },
    ]);
  });

  it("turn EWS errors and SOAP faults into EwsError", () => {
    const error = wrap(
      `<m:CreateItemResponse><m:ResponseMessages><m:CreateItemResponseMessage ResponseClass="Error"><m:MessageText>The change key is stale.</m:MessageText><m:ResponseCode>ErrorStaleObject</m:ResponseCode></m:CreateItemResponseMessage></m:ResponseMessages></m:CreateItemResponse>`,
    );
    expect(() => parseCreateItem(error)).toThrow(EwsError);
    try {
      parseCreateItem(error);
    } catch (caught) {
      expect((caught as EwsError).code).toBe("ErrorStaleObject");
    }
    const fault = wrap(`<s:Fault><faultcode>a:ErrorSchemaValidation</faultcode><faultstring>The request failed schema validation</faultstring></s:Fault>`);
    expect(() => parseCreateItem(fault)).toThrow(/schema validation/);
    expect(() => parseCreateItem("<html>login</html>")).toThrow(EwsError);
  });
});

describe("curl", () => {
  it("escapes config strings", () => {
    expect(configString('a"b\\c\nd\te')).toBe('"a\\"b\\\\c\\nd\\te"');
  });

  it("keeps the password out of the arguments and asks the system for Windows sign-in", () => {
    const ntlm = buildCurlConfig({ url: "https://mail.example.test/EWS/Exchange.asmx", body: "<x/>", auth: { kind: "ntlm", user: "D\\me", password: 'p"w' } }, { revokeBestEffort: false, timeoutMs: 60_000 });
    expect(ntlm).toContain('user = "D\\\\me:p\\"w"');
    expect(ntlm).toContain("\nntlm\n");
    const negotiate = buildCurlConfig({ url: "https://m/EWS/Exchange.asmx", body: "<x/>", auth: { kind: "negotiate" } }, { revokeBestEffort: true, timeoutMs: 60_000 });
    expect(negotiate).toContain('negotiate\nuser = ":"');
    expect(negotiate).toContain("ssl-revoke-best-effort");
    expect(() => buildCurlConfig({ url: "https://m/\nx", body: "", auth: { kind: "negotiate" } }, { revokeBestEffort: false, timeoutMs: 1000 })).toThrow();
  });

  it("uses the system curl by absolute path", () => {
    expect(defaultCurlPath("win32", { SystemRoot: "C:\\Windows" })).toMatch(/^C:\\Windows.System32.curl\.exe$/);
    expect(defaultCurlPath("darwin", {})).toBe("/usr/bin/curl");
  });

  it("reads the version and features", () => {
    const info = parseCurlVersion("curl 8.9.1 (Windows) libcurl/8.9.1 Schannel zlib/1.3 WinIDN\nRelease-Date: 2024\nProtocols: http https\nFeatures: AsynchDNS HSTS HTTPS-proxy IDN IPv6 Kerberos Largefile libz NTLM SPNEGO SSL SSPI threadsafe Unicode UnixSockets\n");
    expect(info.version).toBe("8.9.1");
    expect(info.features).toEqual(expect.arrayContaining(["SSPI", "SPNEGO", "NTLM"]));
  });
});

describe("helpers", () => {
  it("normalizes the Exchange address", () => {
    expect(normalizeEwsUrl("mail.example.test")).toBe("https://mail.example.test/EWS/Exchange.asmx");
    expect(normalizeEwsUrl("https://mail.example.test/EWS/Exchange.asmx")).toBe("https://mail.example.test/EWS/Exchange.asmx");
    expect(() => normalizeEwsUrl("http://mail.example.test/EWS/Exchange.asmx")).toThrow(/https/);
    expect(() => normalizeEwsUrl("https://me:pw@mail.example.test/")).toThrow(/login/);
    expect(normalizeEwsUrl("http://127.0.0.1:8080/EWS/Exchange.asmx")).toBe("http://127.0.0.1:8080/EWS/Exchange.asmx");
  });

  it("parses recipients", () => {
    expect(parseRecipient('"Иванов, Пётр" <p.ivanov@example.test>')).toEqual({ name: "Иванов, Пётр", email: "p.ivanov@example.test" });
    expect(parseRecipient(" bob@example.test ")).toEqual({ name: null, email: "bob@example.test" });
    expect(() => parseRecipient("Bob")).toThrow(/not an email address/);
    expect(() => parseRecipient("a@b.c, d@e.f")).toThrow();
  });

  it("gives short stable refs", () => {
    const ref = refFor("AAMkAD" + "x".repeat(150));
    expect(ref).toMatch(/^m[a-z0-9]{10}$/);
    expect(refFor("AAMkAD" + "x".repeat(150))).toBe(ref);
    expect(refFor("other")).not.toBe(ref);
  });

  it("formats time in the machine's zone", () => {
    expect(formatTime("2026-10-31T11:55:00Z", 180)).toBe("2026-10-31 14:55 UTC+3");
    expect(formatTime("2026-10-31T11:55:00Z", -330)).toBe("2026-10-31 06:25 UTC-5:30");
    expect(formatTime(null)).toBe("(no date)");
  });
});
