// bb-plugin-usage-meter — token usage read from the local Claude Code transcripts.
//
// The module reads ~/.claude/projects/**/*.jsonl, reduces them to a list of
// unique API calls and answers with aggregates over any window. Only counters
// and names ever leave it: message bodies do not, in any shape — of a body it
// takes the length and the number of blocks, nothing more.
//
// Three things the module exists for.
//
// 1. DUPLICATES. One API answer is written to the transcript as several lines —
//    one per content block (thinking / text / tool_use) — and every one of them
//    carries a FULL copy of message.usage. A naive sum overstates usage by 2.2x.
//    Deduplication goes by message.id and has to be global: a fork or a resume
//    copies the history, so one and the same message.id turns up in several
//    files. The first occurrence wins, over files sorted by the time of their
//    first line; content blocks within one file are merged, or tool_use is lost.
// 2. THE COST OF A PASS. The transcripts are gigabytes, and parsing all of them
//    takes seconds. So parsed calls live in a cache next to the plugin's own
//    data, and the next pass reads only the tails of the files that changed.
// 3. ATTRIBUTION. Usage is worth looking at in slices, not as one heap: main
//    session against subagents, project, bb thread, model, workflow run,
//    background /go run, skill.
import { execFile } from "node:child_process";
import fs from "node:fs";
import fsp from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { setImmediate as yieldToLoop } from "node:timers/promises";
import { promisify } from "node:util";

const execFileAsync = promisify(execFile);

// ───────────────────────────────── constants ─────────────────────────────────

/** Where Claude Code keeps its transcripts. */
export const DEFAULT_TRANSCRIPTS_DIR = path.join(os.homedir(), ".claude", "projects");
/** Where the /go skill keeps the metadata of its background runs. */
export const DEFAULT_GO_RUNS_DIR = path.join(os.homedir(), ".claude", "go-runs");
/** The bb database. Opened read-only: it is the live database of the server. */
export const DEFAULT_BB_DB_PATH = path.join(os.homedir(), ".bb", "bb.db");

/** Cache format version. Change it and the cache is rebuilt from scratch. */
const CACHE_VERSION = 2;
/**
 * Read chunk size. Smaller is not an option: single transcript lines weigh
 * megabytes, and one-megabyte chunks make the whole pass three times slower.
 */
const CHUNK_BYTES = 4 << 20;
/** Chunks between two yields back to the server's event loop. */
const YIELD_EVERY_CHUNKS = 1;
/** How long a session counts as active after a call — for the parallel count. */
const SESSION_ACTIVE_MS = 5 * 60_000;
/** Two markers of one skill closer than this are the same run, not two. */
const SKILL_DEDUP_MS = 120_000;
/** How long the in-memory snapshot of the bb.db tables is reused. */
const BB_DB_TTL_MS = 60_000;
/** A day, in milliseconds. */
const DAY_MS = 86_400_000;
/** An hour, in milliseconds. */
const HOUR_MS = 3_600_000;

// The insight numbers below reproduce the "What's contributing to your limits
// usage?" summary of the Claude Code extension for VS Code, constant for
// constant, so a bb user sees the same figures as the extension does. Every
// percentage there is a share of WEIGHTED COST, never of raw tokens: a cached
// read counts 1, uncached input 10, a cache write 12.5, an output token 50, and
// the whole call is multiplied by the model tier. Counting raw tokens instead
// would drown everything in cache reads, which are 97% of the volume.

/** Weight of one cache-read token. */
const COST_CACHE_READ = 1;
/** Weight of one uncached input token. */
const COST_INPUT = 10;
/** Weight of one cache-write token. */
const COST_CACHE_CREATION = 12.5;
/** Weight of one output token. */
const COST_OUTPUT = 50;
/** Model tier for anything that is neither Fable, Opus nor Haiku — and for a call with no model. */
const TIER_DEFAULT = 3;
/** Uncached input above this makes the call a cache miss. */
const CACHE_MISS_INPUT = 100_000;
/** Input context (cache read + cache write + uncached) above this is long context. */
const LONG_CONTEXT_INPUT = 150_000;
/** Sidechain calls that make a session subagent-heavy on their own. */
const SUBAGENT_MIN_CALLS = 3;
/** ...or this share of the session's weighted cost, compared strictly. */
const SUBAGENT_MIN_SHARE = 0.5;
/** Width of the bucket parallel sessions are counted in. */
const PARALLEL_BUCKET_MS = 300_000;
/** Distinct sessions in one bucket that count as running in parallel. */
const PARALLEL_MIN_SESSIONS = 4;
/** Distinct UTC hours that make a session look like a background loop. */
const CRON_MIN_HOURS = 8;
/** Below this share of the window a behaviour gets no sentence at all. */
export const MIN_BEHAVIOR_PCT = 10;
/** Window width up to which the timeline is drawn hour by hour. */
const TIMELINE_HOURLY_LIMIT_MS = 26 * HOUR_MS;
/** Timeline step for anything wider. */
const TIMELINE_WIDE_STEP_MS = 6 * HOUR_MS;
/** Hard cap on timeline points: the chart is an SVG, not a spreadsheet. */
const TIMELINE_MAX_POINTS = 240;

/**
 * The built-in slash commands of Claude Code. They are not skills, and have no
 * business showing up in a breakdown by skill.
 */
const BUILTIN_COMMANDS = new Set([
  "/add-dir", "/agents", "/bug", "/clear", "/compact", "/config", "/context",
  "/cost", "/doctor", "/exit", "/export", "/extra-usage", "/feedback", "/help",
  "/hooks", "/ide", "/init", "/install-github-app", "/login", "/logout",
  "/mcp", "/memory", "/model", "/output-style", "/permissions",
  "/privacy-settings", "/release-notes", "/resume", "/review", "/rewind",
  "/sandbox", "/status", "/statusline", "/terminal-setup", "/theme", "/todos",
  "/upgrade", "/usage", "/vim",
]);

// ─────────────────────────────────── types ───────────────────────────────────

/** Where a call came from: the main session, a subagent, a workflow agent. */
export type CallKind = "main" | "subagent" | "workflow";

/** The sum over a group of calls. No text, only numbers. */
export interface UsageTotals {
  calls: number;
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  thinking: number;
  ephemeral5m: number;
  ephemeral1h: number;
  toolCalls: number;
  /** input + output + cacheCreation + cacheRead. */
  total: number;
}

/** One row of a breakdown: a name, the counters, and a share of the window. */
export interface UsageBucket {
  key: string;
  label: string;
  totals: UsageTotals;
  /** Share of the window's total tokens, 0..1. */
  share: number;
}

/** A workflow run: the usage measured here plus what the engine itself wrote. */
export interface WorkflowBucket extends UsageBucket {
  runId: string;
  workflowName: string | null;
  status: string | null;
  agentCount: number | null;
  toolCallsReported: number | null;
  /** totalTokens from the run's metadata — the engine counts it its own way. */
  tokensReported: number | null;
  durationMs: number | null;
  startedAt: string | null;
  sessionId: string;
}

/** A background /go run, as ~/.claude/go-runs/<name>/meta.env describes it. */
export interface GoRunBucket extends UsageBucket {
  name: string;
  sessionId: string;
  parentSessionId: string | null;
  dir: string | null;
  model: string | null;
  effort: string | null;
  mode: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
}

/** A skill: its runs, the weight of the injected SKILL.md, and its usage. */
export interface SkillBucket {
  skill: string;
  /** Runs in the window: the Skill tool, a slash command, a SKILL.md injection. */
  invocations: number;
  /** How many times the body of SKILL.md was poured into the context. */
  injections: number;
  /** Total weight of the injected SKILL.md bodies, in bytes. */
  injectedBytes: number;
  /** Usage estimated by the window-boundary rule (see SkillWindowBoundary). */
  attributed: UsageTotals;
  attributedShare: number;
  /** Usage by the transcript's own attributionSkill field — this is what is shown. */
  reported: UsageTotals;
  reportedShare: number;
}

/** The traits of one session the summary needs. */
export interface SessionBucket extends UsageBucket {
  sessionId: string;
  projectDir: string;
  /** The session's most frequent working directory. */
  cwd: string;
  threadId: string | null;
  threadTitle: string | null;
  firstCallAt: string;
  lastCallAt: string;
  durationMs: number;
  /** Share of the usage that went to subagents and workflow agents, 0..1. */
  subagentShare: number;
  subagentCalls: number;
  /** Input context per call = cacheRead + cacheCreation + input. */
  contextMedian: number;
  contextP90: number;
  contextMax: number;
  /** Sessions running alongside this one — the mean and the peak over its calls. */
  concurrencyAvg: number;
  concurrencyPeak: number;
}

/** Scanner state: what the plugin draws its “reading, N% done” from. */
export interface ScanStatus {
  phase: "idle" | "scanning" | "error";
  /** true until the first full pass has finished. */
  cold: boolean;
  percent: number;
  filesTotal: number;
  filesDone: number;
  bytesTotal: number;
  bytesDone: number;
  /** Unique calls in the cache. */
  calls: number;
  files: number;
  startedAt: string | null;
  finishedAt: string | null;
  durationMs: number | null;
  error: string | null;
}

/** A request for aggregates. */
export interface UsageQuery {
  /** Window start: an ISO string or epoch ms. Defaults to a day ago. */
  from?: string | number | Date;
  /** Window end. Defaults to now. */
  to?: string | number | Date;
  /** Rows kept in each breakdown. Defaults to 20; 0 keeps all of them. */
  topN?: number;
  /** Boundary rule for a skill's usage window. Defaults to untilNextHumanPrompt. */
  skillWindow?: SkillWindowBoundary;
  /** Do not go to bb.db for thread names. */
  skipThreads?: boolean;
  /** Timeline bucket width; by default an hour for a day, six hours for a week. */
  timelineStepMs?: number;
}

/**
 * How many rows each breakdown had before `topN` cut it down. Without these the
 * page cannot tell a table that happens to hold twelve rows from one that was
 * trimmed to twelve, and the shares under it would read as the whole picture
 * while a thirteenth project quietly carried two per cent of the week.
 */
export interface BucketCounts {
  kind: number;
  model: number;
  effort: number;
  entrypoint: number;
  serviceTier: number;
  project: number;
  workingDir: number;
  thread: number;
  agent: number;
  workflow: number;
  goRun: number;
  skill: number;
  session: number;
}

/** The key of the bucket holding the sessions no bb thread was found for. */
export const UNRESOLVED_THREAD_KEY = "unresolved";

/** The summary of one window — everything that goes out over RPC. */
export interface UsageSummary {
  window: { from: string; to: string; days: number };
  generatedAt: string;
  scan: ScanStatus;
  totals: UsageTotals;
  /** The Claude Code insight figures for the same window. */
  insights: UsageInsights;
  /** Usage over the window, bucketed for the chart. */
  timeline: UsageTimeline;
  byKind: UsageBucket[];
  byModel: UsageBucket[];
  byEffort: UsageBucket[];
  byEntrypoint: UsageBucket[];
  byServiceTier: UsageBucket[];
  byProject: UsageBucket[];
  byWorkingDir: UsageBucket[];
  byThread: UsageBucket[];
  byAgent: UsageBucket[];
  byWorkflow: WorkflowBucket[];
  byGoRun: GoRunBucket[];
  bySkill: SkillBucket[];
  sessions: {
    count: number;
    /** Peak number of sessions running at once during the window. */
    concurrencyPeak: number;
    subagentShare: number;
    contextMedian: number;
    contextP90: number;
    contextMax: number;
    top: SessionBucket[];
  };
  /** How much of the usage could not be tied to a bb thread. */
  unresolvedThreadShare: number;
  /** Rows every breakdown above had before `topN` trimmed it. */
  bucketCounts: BucketCounts;
}

/** One of the five behaviours the Claude Code summary can name. */
export type BehaviorKey =
  | "cache_miss"
  | "long_context"
  | "subagent_heavy"
  | "high_parallel"
  | "cron";

