// The plugin as a whole on bb's fake host: what happens to a message while
// the proxy is missing, downloading or running, and what Fleet Kit is told.
import { chmod, mkdtemp, rm, writeFile } from "node:fs/promises";
import { createServer, type Server } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createFakePluginHost, makeMessageDispatchHookContext } from "@get-bb/plugin-sdk/testing";
import { afterAll, afterEach, beforeAll, describe, expect, it } from "vitest";
import plugin from "../server";
import { KEY_HEADER, THREAD_HEADER, type ThreadStatus } from "../src/shared";

let dir: string;
beforeAll(async () => {
  dir = await mkdtemp(join(tmpdir(), "masking-proxy-server-"));
});
afterAll(async () => {
  await rm(dir, { recursive: true, force: true });
});

const stops: AbortController[] = [];
afterEach(() => {
  for (const stop of stops.splice(0)) stop.abort();
});

async function fakeProxy(name: string, delaySeconds: number): Promise<string> {
  const path = join(dir, name);
  await writeFile(
    path,
    `#!/bin/sh\nsleep ${delaySeconds}\necho '{"level":"INFO","msg":"listening","addr":"127.0.0.1:1"}'\nexec sleep 30\n`,
  );
  await chmod(path, 0o755);
  return path;
}

async function load(settings: Record<string, string | boolean>) {
  const { bb, harness } = createFakePluginHost({ pluginId: "obfuscation-proxy", settings });
  await plugin(bb);
  const service = harness.runService("masking-proxy");
  stops.push(service.controller);
  // A failed run rejects so bb restarts the service with backoff; tests that care await `done`.
  service.done.catch(() => {});
  const status = (threadId = "thr_1", lang: "en" | "ru" = "ru") =>
    harness.callRpc("thread_status", { threadId, lang }) as Promise<ThreadStatus>;
  const dispatch = (providerId: string, threadId = "thr_1") =>
    harness.registrations.hooks["message.dispatch"]!(
      makeMessageDispatchHookContext({
        thread: { id: threadId, sourceThreadId: null },
        requestedExecution: { providerId, model: null, reasoningLevel: null, serviceTier: null, permissionMode: null },
      }),
    );
  return { bb, harness, status, dispatch, done: service.done };
}

