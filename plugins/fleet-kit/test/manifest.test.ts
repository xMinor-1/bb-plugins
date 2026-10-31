import { afterEach, describe, expect, it, vi } from "vitest";
import { checkManifest, readSelfEntry } from "../src/manifest.js";
import { fetchManifestText, maskManifestUrl, parseManifestLocation, parseManifestJson } from "../src/fetch-manifest.js";
import { clone, sampleManifest } from "./fixtures.js";

describe("manifest check", () => {
  it("accepts the sample with its warnings", () => {
    const result = checkManifest(sampleManifest());
    expect(result.errors).toEqual([]);
    expect(result.manifest?.name).toBe("Example build");
    expect(result.warnings).toEqual(["mcp.wiki: no address yet"]);
  });

  it("refuses a newer format with an update hint, but still finds Fleet Kit's entry", () => {
    const manifest = { ...sampleManifest(), schema: 2, somethingNew: { a: 1 } };
    const result = checkManifest(manifest);
    expect(result.manifest).toBeNull();
    expect(result.newerFormat).toBe(true);
    expect(result.errors[0]).toContain("Update Fleet Kit");
    expect(readSelfEntry(manifest)).toEqual({ source: "git:https://git.example.test/plugins.git@semver:fleet-kit/:^0.1.0" });
  });

  it("warns about unknown fields at the root and in plugins instead of failing", () => {
    const manifest = clone(sampleManifest()) as Record<string, any>;
    manifest.surprise = true;
    manifest.plugins[1].colour = "blue";
    const result = checkManifest(manifest);
    expect(result.errors).toEqual([]);
    expect(result.warnings).toContain("surprise: not known to this Fleet Kit; ignored");
    expect(result.warnings).toContain("plugins.1.colour: not known to this Fleet Kit; ignored");
    expect((result.manifest!.plugins[1] as Record<string, unknown>).colour).toBeUndefined();
  });

  it("warns when Fleet Kit's own source is not pinned", () => {
    const manifest = clone(sampleManifest()) as Record<string, any>;
    manifest.plugins[0].source = "git:https://git.example.test/plugins.git";
    expect(checkManifest(manifest).warnings.join("\n")).toContain("pinned with @semver");
  });

  it.each([
    ["fleet-kit missing", (m: Record<string, any>) => { m.plugins = m.plugins.filter((p: any) => p.id !== "fleet-kit"); }, "fleet-kit"],
    ["undeclared secret", (m: Record<string, any>) => { m.secrets = []; }, "{secret:gateway-key} is not declared"],
    ["provider outside the allowed list", (m: Record<string, any>) => { m.allowedProviders = ["other"]; }, "not in allowedProviders"],
    ["required without source", (m: Record<string, any>) => { m.plugins[1].source = null; }, "needs a source"],
    ["install older than minVersion", (m: Record<string, any>) => { m.install.bb = "0.47.0"; }, "install.bb"],
    ["removal of a listed plugin", (m: Record<string, any>) => { m.removePlugins = ["notes"]; }, "also listed"],
    ["removal of Fleet Kit", (m: Record<string, any>) => { m.plugins[0].status = "required"; m.removePlugins = ["fleet-kit"]; }, "cannot remove itself"],
    ["duplicate plugin", (m: Record<string, any>) => { m.plugins.push(clone(m.plugins[1])); }, "listed twice"],
    ["plugin MCP without plugin", (m: Record<string, any>) => { m.mcp.push({ id: "q", title: "Q", type: "plugin", plugin: "nope", default: false }); }, "refers to a plugin"],
    ["a secret in plugin config", (m: Record<string, any>) => { m.plugins[1].config.token = "{secret:gateway-key}"; }, "plugins.1.config.token: {secret:...} is allowed only"],
    ["a secret inside the key", (m: Record<string, any>) => { m.opencode.providers.corp.settings.apiKey = "Key {secret:gateway-key}"; }, "settings.apiKey: {secret:...} is allowed only"],
    ["an {env:} substitution", (m: Record<string, any>) => { m.opencode.providers.corp.settings.headers = { "X-User": "{env:USER}" }; }, "{env:...} and {file:...} are not allowed"],
    ["a {file:} substitution", (m: Record<string, any>) => { m.plugins[1].config.greeting = "{file:~/.ssh/id_rsa}"; }, "{env:...} and {file:...} are not allowed"],
    ["an {env:} substitution in a header name", (m: Record<string, any>) => { m.opencode.providers.corp.settings.headers = { "x-{env:GITHUB_TOKEN}": "1" }; }, "settings.headers.x-{env:GITHUB_TOKEN}: substitutions such as {env:...}"],
    ["a {file:} substitution in a model name", (m: Record<string, any>) => { m.opencode.providers.corp.models["{file:~/.ssh/id_rsa}"] = { name: "x" }; }, "models.{file:~/.ssh/id_rsa}: substitutions such as"],
    ["a {file:} substitution in a plugin setting name", (m: Record<string, any>) => { m.plugins[1].config["{file:~/.ssh/id_rsa}"] = "x"; }, "plugins.1.config.{file:~/.ssh/id_rsa}"],
    ["a provider package from npm", (m: Record<string, any>) => { m.opencode.providers.corp.package = "opencode-evil-provider"; }, "is not an OpenCode provider"],
    ["a provider package under a look-alike scope", (m: Record<string, any>) => { m.opencode.providers.corp.package = "@opencode/ai/providers/../../evil"; }, "is not an OpenCode provider"],
    ["an npm source", (m: Record<string, any>) => { m.plugins[1].source = "npm:notes"; }, "use a git:https:// source"],
    ["a path source", (m: Record<string, any>) => { m.plugins[1].source = "path:/tmp/notes"; }, "use a git:https:// source"],
    ["a local git source", (m: Record<string, any>) => { m.plugins[1].source = "git:/srv/plugins.git"; }, "use a git:https:// source"],
    ["a builtin source", (m: Record<string, any>) => { m.plugins[1].source = "builtin:notes"; }, "bundled with bb"],
    ["a plugin alias", (m: Record<string, any>) => { m.plugins[1].plugin = "other"; }, 'must equal the id "notes"'],
    ["an OpenCode key outside the allowlist", (m: Record<string, any>) => { m.opencode.share = "auto"; }, "share"],
    ["a plain http gateway", (m: Record<string, any>) => { m.opencode.providers.corp.settings.baseURL = "http://llm.example.test/v1"; }, "must be an https:// address"],
    ["a loopback gateway without allowDevSources", (m: Record<string, any>) => { m.opencode.providers.corp.settings.baseURL = "http://127.0.0.1:4010/v1"; }, "only with allowDevSources"],
    ["a keyed provider without baseURL", (m: Record<string, any>) => { delete m.opencode.providers.corp.settings.baseURL; }, "settings.baseURL is required"],
    ["a small model from another provider", (m: Record<string, any>) => { m.opencode.small_model = "other/m"; }, "opencode.small_model"],
  ])("rejects %s", (_, edit, message) => {
    const manifest = clone(sampleManifest()) as Record<string, any>;
    edit(manifest);
    const result = checkManifest(manifest);
    expect(result.manifest).toBeNull();
    expect(result.errors.join("\n")).toContain(message);
  });

  it("accepts local sources and a loopback gateway with allowDevSources", () => {
    const manifest = clone(sampleManifest()) as Record<string, any>;
    manifest.plugins[1].source = "git:/srv/plugins.git@semver:notes/:^1.0.0";
    manifest.plugins.push({ id: "local", source: "path:/srv/local", status: "required" });
    manifest.opencode.providers.corp.settings.baseURL = "http://127.0.0.1:4010/v1";
    expect(checkManifest(manifest, { allowDevSources: true }).errors).toEqual([]);
    expect(checkManifest(manifest).manifest).toBeNull();
  });

  it("accepts another provider package only with allowDevSources", () => {
    const manifest = clone(sampleManifest()) as Record<string, any>;
    manifest.opencode.providers.corp.package = "file:/srv/provider";
    expect(checkManifest(manifest, { allowDevSources: true }).errors).toEqual([]);
    expect(checkManifest(manifest).errors.join("\n")).toContain("need allowDevSources");
  });

  it("accepts plugin sources with spaces in a semver range", () => {
    const manifest = clone(sampleManifest()) as Record<string, any>;
    manifest.plugins[1].source = "git:https://git.example.test/plugins.git@semver:notes/:>=1.0.0 <3.0.0";
    expect(checkManifest(manifest).errors).toEqual([]);
  });
});

