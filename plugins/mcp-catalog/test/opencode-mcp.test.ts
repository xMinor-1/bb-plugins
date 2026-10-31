// Only `mcp.servers.<own names>` changes in opencode.json; everything else stays byte for byte.
import { mkdtemp, readFile, rm, stat, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ConfigFileError, patchMcpServers, writeMcpServers } from "../src/host/opencode-mcp";

const entry = (name: string, url = "https://mcp.example.com/mcp") => ({ name, value: { type: "remote", url, headers: { Authorization: "Bearer {file:/data/tokens/t-1}" }, oauth: false } });

const USER_FILE = `{
  // my settings
  "$schema": "https://opencode.ai/config.json",
  "providers": { "corp": { "settings": { "baseURL": "https://llm.example.com/v1" } } },
  "mcp": {
    "mine": { "type": "remote", "url": "https://other.example.com/mcp" }
  }
}
`;

describe("patchMcpServers", () => {
  it("adds entries under mcp.servers and keeps the rest of the file", () => {
    const { text, owned, conflicts } = patchMcpServers(USER_FILE, [entry("wiki")], []);
    expect(conflicts).toEqual([]);
    expect(owned).toEqual(["wiki"]);
    expect(text).toContain("// my settings");
    // Outside `mcp` the text is untouched; inside it the formatter may re-indent siblings.
    expect(text.slice(0, text.indexOf('"mcp"'))).toBe(USER_FILE.slice(0, USER_FILE.indexOf('"mcp"')));
    const parsed = JSON.parse(text.replace(/^\s*\/\/.*$/m, ""));
    expect(parsed.mcp.servers.wiki.url).toBe("https://mcp.example.com/mcp");
    expect(parsed.mcp.mine.url).toBe("https://other.example.com/mcp");
  });

  it("removes its own entries that are no longer wanted, and only those", () => {
    const first = patchMcpServers(USER_FILE, [entry("wiki"), entry("tracker")], []);
    const second = patchMcpServers(first.text, [entry("tracker")], first.owned);
    expect(second.owned).toEqual(["tracker"]);
    const parsed = JSON.parse(second.text.replace(/^\s*\/\/.*$/m, ""));
    expect(Object.keys(parsed.mcp.servers)).toEqual(["tracker"]);
    expect(parsed.mcp.mine).toBeDefined();
  });

  it("leaves a name it did not write alone, unless asked to replace it", () => {
    const blocked = patchMcpServers(USER_FILE, [entry("mine")], []);
    expect(blocked.conflicts).toEqual(["mine"]);
    expect(blocked.owned).toEqual([]);
    expect(blocked.text).toBe(USER_FILE);

    const replaced = patchMcpServers(USER_FILE, [entry("mine")], [], new Set(["mine"]));
    expect(replaced.conflicts).toEqual([]);
    const parsed = JSON.parse(replaced.text.replace(/^\s*\/\/.*$/m, ""));
    expect(parsed.mcp.mine).toBeUndefined();
    expect(parsed.mcp.servers.mine.url).toBe("https://mcp.example.com/mcp");
  });

  it("also treats an existing mcp.servers entry it did not write as taken", () => {
    const file = JSON.stringify({ mcp: { servers: { wiki: { type: "remote", url: "https://x.example.com" } } } });
    expect(patchMcpServers(file, [entry("wiki")], []).conflicts).toEqual(["wiki"]);
  });

  it("changes nothing when the entries already match", () => {
    const { text, owned } = patchMcpServers(USER_FILE, [entry("wiki")], []);
    expect(patchMcpServers(text, [entry("wiki")], owned).text).toBe(text);
  });

  it("refuses files it cannot patch safely", () => {
    expect(() => patchMcpServers("{ nope", [entry("a")], [])).toThrow(ConfigFileError);
    expect(() => patchMcpServers('{"mcp": [], "x": 1}', [entry("a")], [])).toThrow(/must be an object/);
    expect(() => patchMcpServers('{"a": 1, "a": 2}', [entry("a")], [])).toThrow(/duplicate/);
  });
});

describe("writeMcpServers", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await mkdtemp(join(tmpdir(), "mcp-catalog-write-"));
  });
  afterEach(async () => {
    await rm(dir, { recursive: true, force: true });
  });

  it("creates the file when there is none, and writes nothing when nothing is wanted", async () => {
    const path = join(dir, "opencode.json");
    const none = await writeMcpServers(path, [], [], new Set());
    expect(none.changed).toBe(false);
    await expect(stat(path)).rejects.toThrow();
    const result = await writeMcpServers(path, [entry("wiki")], [], new Set());
    expect(result.changed).toBe(true);
    expect(JSON.parse(await readFile(path, "utf8")).mcp.servers.wiki.type).toBe("remote");
  });

  it("keeps one backup of the original and releases the lock", async () => {
    const path = join(dir, "opencode.json");
    await writeFile(path, USER_FILE);
    await writeMcpServers(path, [entry("wiki")], [], new Set());
    await writeMcpServers(path, [entry("wiki"), entry("tracker")], ["wiki"], new Set());
    expect(await readFile(`${path}.before-mcp-catalog.bak`, "utf8")).toBe(USER_FILE);
    await expect(stat(`${path}.bb-config-lock`)).rejects.toThrow();
  });

  it("waits for another writer's lock", async () => {
    const path = join(dir, "opencode.json");
    await writeFile(path, "{}\n");
    const { acquireConfigLock } = await import("../src/host/config-lock");
    const release = await acquireConfigLock(path, "fleet-kit");
    const writing = writeMcpServers(path, [entry("wiki")], [], new Set());
    await new Promise((resolve) => setTimeout(resolve, 300));
    expect(JSON.parse(await readFile(path, "utf8")).mcp).toBeUndefined();
    await release();
    await writing;
    expect(JSON.parse(await readFile(path, "utf8")).mcp.servers.wiki).toBeDefined();
  });
});
