// @vitest-environment jsdom
//
// The panel reading a message: HTML is shown sanitized in a frame without
// scripts, pictures from the internet wait for a click, the people are names
// that fold, attachments open only as harmless types, and Forward prepares a
// draft — it does not send.
import { cleanup, fireEvent, screen, waitFor } from "@testing-library/react";
import { afterEach, describe, expect, it } from "vitest";
import { loadPluginApp, renderSlot } from "@get-bb/plugin-sdk/testing/app";
import type { PluginRpcTestHandlers } from "@get-bb/plugin-sdk/testing/app";
import type { Draft, MailMessage, MessageSummary } from "../contract";
import type { rpcContract } from "../server";

await loadPluginApp(() => import("../app"));
const { Mailbox } = await import("../src/app/Mailbox");
const { frameDocument, sanitizeMail } = await import("../src/app/MessageBody");
const { viewableType } = await import("../src/app/Attachments");
const { useRpc } = await import("@get-bb/plugin-sdk/app");

afterEach(cleanup);

const HTML =
  "<html><head><style>p{color:red}</style><script>parent.alert(1)</script><meta http-equiv='refresh' content='0;url=https://evil.test'></head><body>" +
  '<p onclick="steal()">Hi <b>Alice</b></p><img src="cid:Chart1@Example.test"><img src="https://tracker.test/p.gif"><img src="data:image/svg+xml;base64,PHN2Zz4=">' +
  '<a href="javascript:alert(1)">bad</a> <a href="https://example.test/r">good</a><form action="https://evil.test"><input name="pw"></form>' +
  '<iframe src="https://evil.test"></iframe><svg><script>alert(1)</script></svg><table background="https://tracker.test/bg.gif"><tr><td>x</td></tr></table></body></html>';

describe("sanitizing HTML mail", () => {
  const images = new Map([["chart1@example.test", "data:image/png;base64,iVBORw0KGgo="]]);

  it("drops scripts, handlers, forms, frames and unsafe links, and keeps the message's own pictures", () => {
    const { head, body, blocked } = sanitizeMail(HTML, { images, remote: false });
    const all = head + body;
    expect(all).not.toMatch(/<script|onclick|<form|<input|<iframe|<svg|<meta|javascript:|refresh/i);
    expect(head).toBe("<style>p{color:red}</style>");
    expect(body).toContain('src="data:image/png;base64,iVBORw0KGgo="');
    expect(body).not.toContain("tracker.test");
    expect(body).not.toContain("svg+xml");
    expect(blocked).toBe(1);
    expect(body).toContain('<a href="https://example.test/r" target="_blank" rel="noopener noreferrer">good</a>');
    expect(body).toMatch(/<a>bad<\/a>/);
  });

  it("loads pictures from the internet only when asked", () => {
    const { body, blocked } = sanitizeMail(HTML, { images, remote: true });
    expect(blocked).toBe(0);
    expect(body).toContain('src="https://tracker.test/p.gif"');
    expect(body).not.toContain("bg.gif");
  });

  it("puts a policy in the frame that forbids scripts and loads", () => {
    const doc = frameDocument({ head: "", body: "<p>x</p>" }, false);
    expect(doc).toContain(`content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; font-src data:"`);
    expect(doc).toContain('<base target="_blank">');
    expect(frameDocument({ head: "", body: "" }, true)).toContain("img-src data: https: http:;");
  });

  it("opens only types a browser shows without running anything", () => {
    expect(viewableType("Agenda.PDF")).toBe("application/pdf");
    expect(viewableType("photo.jpeg")).toBe("image/jpeg");
    expect(viewableType("notes.txt")).toBe("text/plain;charset=utf-8");
    for (const name of ["page.html", "logo.svg", "doc.xhtml", "macro.docm", "run.exe", "noext"]) expect(viewableType(name)).toBeNull();
  });
});

const bob = { name: "Bob Builder", email: "bob@example.test" };
const people = Array.from({ length: 7 }, (_, n) => ({ name: `Person ${n + 1}`, email: `p${n + 1}@example.test` }));
const summary: MessageSummary = { ref: "m0000000001", kind: "Message", subject: "Quarterly report draft", from: bob, displayTo: "Alice", received: "2026-10-31T11:55:00Z", isRead: false, hasAttachments: true, preview: "Hi Alice" };
const message: MailMessage = {
  ...summary,
  to: [{ name: "Alice Example", email: "alice@example.test" }],
  cc: people,
  sent: null,
  body: "Hi Alice",
  html: HTML,
  bodyFormat: "html",
  attachments: [
    { index: 1, name: "chart.png", size: 5, contentType: "image/png", kind: "file", inline: true, contentId: "Chart1@Example.test" },
    { index: 2, name: "agenda.pdf", size: 2048, contentType: "application/pdf", kind: "file", inline: false, contentId: null },
    { index: 3, name: "page.html", size: 100, contentType: "text/html", kind: "file", inline: false, contentId: null },
    { index: 4, name: "Earlier mail", size: null, contentType: null, kind: "item", inline: false, contentId: null },
  ],
};
const forwarded: Draft = {
  id: "d_0123456789ab",
  kind: "forward",
  source: "person",
  threadId: null,
  createdAt: 1,
  subject: "FW: Quarterly report draft",
  to: [{ name: null, email: "dave@example.test" }],
  cc: [],
  bcc: [],
  attachments: [{ name: "agenda.pdf", size: 2048 }],
  bodyFormat: "html",
  body: "FYI",
  text: "FYI",
  replyTo: { ref: summary.ref, subject: summary.subject, from: bob },
  revision: "CK1",
};

