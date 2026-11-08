import { readFileSync } from "node:fs";
import { createServer, type IncomingMessage } from "node:http";
import type { AddressInfo } from "node:net";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import bugReportButton from "../server";
import { BUG_SVG, DEFAULT_LABEL, MAX_LABEL_LENGTH, readConfig, readFormUrl } from "../src/config";
import { layout } from "../src/combine";
import { MAX_IMAGE_BYTES, MAX_IMAGES, MAX_TOTAL_BYTES, checkImage, formatBytes, imageName } from "../src/report";
import { revealOnce, withItem } from "../src/reveal";
import { buildBody, fillTemplate, readAnswer, readFields, readSendConfig, sendReport, type SendConfig } from "../src/send";

const FORM = "https://forms.example.test/report?team=7";
const png = (size: number, name = "shot.png") => ({ name, type: "image/png", size });

type Schema = { safeParse: (value: unknown) => { success: boolean } };
type Handlers = Record<string, (input: unknown) => Promise<unknown>>;

/** The server entry with fake settings: its descriptors, and its RPC handlers over the given values. */
type HostCall = { method: string; input: unknown; options: unknown };
let hostAnswer: (method: string, input: unknown) => unknown = () => {
  throw new Error("no host in this test");
};

function loadServer(
  values: Record<string, unknown> = {},
  uiPreferences: { list: () => Promise<unknown>; set: (args: unknown) => Promise<void> } = {
    list: async () => ({ preferences: { "sidebar.visiblePluginPanels": { revision: 0, value: null } } }),
    set: async () => {},
  },
) {
  let descriptors: Record<string, { experimental_schema: Schema; default: unknown }> = {};
  let handlers: Handlers = {};
  const warnings: string[] = [];
  const hostCalls: HostCall[] = [];
  const kv = new Map<string, unknown>();
  const api = {
    pluginId: "bug-report-button",
    sdk: {
      system: { uiPreferences, config: async () => ({ primaryHostId: "host-1" }) },
      hosts: { list: async () => [{ id: "host-1", status: "connected", lifecycle: { phase: "ready" } }] },
    },
    hosts: {
      experimental_client: () => ({
        call: async (method: string, input: unknown, options: unknown) => (hostCalls.push({ method, input, options }), hostAnswer(method, input)),
      }),
    },
    storage: { kv: { get: async (key: string) => kv.get(key), set: async (key: string, value: unknown) => void kv.set(key, value) } },
    settings: {
      define: (value: typeof descriptors) => {
        descriptors = value;
        return { get: async () => ({ ...Object.fromEntries(Object.entries(value).map(([k, d]) => [k, d.default])), ...values }) };
      },
    },
    rpc: { register: (_contract: unknown, value: Handlers) => (handlers = value) },
    http: { route: () => {} },
    log: { warn: (text: string) => warnings.push(text), info: () => {}, error: () => {}, debug: () => {} },
  };
  bugReportButton(api as unknown as Parameters<typeof bugReportButton>[0]);
  return { descriptors, handlers, warnings, hostCalls, schema: (name: string) => descriptors[name]!.experimental_schema };
}

