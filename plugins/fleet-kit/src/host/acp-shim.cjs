// Wrapper around `opencode acp` for bb: node acp-shim.cjs <opencode> acp. Fleet Kit writes it and registers it as
// the OpenCode agent (customAgents of the ACP provider).
// - In bb's initialize answer it sets promptCapabilities.image = false: bb then sends the path of an attachment
//   instead of base64, so models without vision can pass it on.
// - It holds the first session/prompt until the MCP servers in the config connect or fail, at most 12 s: OpenCode 2
//   connects them in the background, and the first model step would otherwise run without their tools. The only signal
//   is OpenCode's log; when it cannot be read, the request goes out at the limit.
// - While OpenCode is not on the machine yet (Fleet Kit is installing it), it answers bb itself and tells the person
//   so in the chat: ACP_SHIM_NOT_READY holds the text.
// Everything else passes through as is. A command without a path is looked up in the PATH bb gave.
"use strict";
const { spawn } = require("node:child_process");
const fs = require("node:fs");
const os = require("node:os");
const path = require("node:path");

const isWin = process.platform === "win32";
const SIGNALS = ["SIGTERM", "SIGINT", "SIGHUP"];
const SCAN_MAX = 1 << 20; // initialize and its answer are short; longer lines are not parsed
const CLOSE_WAIT_MS = 2000;
const HOLD_MS = Number(process.env.ACP_SHIM_HOLD_MS) || 12000; // MCP wait limit; only tests change it
const HOLD_POLL_MS = 150;
const KEEP_IMAGE = process.env.ACP_SHIM_KEEP_IMAGE === "1"; // only the MCP wait, images as they were
const [name, ...args] = process.argv.slice(2);

