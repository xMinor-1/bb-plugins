import { mkdir, mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { parse } from "jsonc-parser";
import { afterEach, describe, expect, it } from "vitest";
import { openCodeMajor, patchOpenCodeConfig, planOpenCode, writeOpenCodeConfig } from "../src/host/opencode-config.js";
import { RESOLVER_FILE, syncResolverPlugin } from "../src/host/opencode-resolver.js";
import { normalizeVersion } from "../src/host/find-opencode.js";
import { checkSecretValue, openFileSecretStore } from "../src/secret-store.js";
import { sampleManifest } from "./fixtures.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});
async function tempDir(prefix = "fleet-kit-test-") {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  dirs.push(dir);
  return dir;
}

const block = () => (sampleManifest().opencode as Record<string, unknown>);

describe("OpenCode version", () => {
  it.each([["opencode v2.2.5", "2.2.5"], ["2.10.0-beta.1", "2.10.0-beta.1"], ["v1.19.5", "1.19.5"], ["no version", "no version"]])("normalizes %s", (reported, expected) => {
    expect(normalizeVersion(reported)).toBe(expected);
  });

  it("keeps the normalized form readable by the major check", () => {
    expect(openCodeMajor(normalizeVersion("opencode v2.2.5"))).toBe(2);
    expect(openCodeMajor(normalizeVersion("1.19.5"))).toBe(1);
  });
});

describe("OpenCode plan", () => {
  it("keeps the key out of the file and hands it to the resolver", () => {
    const plan = planOpenCode(block(), ["corp"]);
    const provider = plan.entries.find((entry) => entry.path.join(".") === "providers.corp")!.value as Record<string, any>;
    expect(provider.settings).toEqual({ baseURL: "https://llm.example.test/v1" });
    expect(JSON.stringify(plan.entries)).not.toContain("secret:");
    expect(plan.resolver).toEqual({ corp: [{ header: "Authorization", template: "Bearer {secret:gateway-key}" }] });
    expect(plan.secrets).toEqual(["gateway-key"]);
    expect(plan.entries.map((entry) => entry.path.join("."))).toEqual(["providers.corp", "model", "update", "enabled_providers"]);
    expect(plan.entries.at(-1)!.value).toEqual(["corp"]);
  });

  it("moves secret headers to the resolver and refuses secrets elsewhere", () => {
    const withHeader = block();
    (withHeader.providers as any).corp.settings.headers = { "X-Team": "ops", "X-Token": "Token {secret:gateway-key}" };
    const plan = planOpenCode(withHeader, ["corp"]);
    expect((plan.entries[0]!.value as any).settings.headers).toEqual({ "X-Team": "ops" });
    expect(plan.resolver.corp).toContainEqual({ header: "X-Token", template: "Token {secret:gateway-key}" });

    const misplaced = block();
    (misplaced.providers as any).corp.settings.baseURL = "https://{secret:gateway-key}.example.test";
    expect(() => planOpenCode(misplaced, ["corp"])).toThrow("only in settings.apiKey and settings.headers");
    const topLevel = { ...block(), share: "{secret:gateway-key}" };
    expect(() => planOpenCode(topLevel, ["corp"])).toThrow("only in provider settings");
    expect(() => planOpenCode({ ...block(), enabled_providers: ["x"] }, ["corp"])).toThrow("allowedProviders");
  });
});

describe("opencode.json patch", () => {
  const plan = () => planOpenCode(block(), ["corp"]);

  it("preserves the user's settings, other plugins' MCP servers and comments", () => {
    const source = [
      "{",
      "  // my own settings",
      '  "theme": "dark",',
      '  "providers": { "personal": { "name": "Mine", "models": { "m": {} } } },',
      '  "mcp": { "servers": { "qlik-sense": { "type": "local", "command": ["node", "q.mjs"], "enabled": true } } },',
      '  "model": "personal/m",',
      "}",
      "",
    ].join("\n");
    const text = patchOpenCodeConfig(source, plan(), []);
    expect(text).toContain("// my own settings");
    const config = parse(text);
    expect(config.theme).toBe("dark");
    expect(config.providers.personal).toEqual({ name: "Mine", models: { m: {} } });
    expect(config.mcp.servers["qlik-sense"].enabled).toBe(true);
    expect(config.providers.corp.settings.baseURL).toBe("https://llm.example.test/v1");
    expect(config.model).toBe("corp/big-model");
    expect(config.enabled_providers).toEqual(["corp"]);
    expect(config.update).toBe("disable");
  });

  it("removes what it owned before and the manifest dropped", () => {
    const first = patchOpenCodeConfig("{}", plan(), []);
    const owned = plan().entries.map((entry) => entry.path);
    const { update: _dropped, ...rest } = block();
    const smaller = planOpenCode(rest, ["corp"]);
    const second = parse(patchOpenCodeConfig(first, smaller, owned));
    expect(second.update).toBeUndefined();
    expect(second.model).toBe("corp/big-model");
  });

  it.each(['{"providers":[]}', '{"a":1,"a":2}', "[]", "{broken"])("refuses ambiguous input %s", (source) => {
    expect(() => patchOpenCodeConfig(source, plan(), [])).toThrow();
  });

  it("writes atomically, backs up the original once, and is idempotent", async () => {
    const dir = await tempDir();
    const path = join(dir, "opencode.json");
    const original = '{ "theme": "dark" }\n';
    await writeFile(path, original, { mode: 0o640 });
    const first = await writeOpenCodeConfig(path, plan(), []);
    expect(first.changed).toBe(true);
    expect(await readFile(`${path}.before-fleet-kit.bak`, "utf8")).toBe(original);
    expect((await stat(path)).mode & 0o777).toBe(0o640);
    const again = await writeOpenCodeConfig(path, plan(), plan().entries.map((entry) => entry.path));
    expect(again).toEqual({ changed: false, backup: null });
    await writeFile(path, '{ "theme": "light" }\n');
    await writeOpenCodeConfig(path, plan(), []);
    expect(await readFile(`${path}.before-fleet-kit.bak`, "utf8")).toBe(original);
    expect(await stat(`${path}.bb-config-lock`).catch(() => null)).toBeNull();
  });

  it("creates a missing file without a backup", async () => {
    const dir = await tempDir();
    const path = join(dir, "nested", "opencode.json");
    const result = await writeOpenCodeConfig(path, plan(), []);
    expect(result).toEqual({ changed: true, backup: null });
    expect(parse(await readFile(path, "utf8")).$schema).toBe("https://opencode.ai/config.json");
  });

  it("waits for another writer's lock and reports who holds it", async () => {
    const dir = await tempDir();
    const path = join(dir, "opencode.json");
    await writeFile(path, "{}");
    await mkdir(`${path}.bb-config-lock`);
    await writeFile(`${path}.bb-config-lock/owner.json`, JSON.stringify({ plugin: "qlik-sense", pid: process.pid, host: "elsewhere.example", createdAt: new Date().toISOString() }));
    await expect(writeOpenCodeConfig(path, plan(), [], { timeoutMs: 1 })).rejects.toThrow("qlik-sense since");
    expect(await readFile(path, "utf8")).toBe("{}");
  });
});

describe("secret store (file)", () => {
  it("stores one 0600 file per secret in a 0700 directory", async () => {
    const dir = join(await tempDir(), "secrets");
    const store = openFileSecretStore(dir);
    expect(await store.has("gateway-key")).toBe(false);
    await store.set("gateway-key", "  abc-123  ");
    expect(await store.get("gateway-key")).toBe("abc-123");
    expect((await stat(join(dir, "gateway-key"))).mode & 0o777).toBe(0o600);
    expect((await stat(dir)).mode & 0o777).toBe(0o700);
    expect(await store.delete("gateway-key")).toBe(true);
    expect(await store.get("gateway-key")).toBeNull();
    await expect(store.set("../escape", "x")).rejects.toThrow("invalid secret name");
  });

  it("rejects empty and multi-line values", () => {
    expect(() => checkSecretValue("   ")).toThrow("empty");
    expect(() => checkSecretValue("a\nb")).toThrow("line breaks");
  });
});

describe("resolver plugin", () => {
  it("adds headers from the store per provider and leaves them out when the secret is missing", async () => {
    const root = await tempDir();
    const store = openFileSecretStore(join(root, "secrets"));
    const configDir = join(root, "opencode");
    const providers = { corp: [{ header: "Authorization", template: "Bearer {secret:gateway-key}" }] };
    expect(await syncResolverPlugin(configDir, { providers, store })).toBe(true);
    expect(await syncResolverPlugin(configDir, { providers, store })).toBe(false);

    const file = join(configDir, "plugins", RESOLVER_FILE);
    const module = (await import(`${pathToFileURL(file).href}?v=${Date.now()}`)) as { default: { id: string; setup: (ctx: unknown) => Promise<void> } };
    const hooks: { name: string; options: { providerID: string }; callback: (request: { headers: Record<string, string> }) => Promise<void> }[] = [];
    await module.default.setup({
      session: { hook: async (name: string, callback: any, options: any) => { hooks.push({ name, callback, options }); return { dispose: async () => {} }; } },
    });
    expect(hooks.map((hook) => [hook.name, hook.options.providerID])).toEqual([["model.request", "corp"]]);

    const missing = { headers: {} as Record<string, string> };
    await hooks[0]!.callback(missing);
    expect(missing.headers).toEqual({});

    await store.set("gateway-key", "k-123");
    // A miss is cached for five seconds; load a fresh module copy instead of waiting.
    const fresh = (await import(`${pathToFileURL(file).href}?v=${Date.now() + 1}`)) as typeof module;
    const freshHooks: typeof hooks = [];
    await fresh.default.setup({ session: { hook: async (name: string, callback: any, options: any) => { freshHooks.push({ name, callback, options }); return { dispose: async () => {} }; } } });
    const request = { headers: { "User-Agent": "test" } as Record<string, string> };
    await freshHooks[0]!.callback(request);
    expect(request.headers).toEqual({ "User-Agent": "test", Authorization: "Bearer k-123" });

    expect(await syncResolverPlugin(configDir, null)).toBe(true);
    expect(await stat(file).catch(() => null)).toBeNull();
  });

  it("does not overwrite a file it did not write", async () => {
    const root = await tempDir();
    const configDir = join(root, "opencode");
    await mkdir(join(configDir, "plugins"), { recursive: true });
    await writeFile(join(configDir, "plugins", RESOLVER_FILE), "export default {};\n");
    const store = openFileSecretStore(join(root, "secrets"));
    await expect(syncResolverPlugin(configDir, { providers: { corp: [] }, store })).rejects.toThrow("not written by Fleet Kit");
  });
});
