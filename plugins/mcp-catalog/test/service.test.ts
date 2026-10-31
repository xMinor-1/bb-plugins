// The machine's side end to end, on a file credential store, a temporary
// OpenCode directory and stub MCP servers.
import { mkdtemp, readdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import type { WriteConfig } from "../contract";
import { openFileSecretStore } from "../src/host/secret-store";
import { fileReference, McpService, secretName } from "../src/host/service";
import { startStubMcp, type Stub } from "./stub-mcp";

const TOKEN_A = "tok-synthetic-aaaaaaaaaaaa";
const TOKEN_B = "tok-synthetic-bbbbbbbbbbbb";
const TOKEN_NEW = "tok-synthetic-rotated-cccc";

let root: string;
let stubA: Stub;
let stubB: Stub;
let config: WriteConfig;
let major: number | null;

const make = () =>
  new McpService({
    dataDir: join(root, "data"),
    store: openFileSecretStore(join(root, "store")),
    // A host worker's trimmed environment: the OpenCode directory comes from the server.
    env: { HOME: join(root, "home"), PATH: "" },
    userHome: join(root, "home"),
    openCodeMajor: async () => major,
  });

const pasted = (tokenA = TOKEN_A) =>
  JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    mcp: {
      wiki_ab12: { type: "remote", url: stubA.url, headers: { Authorization: `Bearer ${tokenA}` } },
      tracker_cd34: { type: "remote", url: stubB.url, headers: { "X-Api-Key": TOKEN_B, "X-Tenant": "team-1" } },
    },
  });

const opencodeFile = () => join(root, "opencode", "opencode.json");
const readOpencode = async () => JSON.parse(await readFile(opencodeFile(), "utf8"));
const everything = async () => {
  const files = [opencodeFile(), join(root, "data", "state.json")];
  return (await Promise.all(files.map((file) => readFile(file, "utf8").catch(() => "")))).join("\n");
};

beforeEach(async () => {
  root = await mkdtemp(join(tmpdir(), "mcp-catalog-service-"));
  stubA = await startStubMcp({ token: TOKEN_A, tools: 4 });
  stubB = await startStubMcp({ token: null, tools: 1 });
  config = { opencodeConfigDir: "", timeoutSec: 30, serverEnvironment: { OPENCODE_CONFIG_DIR: join(root, "opencode") }, allowHttp: true };
  major = 2;
});
afterEach(async () => {
  await stubA.close();
  await stubB.close();
  await rm(root, { recursive: true, force: true });
});