function renderMailbox() {
  const calls: Array<{ method: string; input: unknown }> = [];
  const log = (method: string) => (input: unknown) => void calls.push({ method, input });
  const handlers = {
    list: (input: unknown) => (log("list")(input), { messages: [summary], total: 1, more: false, unread: 1 }),
    read: (input: unknown) => (log("read")(input), message),
    conversation: (input: unknown) => (log("conversation")(input), { messages: [{ ...summary, ref: "m0000000002", subject: "Quarterly report", from: { name: "Alice Example", email: "alice@example.test" }, isRead: true }, summary] }),
    inlineImages: (input: unknown) => (log("inlineImages")(input), { images: [{ contentId: "Chart1@Example.test", dataUrl: "data:image/png;base64,iVBORw0KGgo=" }], skipped: 0 }),
    saveDraft: (input: unknown) => (log("saveDraft")(input), forwarded),
    draft: (input: unknown) => (log("draft")(input), { draft: forwarded, hostId: "host_1" }),
  } as unknown as PluginRpcTestHandlers<typeof rpcContract>;
  function Harness() {
    return <Mailbox rpc={useRpc<typeof rpcContract>()} hostId="host_1" folder="inbox" />;
  }
  renderSlot({ component: Harness }, {}, { rpc: handlers });
  return calls;
}

describe("a message in the panel", () => {
  it("shows people by name, folds a long copy list, and keeps the HTML in a frame without scripts", async () => {
    const calls = renderMailbox();
    fireEvent.click(await screen.findByText("Quarterly report draft"));
    const frame = (await screen.findByTitle("Message text")) as HTMLIFrameElement;
    expect(frame.getAttribute("sandbox")).toBe("allow-same-origin allow-popups allow-popups-to-escape-sandbox");
    expect(frame.getAttribute("sandbox")).not.toMatch(/allow-scripts|allow-forms/);
    expect(frame.getAttribute("srcdoc")).not.toMatch(/<script|tracker\.test/);

    expect(screen.getByRole("button", { name: "Actions for Bob Builder" }).textContent).toBe("Bob Builder");
    expect(screen.queryByText("bob@example.test")).toBeNull();
    expect(screen.getByText("Person 3")).toBeTruthy();
    expect(screen.queryByText("Person 4")).toBeNull();
    fireEvent.click(screen.getByText("and 4 more"));
    expect(screen.getByText("Person 7")).toBeTruthy();

    // A picture from the internet waits for the person.
    fireEvent.click(screen.getByText("Show pictures"));
    await waitFor(() => expect(frame.getAttribute("srcdoc")).toContain("tracker.test/p.gif"));

    // The conversation, and the message's own picture fetched once.
    expect(await screen.findByText("Conversation, 2 messages")).toBeTruthy();
    expect(calls.filter((c) => c.method === "inlineImages")).toHaveLength(1);
  });

  it("lists files but not the picture inside the text; PDF opens, HTML only saves", async () => {
    renderMailbox();
    fireEvent.click(await screen.findByText("Quarterly report draft"));
    await screen.findByText("agenda.pdf");
    expect(screen.queryByText("chart.png")).toBeNull();
    const row = (name: string) => screen.getByText(name).closest("li")!;
    expect(row("agenda.pdf").textContent).toMatch(/Open.*Save/);
    expect(row("page.html").textContent).not.toMatch(/Open/);
    expect(row("page.html").textContent).toMatch(/Save/);
    expect(row("Earlier mail").textContent).toMatch(/opens in Outlook/);
  });

  it("writes to a person from their menu, address already filled in", async () => {
    const calls = renderMailbox();
    fireEvent.click(await screen.findByText("Quarterly report draft"));
    const person = await screen.findByRole("button", { name: "Actions for Bob Builder" });
    fireEvent.pointerDown(person, { button: 0, pointerType: "mouse" });
    fireEvent.click(await screen.findByRole("menuitem", { name: "Write to them" }));
    expect((screen.getByLabelText("To") as HTMLInputElement).value).toBe("Bob Builder <bob@example.test>");
    fireEvent.change(screen.getByPlaceholderText("Subject"), { target: { value: "Lunch?" } });
    fireEvent.change(screen.getByPlaceholderText("Your message."), { target: { value: "Free at noon?" } });
    fireEvent.click(screen.getByRole("button", { name: "Prepare to send" }));
    await waitFor(() => expect(calls.some((c) => c.method === "saveDraft")).toBe(true));
    expect(calls.find((c) => c.method === "saveDraft")?.input).toEqual({ hostId: "host_1", kind: "new", subject: "Lunch?", to: ["Bob Builder <bob@example.test>"], body: "Free at noon?" });
  });

  it("prepares a forward as a draft with its recipients; nothing is sent from here", async () => {
    const calls = renderMailbox();
    fireEvent.click(await screen.findByText("Quarterly report draft"));
    fireEvent.click(await screen.findByRole("button", { name: "Forward" }));
    const prepare = screen.getByRole("button", { name: "Prepare to send" }) as HTMLButtonElement;
    expect(prepare.disabled).toBe(true);
    fireEvent.change(screen.getByLabelText("To"), { target: { value: "Dave <dave@example.test>, eve@example.test" } });
    fireEvent.change(screen.getByPlaceholderText(/A note above the forwarded message/), { target: { value: "FYI" } });
    fireEvent.click(prepare);
    await screen.findByText(/Forward — draft, not sent/);
    expect(calls.find((c) => c.method === "saveDraft")?.input).toEqual({
      hostId: "host_1",
      kind: "forward",
      replyTo: summary.ref,
      to: ["Dave <dave@example.test>", "eve@example.test"],
      body: "FYI",
    });
    expect(calls.some((c) => c.method === "sendDraft")).toBe(false);
  });
});