describe("settings", () => {
  it("takes only http and https addresses", () => {
    expect(readFormUrl(FORM)).toBe(FORM);
    expect(readFormUrl(`  ${FORM}  `)).toBe(FORM);
    for (const value of ["", "javascript:alert(1)", "data:text/html,x", "file:///etc/passwd", "forms.example.test", 7, null, `https://a.test/${"x".repeat(2048)}`]) {
      expect(readFormUrl(value)).toBe("");
    }
  });

  it("uses the caption from settings, and the default when it is empty", () => {
    expect(readConfig({ formUrl: FORM, label: "  Send it  " })).toEqual({ url: FORM, label: "Send it" });
    expect(readConfig({ formUrl: FORM, label: "  " }).label).toBe(DEFAULT_LABEL);
  });

  it("checks every setting where it is saved", () => {
    const { schema } = loadServer();
    for (const name of ["formUrl", "submitUrl"]) {
      expect(schema(name).safeParse("").success).toBe(true);
      expect(schema(name).safeParse(FORM).success).toBe(true);
      expect(schema(name).safeParse("javascript:alert(1)").success).toBe(false);
    }
    expect(schema("label").safeParse("x".repeat(MAX_LABEL_LENGTH + 1)).success).toBe(false);
    expect(schema("submitFields").safeParse('{"title":"{subject}"}').success).toBe(true);
    expect(schema("submitFields").safeParse("").success).toBe(true);
    for (const bad of ["[1]", "{}", '{"a":1}', "{not json", '{"bad key":"x"}']) expect(schema("submitFields").safeParse(bad).success, bad).toBe(false);
    expect(schema("fileMode").safeParse("separate").success).toBe(true);
    expect(schema("fileMode").safeParse("zip").success).toBe(false);
  });

  it("keeps the plugin icon the same picture as the code", () => {
    expect(readFileSync(join(import.meta.dirname, "../icon.svg"), "utf8").trim()).toBe(BUG_SVG);
  });

  it("does not send without a submit address, and says what is wrong with the fields", () => {
    expect(readSendConfig({ submitUrl: "" })).toEqual({ error: "not-configured" });
    expect(readSendConfig({ submitUrl: FORM, submitFields: "[]" })).toHaveProperty("error");
    expect(readSendConfig({ submitUrl: FORM, fileField: "a b" })).toHaveProperty("error");
    expect(readSendConfig({ submitUrl: FORM, fileField: "file", fileMode: "x", recordUrl: "https://t.test/no-key" })).toEqual({
      submitUrl: FORM,
      fields: { subject: "{subject}", description: "{description}" },
      fileField: "file",
      fileMode: "combine",
      recordUrl: "",
    });
  });
});

describe("pictures", () => {
  it("takes pictures within the limits and explains a refusal", () => {
    expect(checkImage(png(1000), [])).toEqual({ ok: true });
    const refuse = (next: ReturnType<typeof png> | { name: string; type: string; size: number }, attached: ReturnType<typeof png>[] = []) => {
      const result = checkImage(next, attached.map((a) => ({ ...a, type: "image/png" as const })));
      return result.ok ? "" : result.reason;
    };
    expect(refuse({ name: "notes.pdf", type: "application/pdf", size: 10 })).toMatch(/notes\.pdf is not a PNG/);
    expect(refuse(png(MAX_IMAGE_BYTES + 1, "big.png"))).toBe(`big.png is ${formatBytes(MAX_IMAGE_BYTES + 1)}. A picture can be up to 5 MB.`);
    expect(refuse(png(10), Array.from({ length: MAX_IMAGES }, () => png(10)))).toMatch(/up to 6 pictures/);
    expect(refuse(png(MAX_IMAGE_BYTES), [png(MAX_IMAGE_BYTES), png(MAX_IMAGE_BYTES)].map((p) => ({ ...p, size: MAX_TOTAL_BYTES / 2 })))).toMatch(/together can be up to 15 MB/);
  });

  it("names pasted screenshots apart", () => {
    expect(imageName("image.png", "image/png", [])).toBe("screenshot.png");
    expect(imageName("image.png", "image/png", ["screenshot.png"])).toBe("screenshot-2.png");
    expect(imageName("", "image/jpeg", [])).toBe("screenshot.jpg");
    expect(imageName("a/b:c.png", "image/png", [])).toBe("a_b_c.png");
  });

  it("stacks joined pictures, keeps narrow ones at their size, and stays within the canvas limit", () => {
    const place = layout([{ width: 1000, height: 500 }, { width: 500, height: 500 }]);
    expect(place).toEqual({ width: 1000, height: 1016, boxes: [{ x: 0, y: 0, width: 1000, height: 500 }, { x: 250, y: 516, width: 500, height: 500 }] });
    expect(layout([{ width: 4000, height: 1000 }]).boxes[0]).toEqual({ x: 0, y: 0, width: 1920, height: 480 });
    const tall = layout([{ width: 3000, height: 30_000 }, { width: 3000, height: 30_000 }]);
    expect(tall.width).toBeLessThanOrEqual(1920);
    expect(tall.height).toBeLessThanOrEqual(16_000);
  });
});

