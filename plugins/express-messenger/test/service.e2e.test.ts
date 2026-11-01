// The host service against a stand-in web client (test/fixtures/mock-client.html) in a real
// browser without a window: the directory, search, reading without marking read, sending with a
// confirmation, and the watcher's counters.
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { SendConfirmer, SendSummary } from "../src/host/confirm";
import { findBrowser } from "../src/host/browser";
import { MessengerService } from "../src/host/service";

const here = dirname(fileURLToPath(import.meta.url));
const page = readFileSync(join(here, "fixtures", "mock-client.html"), "utf8");
const browser = findBrowser();

let server: Server;
let url = "";
let dataDir = "";
let service: MessengerService;
const asked: SendSummary[] = [];
let answer: "send" | "cancel" = "send";
const confirmer: SendConfirmer = {
  async confirm(summary) {
    asked.push(summary);
    return answer === "send" ? { ok: true } : { ok: false, reason: "cancelled", message: "The user did not confirm sending in the system window. Nothing was sent." };
  },
};

describe.skipIf(!browser)("host service on a mock web client", () => {
  beforeAll(async () => {
    server = createServer((_req, res) => {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(page);
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    url = `http://127.0.0.1:${typeof address === "object" && address ? address.port : 0}/`;
    dataDir = mkdtempSync(join(tmpdir(), "express-e2e-"));
    service = new MessengerService({ dataDir, confirmer, idleMs: 60_000, signInGraceMs: 2000 });
  });

  afterAll(async () => {
    await service?.close();
    service?.dispose();
    server?.close();
    if (dataDir) rmSync(dataDir, { recursive: true, force: true });
  });

  it("builds the directory with people of personal chats, owner-only", async () => {
    const result = await service.sync(url);
    expect(result.ok, result.message).toBe(true);
    // Calls are left out; the channel and the group count.
    expect(result.chats).toBe(5);
    expect(result.people).toBe(3);
    const mode = statSync(join(dataDir, "directory.json")).mode & 0o777;
    expect(mode).toBe(0o600);
  });

  it("finds people by the user's words", async () => {
    const found = await service.tool(url, { tool: "find", query: "Саша Волков" });
    expect(found.isError).toBe(false);
    expect(found.chat?.id).toBe("c1");
    const chat = await service.tool(url, { tool: "find", query: "т2цп" });
    expect(chat.chat?.id).toBe("c4");
    expect(chat.text).toContain("group");
  });

  it("lists unread chats", async () => {
    const unread = await service.tool(url, { tool: "unread" });
    expect(unread.text).toContain("Т2 ЦП");
    expect(unread.text).toContain("unread 7");
    expect(unread.text).toContain("Dmitry Ivanov");
  });

  it("reads the last messages and keeps the chat unread, without disappearing ones", async () => {
    const read = await service.tool(url, { tool: "read", chat: "c4", last: 5 });
    expect(read.isError, read.text).toBe(false);
    const lines = read.text.split("\n").filter((line) => line.startsWith("["));
    expect(lines).toHaveLength(5);
    expect(read.text).toContain("Message 13");
    expect(read.text).not.toContain("Message 14");
    expect(read.text).toContain("Disappearing messages left out: 1");
    expect(read.text).toContain("stays unread");
    const snapshot = await service.snapshot(url, ["c4"]);
    expect(snapshot.chats.c4).toEqual({ unread: 7, lastEventAt: 1700000780000 });
  });

  it("does not send to an unclear chat", async () => {
    const sent = await service.tool(url, { tool: "send", chat: "Волков", text: "Hello", confirm: true });
    expect(sent.isError).toBe(true);
    expect(sent.text).toMatch(/^Not sent/);
    expect(asked).toHaveLength(0);
  });

  it("sends nothing when the user cancels the window", async () => {
    answer = "cancel";
    const sent = await service.tool(url, { tool: "send", chat: "т2 цп", text: "Hello from the test", confirm: true });
    expect(sent.isError).toBe(true);
    expect(sent.text).toContain("did not confirm");
    expect(asked.at(-1)).toMatchObject({ chat: "Т2 ЦП", kind: "group", members: 3, text: "Hello from the test" });
  });

  it("sends after the confirmation, once", async () => {
    answer = "send";
    const sent = await service.tool(url, { tool: "send", chat: "т2 цп", text: "Hello from the test", confirm: true });
    expect(sent.isError, sent.text).toBe(false);
    expect(sent.text).toBe('Sent to "Т2 ЦП" (group).');
    const again = await service.tool(url, { tool: "send", chat: "c4", text: "Hello from the test", confirm: false });
    expect(again.isError).toBe(true);
    expect(again.text).toContain("same text");
  });

  it("asks to sign in when the client shows the sign-in screen", async () => {
    const signin = `${url}?signin`;
    const result = await service.tool(signin, { tool: "unread" });
    expect(result.isError).toBe(true);
    expect(result.text).toContain("asks to sign in");
    expect((await service.status(signin)).signedIn).toBe(false);
  });
});
