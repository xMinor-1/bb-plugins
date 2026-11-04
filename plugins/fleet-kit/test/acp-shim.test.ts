import { spawn } from "node:child_process";
import { chmodSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ACP_SHIM_SOURCE } from "../src/host/acp-shim-source.js";
import { agentEntry, mergeAgents } from "../src/host/acp-agent.js";

const shimFile = new URL("../src/host/acp-shim.cjs", import.meta.url);
const dirs: string[] = [];
const children: ReturnType<typeof spawn>[] = [];
afterEach(() => {
  for (const child of children.splice(0)) child.kill("SIGKILL");
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

/** What Fleet Kit writes after the program answers with the right version. */
function record(program: string) {
  const file = statSync(program);
  writeFileSync(join(dirname(program), "bb-acp-state.json"), JSON.stringify({ verified: { version: "2.2.5", size: file.size, mtimeMs: file.mtimeMs }, message: null }));
}

function start(program: string, env: Record<string, string> = {}) {
  const home = mkdtempSync(join(tmpdir(), "fk-shim-"));
  dirs.push(home);
  const child = spawn(process.execPath, [shimFile.pathname, program, "acp"], { env: { PATH: process.env.PATH, HOME: home, XDG_CONFIG_HOME: home, XDG_DATA_HOME: home, ...env } });
  children.push(child);
  const lines: Record<string, any>[] = [];
  let buffer = "";
  child.stdout.on("data", (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf("\n")) >= 0) {
      lines.push(JSON.parse(buffer.slice(0, at)));
      buffer = buffer.slice(at + 1);
    }
  });
  const send = (message: object) => child.stdin.write(`${JSON.stringify({ jsonrpc: "2.0", ...message })}\n`);
  const until = async (test: (line: Record<string, any>) => boolean) => {
    for (let i = 0; i < 300; i += 1) {
      const found = lines.find(test);
      if (found) return found;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`no such line in ${JSON.stringify(lines)}`);
  };
  const exited = new Promise<number | null>((resolve) => child.on("close", resolve));
  return { send, until, lines, exited, home };
}

describe("the wrapper's text in the server", () => {
  it("is the file", () => {
    expect(ACP_SHIM_SOURCE).toBe(readFileSync(shimFile, "utf8"));
  });
});