/** A behaviour with its share of the window's weighted cost. */
export interface BehaviorInsight {
  key: BehaviorKey;
  /** Share of the weighted cost, rounded to whole percent — this is what is shown. */
  pct: number;
  /** The same share unrounded: the 10% gate is compared against this one. */
  rawPct: number;
  /** Requests for cache_miss / long_context / high_parallel, sessions for the other two. */
  count: number;
  /** Weighted cost behind the share. */
  cost: number;
}

/** One row of an attribution table: a skill, subagent, plugin or MCP server. */
export interface AttributionRow {
  name: string;
  /** Share of the window's weighted cost, rounded; rows that round to 0 are dropped. */
  pct: number;
  cost: number;
}

/** The insight half of the summary: weighted cost, behaviours, attribution. */
export interface UsageInsights {
  /** Weighted cost of every deduplicated call in the window — the denominator of every pct. */
  totalCost: number;
  requestCount: number;
  sessionCount: number;
  /** All five behaviours, sorted by cost; the gate below is the caller's to apply. */
  behaviors: BehaviorInsight[];
  /** Share a behaviour needs before it is worth a sentence — travels with the data so the page cannot drift from it. */
  minBehaviorPct: number;
  agents: AttributionRow[];
  skills: AttributionRow[];
  plugins: AttributionRow[];
  mcpServers: AttributionRow[];
}

/** One bar of the timeline. */
export interface TimelinePoint {
  /** Bucket start, epoch ms. */
  ts: number;
  /**
   * How much of the bucket lies inside the window, in milliseconds. Equal to
   * stepMs for every bar but the first and the last: the grid is aligned to the
   * local clock, so the outer two bars are cut by the window's own edges. They
   * are drawn narrower rather than dropped — dropping them would make the sum of
   * the bars smaller than the total above the chart.
   */
  spanMs: number;
  /** Tokens: input + output + cache write + cache read. */
  total: number;
  /** Weighted cost, same unit as the insights. */
  cost: number;
  calls: number;
  /** Tokens split by where the call came from. */
  main: number;
  subagent: number;
  workflow: number;
}

/** Usage over the window, bucketed for the chart. */
export interface UsageTimeline {
  stepMs: number;
  points: TimelinePoint[];
}

/** The moment a skill started inside a session. */
export interface SkillInvocation {
  skill: string;
  ts: number;
  sessionId: string;
  /** What gave it away: the Skill tool, a slash command, a SKILL.md injection. */
  source: "tool" | "command" | "inject";
}

/** What the boundary rule gets to know about the session. */
export interface SkillWindowContext {
  sessionId: string;
  /** Time of the session's last call inside the requested window. */
  sessionEnd: number;
  /** The nearest real human prompt after ts, or null. */
  nextHumanPrompt(ts: number): number | null;
  /** The nearest run of any skill after ts, or null. */
  nextInvocation(ts: number): number | null;
}

/**
 * The boundary rule of a skill's usage window: it answers with the time (epoch
 * ms) at which usage stops counting towards the skill. One function is all it
 * takes to swap it — this is where the formula lifted from the Claude Code
 * extension for VS Code will go.
 */
export type SkillWindowBoundary = (
  invocation: SkillInvocation,
  context: SkillWindowContext,
) => number;

/** The boundary rules that come ready-made. */
export const skillWindowBoundaries = {
  /** The provisional one: until the next real human prompt. */
  untilNextHumanPrompt: ((invocation, context) =>
    context.nextHumanPrompt(invocation.ts) ?? context.sessionEnd + 1) as SkillWindowBoundary,
  /** Stricter: until a human prompt, or until the next skill run. */
  untilNextInvocationOrPrompt: ((invocation, context) => {
    const prompt = context.nextHumanPrompt(invocation.ts);
    const next = context.nextInvocation(invocation.ts);
    const ends = [prompt, next].filter((value): value is number => value !== null);
    return ends.length ? Math.min(...ends) : context.sessionEnd + 1;
  }) as SkillWindowBoundary,
  /** A fixed window — in case the formula turns out to be a plain timeout. */
  fixedMinutes:
    (minutes: number): SkillWindowBoundary =>
    (invocation) =>
      invocation.ts + minutes * 60_000,
};

/** Scanner options. */
export interface UsageScanOptions {
  transcriptsDir?: string;
  goRunsDir?: string;
  /** Cache directory. Without one the module still works, but every pass is cold. */
  cacheDir?: string | null;
  /** Path to bb.db; null means do not go to the database at all. */
  bbDbPath?: string | null;
  log?: (level: "debug" | "info" | "warn", message: string) => void;
  /** A stand-in clock, for tests. */
  now?: () => number;
}

/** What the module hands out. */
export interface UsageScanner {
  /** The state of the current pass. */
  status(): ScanStatus;
  /** Catch up with the transcripts. A second call during a pass waits for that pass. */
  scan(options?: { signal?: AbortSignal; full?: boolean }): Promise<ScanStatus>;
  /** The endless loop for bb.background.service. */
  runForever(signal: AbortSignal, intervalMs?: number): Promise<void>;
  /** Aggregates over a window. Answers mid-cold-pass too, from what has been read. */
  summary(query?: UsageQuery): UsageSummary;
  /** Let go of the resources (the bb.db snapshot). */
  close(): void;
}

// ────────────────────────── internal representation ──────────────────────────

interface FileRecord {
  id: number;
  rel: string;
  size: number;
  mtimeMs: number;
  /** Bytes parsed; always sits on a line boundary. */
  offset: number;
  /** Time of the first line — the key files are ordered by for deduplication. */
  firstTs: number;
  kind: CallKind;
  projectDir: string;
  sessionId: string;
  agentId: string | null;
  workflowRunId: string | null;
}

interface CallEvent {
  id: string;
  ts: number;
  fileId: number;
  cwd: string;
  model: string;
  effort: string | null;
  entrypoint: string | null;
  serviceTier: string | null;
  attributionAgent: string | null;
  attributionSkill: string | null;
  attributionPlugin: string | null;
  attributionMcpServer: string | null;
  input: number;
  output: number;
  cacheCreation: number;
  cacheRead: number;
  thinking: number;
  ephemeral5m: number;
  ephemeral1h: number;
  toolCalls: number;
  /** Skills the Skill tool started in this call. */
  skills: string[];
}

type MarkKind = "prompt" | "inject";

interface Mark {
  ts: number;
  fileId: number;
  kind: MarkKind;
  /** For a prompt — the slash command or an empty string; for an inject — the skill. */
  name: string;
  /** For an inject — the weight of the SKILL.md body, in bytes. */
  bytes: number;
}

// ─────────────────────────────── small helpers ───────────────────────────────

type JsonObject = Record<string, unknown>;

function asObject(value: unknown): JsonObject | null {
  return typeof value === "object" && value !== null && !Array.isArray(value)
    ? (value as JsonObject)
    : null;
}

function asString(value: unknown): string | null {
  return typeof value === "string" ? value : null;
}

function asNumber(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function asArray(value: unknown): unknown[] {
  return Array.isArray(value) ? value : [];
}

/** A string pool: forty thousand calls share the same models, cwds and entrypoints. */
class Interner {
  private readonly pool = new Map<string, string>();

  intern(value: string): string {
    const found = this.pool.get(value);
    if (found !== undefined) return found;
    this.pool.set(value, value);
    return value;
  }
}

function emptyTotals(): UsageTotals {
  return {
    calls: 0,
    input: 0,
    output: 0,
    cacheCreation: 0,
    cacheRead: 0,
    thinking: 0,
    ephemeral5m: 0,
    ephemeral1h: 0,
    toolCalls: 0,
    total: 0,
  };
}

function addCall(totals: UsageTotals, event: CallEvent): void {
  totals.calls += 1;
  totals.input += event.input;
  totals.output += event.output;
  totals.cacheCreation += event.cacheCreation;
  totals.cacheRead += event.cacheRead;
  totals.thinking += event.thinking;
  totals.ephemeral5m += event.ephemeral5m;
  totals.ephemeral1h += event.ephemeral1h;
  totals.toolCalls += event.toolCalls;
  totals.total += event.input + event.output + event.cacheCreation + event.cacheRead;
}

function toMillis(value: string | number | Date | undefined, fallback: number): number {
  if (value === undefined) return fallback;
  if (value instanceof Date) return value.getTime();
  if (typeof value === "number") return value;
  const parsed = Date.parse(value);
  return Number.isNaN(parsed) ? fallback : parsed;
}

function percentile(sorted: number[], q: number): number {
  if (!sorted.length) return 0;
  const index = Math.min(sorted.length - 1, Math.max(0, Math.ceil(q * sorted.length) - 1));
  return sorted[index];
}

/**
 * The trimming rule of one summary: the denominator every share is taken of,
 * the row limit, and the record of how long each list was before the limit.
 */
interface Cut {
  total: number;
  topN: number;
  counts: BucketCounts;
}

function emptyCounts(): BucketCounts {
  return {
    kind: 0,
    model: 0,
    effort: 0,
    entrypoint: 0,
    serviceTier: 0,
    project: 0,
    workingDir: 0,
    thread: 0,
    agent: 0,
    workflow: 0,
    goRun: 0,
    skill: 0,
    session: 0,
  };
}

/**
 * Sort by usage, work out each share of the total, cut the tail off — and write
 * down how many rows there were before the cut, so the page can own up to it.
 */
function take<T extends { totals: UsageTotals; share: number }>(
  rows: T[],
  cut: Cut,
  slot: keyof BucketCounts,
): T[] {
  cut.counts[slot] = rows.length;
  rows.sort((a, b) => b.totals.total - a.totals.total || b.totals.calls - a.totals.calls);
  const trimmed = cut.topN > 0 ? rows.slice(0, cut.topN) : rows;
  for (const row of trimmed) row.share = cut.total > 0 ? row.totals.total / cut.total : 0;
  return trimmed;
}

// ──────────────────────────────── file paths ─────────────────────────────────

interface PathInfo {
  kind: CallKind;
  projectDir: string;
  /** The root session: the file name of the main session this file belongs to. */
  sessionId: string;
  agentId: string | null;
  workflowRunId: string | null;
}

/**
 * How the paths are laid out:
 *   <project>/<session>.jsonl                                    — main session
 *   <project>/<session>/subagents/agent-<hex>.jsonl              — subagent
 *   <project>/<session>/subagents/workflows/wf_<id>/agent-*.jsonl — workflow agent
 *   <project>/<session>/subagents/workflows/wf_<id>/journal.jsonl — journal, no calls
 */
function classifyPath(rel: string): PathInfo | null {
  const parts = rel.split(path.sep);
  if (parts.length < 2) return null;
  const base = parts[parts.length - 1];
  if (!base.endsWith(".jsonl")) return null;
  if (base === "journal.jsonl") return null;
  const projectDir = parts[0];
  const rest = parts.slice(1);
  if (rest.length === 1) {
    return {
      kind: "main",
      projectDir,
      sessionId: base.slice(0, -".jsonl".length),
      agentId: null,
      workflowRunId: null,
    };
  }
  if (rest.length >= 3 && rest[1] === "subagents") {
    const sessionId = rest[0];
    const agentId = base.slice(0, -".jsonl".length);
    if (rest.length >= 5 && rest[2] === "workflows") {
      return { kind: "workflow", projectDir, sessionId, agentId, workflowRunId: rest[3] };
    }
    if (rest.length === 3) {
      return { kind: "subagent", projectDir, sessionId, agentId, workflowRunId: null };
    }
  }
  return null;
}

// ─────────────────────────────── reading files ───────────────────────────────

/**
 * Reads a file line by line from a byte offset. Answers with the offset that
 * ends the last WHOLE line: a half-written tail is left for the next pass.
 * Control goes back to the event loop between chunks — the server must not
 * freeze.
 */
async function readLinesFrom(
  file: string,
  startOffset: number,
  onLine: (line: string) => void,
  onProgress: ((bytes: number) => void) | null,
  signal: AbortSignal | undefined,
): Promise<number> {
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(file, "r");
  } catch {
    return startOffset;
  }
  let position = startOffset;
  let consumed = startOffset;
  // A tail with no newline in it piles up chunk by chunk and is joined once: a
  // line ten megabytes long would cost quadratic time if joined every chunk.
  let carry: Buffer[] = [];
  let carryLength = 0;
  let chunks = 0;
  try {
    const size = (await handle.stat()).size;
    while (position < size) {
      if (signal?.aborted) break;
      const want = Math.min(CHUNK_BYTES, size - position);
      const buffer = Buffer.allocUnsafe(want);
      const { bytesRead } = await handle.read(buffer, 0, want, position);
      if (bytesRead <= 0) break;
      position += bytesRead;
      const fresh = buffer.subarray(0, bytesRead);
      onProgress?.(bytesRead);
      if (fresh.lastIndexOf(10) < 0) {
        carry.push(fresh);
        carryLength += bytesRead;
        continue;
      }
      const data = carryLength
        ? Buffer.concat([...carry, fresh], carryLength + bytesRead)
        : fresh;
      carry = [];
      carryLength = 0;
      // Cut strictly at the last newline: it is a single byte and cannot sit
      // inside a multi-byte character, so everything before it is always whole
      // UTF-8 and decodes in one go. Splitting into lines after that is done
      // with string slices, without allocating a buffer per line.
      const lastNewline = data.lastIndexOf(10);
      const text = data.toString("utf8", 0, lastNewline);
      let start = 0;
      for (;;) {
        const newline = text.indexOf("\n", start);
        let end = newline < 0 ? text.length : newline;
        if (end > start && text.charCodeAt(end - 1) === 13) end -= 1;
        if (end > start) onLine(text.slice(start, end));
        if (newline < 0) break;
        start = newline + 1;
      }
      consumed = position - (data.length - (lastNewline + 1));
      if (lastNewline + 1 < data.length) {
        carry.push(Buffer.from(data.subarray(lastNewline + 1)));
        carryLength = data.length - lastNewline - 1;
      }
      chunks += 1;
      // Hand control back to the event loop: a cold pass has no business
      // locking the server up for tens of seconds.
      if (chunks % YIELD_EVERY_CHUNKS === 0) await yieldToLoop();
    }
  } catch {
    /* the file vanished or broke mid-read — answer with what was read */
  } finally {
    await handle.close();
  }
  return consumed;
}

