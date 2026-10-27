// The quick voice of conversation mode: a small model that says one sentence
// right after the user finishes, while the agent itself is still reading its
// history. The agent's answer is the real one; this only fills the silence.
//
// One Claude Code process is kept running in stream-json mode. Starting it per
// phrase costs about nine seconds; a resident process answers its first token
// in under two.
import { spawn, type ChildProcessWithoutNullStreams } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { homedir } from "node:os";
import { delimiter, join } from "node:path";
import { createInterface } from "node:readline";

export const QUICK_SYSTEM_PROMPT = [
  "You are the quick voice of a coding agent that the user talks to by voice.",
  "The agent has already received the user's words and is working on the real answer;",
  "that takes ten to thirty seconds because it reads a long history and runs tools.",
  "Your only job is to fill the silence at once with ONE short spoken sentence, at most",
  "twelve words, that shows you heard and understood the request. Examples:",
  "«Понял, смотрю, сколько места на сервере.» «Ага, сейчас разберусь с голосом.»",
  "Rules: never answer the substance; never state facts, numbers, statuses or results;",
  "never say that something is done, works or failed; never promise timing; never ask",
  "questions; do not repeat the user's words verbatim. You have no tools: never write",
  "tool calls, code, markdown, lists or emoji. Plain spoken text only, in the language",
  "the user spoke.",
].join(" ");

/** A long resident session slows down as it grows: start fresh past this. */
const MAX_TURNS = 40;
/** Longer than this is not a filler sentence; the model went off script. */
const MAX_REPLY_CHARS = 160;

export type QuickResult =
  | { ok: true; text: string; firstTokenMs: number | null; totalMs: number }
  | { ok: false; code: "busy" | "unavailable" | "timeout" | "failed"; message: string };

interface Pending {
  started: number;
  firstToken: number | null;
  text: string;
  resolve(result: QuickResult): void;
}

function findClaude(configured: string | null): string | null {
  if (configured !== null && configured.trim() !== "") return configured.trim();
  for (const dir of (process.env.PATH ?? "").split(delimiter)) {
    if (dir !== "" && existsSync(join(dir, "claude"))) return join(dir, "claude");
  }
  const local = join(homedir(), ".local", "bin", "claude");
  return existsSync(local) ? local : null;
}

export class QuickVoice {
  private child: ChildProcessWithoutNullStreams | null = null;
  private key = "";
  private turns = 0;
  private pending: Pending | null = null;

  constructor(
    private readonly workDir: string,
    private readonly log: (message: string) => void,
  ) {}

  /** Start the process now, so the first phrase does not pay for it. */
  async warm(model: string, claudePath: string | null): Promise<boolean> {
    return (await this.ensure(model, claudePath)) !== null;
  }

  async reply(
    prompt: string,
    options: { model: string; claudePath: string | null; timeoutMs: number },
  ): Promise<QuickResult> {
    if (this.pending !== null) {
      return { ok: false, code: "busy", message: "the quick voice is still answering" };
    }
    const child = await this.ensure(options.model, options.claudePath);
    if (child === null) {
      return { ok: false, code: "unavailable", message: "Claude Code (claude) was not found" };
    }
    this.turns += 1;
    return new Promise<QuickResult>((resolve) => {
      const pending: Pending = { started: Date.now(), firstToken: null, text: "", resolve };
      this.pending = pending;
      const timer = setTimeout(() => {
        if (this.pending !== pending) return;
        this.pending = null;
        resolve({ ok: false, code: "timeout", message: "the quick voice took too long" });
        // A session that missed its answer may answer late into the next one.
        this.stop();
      }, options.timeoutMs);
      pending.resolve = (result) => {
        clearTimeout(timer);
        resolve(result);
      };
      child.stdin.write(
        `${JSON.stringify({ type: "user", message: { role: "user", content: prompt } })}\n`,
      );
    });
  }

  stop(): void {
    this.child?.kill();
    this.child = null;
    this.turns = 0;
  }

  private async ensure(
    model: string,
    claudePath: string | null,
  ): Promise<ChildProcessWithoutNullStreams | null> {
    const key = `${model}\n${claudePath ?? ""}`;
    if (this.child !== null && (key !== this.key || this.turns >= MAX_TURNS) && this.pending === null) {
      this.stop();
    }
    if (this.child !== null) return this.child;
    const binary = findClaude(claudePath);
    if (binary === null) return null;
    // An empty directory: no project settings, hooks or instructions to load.
    await mkdir(this.workDir, { recursive: true });
    const child = spawn(
      binary,
      [
        "-p",
        "--input-format",
        "stream-json",
        "--output-format",
        "stream-json",
        "--include-partial-messages",
        "--verbose",
        "--model",
        model,
        "--effort",
        "low",
        "--setting-sources",
        "project",
        "--strict-mcp-config",
        "--no-session-persistence",
        "--tools",
        "",
        "--system-prompt",
        QUICK_SYSTEM_PROMPT,
      ],
      { cwd: this.workDir, stdio: ["pipe", "pipe", "pipe"], env: process.env },
    );
    this.child = child;
    this.key = key;
    this.turns = 0;
    child.stderr.resume();
    child.on("exit", (code) => {
      if (this.child === child) this.child = null;
      const pending = this.pending;
      if (pending !== null) {
        this.pending = null;
        pending.resolve({ ok: false, code: "failed", message: `claude exited (${code ?? "signal"})` });
      }
    });
    child.on("error", (error) => this.log(`quick voice: ${error.message}`));
    createInterface({ input: child.stdout }).on("line", (line) => this.onLine(line));
    this.log(`quick voice started: ${binary} --model ${model}`);
    return child;
  }

  private onLine(line: string): void {
    const pending = this.pending;
    if (pending === null) return;
    let event: { type?: string; event?: { delta?: { type?: string; text?: string } } };
    try {
      event = JSON.parse(line) as typeof event;
    } catch {
      return;
    }
    const delta = event.event?.delta;
    if (event.type === "stream_event" && delta?.type === "text_delta" && typeof delta.text === "string") {
      pending.firstToken ??= Date.now();
      pending.text += delta.text;
      return;
    }
    if (event.type !== "result") return;
    this.pending = null;
    const text = pending.text.replace(/\s+/g, " ").trim();
    const totalMs = Date.now() - pending.started;
    const firstTokenMs = pending.firstToken === null ? null : pending.firstToken - pending.started;
    if (text === "" || text.length > MAX_REPLY_CHARS || /[<>`{}|#*]/.test(text)) {
      pending.resolve({ ok: false, code: "failed", message: `off-script reply dropped: ${text.slice(0, 80)}` });
      return;
    }
    pending.resolve({ ok: true, text, firstTokenMs, totalMs });
  }
}