describe("while OpenCode is not there yet", () => {
  it("opens a thread and tells the person in the chat", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fk-shim-"));
    dirs.push(dir);
    const shim = start(join(dir, "opencode"), { ACP_SHIM_NOT_READY: "still installing" });
    shim.send({ id: 1, method: "initialize", params: { protocolVersion: 1 } });
    expect((await shim.until((l) => l.id === 1)).result.agentCapabilities.promptCapabilities.image).toBe(false);
    shim.send({ id: 2, method: "session/new", params: { cwd: dir } });
    const sessionId = (await shim.until((l) => l.id === 2)).result.sessionId;
    shim.send({ id: 3, method: "session/prompt", params: { sessionId, prompt: [] } });
    expect((await shim.until((l) => l.id === 3)).result.stopReason).toBe("end_turn");
    const chunk = await shim.until((l) => l.method === "session/update");
    expect(chunk.params).toMatchObject({ sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text: "still installing" } } });
    shim.send({ id: 4, method: "unknown/method", params: {} });
    expect((await shim.until((l) => l.id === 4)).error.message).toBe("still installing");
  });

  it("ends after answering once OpenCode has appeared, so bb starts the real one", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fk-shim-"));
    dirs.push(dir);
    const program = join(dir, "opencode");
    const shim = start(program, { ACP_SHIM_NOT_READY: "still installing" });
    shim.send({ id: 1, method: "initialize", params: {} });
    await shim.until((l) => l.id === 1);
    writeFileSync(program, "#!/bin/sh\n");
    record(program);
    shim.send({ id: 2, method: "session/prompt", params: { sessionId: "s" } });
    await shim.until((l) => l.id === 2);
    expect(await shim.exited).toBe(0);
  });

  it("does not start a program Fleet Kit has not checked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fk-shim-"));
    dirs.push(dir);
    const program = join(dir, "opencode");
    writeFileSync(program, `#!/bin/sh\ntouch "${dir}/started"\n`);
    chmodSync(program, 0o755);
    const shim = start(program, { ACP_SHIM_NOT_READY: "still installing" });
    shim.send({ id: 1, method: "initialize", params: {} });
    await shim.until((l) => l.id === 1);
    shim.send({ id: 2, method: "session/prompt", params: { sessionId: "s" } });
    const chunk = await shim.until((l) => l.method === "session/update");
    expect(chunk.params.update.content.text).toBe("still installing");
    expect(existsSync(join(dir, "started"))).toBe(false);
  });

  it("does not start a file that differs from the one checked", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fk-shim-"));
    dirs.push(dir);
    const program = join(dir, "opencode");
    writeFileSync(program, "#!/bin/sh\n");
    record(program);
    writeFileSync(program, `#!/bin/sh\ntouch "${dir}/started"\n`);
    chmodSync(program, 0o755);
    const shim = start(program, { ACP_SHIM_NOT_READY: "still installing" });
    shim.send({ id: 1, method: "initialize", params: {} });
    await shim.until((l) => l.id === 1);
    expect(existsSync(join(dir, "started"))).toBe(false);
  });

  describe("the limit on providers", () => {
    function checkedProgram() {
      const dir = mkdtempSync(join(tmpdir(), "fk-shim-"));
      dirs.push(dir);
      const program = join(dir, "opencode");
      writeFileSync(program, `#!/bin/sh\ntouch "${dir}/started"\nsleep 5\n`);
      chmodSync(program, 0o755);
      record(program);
      return { dir, program, config: join(dir, "opencode.json") };
    }
    const settle = () => new Promise((r) => setTimeout(r, 300));

    it.each([
      ["a broken file", "{"],
      ["no limit in it", '{"model":"x/y"}'],
      ["an empty limit", '{"enabled_providers":[]}'],
    ])("%s: the checked program is not started, and the turn says why", async (_name, text) => {
      const { dir, program, config } = checkedProgram();
      writeFileSync(config, text);
      const shim = start(program, { ACP_SHIM_NOT_READY: "still installing", ACP_SHIM_CONFIG: config, ACP_SHIM_CONFIG_FAILED: "settings are broken" });
      shim.send({ id: 1, method: "initialize", params: {} });
      await shim.until((l) => l.id === 1);
      shim.send({ id: 2, method: "session/prompt", params: { sessionId: "s" } });
      const chunk = await shim.until((l) => l.method === "session/update");
      expect(chunk.params.update.content.text).toBe("settings are broken");
      expect(existsSync(join(dir, "started"))).toBe(false);
    });

    it("no file at all: not started", async () => {
      const { dir, program, config } = checkedProgram();
      const shim = start(program, { ACP_SHIM_NOT_READY: "still installing", ACP_SHIM_CONFIG: config, ACP_SHIM_CONFIG_FAILED: "settings are broken" });
      shim.send({ id: 1, method: "initialize", params: {} });
      await shim.until((l) => l.id === 1);
      expect(existsSync(join(dir, "started"))).toBe(false);
    });

    it.each([
      ["plain", '{"enabled_providers":["corp"]}'],
      ["comments and a trailing comma, as OpenCode allows", '// mine\n{ /* a */ "url": "http://x//y", "enabled_providers": ["corp",], }\n'],
    ])("%s: started (control)", async (_name, text) => {
      const { dir, program, config } = checkedProgram();
      writeFileSync(config, text);
      start(program, { ACP_SHIM_NOT_READY: "still installing", ACP_SHIM_CONFIG: config, ACP_SHIM_CONFIG_FAILED: "settings are broken" });
      for (let i = 0; i < 100 && !existsSync(join(dir, "started")); i += 1) await settle();
      expect(existsSync(join(dir, "started"))).toBe(true);
    });

    it("blocked by Fleet Kit: not started, and the reason from its record reaches the turn", async () => {
      const { dir, program, config } = checkedProgram();
      writeFileSync(config, '{"enabled_providers":["corp"]}');
      const state = join(dir, "bb-acp-state.json");
      writeFileSync(state, JSON.stringify({ ...JSON.parse(readFileSync(state, "utf8")), blocked: true, message: "disk is read-only" }));
      const shim = start(program, { ACP_SHIM_NOT_READY: "still installing", ACP_SHIM_CONFIG: config, ACP_SHIM_CONFIG_FAILED: "settings are broken" });
      shim.send({ id: 1, method: "initialize", params: {} });
      await shim.until((l) => l.id === 1);
      shim.send({ id: 2, method: "session/prompt", params: { sessionId: "s" } });
      const chunk = await shim.until((l) => l.method === "session/update");
      expect(chunk.params.update.content.text).toBe("disk is read-only");
      expect(existsSync(join(dir, "started"))).toBe(false);
    });
  });

  it("says what Fleet Kit has found out: a refusal, or that it stopped trying", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fk-shim-"));
    dirs.push(dir);
    const program = join(dir, "opencode");
    const shim = start(program, { ACP_SHIM_NOT_READY: "still installing" });
    shim.send({ id: 1, method: "initialize", params: {} });
    await shim.until((l) => l.id === 1);
    writeFileSync(join(dir, "bb-acp-state.json"), JSON.stringify({ verified: null, message: "ask IT" }));
    shim.send({ id: 2, method: "session/prompt", params: { sessionId: "s" } });
    const chunk = await shim.until((l) => l.method === "session/update");
    expect(chunk.params.update.content.text).toBe("ask IT");
  });

  it("answers in the chat when the checked program is refused at start", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fk-shim-"));
    dirs.push(dir);
    const program = join(dir, "opencode");
    writeFileSync(program, "#!/bin/sh\n");
    chmodSync(program, 0o644); // EACCES, an "error" event
    record(program);
    const shim = start(program, { ACP_SHIM_NOT_READY: "still installing", ACP_SHIM_DENIED: "the system refused it, ask IT" });
    shim.send({ id: 1, method: "initialize", params: {} });
    await shim.until((l) => l.id === 1);
    shim.send({ id: 2, method: "session/new", params: { cwd: dir } });
    await shim.until((l) => l.id === 2);
    shim.send({ id: 3, method: "session/prompt", params: { sessionId: "s" } });
    const chunk = await shim.until((l) => l.method === "session/update");
    expect(chunk.params.update.content.text).toBe("the system refused it, ask IT");
  });

  it("without the text it fails as before", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fk-shim-"));
    dirs.push(dir);
    expect(await start(join(dir, "opencode")).exited).toBe(127);
  });
});