/** The time of a file's first line — the sort key of the global deduplication. */
async function readFirstTimestamp(file: string): Promise<number> {
  let handle: fsp.FileHandle;
  try {
    handle = await fsp.open(file, "r");
  } catch {
    return 0;
  }
  try {
    const buffer = Buffer.allocUnsafe(1 << 16);
    const { bytesRead } = await handle.read(buffer, 0, buffer.length, 0);
    if (bytesRead <= 0) return 0;
    const text = buffer.toString("utf8", 0, bytesRead);
    // The very first line sometimes carries no time — take the first that does.
    for (const line of text.split("\n")) {
      const match = /"timestamp"\s*:\s*"([^"]+)"/.exec(line);
      if (!match) continue;
      const parsed = Date.parse(match[1]);
      if (!Number.isNaN(parsed)) return parsed;
    }
    return 0;
  } catch {
    return 0;
  } finally {
    await handle.close();
  }
}

/** Walks the transcripts directory. */
async function listTranscripts(root: string): Promise<Map<string, fs.Stats>> {
  const out = new Map<string, fs.Stats>();
  async function walk(dir: string): Promise<void> {
    let entries: fs.Dirent[];
    try {
      entries = await fsp.readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = path.join(dir, entry.name);
      if (entry.isDirectory()) {
        await walk(full);
        continue;
      }
      if (!entry.isFile() || !entry.name.endsWith(".jsonl")) continue;
      const rel = path.relative(root, full);
      if (!classifyPath(rel)) continue;
      try {
        out.set(rel, await fsp.stat(full));
      } catch {
        /* the file vanished between readdir and stat — no great loss */
      }
    }
  }
  await walk(root);
  return out;
}

// ───────────────────────────── reading metadata ──────────────────────────────

interface WorkflowMeta {
  runId: string;
  sessionId: string;
  projectDir: string;
  workflowName: string | null;
  status: string | null;
  agentCount: number | null;
  toolCallsReported: number | null;
  tokensReported: number | null;
  durationMs: number | null;
  startedAt: string | null;
}

/**
 * The metadata of a workflow run. The same file also holds the full text of the
 * script with its prompts — that is neither read nor handed out.
 */
async function readWorkflowMeta(
  transcriptsDir: string,
  projectDir: string,
  sessionId: string,
  runId: string,
): Promise<WorkflowMeta | null> {
  const file = path.join(transcriptsDir, projectDir, sessionId, "workflows", `${runId}.json`);
  let raw: string;
  try {
    raw = await fsp.readFile(file, "utf8");
  } catch {
    return null;
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch {
    return null;
  }
  const meta = asObject(parsed);
  if (!meta) return null;
  const start = asNumber(meta.startTime);
  return {
    runId,
    sessionId,
    projectDir,
    workflowName: asString(meta.workflowName),
    status: asString(meta.status),
    agentCount: typeof meta.agentCount === "number" ? meta.agentCount : null,
    toolCallsReported: typeof meta.totalToolCalls === "number" ? meta.totalToolCalls : null,
    tokensReported: typeof meta.totalTokens === "number" ? meta.totalTokens : null,
    durationMs: typeof meta.durationMs === "number" ? meta.durationMs : null,
    startedAt: start > 0 ? new Date(start).toISOString() : asString(meta.timestamp),
  };
}

interface GoRunMeta {
  name: string;
  sessionId: string;
  parentSessionId: string | null;
  dir: string | null;
  model: string | null;
  effort: string | null;
  mode: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  exitCode: number | null;
}

/** Background /go runs: an exact mapping from a session to its run. */
async function readGoRuns(dir: string): Promise<Map<string, GoRunMeta>> {
  const out = new Map<string, GoRunMeta>();
  let entries: fs.Dirent[];
  try {
    entries = await fsp.readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    let raw: string;
    try {
      raw = await fsp.readFile(path.join(dir, entry.name, "meta.env"), "utf8");
    } catch {
      continue;
    }
    const values = new Map<string, string>();
    for (const line of raw.split("\n")) {
      const eq = line.indexOf("=");
      if (eq <= 0) continue;
      values.set(line.slice(0, eq).trim(), line.slice(eq + 1).trim());
    }
    const sessionId = values.get("session_id");
    if (!sessionId) continue;
    const started = Number(values.get("started"));
    const finished = Number(values.get("finished"));
    const exit = values.get("exit_code");
    out.set(sessionId, {
      name: values.get("name") ?? entry.name,
      sessionId,
      parentSessionId: values.get("parent_session") ?? null,
      dir: values.get("dir") ?? null,
      model: values.get("model") ?? null,
      effort: values.get("effort") ?? null,
      mode: values.get("mode") ?? null,
      startedAt: Number.isFinite(started) && started > 0 ? new Date(started * 1000).toISOString() : null,
      finishedAt: Number.isFinite(finished) && finished > 0 ? new Date(finished * 1000).toISOString() : null,
      exitCode: exit !== undefined && exit !== "" && Number.isFinite(Number(exit)) ? Number(exit) : null,
    });
  }
  return out;
}

// ─────────────────────────────── reading bb.db ───────────────────────────────

interface ThreadRow {
  id: string;
  title: string;
  projectId: string;
  environmentId: string | null;
}

interface BbDbSnapshot {
  /** Claude Code sessionId → bb thread id, via events.provider_thread_id. */
  bySession: Map<string, string>;
  /** environment_id → thread id, only where the environment has a single thread. */
  byEnvironment: Map<string, string>;
  threads: Map<string, ThreadRow>;
}

interface SqliteLikeStatement {
  all(...params: unknown[]): unknown[];
}
interface SqliteLikeDatabase {
  prepare(sql: string): SqliteLikeStatement;
  close(): void;
}
interface NodeSqliteModule {
  DatabaseSync: new (path: string, options?: { readOnly?: boolean }) => SqliteLikeDatabase;
}

const THREADS_SQL =
  "select id, coalesce(title, title_fallback, '') as title, project_id, environment_id from threads where deleted_at is null";
const EVENTS_SQL =
  "select distinct provider_thread_id, thread_id from events where provider_thread_id is not null";

/**
 * The bb.db reader. The database is live, so it is opened read-only and nothing
 * else. The built-in node:sqlite is tried first, then an external
 * `sqlite3 -readonly`; with neither of them a thread simply stays unnamed.
 */
class BbDbReader {
  private snapshot: BbDbSnapshot | null = null;
  private loadedAt = 0;
  private failed = false;

  private readonly dbPath: string | null;
  private readonly log: (level: "debug" | "info" | "warn", message: string) => void;

  constructor(
    dbPath: string | null,
    log: (level: "debug" | "info" | "warn", message: string) => void,
  ) {
    this.dbPath = dbPath;
    this.log = log;
  }

  /** A snapshot of the tables; on any trouble it answers empty and stops trying. */
  async load(now: number): Promise<BbDbSnapshot> {
    const empty: BbDbSnapshot = {
      bySession: new Map(),
      byEnvironment: new Map(),
      threads: new Map(),
    };
    if (!this.dbPath || this.failed) return this.snapshot ?? empty;
    if (this.snapshot && now - this.loadedAt < BB_DB_TTL_MS) return this.snapshot;
    const rows = this.viaNodeSqlite() ?? (await this.viaCli());
    if (!rows) {
      this.failed = true;
      return this.snapshot ?? empty;
    }
    const threads = new Map<string, ThreadRow>();
    const perEnvironment = new Map<string, string[]>();
    for (const row of rows.threads) {
      threads.set(row.id, row);
      if (row.environmentId) {
        const list = perEnvironment.get(row.environmentId) ?? [];
        list.push(row.id);
        perEnvironment.set(row.environmentId, list);
      }
    }
    const byEnvironment = new Map<string, string>();
    for (const [environmentId, ids] of perEnvironment) {
      // Guessing between two threads of one environment would be dishonest.
      if (ids.length === 1) byEnvironment.set(environmentId, ids[0]);
    }
    this.snapshot = { bySession: rows.bySession, byEnvironment, threads };
    this.loadedAt = now;
    return this.snapshot;
  }

  close(): void {
    this.snapshot = null;
  }

  private viaNodeSqlite(): { threads: ThreadRow[]; bySession: Map<string, string> } | null {
    if (!this.dbPath) return null;
    // The built-in module is taken through process.getBuiltinModule rather
    // than an import: the plugin bundler leaves such a call alone, and on a
    // runtime without node:sqlite it honestly answers with nothing, so the
    // external sqlite3 gets its turn.
    const runtime = process as unknown as { getBuiltinModule?: (id: string) => unknown };
    if (typeof runtime.getBuiltinModule !== "function") return null;
    let database: SqliteLikeDatabase;
    try {
      const loaded = runtime.getBuiltinModule("node:sqlite") as NodeSqliteModule | undefined;
      if (!loaded || typeof loaded.DatabaseSync !== "function") return null;
      database = new loaded.DatabaseSync(this.dbPath, { readOnly: true });
    } catch (error) {
      this.log("debug", `node:sqlite unavailable: ${String(error)}`);
      return null;
    }
    try {
      const threads: ThreadRow[] = [];
      for (const raw of database.prepare(THREADS_SQL).all()) {
        const row = asObject(raw);
        if (!row) continue;
        const id = asString(row.id);
        if (!id) continue;
        threads.push({
          id,
          title: asString(row.title) ?? "",
          projectId: asString(row.project_id) ?? "",
          environmentId: asString(row.environment_id),
        });
      }
      const bySession = new Map<string, string>();
      for (const raw of database.prepare(EVENTS_SQL).all()) {
        const row = asObject(raw);
        if (!row) continue;
        const session = asString(row.provider_thread_id);
        const thread = asString(row.thread_id);
        if (session && thread) bySession.set(session, thread);
      }
      return { threads, bySession };
    } catch (error) {
      this.log("warn", `bb.db read failed: ${String(error)}`);
      return null;
    } finally {
      try {
        database.close();
      } catch {
        /* closing failed — we will live */
      }
    }
  }

  private async viaCli(): Promise<{ threads: ThreadRow[]; bySession: Map<string, string> } | null> {
    if (!this.dbPath) return null;
    try {
      const query = async (sql: string): Promise<unknown[]> => {
        const { stdout } = await execFileAsync(
          "sqlite3",
          ["-readonly", "-json", this.dbPath as string, sql],
          { maxBuffer: 32 << 20 },
        );
        const text = stdout.trim();
        return text ? (JSON.parse(text) as unknown[]) : [];
      };
      const threads: ThreadRow[] = [];
      for (const raw of await query(THREADS_SQL)) {
        const row = asObject(raw);
        if (!row) continue;
        const id = asString(row.id);
        if (!id) continue;
        threads.push({
          id,
          title: asString(row.title) ?? "",
          projectId: asString(row.project_id) ?? "",
          environmentId: asString(row.environment_id),
        });
      }
      const bySession = new Map<string, string>();
      for (const raw of await query(EVENTS_SQL)) {
        const row = asObject(raw);
        if (!row) continue;
        const session = asString(row.provider_thread_id);
        const thread = asString(row.thread_id);
        if (session && thread) bySession.set(session, thread);
      }
      return { threads, bySession };
    } catch (error) {
      this.log("debug", `sqlite3 cli unavailable: ${String(error)}`);
      return null;
    }
  }
}

/** A transcripts directory name → the environment_id of a bb environment. */
function environmentIdFromProjectDir(projectDir: string): string | null {
  const match = /-bb-personal-workspaces-(env-[0-9a-z]+)$/.exec(projectDir);
  if (!match) return null;
  return match[1].replace(/^env-/, "env_");
}

// ───────────────────────────────── the store ─────────────────────────────────

/**
 * The parsed calls and the file cursors. The cache is three files next to the
 * plugin's data: state.json (the cursors), events.jsonl and marks.jsonl (one
 * line per record, positional arrays — twice as compact as objects).
 */
class UsageStore {
  readonly files = new Map<string, FileRecord>();
  readonly filesById = new Map<number, FileRecord>();
  readonly events = new Map<string, CallEvent>();
  marks: Mark[] = [];
  /** message.ids seen in more than one file — the traces of forks and resumes. */
  readonly sharedIds = new Set<string>();
  private nextFileId = 1;
  private readonly interner = new Interner();
  private sorted: CallEvent[] | null = null;

  intern(value: string): string {
    return this.interner.intern(value);
  }

  /** Reserve the ids of files raised from the cache so new ones do not clash. */
  reserveFileIds(maxId: number): void {
    this.nextFileId = Math.max(this.nextFileId, maxId + 1);
  }

  /** Forget everything parsed, keeping the file list: a rebuild is due. */
  resetParsed(): void {
    this.events.clear();
    this.marks = [];
    this.sharedIds.clear();
    for (const file of this.files.values()) file.offset = 0;
    this.sorted = null;
  }

  fileFor(rel: string, info: PathInfo): FileRecord {
    const found = this.files.get(rel);
    if (found) return found;
    const record: FileRecord = {
      id: this.nextFileId++,
      rel,
      size: 0,
      mtimeMs: 0,
      offset: 0,
      firstTs: 0,
      kind: info.kind,
      projectDir: this.intern(info.projectDir),
      sessionId: this.intern(info.sessionId),
      agentId: info.agentId,
      workflowRunId: info.workflowRunId ? this.intern(info.workflowRunId) : null,
    };
    this.files.set(rel, record);
    this.filesById.set(record.id, record);
    return record;
  }

  /** Throw a file away together with everything parsed out of it. */
  dropFile(record: FileRecord): void {
    for (const [id, event] of this.events) {
      if (event.fileId === record.id) this.events.delete(id);
    }
    this.marks = this.marks.filter((mark) => mark.fileId !== record.id);
    this.files.delete(record.rel);
    this.filesById.delete(record.id);
    this.sorted = null;
  }

  /** Whether the file holds calls that also live in other files. */
  hasSharedEvents(record: FileRecord): boolean {
    for (const event of this.events.values()) {
      if (event.fileId === record.id && this.sharedIds.has(event.id)) return true;
    }
    return false;
  }

  touch(): void {
    this.sorted = null;
  }

  /** The calls in time order — the base every window is cut from. */
  byTime(): CallEvent[] {
    if (!this.sorted) {
      this.sorted = [...this.events.values()].filter((event) => event.ts > 0);
      this.sorted.sort((a, b) => a.ts - b.ts);
    }
    return this.sorted;
  }
}

// ─────────────────────────────── serialisation ───────────────────────────────

function encodeEvent(event: CallEvent): string {
  return JSON.stringify([
    event.id,
    event.ts,
    event.fileId,
    event.cwd,
    event.model,
    event.effort,
    event.entrypoint,
    event.serviceTier,
    event.attributionAgent,
    event.attributionSkill,
    event.attributionPlugin,
    event.attributionMcpServer,
    event.input,
    event.output,
    event.cacheCreation,
    event.cacheRead,
    event.thinking,
    event.ephemeral5m,
    event.ephemeral1h,
    event.toolCalls,
    event.skills,
  ]);
}

function decodeEvent(line: string, store: UsageStore): CallEvent | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length < 21) return null;
  const id = asString(parsed[0]);
  const fileId = asNumber(parsed[2]);
  if (!id || !store.filesById.has(fileId)) return null;
  const text = (value: unknown): string | null => {
    const found = asString(value);
    return found === null ? null : store.intern(found);
  };
  return {
    id,
    ts: asNumber(parsed[1]),
    fileId,
    cwd: text(parsed[3]) ?? "",
    model: text(parsed[4]) ?? "unknown",
    effort: text(parsed[5]),
    entrypoint: text(parsed[6]),
    serviceTier: text(parsed[7]),
    attributionAgent: text(parsed[8]),
    attributionSkill: text(parsed[9]),
    attributionPlugin: text(parsed[10]),
    attributionMcpServer: text(parsed[11]),
    input: asNumber(parsed[12]),
    output: asNumber(parsed[13]),
    cacheCreation: asNumber(parsed[14]),
    cacheRead: asNumber(parsed[15]),
    thinking: asNumber(parsed[16]),
    ephemeral5m: asNumber(parsed[17]),
    ephemeral1h: asNumber(parsed[18]),
    toolCalls: asNumber(parsed[19]),
    skills: asArray(parsed[20])
      .map((value) => asString(value))
      .filter((value): value is string => value !== null)
      .map((value) => store.intern(value)),
  };
}