describe("the sidebar item after an update", () => {
  const deps = (visible: unknown, revealed = false) => {
    const writes: Array<[string[], number]> = [];
    let mark = revealed;
    return {
      writes,
      marked: () => mark,
      deps: {
        itemId: "bug-report-button/report",
        wasRevealed: async () => mark,
        markRevealed: async () => void (mark = true),
        readVisible: async () => ({ revision: 7, value: visible }),
        writeVisible: async (value: string[], revision: number) => void writes.push([value, revision]),
      },
    };
  };

  it("adds the item for a person who changed the sidebar, once", async () => {
    const run = deps(["__bb__/new-thread", "__bb__/search-threads"]);
    expect(await revealOnce(run.deps)).toBe("shown");
    expect(run.writes).toEqual([[["__bb__/new-thread", "__bb__/search-threads", "bug-report-button/report"], 7]]);
    expect(await revealOnce(run.deps)).toBe("done-before");
    expect(run.writes).toHaveLength(1);
  });

  it("changes nothing when bb shows every item, or the item is already there", async () => {
    for (const visible of [null, ["bug-report-button/report"]]) {
      const run = deps(visible);
      expect(await revealOnce(run.deps)).toBe("already-visible");
      expect(run.writes).toEqual([]);
      expect(run.marked()).toBe(true);
    }
  });

  it("leaves the mark unset when the write fails, so the next start tries again", async () => {
    const run = deps(["__bb__/new-thread"]);
    run.deps.writeVisible = async () => {
      throw new Error("revision conflict");
    };
    await expect(revealOnce(run.deps)).rejects.toThrow("revision conflict");
    expect(run.marked()).toBe(false);
    expect(withItem("x", "a/b")).toBeNull();
  });

  it("runs from the server entry with bb's sidebar setting", async () => {
    const sets: unknown[] = [];
    const { warnings } = loadServer({}, {
      list: async () => ({ preferences: { "sidebar.visiblePluginPanels": { revision: 3, value: ["__bb__/skills"] } } }),
      set: async (args: unknown) => void sets.push(args),
    });
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(sets).toEqual([{ key: "sidebar.visiblePluginPanels", value: ["__bb__/skills", "bug-report-button/report"], expectedRevision: 3 }]);
    expect(warnings).toEqual([]);
  });
});

