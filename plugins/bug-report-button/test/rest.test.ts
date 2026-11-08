import { mkdtemp, mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { Answer } from "../contract";
import { openFileSecretStore, openSecretStore, secretFileDirectory } from "../src/host/secret-store";
import { multipartBody, ReportHost, requestUrl } from "../src/host/service";
import { buildJson, failureText, readRestConfig, sendRest, type RestConfig } from "../src/rest";

const BASE = "https://tracker.example.test/api/v1";
const SETTINGS = {
  apiBaseUrl: `${BASE}/`,
  submitPath: "/forms/abc/submit",
  submitFields: '{"title":"{subject}","body":"{description}\\n\\n{context}"}',
  attachPath: "/issues/{key}/attachments",
  shareKeyWith: "tracker-board",
  recordUrl: "https://tracker.example.test/{key}",
  keyHelp: "Profile → API keys.",
};

describe("REST settings", () => {
  it("reads a complete setup and fills defaults", () => {
    expect(readRestConfig(SETTINGS)).toEqual({
      baseUrl: BASE,
      submitPath: "/forms/abc/submit",
      fields: { title: "{subject}", body: "{description}\n\n{context}" },
      auth: { header: "X-API-Key", format: "{key}" },
      attachPath: "/issues/{key}/attachments",
      attachField: "file",
      shareWith: "tracker-board",
      recordUrl: "https://tracker.example.test/{key}",
      keyHelp: "Profile → API keys.",
      files: "attach",
      fileField: "file",
      combine: true,
    });
    expect(readRestConfig({ ...SETTINGS, restFiles: "form", fileField: "attachment", fileMode: "separate" })).toMatchObject({ files: "form", fileField: "attachment", combine: false });
    expect(readRestConfig({ ...SETTINGS, restFiles: "form", fileField: "a b" })).toHaveProperty("error");
  });

  it("is off until the address and the path are set, and refuses broken values", () => {
    expect(readRestConfig({})).toEqual({ error: "not-configured" });
    expect(readRestConfig({ ...SETTINGS, submitPath: "" })).toEqual({ error: "not-configured" });
    expect(readRestConfig({ ...SETTINGS, apiBaseUrl: "javascript:alert(1)" })).toEqual({ error: "not-configured" });
    expect(readRestConfig({ ...SETTINGS, attachPath: "/issues/attachments" })).toHaveProperty("error");
    expect(readRestConfig({ ...SETTINGS, authFormat: "Bearer" })).toHaveProperty("error");
    expect(readRestConfig({ ...SETTINGS, shareKeyWith: "../x" })).toMatchObject({ shareWith: null });
  });

  it("builds the JSON body from the templates", () => {
    expect(JSON.parse(buildJson({ a: "{subject}", b: "{description} / {context}", c: "fixed" }, { subject: "S", description: "D", context: "C" }))).toEqual({
      a: "S",
      b: "D / C",
      c: "fixed",
    });
  });
});

describe("REST sending", () => {
  const config = readRestConfig(SETTINGS) as RestConfig;
  const report = { subject: "Save fails", description: "Steps", context: "bb" };
  const images = [
    { name: "a.png", type: "image/png" as const, base64: "AQID" },
    { name: "b.png", type: "image/png" as const, base64: "BA==" },
  ];
  const calls = (json: Answer, file: (path: string, name: string) => Answer = () => ({ ok: true, status: 201, text: "{}" })) => {
    const log: unknown[] = [];
    return {
      log,
      calls: {
        postForm: async (input: unknown) => (log.push(["form", input]), json),
        postJson: async (input: unknown) => (log.push(["json", input]), json),
        postFile: async (input: { path: string; file: { name: string } }) => (log.push(["file", input.path, input.file.name]), file(input.path, input.file.name)),
      },
    };
  };

  it("submits, reads the record and attaches every picture to it", async () => {
    const { log, calls: c } = calls({ ok: true, status: 201, text: '{"data":{"key":{"value":"BUGS-7"}}}' });
    expect(await sendRest(config, report, images, c)).toEqual({ ok: true, key: "BUGS-7", url: "https://tracker.example.test/BUGS-7", warning: null });
    expect(log[0]).toEqual([
      "json",
      { baseUrl: BASE, shareWith: "tracker-board", auth: { header: "X-API-Key", format: "{key}" }, path: "/forms/abc/submit", body: '{"title":"Save fails","body":"Steps\\n\\nbb"}' },
    ]);
    expect(log.slice(1)).toEqual([
      ["file", "/issues/BUGS-7/attachments", "a.png"],
      ["file", "/issues/BUGS-7/attachments", "b.png"],
    ]);
  });

  it("keeps the report when a picture fails, and says which", async () => {
    const { calls: c } = calls({ ok: true, status: 201, text: "BUGS-8" }, (_path, name) =>
      name === "b.png" ? { ok: false, code: "tooLarge", status: 413, detail: null } : { ok: true, status: 201, text: "" },
    );
    const result = await sendRest(config, report, images, c);
    expect(result).toMatchObject({ ok: true, key: "BUGS-8" });
    expect(result.ok && result.warning).toBe(
      "The report is sent, but 1 of 2 pictures are not attached. b.png: The tracker refused the request as too large. Attach smaller pictures (HTTP 413).",
    );
  });

  it("does not guess a record it was not told about", async () => {
    const { log, calls: c } = calls({ ok: true, status: 200, text: '{"ok":true}' });
    const result = await sendRest(config, report, images, c);
    expect(result).toEqual({ ok: true, key: null, url: null, warning: "The report is sent, but the pictures are not: the tracker did not say which record it created." });
    expect(log).toHaveLength(1);
  });

  it("form files: one multipart request with the fields and the pictures under the form's file field", async () => {
    const form = readRestConfig({ ...SETTINGS, restFiles: "form", fileField: "attachment", submitFields: '{"title":"{subject}\\n\\n{description}"}' }) as RestConfig;
    const { log, calls: c } = calls({ ok: true, status: 201, text: '{"key":"BUGS-9"}' });
    expect(await sendRest(form, report, images, c)).toEqual({ ok: true, key: "BUGS-9", url: "https://tracker.example.test/BUGS-9", warning: null });
    expect(log).toEqual([
      [
        "form",
        { baseUrl: BASE, shareWith: "tracker-board", auth: { header: "X-API-Key", format: "{key}" }, path: "/forms/abc/submit", fields: { title: "Save fails\n\nSteps" }, field: "attachment", files: images },
      ],
    ]);
    const refused = calls({ ok: false, code: "badRequest", status: 400, detail: "attachment: bad file" });
    expect(await sendRest(form, report, images, refused.calls)).toEqual({ ok: false, error: "The tracker refused the report (HTTP 400): attachment: bad file" });
  });

  it("turns a refusal into words", async () => {
    const { calls: c } = calls({ ok: false, code: "unauthorized", status: 401, detail: "invalid api key" });
    expect(await sendRest(config, report, [], c)).toEqual({ ok: false, error: "The tracker did not accept your API key. Check it or save a new one (HTTP 401): invalid api key" });
    expect(failureText({ ok: false, code: "noKey", status: null, detail: null })).toBe("There is no API key on this computer. Save yours above.");
  });
});

describe("host: the key and the request", () => {
  let root = "";
  let close = () => {};
  const seen: Array<{ url: string; headers: IncomingMessage["headers"]; body: Buffer }> = [];
  let answer: { status: number; text: string; headers?: Record<string, string> } = { status: 201, text: '{"key":"BUGS-1"}' };
  let base = "";

  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), "brb-host-"));
    seen.length = 0;
    answer = { status: 201, text: '{"key":"BUGS-1"}' };
    const server = createServer((request, response) => {
      const chunks: Buffer[] = [];
      request.on("data", (chunk: Buffer) => chunks.push(chunk));
      request.on("end", () => {
        seen.push({ url: request.url ?? "", headers: request.headers, body: Buffer.concat(chunks) });
        response.writeHead(answer.status, { "content-type": "application/json", ...answer.headers }).end(answer.text);
      });
    });
    await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
    close = () => server.close();
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}/api/v1`;
  });
  afterEach(async () => {
    close();
    await rm(root, { recursive: true, force: true });
  });

  const dirs = () => ({ own: join(root, "data", "plugins", "bug-report-button", "host-data"), board: join(root, "data", "plugins", "tracker-board", "host-data") });
  const host = () =>
    new ReportHost({ dataDir: dirs().own, store: openFileSecretStore(join(root, "own")), sharedStore: (plugin) => openFileSecretStore(join(root, plugin)) });
  const auth = { header: "X-API-Key", format: "{key}" };

  it("saves the key for one address and sends it only there", async () => {
    const h = host();
    expect(await h.status(base, null)).toEqual({ hasKey: false, source: null, keyStore: null });
    expect(await h.saveKey(base, null, "  xk_own  ")).toEqual({ hasKey: true, source: "own", keyStore: "file" });
    expect((await readFile(join(root, "own", "api-key"), "utf8")).trim()).toBe(Buffer.from("xk_own").toString("base64"));
    expect(JSON.stringify(await readFile(join(dirs().own, "state.json"), "utf8"))).not.toContain("xk_own");

    const result = await h.post({ baseUrl: base, shareWith: null, auth, path: "/forms/abc/submit", body: '{"a":1}', type: "application/json" });
    expect(result).toEqual({ ok: true, status: 201, text: '{"key":"BUGS-1"}' });
    expect(seen[0]).toMatchObject({ url: "/api/v1/forms/abc/submit", body: Buffer.from('{"a":1}') });
    expect(seen[0]!.headers["x-api-key"]).toBe("xk_own");
    expect(seen[0]!.headers["content-type"]).toBe("application/json");

    // Another address: the key is not sent.
    const other = base.replace("127.0.0.1", "localhost");
    expect(await h.status(other, null)).toMatchObject({ hasKey: false });
    expect(await h.post({ baseUrl: other, shareWith: null, auth, path: "/x", body: "{}", type: "application/json" })).toMatchObject({ ok: false, code: "noKey" });
    expect(seen).toHaveLength(1);
  });

  it("uses the tracker board's key for the same address, and never forgets it", async () => {
    await mkdir(dirs().board, { recursive: true });
    await writeFile(join(dirs().board, "state.json"), JSON.stringify({ origin: new URL(base).origin, lastCheck: null }));
    await mkdir(join(root, "tracker-board"), { recursive: true });
    await writeFile(join(root, "tracker-board", "api-key"), `${Buffer.from("xk_board").toString("base64")}\n`);
    const h = host();
    expect(await h.status(base, null)).toMatchObject({ hasKey: false });
    expect(await h.status(base, "tracker-board")).toEqual({ hasKey: true, source: "shared", keyStore: "file" });
    await h.post({ baseUrl: base, shareWith: "tracker-board", auth, path: "/forms/abc/submit", body: "{}", type: "application/json" });
    expect(seen[0]!.headers["x-api-key"]).toBe("xk_board");
    expect(await h.forget(base, "tracker-board")).toMatchObject({ hasKey: true, source: "shared" });
    expect(await readFile(join(root, "tracker-board", "api-key"), "utf8")).toContain(Buffer.from("xk_board").toString("base64"));

    // The board's key was saved for another address: not used.
    await writeFile(join(dirs().board, "state.json"), JSON.stringify({ origin: "https://elsewhere.test" }));
    expect(await h.status(base, "tracker-board")).toMatchObject({ hasKey: false });
    // Our own key wins over the shared one.
    await h.saveKey(base, "tracker-board", "xk_own");
    expect(await h.status(base, "tracker-board")).toMatchObject({ source: "own" });
  });

  it("does not follow a redirect with the key, nor leave the address by the path", async () => {
    const h = host();
    await h.saveKey(base, null, "xk_own");
    answer = { status: 302, text: "", headers: { location: "https://evil.test/steal" } };
    expect(await h.post({ baseUrl: base, shareWith: null, auth, path: "/forms/abc/submit", body: "{}", type: "application/json" })).toMatchObject({ ok: false, code: "redirect", status: 302 });
    expect(seen).toHaveLength(1);
    for (const path of ["//evil.test/x", "/../../x", "/a/../../b", "x", "/a\\b"]) {
      expect(await h.post({ baseUrl: base, shareWith: null, auth, path, body: "{}", type: null }), path).toMatchObject({ ok: false, code: "badAddress" });
    }
    expect(() => requestUrl(base, "/forms/1/submit")).not.toThrow();
  });

  it("sends a picture as multipart/form-data under the field name", async () => {
    const h = host();
    await h.saveKey(base, null, "xk_own");
    const form = new FormData();
    form.append("file", new Blob([new Uint8Array([1, 2, 3])], { type: "image/png" }), "скрин.png");
    await h.post({ baseUrl: base, shareWith: null, auth, path: "/issues/BUGS-1/attachments", body: form, type: null });
    const got = seen[0]!;
    expect(got.headers["content-type"]).toMatch(/^multipart\/form-data; boundary=/);
    const parsed = await new Request("http://x", { method: "POST", headers: { "content-type": got.headers["content-type"]! }, body: new Uint8Array(got.body) }).formData();
    const file = parsed.get("file") as File;
    expect(file.name).toBe("скрин.png");
    expect([...new Uint8Array(await file.arrayBuffer())]).toEqual([1, 2, 3]);
  });

  it("maps failures for the page", async () => {
    const h = host();
    await h.saveKey(base, null, "xk_own");
    for (const [status, code] of [[401, "unauthorized"], [403, "forbidden"], [404, "notFound"], [413, "tooLarge"], [400, "badRequest"], [502, "serverError"]] as const) {
      answer = { status, text: "<b>nope</b>" };
      expect(await h.post({ baseUrl: base, shareWith: null, auth, path: "/x", body: "{}", type: null })).toEqual({ ok: false, code, status, detail: "nope" });
    }
    close();
    expect(await h.post({ baseUrl: base, shareWith: null, auth, path: "/x", body: "{}", type: null })).toMatchObject({ ok: false, code: "unreachable" });
  });

  it("sends a whole form, fields and several files, as one multipart request", async () => {
    const h = host();
    await h.saveKey(base, null, "xk_own");
    const body = multipartBody({ title: "Тема\n\nОписание", extra: "x" }, "attachment", [
      { name: "a.png", type: "image/png", base64: "AQID" },
      { name: "b.png", type: "image/png", base64: "BA==" },
    ]);
    expect(await h.post({ baseUrl: base, shareWith: null, auth, path: "/forms/abc/submit", body, type: null })).toMatchObject({ ok: true });
    const got = seen[0]!;
    expect(got.headers["x-api-key"]).toBe("xk_own");
    const parsed = await new Request("http://x", { method: "POST", headers: { "content-type": got.headers["content-type"]! }, body: new Uint8Array(got.body) }).formData();
    expect(parsed.get("title")).toBe("Тема\r\n\r\nОписание");
    expect(parsed.get("extra")).toBe("x");
    expect((parsed.getAll("attachment") as File[]).map((file) => file.name)).toEqual(["a.png", "b.png"]);
  });

  it("keeps each plugin's key under its own service name", () => {
    expect(secretFileDirectory("bb-bug-report-button", { XDG_DATA_HOME: "/d" })).toBe("/d/bb-bug-report-button/secrets");
    expect(secretFileDirectory("bb-tracker-board", { XDG_DATA_HOME: "/d" })).toBe("/d/bb-tracker-board/secrets");
    expect(() => openSecretStore("tracker-board")).toThrow(/invalid secret service/);
  });
});