function encodeMark(mark: Mark): string {
  return JSON.stringify([mark.ts, mark.fileId, mark.kind, mark.name, mark.bytes]);
}

function decodeMark(line: string, store: UsageStore): Mark | null {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return null;
  }
  if (!Array.isArray(parsed) || parsed.length < 5) return null;
  const fileId = asNumber(parsed[1]);
  if (!store.filesById.has(fileId)) return null;
  const kind = asString(parsed[2]);
  if (kind !== "prompt" && kind !== "inject") return null;
  return {
    ts: asNumber(parsed[0]),
    fileId,
    kind,
    name: store.intern(asString(parsed[3]) ?? ""),
    bytes: asNumber(parsed[4]),
  };
}

// ─────────────────────────────── parsing lines ───────────────────────────────

/**
 * A quick key check without parsing the JSON: lines run to a megabyte, and one
 * extra pass over each of them costs seconds over the whole walk. The transcript
 * is written by JSON.stringify, which never puts a space after a colon.
 */
function hasKeyValue(line: string, key: string, value: string): boolean {
  return line.includes(`"${key}":"${value}"`);
}

interface ParseSink {
  file: FileRecord;
  store: UsageStore;
  onEvent: (event: CallEvent) => void;
  onMark: (mark: Mark) => void;
}

/**
 * Parses one transcript line. Broken lines are skipped silently: there are three
 * of them in 216 thousand, and one must not bring the whole pass down.
 */
function parseLine(line: string, sink: ParseSink): void {
  // Sifting before the JSON is parsed: what matters is model answers, human
  // prompts and SKILL.md injections. The checks are ordered so that the fattest
  // lines — tool results — are dropped by the very first hit.
  let interesting: boolean;
  if (line.includes('"usage":{')) {
    interesting = hasKeyValue(line, "type", "assistant");
  } else if (line.includes('"tool_result"')) {
    interesting = false;
  } else {
    interesting =
      hasKeyValue(line, "type", "user") ||
      (line.includes("invoked_skills") && hasKeyValue(line, "type", "attachment"));
  }
  if (!interesting) return;

  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    return;
  }
  const record = asObject(parsed);
  if (!record) return;
  const timestamp = asString(record.timestamp);
  const ts = timestamp ? Date.parse(timestamp) : Number.NaN;
  const time = Number.isNaN(ts) ? 0 : ts;

  if (record.type === "assistant") {
    parseAssistant(record, time, sink);
    return;
  }
  if (record.type === "attachment") {
    parseAttachment(record, time, sink);
    return;
  }
  if (record.type === "user") {
    parsePrompt(record, time, sink);
  }
}

function parseAssistant(record: JsonObject, time: number, sink: ParseSink): void {
  const message = asObject(record.message);
  if (!message) return;
  const usage = asObject(message.usage);
  if (!usage) return;
  const id = asString(message.id);
  if (!id) return;
  const model = asString(message.model) ?? "unknown";
  // Synthetic answers (aborts, local errors) cost no tokens.
  if (model === "<synthetic>") return;

  const { store, file } = sink;
  const existing = store.events.get(id);
  if (existing) {
    if (existing.fileId !== file.id) {
      // The same call in another file — the trace of a fork or a resume. The
      // first occurrence wins, and the fact is remembered: it is what stops
      // files from being thrown away one at a time.
      store.sharedIds.add(id);
      return;
    }
    // The group continues: every content block gets its own line with a full
    // copy of usage. The tokens are counted already; only the content is merged.
    mergeContent(existing, message, store);
    // Attribution can sit on a later content line of the same call: back-fill
    // whatever the first line did not carry.
    backfillAttribution(existing, record, store);
    return;
  }

  const creation = asObject(usage.cache_creation);
  const details = asObject(usage.output_tokens_details);
  const event: CallEvent = {
    id,
    ts: time,
    fileId: file.id,
    cwd: store.intern(asString(record.cwd) ?? ""),
    model: store.intern(model),
    effort: nullableInterned(record.effort, store),
    entrypoint: nullableInterned(record.entrypoint, store),
    serviceTier: nullableInterned(usage.service_tier, store),
    attributionAgent: nullableInterned(record.attributionAgent, store),
    attributionSkill: nullableInterned(record.attributionSkill, store),
    attributionPlugin: nullableInterned(record.attributionPlugin, store),
    attributionMcpServer: nullableInterned(record.attributionMcpServer, store),
    input: asNumber(usage.input_tokens),
    output: asNumber(usage.output_tokens),
    cacheCreation: asNumber(usage.cache_creation_input_tokens),
    cacheRead: asNumber(usage.cache_read_input_tokens),
    thinking: details ? asNumber(details.thinking_tokens) : 0,
    ephemeral5m: creation ? asNumber(creation.ephemeral_5m_input_tokens) : 0,
    ephemeral1h: creation ? asNumber(creation.ephemeral_1h_input_tokens) : 0,
    toolCalls: 0,
    skills: [],
  };
  mergeContent(event, message, store);
  sink.onEvent(event);
}

function nullableInterned(value: unknown, store: UsageStore): string | null {
  const text = asString(value);
  return text === null ? null : store.intern(text);
}

/** Copy attribution fields the first line of the call did not carry. */
function backfillAttribution(event: CallEvent, record: JsonObject, store: UsageStore): void {
  if (!event.attributionAgent) {
    event.attributionAgent = nullableInterned(record.attributionAgent, store);
  }
  if (!event.attributionSkill) {
    event.attributionSkill = nullableInterned(record.attributionSkill, store);
  }
  if (!event.attributionPlugin) {
    event.attributionPlugin = nullableInterned(record.attributionPlugin, store);
  }
  if (!event.attributionMcpServer) {
    event.attributionMcpServer = nullableInterned(record.attributionMcpServer, store);
  }
}