describe("with OpenCode there", () => {
  it("hides image support, and the agent does not inherit the app's Node mode", async () => {
    const dir = mkdtempSync(join(tmpdir(), "fk-shim-"));
    dirs.push(dir);
    const program = join(dir, "opencode");
    const answer = { jsonrpc: "2.0", id: 1, result: { agentCapabilities: { promptCapabilities: { image: true } } } };
    writeFileSync(program, `#!/bin/sh\nread line\necho "$ELECTRON_RUN_AS_NODE" > "${dir}/seen"\necho '${JSON.stringify(answer)}'\nread rest\n`);
    chmodSync(program, 0o755);
    const shim = start(program, { ELECTRON_RUN_AS_NODE: "" });
    shim.send({ id: 1, method: "initialize", params: {} });
    expect((await shim.until((l) => l.id === 1)).result.agentCapabilities.promptCapabilities.image).toBe(false);
    expect(readFileSync(join(dir, "seen"), "utf8").trim()).toBe("");
  });
});

describe("agent entry", () => {
  it("runs under the program that runs bb, switching the app to Node mode", () => {
    const app = agentEntry({ execPath: "C:\\ADE\\app.exe", electron: true }, "s.cjs", "oc.exe", { notReady: "wait", denied: "no" });
    expect(app).toMatchObject({ id: "opencode", command: "C:\\ADE\\app.exe", args: ["s.cjs", "oc.exe", "acp"], env: { ELECTRON_RUN_AS_NODE: "1", ACP_SHIM_NOT_READY: "wait" } });
    expect(agentEntry({ execPath: "/usr/bin/node", electron: false }, "s", "o", { notReady: "w", denied: "d" }).env).toEqual({ ACP_SHIM_NOT_READY: "w", ACP_SHIM_DENIED: "d" });
  });

  it("keeps the person's other agents and gives way only to an unreadable value", () => {
    const ours = { id: "opencode", command: "new" };
    const merged = mergeAgents(JSON.stringify([{ id: "mine" }, { id: "opencode", command: "old" }]), ours);
    expect(merged.kept).toBe(true);
    expect(JSON.parse(merged.value)).toEqual([{ id: "mine" }, ours]);
    expect(mergeAgents("", ours)).toEqual({ value: JSON.stringify([ours]), kept: true });
    expect(mergeAgents("{not json", ours)).toEqual({ value: JSON.stringify([ours]), kept: false });
  });
});