describe("sending", () => {
  const config: SendConfig = {
    submitUrl: "http://127.0.0.1:1/submit",
    fields: { title: "{subject}", text: "{description}\n\n{context}", fixed: "bb" },
    fileField: "attachment",
    fileMode: "separate",
    recordUrl: "https://tracker.example.test/{key}",
  };
  const report = {
    subject: "Save fails",
    description: "Click save, nothing happens",
    context: "bb 1.0",
    files: [
      { name: "a.png", type: "image/png", bytes: new Uint8Array([137, 80, 78, 71]) },
      { name: "b.png", type: "image/png", bytes: new Uint8Array([1, 2, 3]) },
    ],
  };

  it("fills field templates", () => {
    expect(fillTemplate("{subject}: {description} {other}", report)).toBe("Save fails: Click save, nothing happens {other}");
    expect(readFields('{"x":"{subject}"}')).toEqual({ x: "{subject}" });
  });

  it("puts every field and picture into the form body", async () => {
    const body = buildBody(config, report);
    expect(body.get("title")).toBe("Save fails");
    expect(body.get("text")).toBe("Click save, nothing happens\n\nbb 1.0");
    expect(body.get("fixed")).toBe("bb");
    const files = body.getAll("attachment") as File[];
    expect(files.map((file) => file.name)).toEqual(["a.png", "b.png"]);
    expect([...new Uint8Array(await files[0]!.arrayBuffer())]).toEqual([137, 80, 78, 71]);
  });

  it("finds the created record in JSON or text answers", () => {
    expect(readAnswer('{"data":{"key":{"value":"BUGS-12"}}}', config.recordUrl)).toEqual({ key: "BUGS-12", url: "https://tracker.example.test/BUGS-12" });
    expect(readAnswer('{"issue_key":"BUGS-7","url":"https://t.test/x/BUGS-7"}', "")).toEqual({ key: "BUGS-7", url: "https://t.test/x/BUGS-7" });
    expect(readAnswer("<p>Задача создана BUGS-128</p>", "")).toEqual({ key: "BUGS-128", url: null });
    expect(readAnswer('{"ok":true}', config.recordUrl)).toEqual({ key: null, url: null });
    expect(readAnswer('{"key":"BUGS-1","url":"javascript:alert(1)"}', "")).toEqual({ key: "BUGS-1", url: null });
  });

  describe("to a real HTTP server", () => {
    let close = () => {};
    afterEach(() => close());
    const serve = async (answer: (request: IncomingMessage, body: Buffer) => { status: number; text: string }) => {
      const seen: Array<{ type: string; body: Buffer }> = [];
      const server = createServer((request, response) => {
        const chunks: Buffer[] = [];
        request.on("data", (chunk: Buffer) => chunks.push(chunk));
        request.on("end", () => {
          const body = Buffer.concat(chunks);
          seen.push({ type: request.headers["content-type"] ?? "", body });
          const { status, text } = answer(request, body);
          response.writeHead(status, { "content-type": "application/json" }).end(text);
        });
      });
      await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
      close = () => server.close();
      return { url: `http://127.0.0.1:${(server.address() as AddressInfo).port}/submit`, seen };
    };

    it("posts multipart/form-data and reads the record from the answer", async () => {
      const { url, seen } = await serve(() => ({ status: 201, text: '{"key":"BUGS-5"}' }));
      const result = await sendReport({ ...config, submitUrl: url }, report);
      expect(result).toEqual({ ok: true, key: "BUGS-5", url: "https://tracker.example.test/BUGS-5" });
      expect(seen[0]!.type).toMatch(/^multipart\/form-data; boundary=/);
      const parsed = await new Request(url, { method: "POST", headers: { "content-type": seen[0]!.type }, body: new Uint8Array(seen[0]!.body) }).formData();
      expect(parsed.get("title")).toBe("Save fails");
      expect((parsed.getAll("attachment") as File[]).map((file) => file.name)).toEqual(["a.png", "b.png"]);
    });

    it("turns a refusal into words", async () => {
      const { url } = await serve(() => ({ status: 413, text: "<h1>Too big</h1>" }));
      const result = await sendReport({ ...config, submitUrl: url }, report);
      expect(result).toEqual({ ok: false, error: "The form refused the report as too large. Remove a picture or attach smaller ones (HTTP 413): Too big" });
    });

    it("says when the form cannot be reached", async () => {
      const result = await sendReport({ ...config, submitUrl: "http://127.0.0.1:1/submit" }, report);
      expect(result.ok).toBe(false);
      expect(!result.ok && result.error).toMatch(/^Could not reach the form: .*VPN/);
    });

    it("goes through the plugin's own send handler, with the app context in the template", async () => {
      const { url, seen } = await serve(() => ({ status: 200, text: '{"key":"BUGS-9"}' }));
      const { handlers } = loadServer({ submitUrl: url, submitFields: '{"t":"{subject}","d":"{description}\\n{context}"}', fileField: "f", fileMode: "combine" });
      expect(await handlers.config!(null)).toEqual({ label: DEFAULT_LABEL, formUrl: "", canSend: true, canAttach: true, combine: true, problem: null, mode: "form", key: null, keyHelp: "", keyProblem: null });
      const result = await handlers.send!({ subject: " Bug ", description: "Steps", client: "Chrome 140", images: [{ name: "a.png", type: "image/png", base64: "AQID" }] });
      expect(result).toEqual({ ok: true, key: "BUGS-9", url: null, warning: null });
      const parsed = await new Request(url, { method: "POST", headers: { "content-type": seen[0]!.type }, body: new Uint8Array(seen[0]!.body) }).formData();
      expect(parsed.get("t")).toBe("Bug");
      expect(parsed.get("d")).toMatch(/^Steps\r?\nBug Report Button \d+\.\d+\.\d+\r?\n.+\r?\nChrome 140$/);
      expect([...new Uint8Array(await (parsed.get("f") as File).arrayBuffer())]).toEqual([1, 2, 3]);
    });
  });

  it("without a submit address the page links to the form instead", async () => {
    const { handlers } = loadServer({ formUrl: FORM });
    expect(await handlers.config!(null)).toEqual({ label: DEFAULT_LABEL, formUrl: FORM, canSend: false, canAttach: false, combine: false, problem: null, mode: "form", key: null, keyHelp: "", keyProblem: null });
    expect(await handlers.send!({ subject: "x", description: "", client: "", images: [] })).toEqual({ ok: false, error: "Sending is not set up: there is no submit address." });
  });
});