/** Merging the group's content blocks: counting tool uses and skill runs. */
function mergeContent(event: CallEvent, message: JsonObject, store: UsageStore): void {
  for (const raw of asArray(message.content)) {
    const block = asObject(raw);
    if (!block || block.type !== "tool_use") continue;
    event.toolCalls += 1;
    if (block.name !== "Skill") continue;
    const input = asObject(block.input);
    const skill = input ? asString(input.skill) : null;
    if (skill) event.skills.push(store.intern(skill));
  }
}

function parseAttachment(record: JsonObject, time: number, sink: ParseSink): void {
  const attachment = asObject(record.attachment);
  if (!attachment || attachment.type !== "invoked_skills") return;
  for (const raw of asArray(attachment.skills)) {
    const skill = asObject(raw);
    if (!skill) continue;
    const name = asString(skill.name);
    if (!name) continue;
    const content = asString(skill.content);
    sink.onMark({
      ts: time,
      fileId: sink.file.id,
      kind: "inject",
      name: sink.store.intern(name),
      // The weight of the SKILL.md body poured into the context. Not the body.
      bytes: content ? Buffer.byteLength(content, "utf8") : 0,
    });
  }
}

const COMMAND_NAME = /<command-name>([^<]+)<\/command-name>/;

/**
 * A real human prompt. Housekeeping injections (isMeta), tool results, task
 * notifications and subagent prompts are all sifted out: only a live human moves
 * the boundary of a skill's usage window.
 */
function parsePrompt(record: JsonObject, time: number, sink: ParseSink): void {
  if (record.isMeta === true) return;
  if (record.isSidechain === true) return;
  if (record.userType !== undefined && record.userType !== "external") return;
  const origin = asObject(record.origin);
  const originKind = origin ? asString(origin.kind) : null;
  if (originKind !== null && originKind !== "human") return;
  const message = asObject(record.message);
  if (!message) return;
  let text: string | null = null;
  const content = message.content;
  if (typeof content === "string") {
    text = content;
  } else {
    for (const raw of asArray(content)) {
      const block = asObject(raw);
      if (!block) continue;
      if (block.type === "tool_result") return;
      if (block.type === "text") {
        text = asString(block.text);
        break;
      }
    }
  }
  if (text === null) return;
  const head = text.slice(0, 400);
  // Lines written not by a human but by the agent itself or its environment.
  if (
    head.startsWith("<system-reminder>") ||
    head.startsWith("<local-command-stdout>") ||
    head.startsWith("<command-output>") ||
    head.startsWith("Caveat: The messages below")
  ) {
    return;
  }
  const command = COMMAND_NAME.exec(head);
  sink.onMark({
    ts: time,
    fileId: sink.file.id,
    kind: "prompt",
    name: command ? sink.store.intern(command[1].trim()) : "",
    bytes: 0,
  });
}

// ──────────────────────────── the scanner itself ─────────────────────────────

class Scanner implements UsageScanner {
  private readonly store = new UsageStore();
  private readonly bbDb: BbDbReader;
  private readonly log: (level: "debug" | "info" | "warn", message: string) => void;
  private readonly now: () => number;
  private readonly transcriptsDir: string;
  private readonly goRunsDir: string;
  private readonly cacheDir: string | null;

  private loaded = false;
  private running: Promise<ScanStatus> | null = null;
  private workflowCache = new Map<string, WorkflowMeta | null>();
  private goRuns = new Map<string, GoRunMeta>();
  private threads: BbDbSnapshot = {
    bySession: new Map(),
    byEnvironment: new Map(),
    threads: new Map(),
  };
  private state: ScanStatus = {
    phase: "idle",
    cold: true,
    percent: 0,
    filesTotal: 0,
    filesDone: 0,
    bytesTotal: 0,
    bytesDone: 0,
    calls: 0,
    files: 0,
    startedAt: null,
    finishedAt: null,
    durationMs: null,
    error: null,
  };

  constructor(options: UsageScanOptions) {
    this.transcriptsDir = options.transcriptsDir ?? DEFAULT_TRANSCRIPTS_DIR;
    this.goRunsDir = options.goRunsDir ?? DEFAULT_GO_RUNS_DIR;
    this.cacheDir = options.cacheDir === undefined ? null : options.cacheDir;
    this.log = options.log ?? (() => {});
    this.now = options.now ?? (() => Date.now());
    this.bbDb = new BbDbReader(
      options.bbDbPath === undefined ? DEFAULT_BB_DB_PATH : options.bbDbPath,
      this.log,
    );
  }

  status(): ScanStatus {
    return { ...this.state };
  }

  close(): void {
    this.bbDb.close();
  }

  async scan(options: { signal?: AbortSignal; full?: boolean } = {}): Promise<ScanStatus> {
    if (this.running) return this.running;
    this.running = this.runScan(options).finally(() => {
      this.running = null;
    });
    return this.running;
  }

  async runForever(signal: AbortSignal, intervalMs = 60_000): Promise<void> {
    while (!signal.aborted) {
      try {
        await this.scan({ signal });
      } catch (error) {
        this.log("warn", `usage scan failed: ${String(error)}`);
      }
      if (signal.aborted) return;
      await new Promise<void>((resolve) => {
        const timer = setTimeout(resolve, intervalMs);
        signal.addEventListener(
          "abort",
          () => {
            clearTimeout(timer);
            resolve();
          },
          { once: true },
        );
      });
    }
  }

  // ────────────────────────────── the pass ───────────────────────────────

  private async runScan(options: { signal?: AbortSignal; full?: boolean }): Promise<ScanStatus> {
    const started = this.now();
    this.state = {
      ...this.state,
      phase: "scanning",
      error: null,
      startedAt: new Date(started).toISOString(),
      finishedAt: null,
      durationMs: null,
      percent: 0,
      filesDone: 0,
      bytesDone: 0,
    };
    try {
      if (!this.loaded) {
        await this.loadCache();
        this.loaded = true;
      }
      const present = await listTranscripts(this.transcriptsDir);
      let rewrite = options.full === true;

      // Files that are gone: the thirty-day sweep took them.
      const gone = [...this.store.files.values()].filter((file) => !present.has(file.rel));
      if (gone.length) {
        rewrite = true;
        // If the calls of a vanished file also lived in other files, simply
        // dropping it would make part of the usage invisible: the winner of the
        // deduplication is gone, and nobody will read the copy again. This is
        // rare, and rebuilding everything from scratch is the honest answer.
        const shared = gone.some((file) => this.store.hasSharedEvents(file));
        for (const file of gone) this.store.dropFile(file);
        if (shared) this.store.resetParsed();
      }

      interface Pending {
        rel: string;
        stats: fs.Stats;
        record: FileRecord;
        fromStart: boolean;
      }
      // First round: decide the fate of every file without touching anything.
      // Parsing starts once it is clear whether a full rebuild is due.
      type Action = "skip" | "tail" | "full";
      const plan: { rel: string; stats: fs.Stats; info: PathInfo; action: Action }[] = [];
      const rewritten: FileRecord[] = [];
      for (const [rel, stats] of present) {
        const info = classifyPath(rel);
        if (!info) continue;
        const record = this.store.files.get(rel);
        const known = record !== undefined && (record.size > 0 || record.offset > 0);
        let action: Action = options.full === true || !known ? "full" : "tail";
        if (record && known && action === "tail") {
          if (stats.size < record.offset || stats.size < record.size) action = "full";
          else if (stats.size === record.size && stats.mtimeMs !== record.mtimeMs) action = "full";
          else if (stats.size === record.size && record.offset >= stats.size) action = "skip";
        }
        if (action === "full" && record && known) rewritten.push(record);
        plan.push({ rel, stats, info, action });
      }
      if (rewritten.length) {
        rewrite = true;
        const shared = rewritten.some((file) => this.store.hasSharedEvents(file));
        for (const file of rewritten) this.store.dropFile(file);
        // After a full rebuild everyone has to be read again, including the
        // files that have not changed since last time.
        if (shared) {
          this.store.resetParsed();
          for (const item of plan) item.action = "full";
        }
      }

      const pending: Pending[] = [];
      for (const item of plan) {
        if (item.action === "skip") continue;
        const record = this.store.fileFor(item.rel, item.info);
        if (item.action === "full") record.offset = 0;
        if (!record.firstTs) {
          record.firstTs = await readFirstTimestamp(path.join(this.transcriptsDir, item.rel));
        }
        pending.push({ rel: item.rel, stats: item.stats, record, fromStart: item.action === "full" });
      }

      // The order of the walk decides which file keeps a duplicated message.id.
      // Paths are compared strictly byte by byte: a locale-aware sort would move
      // the winner of the deduplication, and whole projects along with it.
      //
      // The first key, firstTs, is the first line of the file that carries a
      // timestamp, not the first line as such: in 92 transcripts the first line
      // is a summary record with no time at all, and reading it as zero would
      // hand those sessions the win. Which rule is right the data cannot say —
      // a forked copy REWRITES the sessionId, so the original session is not in
      // the record any more, and Claude Code itself breaks the same tie by
      // readdir order. The choice is worth up to ~4 percentage points on the
      // "8+ hours" and "subagent-heavy" statements; see README.
      pending.sort(
        (a, b) => a.record.firstTs - b.record.firstTs || (a.rel < b.rel ? -1 : a.rel > b.rel ? 1 : 0),
      );

      const bytesTotal = pending.reduce(
        (sum, item) => sum + Math.max(0, item.stats.size - item.record.offset),
        0,
      );
      this.state = {
        ...this.state,
        filesTotal: pending.length,
        bytesTotal,
        bytesDone: 0,
        filesDone: 0,
      };

      const newEvents: CallEvent[] = [];
      const newMarks: Mark[] = [];
      for (const item of pending) {
        if (options.signal?.aborted) break;
        const sink: ParseSink = {
          file: item.record,
          store: this.store,
          onEvent: (event) => {
            this.store.events.set(event.id, event);
            newEvents.push(event);
          },
          onMark: (mark) => {
            this.store.marks.push(mark);
            newMarks.push(mark);
          },
        };
        const consumed = await readLinesFrom(
          path.join(this.transcriptsDir, item.rel),
          item.record.offset,
          (line) => parseLine(line, sink),
          (bytes) => {
            this.state.bytesDone += bytes;
            this.state.percent =
              this.state.bytesTotal > 0
                ? Math.min(99, Math.round((this.state.bytesDone / this.state.bytesTotal) * 100))
                : 100;
          },
          options.signal,
        );
        item.record.offset = consumed;
        item.record.size = item.stats.size;
        item.record.mtimeMs = item.stats.mtimeMs;
        this.state.filesDone += 1;
        this.state.calls = this.store.events.size;
        // Drop the sorted view after every file, not once at the end: during
        // the first pass the page asks for a summary every couple of seconds,
        // and it should show what has been read by then rather than zeros.
        // Nothing is sorted here — the next summary() call pays for that.
        this.store.touch();
      }
      this.store.touch();

      await this.loadWorkflowMeta();
      this.goRuns = await readGoRuns(this.goRunsDir);
      this.threads = await this.bbDb.load(this.now());
      await this.persist(rewrite, newEvents, newMarks);

      const finished = this.now();
      this.state = {
        ...this.state,
        phase: "idle",
        cold: false,
        percent: 100,
        calls: this.store.events.size,
        files: this.store.files.size,
        finishedAt: new Date(finished).toISOString(),
        durationMs: finished - started,
      };
      return this.status();
    } catch (error) {
      const finished = this.now();
      this.state = {
        ...this.state,
        phase: "error",
        error: error instanceof Error ? error.message : String(error),
        finishedAt: new Date(finished).toISOString(),
        durationMs: finished - started,
      };
      return this.status();
    }
  }

