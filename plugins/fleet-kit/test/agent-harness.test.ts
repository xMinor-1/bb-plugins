// The agent harness part of the OpenCode block: agents, compaction, tool
// output, experimental keys, MCP timeouts, and the build's agent rules.
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parse } from "jsonc-parser";
import { afterEach, describe, expect, it } from "vitest";
import { checkManifest } from "../src/manifest.js";
import { patchOpenCodeConfig, planOpenCode, RULES_FILE } from "../src/host/opencode-config.js";
import { rulesPath, syncAgentRules } from "../src/host/agent-rules.js";
import { clone, sampleManifest } from "./fixtures.js";

const dirs: string[] = [];
afterEach(async () => {
  await Promise.all(dirs.splice(0).map((dir) => rm(dir, { recursive: true, force: true })));
});

const RULES = "/home/user/.config/opencode/" + RULES_FILE;

function harnessManifest(): Record<string, any> {
  const manifest = clone(sampleManifest()) as Record<string, any>;
  Object.assign(manifest.opencode, {
    default_agent: "build",
    agents: {
      build: { steps: 40 },
      digest: { mode: "subagent", description: "Reads long output", steps: 10, model: "corp/small-model" },
    },
    compaction: { auto: true, buffer: "20%", keep: { tokens: 12000 } },
    tool_output: { max_lines: 400, max_bytes: 16384 },
    experimental: { subagent_depth: 1 },
    mcp: { timeout: { execution: 120000 } },
  });
  manifest.agentRules = ["# Rules", "- Short steps."];
  return manifest;
}

describe("manifest: agent harness", () => {
  it("accepts agents, compaction, tool output, experimental keys, MCP timeouts and rules", () => {
    const check = checkManifest(harnessManifest());
    expect(check.errors).toEqual([]);
    expect(check.manifest?.agentRules).toEqual(["# Rules", "- Short steps."]);
  });

  it.each([
    ["an MCP server", (m: Record<string, any>) => { m.opencode.mcp.servers = { x: { type: "remote", url: "https://x.test" } }; }, "opencode.mcp"],
    ["an unknown MCP timeout", (m: Record<string, any>) => { m.opencode.mcp.timeout.forever = 1; }, "opencode.mcp.timeout"],
    ["an agent model from another provider", (m: Record<string, any>) => { m.opencode.agents.digest.model = "other/m"; }, "opencode.agents.digest.model"],
    ["an agent model object from another provider", (m: Record<string, any>) => { m.opencode.agents.digest.model = { providerID: "other", model: "m" }; }, "opencode.agents.digest.model"],
    ["a bad agent id", (m: Record<string, any>) => { m.opencode.agents["../x"] = {}; }, "opencode.agents"],
    ["native instructions", (m: Record<string, any>) => { m.opencode.instructions = ["https://x.test/rules.md"]; }, "opencode"],
    ["a multi-line rule", (m: Record<string, any>) => { m.agentRules = ["a\nb"]; }, "agentRules.0"],
    ["empty rules", (m: Record<string, any>) => { m.agentRules = []; }, "agentRules"],
    ["{env:} inside an agent", (m: Record<string, any>) => { m.opencode.agents.build.system = "{env:HOME}"; }, "opencode.agents.build.system"],
  ])("refuses %s", (_name, mutate, where) => {
    const manifest = harnessManifest();
    mutate(manifest);
    const check = checkManifest(manifest);
    expect(check.manifest).toBeNull();
    expect(check.errors.some((error) => error.startsWith(where))).toBe(true);
  });
});