describe("connecting servers", () => {
  it("keeps tokens out of state, opencode.json and answers, and points OpenCode at 0600 token files", async () => {
    const service = make();
    const result = await service.importConfig(pasted(), config);
    expect(result.added).toEqual(["wiki_ab12", "tracker_cd34"]);
    expect(result.skipped).toEqual([]);

    const text = await everything();
    expect(text).not.toContain(TOKEN_A);
    expect(text).not.toContain(TOKEN_B);
    expect(JSON.stringify(result)).not.toContain(TOKEN_A);

    const file = await readOpencode();
    const wiki = file.mcp.servers.wiki_ab12;
    expect(wiki).toMatchObject({ type: "remote", url: stubA.url, oauth: false, timeout: { execution: 30_000 } });
    const reference = /^Bearer \{file:(.+)\}$/.exec(wiki.headers.Authorization);
    expect(reference).not.toBeNull();
    expect(await readFile(reference![1]!, "utf8")).toBe(TOKEN_A);
    expect((await stat(reference![1]!)).mode & 0o777).toBe(0o600);
    expect(file.mcp.servers.tracker_cd34.headers["X-Tenant"]).toBe("team-1");
    expect(file.mcp.servers.tracker_cd34.headers["X-Api-Key"]).toMatch(/^\{file:.+\}$/);

    const store = openFileSecretStore(join(root, "store"));
    expect(await store.get(secretName("wiki_ab12", "Authorization"))).toBe(TOKEN_A);
    expect(result.status.servers[0]?.secretHeaders).toEqual(["X-Api-Key"]);
  });

  it("checks servers with their tokens and remembers since when", async () => {
    const service = make();
    await service.importConfig(pasted(), config);
    const first = await service.check(undefined, 0, config);
    const wiki = first.servers.find((server) => server.name === "wiki_ab12")!;
    expect(wiki.health).toMatchObject({ status: "ok", tools: 4 });
    expect(stubA.requests.every((request) => request.authOk)).toBe(true);

    // Not due yet: nothing is asked again.
    const before = stubA.requests.length;
    await service.check(undefined, 60_000, config);
    expect(stubA.requests.length).toBe(before);

    await new Promise((resolve) => setTimeout(resolve, 5));
    const again = await service.check(["wiki_ab12"], 0, config);
    const still = again.servers.find((server) => server.name === "wiki_ab12")!;
    expect(still.health.since).toBe(wiki.health.since);
    expect(still.health.checkedAt).toBeGreaterThan(wiki.health.checkedAt!);
  });

  it("calls a refused token what it is, and a fresh paste fixes it in place", async () => {
    const service = make();
    await service.importConfig(pasted("tok-synthetic-wrong"), config);
    const refused = await service.check(["wiki_ab12"], 0, config);
    expect(refused.servers.find((server) => server.name === "wiki_ab12")!.health.status).toBe("unauthorized");

    const oldReference = /\{file:(.+)\}/.exec((await readOpencode()).mcp.servers.wiki_ab12.headers.Authorization)![1]!;
    stubA.options.token = TOKEN_NEW;
    const rotated = await service.importConfig(pasted(TOKEN_NEW), config);
    expect(rotated.updated).toEqual(["wiki_ab12", "tracker_cd34"]);
    const reference = /\{file:(.+)\}/.exec((await readOpencode()).mcp.servers.wiki_ab12.headers.Authorization)![1]!;
    // A new file name, so OpenCode sees opencode.json change and reloads; the old file is gone.
    expect(reference).not.toBe(oldReference);
    expect(await readFile(reference, "utf8")).toBe(TOKEN_NEW);
    await expect(stat(oldReference)).rejects.toThrow();
    const fixed = await service.check(["wiki_ab12"], 0, config);
    expect(fixed.servers.find((server) => server.name === "wiki_ab12")!.health.status).toBe("ok");
  });
});

describe("on, off, timeouts, removal", () => {
  it("switching off takes the entry and the token file away; the token stays in the store", async () => {
    const service = make();
    await service.importConfig(pasted(), config);
    await service.setEnabled("wiki_ab12", false, false, config);
    expect((await readOpencode()).mcp.servers.wiki_ab12).toBeUndefined();
    const files = await readdir(join(root, "data", "tokens"));
    expect(files.some((file) => file.startsWith(secretName("wiki_ab12", "Authorization")))).toBe(false);
    expect(files.length).toBe(1);
    expect(await openFileSecretStore(join(root, "store")).get(secretName("wiki_ab12", "Authorization"))).toBe(TOKEN_A);

    await service.setEnabled("wiki_ab12", true, false, config);
    expect((await readOpencode()).mcp.servers.wiki_ab12.url).toBe(stubA.url);
  });

  it("writes a server's own timeout, else the default, else none", async () => {
    const service = make();
    await service.importConfig(pasted(), { ...config, timeoutSec: 0 });
    expect((await readOpencode()).mcp.servers.wiki_ab12.timeout).toBeUndefined();
    await service.setTimeout("wiki_ab12", 45, config);
    const file = await readOpencode();
    expect(file.mcp.servers.wiki_ab12.timeout).toEqual({ execution: 45_000 });
    expect(file.mcp.servers.tracker_cd34.timeout).toEqual({ execution: 30_000 });
  });

  it("removal clears the entry, the files and the store", async () => {
    const service = make();
    await service.importConfig(pasted(), config);
    const status = await service.remove("wiki_ab12", config);
    expect(status.servers.map((server) => server.name)).toEqual(["tracker_cd34"]);
    expect((await readOpencode()).mcp.servers.wiki_ab12).toBeUndefined();
    expect(await openFileSecretStore(join(root, "store")).get(secretName("wiki_ab12", "Authorization"))).toBeNull();
  });
});