  /**
   * The metadata of the workflow runs. There are dozens of them and they read
   * instantly, so they are pulled in on every pass — the summary has to be ready
   * the moment it is asked for.
   */
  private async loadWorkflowMeta(): Promise<void> {
    const seen = new Map<string, FileRecord>();
    for (const file of this.store.files.values()) {
      if (!file.workflowRunId) continue;
      seen.set(`${file.sessionId}/${file.workflowRunId}`, file);
    }
    const fresh = new Map<string, WorkflowMeta | null>();
    for (const [key, file] of seen) {
      const known = this.workflowCache.get(key);
      if (known) {
        fresh.set(key, known);
        continue;
      }
      fresh.set(
        key,
        await readWorkflowMeta(
          this.transcriptsDir,
          file.projectDir,
          file.sessionId,
          file.workflowRunId as string,
        ),
      );
    }
    this.workflowCache = fresh;
  }

  // ────────────────────────────── the cache ──────────────────────────────

  private cachePath(name: string): string | null {
    return this.cacheDir ? path.join(this.cacheDir, name) : null;
  }

  private async loadCache(): Promise<void> {
    const statePath = this.cachePath("state.json");
    if (!statePath) return;
    let raw: string;
    try {
      raw = await fsp.readFile(statePath, "utf8");
    } catch {
      return;
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(raw);
    } catch {
      return;
    }
    const state = asObject(parsed);
    if (!state) return;
    if (asNumber(state.version) !== CACHE_VERSION) return;
    if (asString(state.transcriptsDir) !== this.transcriptsDir) return;
    let maxId = 0;
    for (const raw of asArray(state.files)) {
      const row = asObject(raw);
      if (!row) continue;
      const rel = asString(row.rel);
      if (!rel) continue;
      const info = classifyPath(rel);
      if (!info) continue;
      const record: FileRecord = {
        id: asNumber(row.id),
        rel,
        size: asNumber(row.size),
        mtimeMs: asNumber(row.mtimeMs),
        offset: asNumber(row.offset),
        firstTs: asNumber(row.firstTs),
        kind: info.kind,
        projectDir: this.store.intern(info.projectDir),
        sessionId: this.store.intern(info.sessionId),
        agentId: info.agentId,
        workflowRunId: info.workflowRunId ? this.store.intern(info.workflowRunId) : null,
      };
      if (!record.id) continue;
      maxId = Math.max(maxId, record.id);
      this.store.files.set(rel, record);
      this.store.filesById.set(record.id, record);
    }
    this.store.reserveFileIds(maxId);
    for (const id of asArray(state.sharedIds)) {
      const value = asString(id);
      if (value) this.store.sharedIds.add(value);
    }

    const eventsPath = this.cachePath("events.jsonl");
    if (eventsPath) {
      await readLinesFrom(
        eventsPath,
        0,
        (line) => {
          const event = decodeEvent(line, this.store);
          if (event) this.store.events.set(event.id, event);
        },
        null,
        undefined,
      );
    }
    const marksPath = this.cachePath("marks.jsonl");
    if (marksPath) {
      await readLinesFrom(
        marksPath,
        0,
        (line) => {
          const mark = decodeMark(line, this.store);
          if (mark) this.store.marks.push(mark);
        },
        null,
        undefined,
      );
    }
    this.store.touch();
    this.state = {
      ...this.state,
      calls: this.store.events.size,
      files: this.store.files.size,
      cold: this.store.events.size === 0,
    };
    this.log("debug", `usage cache loaded: ${this.store.events.size} calls`);
  }

  private async persist(rewrite: boolean, events: CallEvent[], marks: Mark[]): Promise<void> {
    if (!this.cacheDir) return;
    await fsp.mkdir(this.cacheDir, { recursive: true });
    const eventsPath = path.join(this.cacheDir, "events.jsonl");
    const marksPath = path.join(this.cacheDir, "marks.jsonl");
    if (rewrite) {
      await writeRows(eventsPath, [...this.store.events.values()], encodeEvent, false);
      await writeRows(marksPath, this.store.marks, encodeMark, false);
    } else {
      await writeRows(eventsPath, events, encodeEvent, true);
      await writeRows(marksPath, marks, encodeMark, true);
    }
    const state = {
      version: CACHE_VERSION,
      transcriptsDir: this.transcriptsDir,
      updatedAt: new Date(this.now()).toISOString(),
      sharedIds: [...this.store.sharedIds],
      files: [...this.store.files.values()].map((file) => ({
        id: file.id,
        rel: file.rel,
        size: file.size,
        mtimeMs: file.mtimeMs,
        offset: file.offset,
        firstTs: file.firstTs,
      })),
    };
    await writeAtomic(path.join(this.cacheDir, "state.json"), JSON.stringify(state));
  }

  // ───────────────────────────── the summary ─────────────────────────────

  summary(query: UsageQuery = {}): UsageSummary {
    const now = this.now();
    const to = toMillis(query.to, now);
    const from = toMillis(query.from, to - DAY_MS);
    const topN = query.topN === undefined ? 20 : query.topN;
    const boundary = query.skillWindow ?? skillWindowBoundaries.untilNextHumanPrompt;

    const all = this.store.byTime();
    const first = lowerBound(all, from);
    const last = lowerBound(all, to + 1);
    const events = all.slice(first, last);

    const totals = emptyTotals();
    for (const event of events) addCall(totals, event);
    const cut: Cut = { total: totals.total, topN, counts: emptyCounts() };

    const summary: UsageSummary = {
      window: {
        from: new Date(from).toISOString(),
        to: new Date(to).toISOString(),
        days: (to - from) / DAY_MS,
      },
      generatedAt: new Date(now).toISOString(),
      scan: this.status(),
      totals,
      insights: this.insights(events),
      timeline: this.timelineOf(events, from, to, query.timelineStepMs),
      byKind: this.group(events, cut, "kind", (event) => {
        const file = this.store.filesById.get(event.fileId);
        return file ? [file.kind, KIND_LABELS[file.kind]] : null;
      }),
      byModel: this.group(events, cut, "model", (event) => [event.model, event.model]),
      byEffort: this.group(events, cut, "effort", (event) => {
        const value = event.effort ?? "none";
        return [value, value];
      }),
      byEntrypoint: this.group(events, cut, "entrypoint", (event) => {
        const value = event.entrypoint ?? "unknown";
        return [value, value];
      }),
      byServiceTier: this.group(events, cut, "serviceTier", (event) => {
        const value = event.serviceTier ?? "unknown";
        return [value, value];
      }),
      byProject: [],
      byWorkingDir: this.group(events, cut, "workingDir", (event) => {
        const value = event.cwd || "unknown";
        return [value, value];
      }),
      byThread: [],
      byAgent: this.group(events, cut, "agent", (event) => {
        const file = this.store.filesById.get(event.fileId);
        if (!file || file.kind === "main") return null;
        const value = event.attributionAgent ?? "unknown";
        return [value, value];
      }),
      byWorkflow: [],
      byGoRun: [],
      bySkill: [],
      sessions: {
        count: 0,
        concurrencyPeak: 0,
        subagentShare: 0,
        contextMedian: 0,
        contextP90: 0,
        contextMax: 0,
        top: [],
      },
      unresolvedThreadShare: 0,
      bucketCounts: cut.counts,
    };

    summary.byProject = this.projects(events, cut);
    summary.byWorkflow = this.workflows(events, cut);
    summary.byGoRun = this.goRunBuckets(events, cut);
    summary.bySkill = this.skills(events, from, to, cut, boundary);
    const sessions = this.sessions(events, cut, query.skipThreads === true);
    summary.sessions = sessions.stats;
    summary.byThread = sessions.threads;
    summary.unresolvedThreadShare = sessions.unresolvedShare;
    return summary;
  }

  /** The common breakdown: a function gives the key and the label, the rest is one. */
  private group(
    events: CallEvent[],
    cut: Cut,
    slot: keyof BucketCounts,
    keyOf: (event: CallEvent) => [string, string] | null,
  ): UsageBucket[] {
    const buckets = new Map<string, UsageBucket>();
    for (const event of events) {
      const key = keyOf(event);
      if (!key) continue;
      let bucket = buckets.get(key[0]);
      if (!bucket) {
        bucket = { key: key[0], label: key[1], totals: emptyTotals(), share: 0 };
        buckets.set(key[0], bucket);
      }
      addCall(bucket.totals, event);
    }
    return take([...buckets.values()], cut, slot);
  }

  /**
   * The project is the transcripts directory (that is the session's first
   * working directory), and the label is the most frequent cwd inside it: cwd
   * moves around as a session goes on.
   */
  private projects(events: CallEvent[], cut: Cut): UsageBucket[] {
    const buckets = new Map<string, UsageBucket>();
    const cwds = new Map<string, Map<string, number>>();
    for (const event of events) {
      const file = this.store.filesById.get(event.fileId);
      if (!file) continue;
      let bucket = buckets.get(file.projectDir);
      if (!bucket) {
        bucket = { key: file.projectDir, label: file.projectDir, totals: emptyTotals(), share: 0 };
        buckets.set(file.projectDir, bucket);
        cwds.set(file.projectDir, new Map());
      }
      addCall(bucket.totals, event);
      if (event.cwd) {
        const counter = cwds.get(file.projectDir);
        if (counter) counter.set(event.cwd, (counter.get(event.cwd) ?? 0) + 1);
      }
    }
    for (const bucket of buckets.values()) {
      const counter = cwds.get(bucket.key);
      if (!counter) continue;
      let best = "";
      let bestCount = 0;
      for (const [cwd, count] of counter) {
        if (count > bestCount) {
          best = cwd;
          bestCount = count;
        }
      }
      if (best) bucket.label = best;
    }
    return take([...buckets.values()], cut, "project");
  }

  private workflows(events: CallEvent[], cut: Cut): WorkflowBucket[] {
    const buckets = new Map<string, WorkflowBucket>();
    for (const event of events) {
      const file = this.store.filesById.get(event.fileId);
      if (!file || !file.workflowRunId) continue;
      const key = `${file.sessionId}/${file.workflowRunId}`;
      let bucket = buckets.get(key);
      if (!bucket) {
        const meta = this.workflowCache.get(key) ?? null;
        bucket = {
          key,
          label: meta?.workflowName ?? file.workflowRunId,
          totals: emptyTotals(),
          share: 0,
          runId: file.workflowRunId,
          sessionId: file.sessionId,
          workflowName: meta?.workflowName ?? null,
          status: meta?.status ?? null,
          agentCount: meta?.agentCount ?? null,
          toolCallsReported: meta?.toolCallsReported ?? null,
          tokensReported: meta?.tokensReported ?? null,
          durationMs: meta?.durationMs ?? null,
          startedAt: meta?.startedAt ?? null,
        };
        buckets.set(key, bucket);
      }
      addCall(bucket.totals, event);
    }
    return take([...buckets.values()], cut, "workflow");
  }

  private goRunBuckets(events: CallEvent[], cut: Cut): GoRunBucket[] {
    const buckets = new Map<string, GoRunBucket>();
    for (const event of events) {
      const file = this.store.filesById.get(event.fileId);
      if (!file) continue;
      const meta = this.goRuns.get(file.sessionId);
      if (!meta) continue;
      let bucket = buckets.get(meta.sessionId);
      if (!bucket) {
        bucket = {
          key: meta.sessionId,
          label: meta.name,
          totals: emptyTotals(),
          share: 0,
          name: meta.name,
          sessionId: meta.sessionId,
          parentSessionId: meta.parentSessionId,
          dir: meta.dir,
          model: meta.model,
          effort: meta.effort,
          mode: meta.mode,
          startedAt: meta.startedAt,
          finishedAt: meta.finishedAt,
          exitCode: meta.exitCode,
        };
        buckets.set(meta.sessionId, bucket);
      }
      addCall(bucket.totals, event);
    }
    return take([...buckets.values()], cut, "goRun");
  }