async function until(check: () => Promise<boolean>, ms = 5_000): Promise<void> {
  const deadline = Date.now() + ms;
  while (!(await check())) {
    if (Date.now() > deadline) throw new Error("condition not met in time");
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
}

describe("without a proxy binary", () => {
  it("queues messages to Claude Code with a reason instead of breaking them", async () => {
    const { harness, status, dispatch } = await load({});
    await until(async () => (await status()).proxy.state === "not-configured");

    const decision = await dispatch("claude-code");
    expect(decision).toMatchObject({ action: "wait" });
    expect((decision as { reason: string }).reason).toMatch(/^Прокси обфускации не установлен: в настройках плагина нет адреса/u);
    expect((decision as { reason: string }).reason).toContain("выключите обфускацию над полем ввода");
    // Agents on in-network models are not this plugin's business.
    expect(await dispatch("acp-opencode")).toEqual({ action: "proceed" });

    expect(await harness.callRpc("setupStatus", { lang: "ru" })).toMatchObject({
      state: "problem",
      summary: expect.stringMatching(/^Прокси обфускации не установлен/u),
    });
    // Without a language in the call, the one people last used.
    expect(await harness.callRpc("setupStatus", null)).toMatchObject({
      state: "problem",
      summary: "Прокси обфускации не установлен: в настройках плагина нет адреса загрузки",
    });

    // Turning masking off sends the queued message on.
    const before = harness.inspection.recheckCount;
    await harness.callRpc("thread_set_masking", { threadId: "thr_1", masking: false });
    expect(harness.inspection.recheckCount).toBeGreaterThan(before);
    expect(await dispatch("claude-code")).toEqual({ action: "proceed" });
  });

  it("refuses a request that bypassed the queue, in the person's language, and sends nothing", async () => {
    const { bb, harness, status } = await load({});
    await until(async () => (await status("thr_2", "ru")).proxy.state === "not-configured");
    const key = await bb.storage.kv.get<string>("routing-key");
    const route = harness.registrations.httpRoutes.find((item) => item.path === "/v1/messages")!;
    const response = await route.handler({
      req: {
        raw: new Request("http://127.0.0.1/api/v1/plugins/obfuscation-proxy/http/v1/messages", {
          method: "POST",
          headers: { [KEY_HEADER]: key!, [THREAD_HEADER]: "thr_2", "content-type": "application/json" },
          body: '{"model":"m","messages":[]}',
        }),
      },
    } as never);
    expect(response.status).toBe(503);
    const body = (await response.json()) as { error: { message: string } };
    expect(body.error.message).toBe(
      "Обфускация в этом треде включена. Прокси обфускации не установлен: в настройках плагина нет адреса загрузки. " +
        "Ничего не отправлено. Подождите, пока он запустится, или выключите обфускацию над полем ввода.",
    );
  });
});

describe("when the release host refuses the download", () => {
  let server: Server;
  let base: string;
  beforeAll(async () => {
    server = createServer((_req, res) => res.writeHead(401).end());
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    const address = server.address();
    base = `http://127.0.0.1:${typeof address === "object" && address !== null ? address.port : 0}`;
  });
  afterAll(() => new Promise<void>((resolve) => server.close(() => resolve())));

  it("says the proxy did not download, in the thread and in Fleet Kit", async () => {
    const { status, dispatch, harness, done } = await load({ downloadUrl: `${base}/proxy-{os}-{arch}{ext}` });
    await expect(done).rejects.toThrow(/^HTTP 401 /u);
    expect((await status()).proxy).toMatchObject({ problem: "download", message: expect.stringMatching(/^HTTP 401 /u) });
    const decision = await dispatch("claude-code");
    expect(decision).toMatchObject({ action: "wait" });
    expect((decision as { reason: string }).reason).toMatch(/^Прокси обфускации не скачался \(HTTP 401 /u);
    expect(await harness.callRpc("setupStatus", { lang: "ru" })).toMatchObject({
      state: "problem",
      summary: expect.stringMatching(/^Прокси обфускации не скачался \(HTTP 401 /u),
    });
  });
});

describe("with a proxy that takes a moment to start", () => {
  it("lets messages through once it runs and tells core to re-check the queue", async () => {
    const binaryPath = await fakeProxy("slow.sh", 0.6);
    const { harness, status, dispatch } = await load({ binaryPath });
    await until(async () => ["installing", "starting"].includes((await status()).proxy.state));
    const waiting = await dispatch("claude-code");
    expect(waiting).toMatchObject({ action: "wait" });
    expect((waiting as { reason: string }).reason).toMatch(/^Прокси обфускации (запускается|ещё скачивается)\. Сообщение уйдёт само/u);
    expect(await harness.callRpc("setupStatus", { lang: "en" })).toMatchObject({ state: "todo" });

    const before = harness.inspection.recheckCount;
    await until(async () => (await status()).proxy.state === "running");
    expect(harness.inspection.recheckCount).toBeGreaterThan(before);
    // Once more after core's one-second pause between re-attempts on a thread.
    const once = harness.inspection.recheckCount;
    await until(async () => harness.inspection.recheckCount > once, 3_000);
    expect(await dispatch("claude-code")).toEqual({ action: "proceed" });
    expect(await harness.callRpc("setupStatus", { lang: "ru" })).toEqual({
      state: "done",
      summary: "Прокси обфускации работает",
    });
  });

  it("holds a request in flight until the proxy runs instead of refusing it", async () => {
    const binaryPath = await fakeProxy("slow2.sh", 0.8);
    const { bb, harness, status } = await load({ binaryPath });
    await until(async () => ["installing", "starting"].includes((await status()).proxy.state));
    const key = await bb.storage.kv.get<string>("routing-key");
    const route = harness.registrations.httpRoutes.find((item) => item.path === "/v1/messages")!;
    const response = await route.handler({
      req: {
        raw: new Request("http://127.0.0.1/api/v1/plugins/obfuscation-proxy/http/v1/messages", {
          method: "POST",
          headers: { [KEY_HEADER]: key!, [THREAD_HEADER]: "thr_3", "content-type": "application/json" },
          body: '{"model":"m","messages":[]}',
        }),
      },
    } as never);
    // The fake proxy listens nowhere, so the forward fails at the socket: the request was not refused up front.
    expect(response.status).toBe(502);
    expect(((await response.json()) as { error: { message: string } }).error.message).toContain("masking proxy");
    expect((await status()).proxy.state).toBe("running");
  });
});