describe("REST mode through the server", () => {
  const REST = {
    sendMode: "rest",
    apiBaseUrl: "https://tracker.example.test/api/v1",
    submitPath: "/forms/abc/submit",
    submitFields: '{"title":"{subject}"}',
    attachPath: "/issues/{key}/attachments",
    shareKeyWith: "tracker-board",
    keyHelp: "Profile → API keys.",
  };
  afterEach(() => {
    hostAnswer = () => {
      throw new Error("no host in this test");
    };
  });

  it("asks the person's machine about the key, and saves and forgets it there", async () => {
    hostAnswer = (method) => ({ hasKey: method !== "forget", source: method === "forget" ? null : "own", keyStore: method === "forget" ? null : "keychain" });
    const { handlers, hostCalls } = loadServer(REST);
    expect(await handlers.config!(null)).toEqual({
      label: DEFAULT_LABEL, formUrl: "", canSend: true, canAttach: true, combine: false, problem: null, mode: "rest",
      key: { hasKey: true, source: "own", keyStore: "keychain" }, keyHelp: "Profile → API keys.", keyProblem: null,
    });
    await handlers.key_save!({ key: "xk_1" });
    await handlers.key_forget!(null);
    expect(hostCalls.map((c) => [c.method, c.input, (c.options as { hostId: string }).hostId])).toEqual([
      ["status", { baseUrl: "https://tracker.example.test/api/v1", shareWith: "tracker-board" }, "host-1"],
      ["saveKey", { baseUrl: "https://tracker.example.test/api/v1", shareWith: "tracker-board", key: "xk_1" }, "host-1"],
      ["forget", { baseUrl: "https://tracker.example.test/api/v1", shareWith: "tracker-board" }, "host-1"],
    ]);
  });

  it("says when the machine cannot be asked, and is off until set up", async () => {
    hostAnswer = () => {
      throw new Error("host offline");
    };
    const { handlers } = loadServer(REST);
    expect(await handlers.config!(null)).toMatchObject({ canSend: true, key: null, keyProblem: "Could not check the API key on this computer: host offline" });
    const off = loadServer({ sendMode: "rest", formUrl: FORM });
    expect(await off.handlers.config!(null)).toMatchObject({ mode: "rest", canSend: false, formUrl: FORM, problem: null });
    expect(await off.handlers.send!({ subject: "x", description: "", client: "", images: [] })).toEqual({ ok: false, error: "Sending through the API is not set up." });
  });

  it("form files: the page joins pictures, and the machine gets one form request", async () => {
    hostAnswer = () => ({ ok: true, status: 201, text: '{"key":"BUGS-4"}' });
    const { handlers, hostCalls } = loadServer({ ...REST, restFiles: "form", fileField: "attachment" });
    hostAnswer = (method) => (method === "status" ? { hasKey: true, source: "shared", keyStore: "keychain" } : { ok: true, status: 201, text: '{"key":"BUGS-4"}' });
    expect(await handlers.config!(null)).toMatchObject({ mode: "rest", canAttach: true, combine: true });
    const result = await handlers.send!({ subject: "Bug", description: "Steps", client: "", images: [{ name: "screenshots.png", type: "image/png", base64: "AQID" }] });
    expect(result).toEqual({ ok: true, key: "BUGS-4", url: null, warning: null });
    expect(hostCalls.map((c) => c.method)).toEqual(["status", "postForm"]);
    expect(hostCalls[1]!.input).toMatchObject({ path: "/forms/abc/submit", fields: { title: "Bug" }, field: "attachment", files: [{ name: "screenshots.png" }] });
  });

  it("sends JSON and then each picture through the machine", async () => {
    hostAnswer = (method) => (method === "postJson" ? { ok: true, status: 201, text: '{"key":"BUGS-3"}' } : { ok: true, status: 201, text: "" });
    const { handlers, hostCalls } = loadServer(REST);
    const result = await handlers.send!({ subject: " Bug ", description: "Steps", client: "Chrome", images: [{ name: "a.png", type: "image/png", base64: "AQID" }] });
    expect(result).toEqual({ ok: true, key: "BUGS-3", url: null, warning: null });
    expect(hostCalls.map((c) => c.method)).toEqual(["postJson", "postFile"]);
    expect(JSON.parse((hostCalls[0]!.input as { body: string }).body)).toEqual({ title: "Bug" });
    expect(hostCalls[1]!.input).toMatchObject({ path: "/issues/BUGS-3/attachments", field: "file", file: { name: "a.png" } });
  });
});