  /**
   * The insight figures, formula for formula from the Claude Code extension:
   * one pass over the window that accumulates weighted cost per session, per
   * five-minute bucket and per attribution name, then turns those into the five
   * behaviours and the four attribution tables.
   *
   * Two details that look like slips but are the extension's own behaviour and
   * are reproduced on purpose, or the numbers would not match:
   *   - a call carrying both an agent and a skill lands in the SUBAGENTS table
   *     under the SKILL's name;
   *   - the behaviours are not a breakdown — one call feeds several of them, so
   *     the percentages overlap and may add up to more than 100.
   */
  private insights(events: CallEvent[]): UsageInsights {
    interface SessionAcc {
      cost: number;
      subCost: number;
      subCalls: number;
      /** Distinct UTC hours the session touched. */
      hours: Set<number>;
    }
    interface BucketAcc {
      sessions: Set<string>;
      cost: number;
      count: number;
    }

    const sessions = new Map<string, SessionAcc>();
    const buckets = new Map<number, BucketAcc>();
    const byAgent = new Map<string, number>();
    const bySkill = new Map<string, number>();
    const byPlugin = new Map<string, number>();
    const byMcpServer = new Map<string, number>();
    let totalCost = 0;
    let cacheMissCost = 0;
    let cacheMissCount = 0;
    let longContextCost = 0;
    let longContextCount = 0;

    for (const event of events) {
      const file = this.store.filesById.get(event.fileId);
      if (!file) continue;
      const cost = weightedCost(event);
      totalCost += cost;

      if (event.attributionAgent) {
        addCost(byAgent, event.attributionSkill ?? event.attributionAgent, cost);
      } else {
        addCost(bySkill, event.attributionSkill, cost);
      }
      addCost(byPlugin, event.attributionPlugin, cost);
      addCost(byMcpServer, event.attributionMcpServer, cost);

      if (event.input > CACHE_MISS_INPUT) {
        cacheMissCost += cost;
        cacheMissCount += 1;
      }
      if (event.cacheRead + event.cacheCreation + event.input > LONG_CONTEXT_INPUT) {
        longContextCost += cost;
        longContextCount += 1;
      }

      let session = sessions.get(file.sessionId);
      if (!session) {
        session = { cost: 0, subCost: 0, subCalls: 0, hours: new Set() };
        sessions.set(file.sessionId, session);
      }
      session.cost += cost;
      // Subagent and workflow transcripts are exactly the records the extension
      // sees as isSidechain: every line of a subagents/ file carries that flag
      // and no main-session line does — checked over the whole local history.
      if (file.kind !== "main") {
        session.subCost += cost;
        session.subCalls += 1;
      }
      session.hours.add(Math.floor(event.ts / HOUR_MS));

      const slot = Math.floor(event.ts / PARALLEL_BUCKET_MS);
      let bucket = buckets.get(slot);
      if (!bucket) {
        bucket = { sessions: new Set(), cost: 0, count: 0 };
        buckets.set(slot, bucket);
      }
      bucket.sessions.add(file.sessionId);
      bucket.cost += cost;
      bucket.count += 1;
    }

    let parallelCost = 0;
    let parallelCount = 0;
    for (const bucket of buckets.values()) {
      if (bucket.sessions.size < PARALLEL_MIN_SESSIONS) continue;
      parallelCost += bucket.cost;
      parallelCount += bucket.count;
    }

    let subagentCost = 0;
    let subagentSessions = 0;
    let cronCost = 0;
    let cronSessions = 0;
    for (const session of sessions.values()) {
      // The whole session counts, not just its subagent part — that is what the
      // sentence claims, and what the extension sums.
      if (
        session.subCalls >= SUBAGENT_MIN_CALLS ||
        (session.cost > 0 && session.subCost / session.cost > SUBAGENT_MIN_SHARE)
      ) {
        subagentCost += session.cost;
        subagentSessions += 1;
      }
      if (session.hours.size >= CRON_MIN_HOURS) {
        cronCost += session.cost;
        cronSessions += 1;
      }
    }

    const behaviors: BehaviorInsight[] = [
      behavior("cache_miss", cacheMissCost, cacheMissCount, totalCost),
      behavior("long_context", longContextCost, longContextCount, totalCost),
      behavior("subagent_heavy", subagentCost, subagentSessions, totalCost),
      behavior("high_parallel", parallelCost, parallelCount, totalCost),
      behavior("cron", cronCost, cronSessions, totalCost),
    ].sort((a, b) => b.cost - a.cost);

    return {
      totalCost,
      requestCount: events.length,
      sessionCount: sessions.size,
      behaviors,
      minBehaviorPct: MIN_BEHAVIOR_PCT,
      agents: attributionRows(byAgent, totalCost),
      skills: attributionRows(bySkill, totalCost),
      plugins: attributionRows(byPlugin, totalCost),
      mcpServers: attributionRows(byMcpServer, totalCost),
    };
  }

  /**
   * Usage over the window, bucketed for the chart. Empty buckets are kept: a
   * gap in the bars is the honest picture of an idle hour, and dropping them
   * would stretch the busy ones over the whole width.
   */
  private timelineOf(
    events: CallEvent[],
    from: number,
    to: number,
    requested: number | undefined,
  ): UsageTimeline {
    const span = Math.max(1, to - from);
    let stepMs =
      requested && requested > 0
        ? requested
        : span <= TIMELINE_HOURLY_LIMIT_MS
          ? HOUR_MS
          : TIMELINE_WIDE_STEP_MS;
    if (span / stepMs > TIMELINE_MAX_POINTS) stepMs = Math.ceil(span / TIMELINE_MAX_POINTS);
    // Buckets sit on the step grid of LOCAL time, not of UTC: a six-hour bar
    // that starts at 03:00 because the machine is three hours east of UTC would
    // make the chart unreadable, and no day label would ever land on a bar.
    const offset = new Date(from).getTimezoneOffset() * 60_000;
    const start = Math.floor((from - offset) / stepMs) * stepMs + offset;
    const count = Math.max(1, Math.min(TIMELINE_MAX_POINTS, Math.ceil((to - start) / stepMs)));
    const points: TimelinePoint[] = [];
    for (let index = 0; index < count; index += 1) {
      const ts = start + index * stepMs;
      points.push({
        ts,
        // The grid is aligned to the clock, the window to "now": the first
        // bucket opens before the window does and the last one closes after it,
        // so both cover less time than the step says. The chart draws them
        // narrower for it — a bar covering ten minutes of a six-hour slot must
        // not read as a quiet stretch.
        spanMs: Math.max(0, Math.min(to, ts + stepMs) - Math.max(from, ts)),
        total: 0,
        cost: 0,
        calls: 0,
        main: 0,
        subagent: 0,
        workflow: 0,
      });
    }
    for (const event of events) {
      const index = Math.floor((event.ts - start) / stepMs);
      if (index < 0 || index >= points.length) continue;
      const point = points[index];
      const tokens = event.input + event.output + event.cacheCreation + event.cacheRead;
      point.total += tokens;
      point.cost += weightedCost(event);
      point.calls += 1;
      const file = this.store.filesById.get(event.fileId);
      const kind = file ? file.kind : "main";
      if (kind === "workflow") point.workflow += tokens;
      else if (kind === "subagent") point.subagent += tokens;
      else point.main += tokens;
    }
    return { stepMs, points };
  }

