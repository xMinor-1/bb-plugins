// Pasted client settings → remote servers, in every shape the plugin accepts.
import { describe, expect, it } from "vitest";
import { ConfigTextError, isCredential, maskAddress, parseClientConfig, splitScheme } from "../src/shared/parse-config";

const TOKEN = "tok-synthetic-0123456789";
const remote = (url = "https://mcp.example.com/u/1/srv/mcp") => ({ type: "remote", url, headers: { Authorization: `Bearer ${TOKEN}` } });

describe("parseClientConfig", () => {
  it("reads OpenCode 1 settings, the shape a platform hands out", () => {
    const text = JSON.stringify({ $schema: "https://opencode.ai/config.json", mcp: { wiki_ab12: remote(), tracker_cd34: remote("https://mcp.example.com/u/1/t/mcp") } });
    const { servers, skipped } = parseClientConfig(text);
    expect(skipped).toEqual([]);
    expect(servers.map((server) => server.name)).toEqual(["wiki_ab12", "tracker_cd34"]);
    expect(servers[0]).toEqual({ name: "wiki_ab12", url: "https://mcp.example.com/u/1/srv/mcp", headers: [{ name: "Authorization", value: `Bearer ${TOKEN}` }] });
  });

  it("reads OpenCode 2, mcpServers and VS Code shapes", () => {
    expect(parseClientConfig(JSON.stringify({ mcp: { servers: { a: remote() }, timeout: { execution: 1 } } })).servers.map((s) => s.name)).toEqual(["a"]);
    expect(parseClientConfig(JSON.stringify({ mcpServers: { b: { url: "https://x.example.com/mcp", headers: { "X-Api-Key": TOKEN } } } })).servers[0]!.name).toBe("b");
    expect(parseClientConfig(JSON.stringify({ mcpServers: { c: { type: "streamable-http", serverUrl: "https://x.example.com/mcp" } } })).servers[0]!.url).toBe("https://x.example.com/mcp");
    expect(parseClientConfig(JSON.stringify({ servers: { d: { type: "http", url: "https://x.example.com/mcp" } } })).servers[0]!.name).toBe("d");
  });

  it("reads fragments: a key without braces, the inner map alone, JSONC", () => {
    const fragment = `"mcp": { "wiki": ${JSON.stringify(remote())} },`;
    expect(parseClientConfig(fragment).servers.map((s) => s.name)).toEqual(["wiki"]);
    expect(parseClientConfig(JSON.stringify({ solo: remote() })).servers.map((s) => s.name)).toEqual(["solo"]);
    const jsonc = `{\n  // copied from the platform\n  "mcp": { "w": { "type": "remote", "url": "https://x.example.com/mcp", }, },\n}`;
    expect(parseClientConfig(jsonc).servers.map((s) => s.name)).toEqual(["w"]);
  });

  it("skips what it cannot carry, with a reason", () => {
    const text = JSON.stringify({
      mcp: {
        local: { type: "local", command: ["npx", "server"] },
        plain: { type: "remote", url: "http://mcp.example.com/mcp" },
        query: { type: "remote", url: "https://mcp.example.com/mcp?token=abc" },
        userinfo: { type: "remote", url: "https://user:pw@mcp.example.com/mcp" },
        env: { type: "remote", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer {env:TOKEN}" } },
        "bad name": remote(),
        nourl: { type: "remote" },
        ok: remote(),
      },
    });
    const { servers, skipped } = parseClientConfig(text);
    expect(servers.map((s) => s.name)).toEqual(["ok"]);
    expect(Object.fromEntries(skipped.map((s) => [s.name, s.reason]))).toEqual({
      local: "local",
      plain: "insecure-url",
      query: "url-secret",
      userinfo: "url-secret",
      env: "reference",
      "bad name": "bad-name",
      nourl: "no-url",
    });
  });

  it("allows plain http only when asked (a developer's stub)", () => {
    const text = JSON.stringify({ mcp: { stub: { type: "remote", url: "http://127.0.0.1:7801/mcp" } } });
    expect(parseClientConfig(text).skipped[0]?.reason).toBe("insecure-url");
    expect(parseClientConfig(text, { allowHttp: true }).servers[0]?.name).toBe("stub");
  });

  it("refuses text that is not settings", () => {
    expect(() => parseClientConfig("hello")).toThrow(ConfigTextError);
    expect(() => parseClientConfig(JSON.stringify({ model: "x/y" }))).toThrow(/no remote MCP servers/);
  });

  it("never puts a token into a skip record", () => {
    const text = JSON.stringify({ mcp: { env: { type: "remote", url: `https://mcp.example.com/mcp?api_key=${TOKEN}` } } });
    expect(JSON.stringify(parseClientConfig(text).skipped)).not.toContain(TOKEN);
  });

  it("refuses an address with a token in its path, and leaves instance ids alone", () => {
    const at = (url: string) => parseClientConfig(JSON.stringify({ mcp: { s: { type: "remote", url } } }));
    for (const url of [
      "https://mcp.example.com/mcp/glpat-0123456789abcdefXYZ",
      "https://mcp.example.com/sse/eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.c2ln",
      "https://mcp.example.com/k/9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08/mcp",
      "https://mcp.example.com/k/tok%2Dsynthetic%2D0123456789abcdefghijklmnopqrstuvwxyz/mcp",
    ]) expect(at(url).skipped[0]?.reason, url).toBe("url-secret");
    for (const url of [
      "https://mcp.example.com/u/1/corp_wiki_ab12cd34/mcp",
      "https://mcp.example.com/servers/3f2a8c1e-9b7d-4e21-a5c3-0d6f4b8e2a17/mcp",
      "https://mcp.example.com/streamable-http/mcp",
    ]) expect(at(url).servers[0]?.url, url).toBe(url);
  });

  it("skips a substitution even when it is not closed", () => {
    const text = JSON.stringify({
      mcp: {
        a: { type: "remote", url: "https://mcp.example.com/mcp", headers: { Authorization: "Bearer {env:TOKEN" } },
        b: { type: "remote", url: "https://mcp.example.com/mcp", headers: { "X-Key": "${TOKEN" } },
        c: { type: "remote", url: "https://mcp.example.com/{file:x/mcp" },
      },
    });
    expect(parseClientConfig(text).skipped.map((skip) => skip.reason)).toEqual(["reference", "reference", "reference"]);
  });
});

describe("credentials", () => {
  it("stores every header except the known harmless ones, short values included", () => {
    for (const name of ["Authorization", "X-Api-Key", "Cookie", "X-Pat", "X-Tenant", "X-Custom", "Private-Token"]) expect(isCredential(name, "s3"), name).toBe(true);
    for (const name of ["Accept", "accept-language", "Content-Type", "User-Agent", "MCP-Protocol-Version"]) expect(isCredential(name, "application/json"), name).toBe(false);
    expect(isCredential("X-Custom", "  ")).toBe(false);
  });

  it("shows an address without the parts that identify the instance", () => {
    expect(maskAddress("https://mcp.example.com/u/1/corp_wiki_ab12cd34/mcp")).toBe("mcp.example.com/u/1/cor…/mcp");
    expect(maskAddress("https://mcp.example.com/servers/3f2a8c1e-9b7d-4e21-a5c3-0d6f4b8e2a17/mcp?tenant=7")).toBe("mcp.example.com/servers/3f2…/mcp?…");
    expect(maskAddress("https://mcp.example.com/")).toBe("mcp.example.com");
    expect(maskAddress("not an address")).toBe("…");
  });

  it("keeps only the token part of a scheme", () => {
    expect(splitScheme(`Bearer ${TOKEN}`)).toEqual({ prefix: "Bearer ", secret: TOKEN });
    expect(splitScheme(TOKEN)).toEqual({ prefix: "", secret: TOKEN });
  });
});