describe("plan and patch: agent harness", () => {
  const plan = () => planOpenCode(harnessManifest().opencode, ["corp"], { rulesFile: RULES });

  it("owns each agent, each experimental key and only mcp.timeout", () => {
    expect(plan().entries.map((entry) => entry.path.join("."))).toEqual([
      "providers.corp",
      "model",
      "update",
      "default_agent",
      "agents.build",
      "agents.digest",
      "compaction",
      "tool_output",
      "experimental.subagent_depth",
      "mcp.timeout",
      "enabled_providers",
    ]);
    expect(plan().instructions).toBe(RULES);
  });

  it("keeps the person's agents, MCP servers, experimental keys and instructions", () => {
    const source = `{
  // mine
  "agents": { "mine": { "mode": "subagent" }, "build": { "steps": 5 } },
  "experimental": { "todo": true },
  "mcp": { "servers": { "qlik": { "type": "local", "command": ["qlik"] } } },
  "instructions": ["CONTRIBUTING.md"]
}
`;
    const text = patchOpenCodeConfig(source, plan(), []);
    const config = parse(text);
    expect(text).toContain("// mine");
    expect(config.agents.mine).toEqual({ mode: "subagent" });
    expect(config.agents.build).toEqual({ steps: 40 });
    expect(config.experimental).toEqual({ todo: true, subagent_depth: 1 });
    expect(config.mcp).toEqual({ servers: { qlik: { type: "local", command: ["qlik"] } }, timeout: { execution: 120000 } });
    expect(config.instructions).toEqual(["CONTRIBUTING.md", RULES]);
    expect(patchOpenCodeConfig(text, plan(), plan().entries.map((entry) => entry.path))).toBe(text);
  });

  it("keeps one rules entry when the configuration directory moves", () => {
    const source = JSON.stringify({ instructions: ["/old/place/fleet-kit-rules.md", "mine.md"] });
    expect(parse(patchOpenCodeConfig(source, plan(), [])).instructions).toEqual(["mine.md", RULES]);
  });

  it("removes what it owned when the manifest drops the harness", () => {
    const owned = plan().entries.map((entry) => entry.path);
    const full = patchOpenCodeConfig(JSON.stringify({ agents: { mine: {} }, mcp: { servers: {} } }), plan(), []);
    const bare = planOpenCode(clone(sampleManifest()).opencode as Record<string, unknown>, ["corp"]);
    const config = parse(patchOpenCodeConfig(full, bare, owned));
    expect(config.agents).toEqual({ mine: {} });
    expect(config.mcp).toEqual({ servers: {} });
    expect(config.experimental).toBeUndefined();
    expect(config.compaction).toBeUndefined();
    expect(config.instructions).toBeUndefined();
    const onlyOurs = parse(patchOpenCodeConfig(patchOpenCodeConfig("{}", plan(), []), bare, owned));
    expect([onlyOurs.agents, onlyOurs.mcp, onlyOurs.experimental]).toEqual([undefined, undefined, undefined]);
  });

  it("leaves a string instructions alone without rules and refuses it with rules", () => {
    const bare = planOpenCode(clone(sampleManifest()).opencode as Record<string, unknown>, ["corp"]);
    const source = JSON.stringify({ instructions: "mine.md" });
    expect(parse(patchOpenCodeConfig(source, bare, [])).instructions).toBe("mine.md");
    expect(() => patchOpenCodeConfig(source, plan(), [])).toThrow('"instructions" must be a list');
  });

  it("refuses a relative rules path and MCP keys other than timeout", () => {
    expect(() => planOpenCode(harnessManifest().opencode, ["corp"], { rulesFile: RULES_FILE })).toThrow("absolute path");
    const block = harnessManifest().opencode;
    block.mcp.servers = {};
    expect(() => planOpenCode(block, ["corp"])).toThrow("only mcp.timeout");
  });
});

describe("agent rules file", () => {
  it("writes, keeps, replaces and removes its own file", async () => {
    const dir = await mkdtemp(join(tmpdir(), "fleet-kit-rules-"));
    dirs.push(dir);
    const path = rulesPath(dir);
    expect(await syncAgentRules(dir, ["# Rules", "- One."])).toBe(true);
    const text = await readFile(path, "utf8");
    expect(text).toMatch(/^<!-- Written by Fleet Kit/);
    expect(text).toContain("# Rules\n- One.\n");
    expect(await syncAgentRules(dir, ["# Rules", "- One."])).toBe(false);
    await writeFile(path, "local edit", "utf8");
    expect(await syncAgentRules(dir, ["# Rules", "- One."])).toBe(true);
    expect(await readFile(path, "utf8")).toBe(text);
    expect(await syncAgentRules(dir, undefined)).toBe(true);
    await expect(readFile(path, "utf8")).rejects.toThrow();
    expect(await syncAgentRules(dir, undefined)).toBe(false);
  });
});