  /**
   * Skills. A run gives itself away in three ways (the Skill tool, a slash
   * command, an injection of the SKILL.md body). Two usage figures sit side by
   * side: `reported`, taken straight from the transcript's own attributionSkill
   * field — that is the one the page shows and the one the rows are ranked by —
   * and `attributed`, this module's own estimate under a boundary rule that one
   * function replaces. Keeping the estimate next to the measurement is the only
   * way to see how far the rule is off.
   */
  private skills(
    events: CallEvent[],
    from: number,
    to: number,
    cut: Cut,
    boundary: SkillWindowBoundary,
  ): SkillBucket[] {
    interface Row {
      skill: string;
      invocations: number;
      injections: number;
      injectedBytes: number;
      attributed: UsageTotals;
      reported: UsageTotals;
    }
    const rows = new Map<string, Row>();
    const rowFor = (skill: string): Row => {
      let row = rows.get(skill);
      if (!row) {
        row = {
          skill,
          invocations: 0,
          injections: 0,
          injectedBytes: 0,
          attributed: emptyTotals(),
          reported: emptyTotals(),
        };
        rows.set(skill, row);
      }
      return row;
    };

    // What the window held: calls, human prompts and SKILL.md injections, by session.
    const bySession = new Map<string, CallEvent[]>();
    for (const event of events) {
      const file = this.store.filesById.get(event.fileId);
      if (!file) continue;
      const list = bySession.get(file.sessionId);
      if (list) list.push(event);
      else bySession.set(file.sessionId, [event]);
      if (event.attributionSkill) addCall(rowFor(event.attributionSkill).reported, event);
    }
    const prompts = new Map<string, number[]>();
    const invocations = new Map<string, SkillInvocation[]>();
    const pushInvocation = (sessionId: string, invocation: SkillInvocation): void => {
      const list = invocations.get(sessionId);
      if (list) list.push(invocation);
      else invocations.set(sessionId, [invocation]);
    };
    for (const mark of this.store.marks) {
      if (mark.ts < from || mark.ts > to) continue;
      const file = this.store.filesById.get(mark.fileId);
      if (!file) continue;
      if (mark.kind === "prompt") {
        const list = prompts.get(file.sessionId);
        if (list) list.push(mark.ts);
        else prompts.set(file.sessionId, [mark.ts]);
        if (mark.name && !BUILTIN_COMMANDS.has(mark.name)) {
          pushInvocation(file.sessionId, {
            skill: mark.name.replace(/^\//, ""),
            ts: mark.ts,
            sessionId: file.sessionId,
            source: "command",
          });
        }
        continue;
      }
      const row = rowFor(mark.name);
      row.injections += 1;
      row.injectedBytes += mark.bytes;
      pushInvocation(file.sessionId, {
        skill: mark.name,
        ts: mark.ts,
        sessionId: file.sessionId,
        source: "inject",
      });
    }
    for (const event of events) {
      if (!event.skills.length) continue;
      const file = this.store.filesById.get(event.fileId);
      if (!file) continue;
      for (const skill of event.skills) {
        pushInvocation(file.sessionId, {
          skill,
          ts: event.ts,
          sessionId: file.sessionId,
          source: "tool",
        });
      }
    }

    for (const [sessionId, list] of invocations) {
      list.sort((a, b) => a.ts - b.ts || a.skill.localeCompare(b.skill));
      // One run shows up as several markers at once — bring them together.
      const merged: SkillInvocation[] = [];
      for (const invocation of list) {
        const previous = merged.find(
          (item) => item.skill === invocation.skill && invocation.ts - item.ts < SKILL_DEDUP_MS,
        );
        if (previous) continue;
        merged.push(invocation);
      }
      const sessionEvents = bySession.get(sessionId) ?? [];
      const sessionEnd = sessionEvents.length ? sessionEvents[sessionEvents.length - 1].ts : to;
      const sessionPrompts = (prompts.get(sessionId) ?? []).slice().sort((a, b) => a - b);
      const context: SkillWindowContext = {
        sessionId,
        sessionEnd,
        nextHumanPrompt: (ts) => {
          const index = sessionPrompts.findIndex((value) => value > ts);
          return index < 0 ? null : sessionPrompts[index];
        },
        nextInvocation: (ts) => {
          const found = merged.find((item) => item.ts > ts);
          return found ? found.ts : null;
        },
      };
      interface Span {
        skill: string;
        start: number;
        end: number;
      }
      const spans: Span[] = [];
      for (const invocation of merged) {
        rowFor(invocation.skill).invocations += 1;
        spans.push({ skill: invocation.skill, start: invocation.ts, end: boundary(invocation, context) });
      }
      if (!spans.length) continue;
      spans.sort((a, b) => a.start - b.start);
      // Nested runs: usage counts towards the last skill that opened.
      let cursor = 0;
      const open: Span[] = [];
      for (const event of sessionEvents) {
        while (cursor < spans.length && spans[cursor].start <= event.ts) open.push(spans[cursor++]);
        while (open.length && open[open.length - 1].end <= event.ts) open.pop();
        if (!open.length) continue;
        addCall(rowFor(open[open.length - 1].skill).attributed, event);
      }
    }

    const buckets: SkillBucket[] = [...rows.values()].map((row) => ({
      skill: row.skill,
      invocations: row.invocations,
      injections: row.injections,
      injectedBytes: row.injectedBytes,
      attributed: row.attributed,
      attributedShare: cut.total > 0 ? row.attributed.total / cut.total : 0,
      reported: row.reported,
      reportedShare: cut.total > 0 ? row.reported.total / cut.total : 0,
    }));
    // Ranked by `reported`, the figure the page prints. Ranking by the module's
    // own `attributed` estimate instead would let a skill with the largest
    // measured usage fall off the end of a table that still shows rows of zero.
    buckets.sort(
      (a, b) =>
        b.reported.total - a.reported.total ||
        b.attributed.total - a.attributed.total ||
        b.invocations - a.invocations,
    );
    cut.counts.skill = buckets.length;
    return cut.topN > 0 ? buckets.slice(0, cut.topN) : buckets;
  }

  /** Session traits and the bb-thread breakdown — counted in one pass. */
  private sessions(
    events: CallEvent[],
    cut: Cut,
    skipThreads: boolean,
  ): {
    stats: UsageSummary["sessions"];
    threads: UsageBucket[];
    unresolvedShare: number;
  } {
    interface Draft {
      sessionId: string;
      projectDir: string;
      totals: UsageTotals;
      subagentTokens: number;
      subagentCalls: number;
      first: number;
      last: number;
      contexts: number[];
      cwds: Map<string, number>;
      concurrencySum: number;
      concurrencyPeak: number;
    }
    const drafts = new Map<string, Draft>();
    const contexts: number[] = [];
    let subagentTokens = 0;

    // Sessions active at once: counted over a sliding window of calls.
    const lastSeen = new Map<string, number>();
    let concurrencyPeak = 0;

    for (const event of events) {
      const file = this.store.filesById.get(event.fileId);
      if (!file) continue;
      let draft = drafts.get(file.sessionId);
      if (!draft) {
        draft = {
          sessionId: file.sessionId,
          projectDir: file.projectDir,
          totals: emptyTotals(),
          subagentTokens: 0,
          subagentCalls: 0,
          first: event.ts,
          last: event.ts,
          contexts: [],
          cwds: new Map(),
          concurrencySum: 0,
          concurrencyPeak: 0,
        };
        drafts.set(file.sessionId, draft);
      }
      addCall(draft.totals, event);
      draft.first = Math.min(draft.first, event.ts);
      draft.last = Math.max(draft.last, event.ts);
      // The same sum the ">150k context" statement is measured against, so the
      // tile above the chart and the sentence below it cannot disagree.
      const context = event.cacheRead + event.cacheCreation + event.input;
      draft.contexts.push(context);
      contexts.push(context);
      if (event.cwd) draft.cwds.set(event.cwd, (draft.cwds.get(event.cwd) ?? 0) + 1);
      if (file.kind !== "main") {
        const tokens = event.input + event.output + event.cacheCreation + event.cacheRead;
        draft.subagentTokens += tokens;
        draft.subagentCalls += 1;
        subagentTokens += tokens;
      }
      lastSeen.set(file.sessionId, event.ts);
      let active = 0;
      for (const [id, ts] of lastSeen) {
        if (event.ts - ts <= SESSION_ACTIVE_MS) active += 1;
        else if (event.ts - ts > SESSION_ACTIVE_MS * 4) lastSeen.delete(id);
      }
      draft.concurrencySum += active;
      draft.concurrencyPeak = Math.max(draft.concurrencyPeak, active);
      concurrencyPeak = Math.max(concurrencyPeak, active);
    }

    const threadBuckets = new Map<string, UsageBucket>();
    let unresolved = 0;
    const buckets: SessionBucket[] = [];
    for (const draft of drafts.values()) {
      const sorted = draft.contexts.slice().sort((a, b) => a - b);
      let cwd = "";
      let best = 0;
      for (const [value, count] of draft.cwds) {
        if (count > best) {
          cwd = value;
          best = count;
        }
      }
      const thread = skipThreads ? null : this.threadFor(draft.sessionId, draft.projectDir);
      buckets.push({
        key: draft.sessionId,
        label: thread?.title || cwd || draft.projectDir,
        totals: draft.totals,
        share: 0,
        sessionId: draft.sessionId,
        projectDir: draft.projectDir,
        cwd,
        threadId: thread?.id ?? null,
        threadTitle: thread ? thread.title.slice(0, 80) : null,
        firstCallAt: new Date(draft.first).toISOString(),
        lastCallAt: new Date(draft.last).toISOString(),
        durationMs: draft.last - draft.first,
        subagentShare: draft.totals.total > 0 ? draft.subagentTokens / draft.totals.total : 0,
        subagentCalls: draft.subagentCalls,
        contextMedian: percentile(sorted, 0.5),
        contextP90: percentile(sorted, 0.9),
        contextMax: sorted.length ? sorted[sorted.length - 1] : 0,
        concurrencyAvg: draft.totals.calls > 0 ? draft.concurrencySum / draft.totals.calls : 0,
        concurrencyPeak: draft.concurrencyPeak,
      });
      const key = thread ? thread.id : UNRESOLVED_THREAD_KEY;
      let bucket = threadBuckets.get(key);
      if (!bucket) {
        bucket = {
          key,
          label: thread ? thread.title.slice(0, 80) || thread.id : "Without a bb thread",
          totals: emptyTotals(),
          share: 0,
        };
        threadBuckets.set(key, bucket);
      }
      mergeTotals(bucket.totals, draft.totals);
      if (!thread) unresolved += draft.totals.total;
    }

    const allContexts = contexts.sort((a, b) => a - b);
    return {
      stats: {
        count: drafts.size,
        concurrencyPeak,
        subagentShare: cut.total > 0 ? subagentTokens / cut.total : 0,
        contextMedian: percentile(allContexts, 0.5),
        contextP90: percentile(allContexts, 0.9),
        contextMax: allContexts.length ? allContexts[allContexts.length - 1] : 0,
        top: take(buckets, cut, "session"),
      },
      threads: take([...threadBuckets.values()], cut, "thread"),
      unresolvedShare: cut.total > 0 ? unresolved / cut.total : 0,
    };
  }

  /**
   * A Claude Code session → a bb thread. The exact mapping lives in events
   * (provider_thread_id), but events are kept for a couple of days; for older
   * sessions only the environment is left, and only where it has one thread.
   */
  private threadFor(sessionId: string, projectDir: string): ThreadRow | null {
    const direct = this.threads.bySession.get(sessionId);
    if (direct) {
      const row = this.threads.threads.get(direct);
      if (row) return row;
    }
    const environmentId = environmentIdFromProjectDir(projectDir);
    if (!environmentId) return null;
    const byEnvironment = this.threads.byEnvironment.get(environmentId);
    if (!byEnvironment) return null;
    return this.threads.threads.get(byEnvironment) ?? null;
  }
}

const KIND_LABELS: Record<CallKind, string> = {
  main: "Main session",
  subagent: "Subagent",
  workflow: "Workflow agent",
};

/**
 * Model tier of the weighted cost, matched on the model name the same way the
 * extension does: substring, lowercased, default for anything unknown.
 */
function modelTier(model: string): number {
  const name = model.toLowerCase();
  if (name.includes("fable")) return 10;
  if (name.includes("opus")) return 5;
  if (name.includes("haiku")) return 1;
  return TIER_DEFAULT;
}

/** Weighted cost of one call — the unit every insight percentage is a share of. */
function weightedCost(event: CallEvent): number {
  return (
    (event.cacheRead * COST_CACHE_READ +
      event.input * COST_INPUT +
      event.cacheCreation * COST_CACHE_CREATION +
      event.output * COST_OUTPUT) *
    modelTier(event.model)
  );
}

/** Add cost under a name, ignoring the calls that carry no name at all. */
function addCost(map: Map<string, number>, name: string | null, cost: number): void {
  if (!name) return;
  map.set(name, (map.get(name) ?? 0) + cost);
}

/**
 * An attribution map turned into rows: sorted by cost, percentages rounded, and
 * everything that rounds to zero dropped rather than shown as "0%".
 */
function attributionRows(map: Map<string, number>, total: number): AttributionRow[] {
  if (map.size === 0 || total <= 0) return [];
  return [...map.entries()]
    .sort((a, b) => b[1] - a[1])
    .map(([name, cost]) => ({ name, cost, pct: Math.round((cost / total) * 100) }))
    .filter((row) => row.pct > 0);
}

/** One behaviour row; the gate compares rawPct, the interface prints pct. */
function behavior(
  key: BehaviorKey,
  cost: number,
  count: number,
  total: number,
): BehaviorInsight {
  const rawPct = total > 0 ? (cost / total) * 100 : 0;
  return { key, cost, count, rawPct, pct: Math.round(rawPct) };
}

function mergeTotals(target: UsageTotals, source: UsageTotals): void {
  target.calls += source.calls;
  target.input += source.input;
  target.output += source.output;
  target.cacheCreation += source.cacheCreation;
  target.cacheRead += source.cacheRead;
  target.thinking += source.thinking;
  target.ephemeral5m += source.ephemeral5m;
  target.ephemeral1h += source.ephemeral1h;
  target.toolCalls += source.toolCalls;
  target.total += source.total;
}

/** The first index whose ts is >= value. */
function lowerBound(events: CallEvent[], value: number): number {
  let low = 0;
  let high = events.length;
  while (low < high) {
    const mid = (low + high) >> 1;
    if (events[mid].ts < value) low = mid + 1;
    else high = mid;
  }
  return low;
}

/**
 * Writes the cache in batches. Forty thousand rows joined into one eight-megabyte
 * string freeze the server for half a second; in batches, for milliseconds.
 */
async function writeRows<T>(
  file: string,
  rows: readonly T[],
  encode: (row: T) => string,
  append: boolean,
): Promise<void> {
  if (append && !rows.length) return;
  const target = append ? file : `${file}.tmp`;
  const handle = await fsp.open(target, append ? "a" : "w");
  try {
    const batch = 2000;
    for (let index = 0; index < rows.length; index += batch) {
      let text = "";
      for (let inner = index; inner < Math.min(index + batch, rows.length); inner += 1) {
        text += encode(rows[inner]) + "\n";
      }
      await handle.write(text);
    }
  } finally {
    await handle.close();
  }
  if (!append) await fsp.rename(target, file);
}

async function writeAtomic(file: string, content: string): Promise<void> {
  const temporary = `${file}.tmp`;
  await fsp.writeFile(temporary, content);
  await fsp.rename(temporary, file);
}

// ─────────────────────────────── entry points ────────────────────────────────

/** Builds a scanner. Without a cacheDir every pass is a cold one. */
export function createUsageScanner(options: UsageScanOptions = {}): UsageScanner {
  return new Scanner(options);
}

/** The least of bb the module needs: the path to its own database, and a log. */
export interface BbLike {
  storage: { database(): { name: string } };
  log?: {
    debug?: (message: string) => void;
    info?: (message: string) => void;
    warn?: (message: string) => void;
  };
}

/**
 * A scanner tied to the plugin's data directory. The SDK gives no file path
 * outright, but bb.storage.database() opens the plugin's database at
 * <dataDir>/plugins/<id>/data.db — and that is enough to work from: the cache
 * goes next to it, and bb.db is looked for in the data directory itself.
 */
export function usageScannerForPlugin(bb: BbLike, options: UsageScanOptions = {}): UsageScanner {
  let cacheDir = options.cacheDir ?? null;
  let bbDbPath = options.bbDbPath;
  try {
    const own = bb.storage.database().name;
    const pluginDir = path.dirname(own);
    if (cacheDir === null) cacheDir = path.join(pluginDir, "usage-scan");
    if (bbDbPath === undefined) {
      // <dataDir>/plugins/<id>/data.db → <dataDir>/bb.db
      const dataDir = path.dirname(path.dirname(pluginDir));
      const candidate = path.join(dataDir, "bb.db");
      bbDbPath = fs.existsSync(candidate) ? candidate : DEFAULT_BB_DB_PATH;
    }
  } catch {
    // The plugin database is out of reach — no cache then, but still working.
  }
  const log =
    options.log ??
    ((level: "debug" | "info" | "warn", message: string) => {
      bb.log?.[level]?.(message);
    });
  return createUsageScanner({ ...options, cacheDir, bbDbPath, log });
}
