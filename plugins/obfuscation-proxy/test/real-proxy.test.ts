// End to end with a real masking proxy binary: MASKING_PROXY_BIN=/path/to/binary.
// The upstream is a local HTTPS server with a throwaway certificate.

import { execFileSync } from "node:child_process";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { createServer, type Server } from "node:https";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { MaskMatcher, ThreadFeeds } from "../src/feed";
import { forwardRequest } from "../src/forward";
import { KEY_HEADER, THREAD_HEADER } from "../src/shared";
import { ProxySupervisor } from "../src/supervisor";
import { memoryStorage } from "./helpers";

const BIN = process.env.MASKING_PROXY_BIN ?? "";
const KEY = "k".repeat(48);

const SECRET_EMAIL = "ivan.petrov@example.com";
const SECRET_TOKEN = "ghp_abcdefghijklmnopqrstuvwxyz0123456789";
const SECRET_HOST = "billing.corp.example";

function sse(events: { event: string; data: unknown }[]): string {
  return events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join("");
}

describe.skipIf(BIN === "")("with the real masking proxy", () => {
  let dir: string;
  let upstream: Server;
  let upstreamUrl: string;
  const seenBodies: string[] = [];
  const controller = new AbortController();
  let supervisor: ProxySupervisor;
  const masks = new MaskMatcher();

  beforeAll(async () => {
    dir = await mkdtemp(join(tmpdir(), "masking-proxy-e2e-"));
    execFileSync("openssl", [
      "req", "-x509", "-newkey", "rsa:2048", "-nodes", "-days", "1", "-subj", "/CN=localhost",
      "-addext", "subjectAltName=IP:127.0.0.1",
      "-keyout", join(dir, "key.pem"), "-out", join(dir, "cert.pem"),
    ], { stdio: "ignore" });
    process.env.SSL_CERT_FILE = join(dir, "cert.pem");
    upstream = createServer(
      { key: await readFile(join(dir, "key.pem")), cert: await readFile(join(dir, "cert.pem")) },
      (req, res) => {
        let body = "";
        req.on("data", (chunk) => (body += chunk));
        req.on("end", () => {
          seenBodies.push(body);
          const content = (JSON.parse(body) as { messages: { content: string }[] }).messages[0]!.content;
          res.writeHead(200, { "content-type": "text/event-stream" });
          res.end(
            sse([
              { event: "message_start", data: { type: "message_start", message: { id: "msg_1", role: "assistant" } } },
              { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
              { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `echo: ${content}` } } },
              { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
              { event: "message_delta", data: { type: "message_delta", delta: { stop_reason: "end_turn" } } },
              { event: "message_stop", data: { type: "message_stop" } },
            ]),
          );
        });
      },
    );
    await new Promise<void>((resolve) => upstream.listen(0, "127.0.0.1", resolve));
    const address = upstream.address();
    upstreamUrl = `https://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;

    supervisor = new ProxySupervisor({
      dir: join(dir, "work"),
      upstream: upstreamUrl,
      extraConfig: 'obfuscation:\n  detect:\n    org_domains: ["corp.example"]',
      resolveBinary: async () => BIN,
      onEvent: (event) => {
        if (event.kind === "masks") masks.report(event.inBytes, event.byCategory);
      },
      onStatus: () => {},
    });
    void supervisor.run(controller.signal).catch(() => {});
    const deadline = Date.now() + 15_000;
    while (supervisor.status.state !== "running" && Date.now() < deadline) {
      await new Promise((resolve) => setTimeout(resolve, 50));
    }
    if (supervisor.status.state !== "running") throw new Error(`proxy did not start: ${supervisor.status.message}`);
  }, 30_000);

  afterAll(async () => {
    controller.abort();
    await new Promise<void>((resolve) => upstream.close(() => resolve()));
    await rm(dir, { recursive: true, force: true });
  });

  it("masks what leaves, restores the answer and reports what it masked", async () => {
    const feeds = new ThreadFeeds(memoryStorage());
    const content = `deploy to ${SECRET_HOST}, mail ${SECRET_EMAIL}, token ${SECRET_TOKEN} please`;
    const request = new Request("http://127.0.0.1/api/v1/plugins/obfuscation-proxy/http/v1/messages", {
      method: "POST",
      headers: { "content-type": "application/json", [KEY_HEADER]: KEY, [THREAD_HEADER]: "thr_e2e" },
      body: JSON.stringify({ model: "claude-sonnet-5-5", stream: true, messages: [{ role: "user", content }] }),
    });
    const response = await forwardRequest(request, "/v1/messages", {
      key: KEY,
      upstream: upstreamUrl,
      isMasking: async () => true,
      proxy: () => (supervisor.url ? { url: supervisor.url } : { error: "down" }),
      feeds,
      masks,
      changed: () => {},
    });
    expect(response.status).toBe(200);
    const text = await response.text();

    const sent = seenBodies.at(-1)!;
    for (const secret of [SECRET_EMAIL, SECRET_TOKEN, SECRET_HOST]) {
      expect(sent).not.toContain(secret);
      expect(text).toContain(secret);
    }
    const deltas = text
      .split("\n")
      .filter((line) => line.startsWith("data: "))
      .map((line) => JSON.parse(line.slice(6)) as { type: string; delta?: { text?: string } })
      .filter((event) => event.type === "content_block_delta")
      .map((event) => event.delta?.text ?? "")
      .join("");
    expect(deltas).toBe(`echo: ${content}`);

    await new Promise((resolve) => setTimeout(resolve, 50));
    const [item] = await feeds.entries("thr_e2e");
    expect(item).toMatchObject({ via: "proxy", status: 200 });
    expect(item!.maskedTotal).toBeGreaterThanOrEqual(3);
    expect(Object.keys(item!.masked ?? {})).toEqual(
      expect.arrayContaining(["structured_pii", "secrets", "internal_hosts"]),
    );
  }, 30_000);
});