// Windows: only runnable PATHEXT extensions, since npm puts an extensionless sh script next to opencode.cmd. The thread
// folder bb looks at first and relative PATH items are skipped: OpenCode is never started from a project folder. Not
// found is null rather than the bare name, which process creation on Windows would look up in the current folder.
// A path that names a missing file is also null: Fleet Kit may still be installing it.
function resolveBin(cmd) {
  if (!cmd) return cmd;
  if ((isWin ? /[\\/]/ : /\//).test(cmd)) return fs.existsSync(cmd) ? cmd : null;
  const exts = isWin ? (process.env.PATHEXT || ".COM;.EXE;.BAT;.CMD").split(";").filter((ext) => /^\.(com|exe|bat|cmd)$/i.test(ext)) : [""];
  for (const entry of (process.env.PATH || "").split(isWin ? ";" : ":")) {
    const dir = isWin ? entry.replace(/^"(.*)"$/, "$1") : entry;
    if (!dir || !path.isAbsolute(dir)) continue;
    for (const ext of exts) {
      const file = path.join(dir, cmd + ext);
      try {
        fs.accessSync(file, fs.constants.X_OK);
        if (fs.statSync(file).isFile()) return file;
      } catch {}
    }
  }
  return null;
}

// Node does not start .cmd and .bat directly, so through cmd.exe. The arguments are fixed (acp), nothing to escape.
// NoDefaultCurrentDirectoryInExePath: commands inside the .cmd are not taken from the project folder.
function launch(file, argv) {
  const options = { stdio: ["pipe", "pipe", "inherit"], windowsHide: true };
  if (!isWin || !/\.(cmd|bat)$/i.test(file)) return spawn(file, argv, options);
  const line = [`"${file}"`, ...argv].join(" ");
  const shell = process.env.ComSpec || path.join(process.env.SystemRoot || "C:\\Windows", "System32", "cmd.exe");
  const env = { ...process.env, NoDefaultCurrentDirectoryInExePath: "1" };
  return spawn(shell, ["/d", "/s", "/c", `"${line}"`], { ...options, env, windowsVerbatimArguments: true });
}

// The agent is not on the machine yet: enough of ACP for bb to open a thread and show the person what is going on. When
// the agent has appeared by the time of a prompt, this process ends after answering, and bb starts a real one next turn.
function serveNotReady(text) {
  const send = (message) => process.stdout.write(JSON.stringify({ jsonrpc: "2.0", ...message }) + "\n");
  let buffer = "";
  const answer = (msg) => {
    const { id, method, params } = msg;
    if (id === undefined || id === null) return;
    if (method === "initialize") {
      send({ id, result: { protocolVersion: params?.protocolVersion ?? 1, agentCapabilities: { loadSession: false, promptCapabilities: { image: false } }, authMethods: [] } });
    } else if (method === "session/new") {
      send({ id, result: { sessionId: `not-ready-${process.pid}-${Date.now()}` } });
    } else if (method === "session/prompt") {
      send({ method: "session/update", params: { sessionId: params?.sessionId, update: { sessionUpdate: "agent_message_chunk", content: { type: "text", text } } } });
      send({ id, result: { stopReason: "end_turn" } });
      if (resolveBin(name)) process.stdout.write("", () => process.exit(0));
    } else if (typeof method === "string" && method.startsWith("session/set_")) {
      send({ id, result: {} });
    } else {
      send({ id, error: { code: -32601, message: text } });
    }
  };
  process.stdin.setEncoding("utf8");
  process.stdin.on("data", (chunk) => {
    buffer += chunk;
    let at;
    while ((at = buffer.indexOf("\n")) >= 0) {
      const line = buffer.slice(0, at);
      buffer = buffer.slice(at + 1);
      try {
        answer(JSON.parse(line));
      } catch {}
    }
  });
  process.stdin.on("end", () => process.exit(0));
  process.stdout.on("error", () => process.exit(0));
}

const bin = resolveBin(name);
if (!bin) {
  if (process.env.ACP_SHIM_NOT_READY) {
    serveNotReady(process.env.ACP_SHIM_NOT_READY);
    return;
  }
  process.stderr.write(`bb-acp-shim: ${name} not found\n`);
  process.exit(127);
}
// The app runs this file in its Node mode; the agent and what it starts are ordinary programs.
delete process.env.ELECTRON_RUN_AS_NODE;
// OpenCode's log: only what is written after this wrapper started matters.
function homeDir() {
  try {
    return os.homedir();
  } catch {
    return process.env.HOME || process.env.USERPROFILE || ".";
  }
}
const LOG_FILE = path.join(process.env.XDG_DATA_HOME || path.join(homeDir(), ".local", "share"), "opencode", "log", "opencode.log");
let logPos = 0;
let logTail = Buffer.alloc(0);
try {
  logPos = fs.statSync(LOG_FILE).size;
} catch {}
let child;
try {
  child = launch(bin, args);
} catch (error) {
  // On Windows a refused start throws here instead of emitting "error".
  process.stderr.write(`bb-acp-shim: ${error.message}\n`);
  process.exit(127);
}
const pending = new Set(); // ids of bb's initialize requests still without an answer

// bb -> agent: chunks pass as they are, initialize requests are noted on the way. "\n" is searched in the new chunk only.
let inParts = [];
let inSize = 0;
function scanFromBb(line) {
  if (line.length > SCAN_MAX || !line.includes('"initialize"')) return;
  try {
    const msg = JSON.parse(line);
    if (msg && msg.method === "initialize" && msg.id !== undefined && msg.id !== null) pending.add(JSON.stringify(msg.id));
  } catch {}
}
function toAgent(text) {
  if (!child.stdin.write(text)) {
    process.stdin.pause();
    child.stdin.once("drain", () => process.stdin.resume());
  }
}
function passThrough(chunk) {
  let start = 0;
  let i;
  while ((i = chunk.indexOf("\n", start)) >= 0) {
    if (inSize + (i + 1 - start) <= SCAN_MAX) {
      inParts.push(chunk.slice(start, i + 1));
      scanFromBb(inParts.length === 1 ? inParts[0] : inParts.join(""));
    }
    inParts = [];
    inSize = 0;
    start = i + 1;
  }
  if (start < chunk.length) {
    inSize += chunk.length - start;
    if (inSize <= SCAN_MAX) inParts.push(chunk.slice(start));
    else inParts = [];
  }
  toAgent(chunk);
}

// MCP servers to wait for; the config is found the way OpenCode finds it. []: nobody to wait for, null: config unreadable.
function configuredServers(cwd) {
  const envDir = process.env.OPENCODE_CONFIG_DIR;
  const dir = envDir ? path.resolve(cwd || ".", envDir) : path.join(process.env.XDG_CONFIG_HOME || path.join(homeDir(), ".config"), "opencode");
  let text = null;
  for (const file of ["opencode.json", "opencode.jsonc"]) {
    try {
      text = fs.readFileSync(path.join(dir, file), "utf8");
      break;
    } catch (error) {
      if (error.code !== "ENOENT") return null;
    }
  }
  if (text === null) return [];
  let mcp;
  try {
    mcp = JSON.parse(text.replace(/^\uFEFF/, "")).mcp;
  } catch {
    return null;
  }
  if (!mcp || typeof mcp !== "object") return [];
  const v2 = mcp.servers && typeof mcp.servers === "object"; // otherwise mcp.<name>, the OpenCode 1 format
  const all = v2 ? mcp.servers : mcp;
  return Object.keys(all).filter((key) => {
    const server = all[key];
    return server && typeof server === "object" && (v2 || key !== "timeout") && !server.disabled && server.enabled !== false;
  });
}
function readLogLines() {
  const fd = fs.openSync(LOG_FILE, "r");
  try {
    const size = fs.fstatSync(fd).size;
    if (size < logPos) {
      logPos = 0;
      logTail = Buffer.alloc(0);
    }
    const buf = Buffer.alloc(size - logPos);
    if (buf.length > 0) fs.readSync(fd, buf, 0, buf.length, logPos);
    logPos = size;
    const data = Buffer.concat([logTail, buf]);
    const end = data.lastIndexOf(0x0a) + 1; // an unfinished line follows: decode whole lines only
    logTail = data.subarray(end);
    return data.toString("utf8", 0, end).split("\n");
  } finally {
    fs.closeSync(fd);
  }
}
// A log line saying a server of this folder finished connecting, either way: the server's name, otherwise null.
function finishedServer(line, markers) {
  if (!/message="mcp connect(ed| failed)"/.test(line)) return null;
  if (!markers.some((marker) => line.includes(marker + " ") || line.endsWith(marker))) return null;
  const found = [...line.matchAll(/(?:^| )server=("(?:[^"\\]|\\.)*"|\S+)/g)]; // the last one: error text may come before it
  if (found.length === 0) return null;
  const raw = found[found.length - 1][1];
  try {
    return raw.startsWith('"') ? JSON.parse(raw) : raw;
  } catch {
    return raw;
  }
}
function directoryMarkers(cwd) {
  if (!cwd) return [];
  const dirs = new Set([cwd, cwd.replace(/\\/g, "/")]);
  try {
    dirs.add(fs.realpathSync(cwd));
  } catch {}
  return [...dirs].flatMap((dir) => [`directory=${dir}`, `directory=${JSON.stringify(dir)}`]);
}

// before: split into lines until the first session/prompt; holding: it and everything after it wait here; passed: direct.
let stage = "before";
let beforeParts = [];
let heldPrompt = "";
let held = [];
let sessionCwd = null;
let stdinEnded = false;
let holdTimer = null;
function releasePrompt() {
  if (stage !== "holding") return;
  stage = "passed";
  clearTimeout(holdTimer);
  toAgent(heldPrompt);
  heldPrompt = "";
  const rest = held;
  held = [];
  for (const chunk of rest) passThrough(chunk);
  if (stdinEnded) child.stdin.end();
}
function holdPrompt() {
  let wanted = null;
  try {
    wanted = configuredServers(sessionCwd);
  } catch {}
  if (wanted && wanted.length === 0) return releasePrompt();
  const left = new Set(wanted || []);
  const markers = directoryMarkers(sessionCwd);
  const deadline = Date.now() + HOLD_MS;
  const tick = () => {
    if (stage !== "holding") return;
    try {
      for (const line of readLogLines()) {
        const server = finishedServer(line, markers);
        if (server !== null) left.delete(server);
      }
    } catch {}
    if (wanted && left.size === 0) return releasePrompt();
    if (Date.now() >= deadline) {
      process.stderr.write(`bb-acp-shim: first prompt released after ${HOLD_MS} ms, MCP not ready: ${wanted ? [...left].join(", ") : "config not read"}\n`);
      return releasePrompt();
    }
    holdTimer = setTimeout(tick, HOLD_POLL_MS);
  };
  tick();
}
// true: this is the first session/prompt and the line was taken.
function checkLineBeforePrompt(line) {
  if (!/"session\/(new|load|resume|prompt)"/.test(line)) return false;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch {
    return false;
  }
  if (msg && ["session/new", "session/load", "session/resume"].includes(msg.method) && msg.params && msg.params.cwd) sessionCwd = msg.params.cwd;
  if (!msg || msg.method !== "session/prompt") return false;
  stage = "holding";
  heldPrompt = line;
  holdPrompt();
  return true;
}
function beforePrompt(chunk) {
  let start = 0;
  let i;
  while ((i = chunk.indexOf("\n", start)) >= 0) {
    beforeParts.push(chunk.slice(start, i + 1));
    const line = beforeParts.length === 1 ? beforeParts[0] : beforeParts.join("");
    beforeParts = [];
    start = i + 1;
    scanFromBb(line);
    if (checkLineBeforePrompt(line)) {
      if (start < chunk.length) {
        const rest = chunk.slice(start);
        if (stage === "holding") {
          held.push(rest);
          if (rest.includes('"session/cancel"')) releasePrompt();
        } else passThrough(rest);
      }
      return;
    }
    toAgent(line);
  }
  if (start < chunk.length) beforeParts.push(chunk.slice(start));
}
process.stdin.setEncoding("utf8");
process.stdin.on("data", (chunk) => {
  if (stage === "before") return beforePrompt(chunk);
  if (stage === "passed") return passThrough(chunk);
  held.push(chunk);
  if (chunk.includes('"session/cancel"')) releasePrompt();
});
process.stdin.on("end", () => {
  stdinEnded = true;
  if (stage === "holding") return releasePrompt();
  if (stage === "before" && beforeParts.length > 0) toAgent(beforeParts.join(""));
  child.stdin.end();
});
process.stdin.on("error", () => {});
child.stdin.on("error", () => {});

// agent -> bb: split into lines while an initialize answer is due, then direct.
function patch(line) {
  if (line.length > SCAN_MAX || !line.includes('"promptCapabilities"')) return line;
  try {
    const msg = JSON.parse(line);
    const key = msg && msg.id !== undefined && msg.id !== null ? JSON.stringify(msg.id) : null;
    if (key === null || !pending.has(key)) return line;
    pending.delete(key);
    const caps = msg.result && msg.result.agentCapabilities && msg.result.agentCapabilities.promptCapabilities;
    if (!caps || caps.image === false || KEEP_IMAGE) return line;
    caps.image = false;
    return JSON.stringify(msg) + (line.endsWith("\n") ? "\n" : "");
  } catch {
    return line;
  }
}
let waiting = false;
function toBb(text) {
  if (!process.stdout.write(text) && !waiting) {
    waiting = true;
    child.stdout.pause();
    process.stdout.once("drain", () => {
      waiting = false;
      child.stdout.resume();
    });
  }
}
let outParts = [];
child.stdout.setEncoding("utf8");
child.stdout.on("data", (chunk) => {
  let start = 0;
  while (pending.size > 0 || outParts.length > 0) {
    const i = chunk.indexOf("\n", start);
    if (i < 0) {
      if (start < chunk.length) outParts.push(chunk.slice(start));
      return;
    }
    outParts.push(chunk.slice(start, i + 1));
    const line = outParts.length === 1 ? outParts[0] : outParts.join("");
    outParts = [];
    toBb(patch(line));
    start = i + 1;
    if (start >= chunk.length) return;
  }
  toBb(start ? chunk.slice(start) : chunk);
});
function flushTail() {
  if (outParts.length) toBb(patch(outParts.join("")));
  outParts = [];
}
child.stdout.on("end", flushTail);

// bb closed its end (EPIPE): leave quietly and stop the agent.
process.stdout.on("error", () => {
  child.kill("SIGTERM");
  process.exit(0);
});
// Windows has no signals, and kill stops only the cmd.exe above a .cmd; the agent under it ends on the closed stdin.
for (const sig of SIGNALS) {
  process.on(sig, () => {
    if (isWin) child.stdin.destroy();
    child.kill(isWin ? "SIGTERM" : sig);
  });
}
child.on("error", (error) => {
  process.stderr.write(`bb-acp-shim: ${error.message}\n`);
  process.exit(127);
});
// Exit the way the agent did, with its code or signal, after bb got all the output.
let finished = false;
function finish(code, signal) {
  if (finished) return;
  finished = true;
  flushTail();
  process.stdout.write("", () => {
    if (signal && !isWin) {
      for (const sig of SIGNALS) process.removeAllListeners(sig);
      process.kill(process.pid, signal);
    }
    process.exit(code === null ? 1 : code);
  });
}
child.on("close", finish);
// close does not come while a descendant holds the agent's stdout: wait briefly, then exit with the agent's code.
child.on("exit", (code, signal) => setTimeout(() => finish(code, signal), CLOSE_WAIT_MS));