describe("manifest location", () => {
  it("understands paths, file URLs and https", () => {
    expect(parseManifestLocation("/srv/build/manifest.json")).toMatchObject({ kind: "file", path: "/srv/build/manifest.json" });
    expect(parseManifestLocation("file:///srv/build/manifest.json")).toMatchObject({ kind: "file", path: "/srv/build/manifest.json" });
    expect(parseManifestLocation("~/build/manifest.json").kind).toBe("file");
    const https = parseManifestLocation("https://git.example.test/raw/manifest.json?ref=main");
    expect(https).toMatchObject({ kind: "https", display: "https://git.example.test/raw/manifest.json" });
  });

  it.each(["http://git.example.test/m.json", "https://user:pw@git.example.test/m.json", "relative/m.json", ""])("refuses %s", (value) => {
    expect(() => parseManifestLocation(value)).toThrow();
  });

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it("refuses a redirect away from https", async () => {
    vi.stubGlobal("fetch", async () => ({ url: "http://git.example.test/m.json", ok: true, status: 200, statusText: "OK", body: null }));
    await expect(fetchManifestText(parseManifestLocation("https://git.example.test/m.json"))).rejects.toThrow("non-https");
  });

  it("hides credentials when showing an address", () => {
    expect(maskManifestUrl("https://user:pw@git.example.test/m.json")).toBe("https://***@git.example.test/m.json");
    expect(maskManifestUrl("/srv/build/manifest.json")).toBe("/srv/build/manifest.json");
  });

  it("strips a byte order mark and reports bad JSON", () => {
    expect(parseManifestJson("﻿{\"a\":1}")).toEqual({ a: 1 });
    expect(() => parseManifestJson("{")).toThrow("not valid JSON");
  });
});