describe("opencode.json it did not write", () => {
  it("leaves a server of the same name alone until the person replaces it", async () => {
    await writeFile(join(await mkdtempDir(join(root, "opencode")), "opencode.json"), JSON.stringify({ mcp: { wiki_ab12: { type: "remote", url: "https://old.example.com/mcp", headers: { Authorization: "Bearer plain-text-old" } } } }, null, 2));
    const service = make();
    const result = await service.importConfig(pasted(), config);
    expect(result.status.servers.find((server) => server.name === "wiki_ab12")!.conflict).toBe(true);
    let file = await readOpencode();
    expect(file.mcp.wiki_ab12.url).toBe("https://old.example.com/mcp");
    expect(file.mcp.servers.wiki_ab12).toBeUndefined();
    expect(file.mcp.servers.tracker_cd34).toBeDefined();

    const replaced = await service.setEnabled("wiki_ab12", true, true, config);
    expect(replaced.servers.find((server) => server.name === "wiki_ab12")!.conflict).toBe(false);
    file = await readOpencode();
    expect(file.mcp.wiki_ab12).toBeUndefined();
    expect(JSON.stringify(file)).not.toContain("plain-text-old");
    expect(file.mcp.servers.wiki_ab12.url).toBe(stubA.url);
  });

  it("uses the directory setting first, else the server's OpenCode variables, else the home directory", async () => {
    const service = make();
    const fromSetting = await service.importConfig(pasted(), { ...config, opencodeConfigDir: join(root, "chosen") });
    expect(fromSetting.status.configFile).toBe(join(root, "chosen", "opencode.json"));
    const fromXdg = await service.sync({ ...config, serverEnvironment: { XDG_CONFIG_HOME: join(root, "xdg") } });
    expect(fromXdg.configFile).toBe(join(root, "xdg", "opencode", "opencode.json"));
    const fromHome = await service.sync({ ...config, serverEnvironment: {} });
    expect(fromHome.configFile).toBe(join(root, "home", ".config", "opencode", "opencode.json"));
  });

  it("refuses plain http unless the developer switch is on", async () => {
    const result = await make().importConfig(pasted(), { ...config, allowHttp: false });
    expect(result.added).toEqual([]);
    expect(result.skipped.map((skip) => skip.reason)).toEqual(["insecure-url", "insecure-url"]);
  });

  it("writes nothing for OpenCode 1 and says why", async () => {
    major = 1;
    const service = make();
    const result = await service.importConfig(pasted(), config);
    expect(result.status.configError).toMatch(/^\[mcp:opencode-1\]/);
    await expect(stat(opencodeFile())).rejects.toThrow();
  });

  it("does not touch an opencode.json that is not valid JSON", async () => {
    const dir = await mkdtempDir(join(root, "opencode"));
    await writeFile(join(dir, "opencode.json"), "{ broken");
    const service = make();
    const result = await service.importConfig(pasted(), config);
    expect(result.status.configError).toMatch(/^\[mcp:config-invalid\]/);
    expect(await readFile(join(dir, "opencode.json"), "utf8")).toBe("{ broken");
  });
});

async function mkdtempDir(path: string): Promise<string> {
  const { mkdir } = await import("node:fs/promises");
  await mkdir(path, { recursive: true });
  return path;
}

describe("fileReference", () => {
  it("carries Windows paths with forward slashes and refuses characters that would break it", () => {
    expect(fileReference("C:\\Users\\Ivan Petrov\\.bb\\plugins\\mcp-catalog\\tokens\\t-1.ab")).toBe("{file:C:/Users/Ivan Petrov/.bb/plugins/mcp-catalog/tokens/t-1.ab}");
    expect(fileReference("/home/u/.bb/tokens/t-1.ab")).toBe("{file:/home/u/.bb/tokens/t-1.ab}");
    expect(() => fileReference("/home/u/{x}/t")).toThrow(/cannot carry/);
    expect(() => fileReference('/home/u/"x/t')).toThrow(/cannot carry/);
  });
});
