// OpenCode's own record of what each model spent, read on the machine where
// OpenCode runs. Nothing here writes: the database is opened read-only, the
// connection is closed before the call returns, and only sums leave this file —
// no prompts, no replies, no session titles.
//
// OpenCode keeps one SQLite file, `opencode.db`, in its data directory
// ($XDG_DATA_HOME/opencode, otherwise ~/.local/share/opencode — on macOS too).
// Two layouts exist:
//   - 2.x: `session_message` rows; an assistant step carries
//     data.model.{providerID,id} and data.tokens.{input,output,reasoning,cache.{read,write}}.
//   - 1.x (1.2 and later): `message` + `part`; the per-step figures sit in the
//     `step-finish` parts, the model in the message (data.providerID/modelID).
// A database upgraded from 1.x keeps the old tables next to the new ones and
// carries the imported messages over under the same ids, so the 1.x query skips
// every message 2.x already has.
import { DatabaseSync } from "node:sqlite";
import { readdirSync, statSync } from "node:fs";
import os from "node:os";
import path from "node:path";

/** Sums for one model in one time bucket. */
export interface OpencodeRow {
  providerId: string;
  modelId: string;
  /** 0: the last five hours; 1: five to twenty-four hours ago; 2: one to seven days ago. */
  bucket: 0 | 1 | 2;
  input: number;
  output: number;
  reasoning: number;
  cacheRead: number;
  cacheWrite: number;
  /** US dollars as OpenCode priced them; 0 for models without a price. */
  cost: number;
  /** Model steps counted (one request to the model each). */
  requests: number;
}

export type OpencodeSchema = "v1" | "v2" | "mixed";

export type OpencodeReadResult =
  | { status: "ok"; dbPath: string; schema: OpencodeSchema; rows: OpencodeRow[] }
  | { status: "not_found"; dbPath: null; schema: null; rows: [] }
  | { status: "error"; dbPath: string | null; schema: null; rows: []; message: string };

const HOUR_MS = 60 * 60_000;
export const BUCKET_EDGES_MS = [5 * HOUR_MS, 24 * HOUR_MS, 7 * 24 * HOUR_MS] as const;

/** Where OpenCode keeps its data, by the same rule OpenCode itself follows. */
export function opencodeDataDir(
  env: NodeJS.ProcessEnv = process.env,
  home: string = os.homedir(),
): string {
  const xdg = env.XDG_DATA_HOME;
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(home, ".local", "share");
  return path.join(base, "opencode");
}

const DB_NAME = /^opencode(-[A-Za-z0-9._]+)?\.db$/;

/**
 * The database file: `$OPENCODE_DB` when set, then `opencode.db`, then the
 * newest `opencode-<channel>.db` (development and preview channels write
 * there). Null when OpenCode has never run here.
 */
export function findOpencodeDb(
  dataDir: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const explicit = env.OPENCODE_DB;
  if (explicit) {
    const file = path.isAbsolute(explicit) ? explicit : path.join(dataDir, explicit);
    return isFile(file) ? file : null;
  }
  const main = path.join(dataDir, "opencode.db");
  if (isFile(main)) return main;
  let names: string[];
  try {
    names = readdirSync(dataDir);
  } catch {
    return null;
  }
  let best: { file: string; mtime: number } | null = null;
  for (const name of names) {
    if (!DB_NAME.test(name)) continue;
    const file = path.join(dataDir, name);
    try {
      const stat = statSync(file);
      if (stat.isFile() && (!best || stat.mtimeMs > best.mtime)) best = { file, mtime: stat.mtimeMs };
    } catch {
      // Gone between the listing and the stat: OpenCode is rotating it.
    }
  }
  return best?.file ?? null;
}

function isFile(file: string): boolean {
  try {
    return statSync(file).isFile();
  } catch {
    return false;
  }
}

type Columns = Map<string, Set<string>>;

function columnsOf(db: DatabaseSync): Columns {
  const tables = db
    .prepare("SELECT name FROM sqlite_master WHERE type = 'table'")
    .all() as Array<{ name: string }>;
  const out: Columns = new Map();
  for (const { name } of tables) {
    if (!/^[A-Za-z0-9_]+$/.test(name)) continue;
    const cols = db.prepare(`PRAGMA table_info(${name})`).all() as Array<{ name: string }>;
    out.set(name, new Set(cols.map((col) => col.name)));
  }
  return out;
}

const has = (cols: Columns, table: string, ...names: string[]) =>
  names.every((name) => cols.get(table)?.has(name) ?? false);

const BUCKET_SQL = (column: string) =>
  `CASE WHEN ${column} >= :t5h THEN 0 WHEN ${column} >= :t24h THEN 1 ELSE 2 END`;

const SUMS = (src: string) => `
  SUM(COALESCE(json_extract(${src}, '$.tokens.input'), 0)) AS input,
  SUM(COALESCE(json_extract(${src}, '$.tokens.output'), 0)) AS output,
  SUM(COALESCE(json_extract(${src}, '$.tokens.reasoning'), 0)) AS reasoning,
  SUM(COALESCE(json_extract(${src}, '$.tokens.cache.read'), 0)) AS cacheRead,
  SUM(COALESCE(json_extract(${src}, '$.tokens.cache.write'), 0)) AS cacheWrite,
  SUM(COALESCE(json_extract(${src}, '$.cost'), 0)) AS cost`;

/** 2.x: one assistant (or compaction) step per row, summed per model. */
function v2Query(cols: Columns): string {
  // A fork copies its parent's history with the original times; only the steps
  // made after the fork are its own. OpenCode's own statistics use this rule.
  const forks = has(cols, "session_v2", "id", "fork_session_id", "time_created");
  return `
    SELECT json_extract(m.data, '$.model.providerID') AS providerId,
           json_extract(m.data, '$.model.id') AS modelId,
           ${BUCKET_SQL("m.time_created")} AS bucket,
           ${SUMS("m.data")},
           COUNT(*) AS requests
      FROM session_message m
      ${forks ? "LEFT JOIN session_v2 s ON s.id = m.session_id" : ""}
     WHERE m.time_created >= :t7d
       AND m.type IN ('assistant', 'compaction')
       AND json_type(m.data, '$.tokens') = 'object'
       ${forks ? "AND (s.fork_session_id IS NULL OR m.time_created >= s.time_created)" : ""}
     GROUP BY providerId, modelId, bucket`;
}

/** 1.x: the figures of every finished step, the model from its message. */
function v1Query(cols: Columns, alsoV2: boolean): string {
  const partTime = has(cols, "part", "time_created") ? "COALESCE(p.time_created, m.time_created)" : "m.time_created";
  return `
    SELECT json_extract(m.data, '$.providerID') AS providerId,
           json_extract(m.data, '$.modelID') AS modelId,
           ${BUCKET_SQL(partTime)} AS bucket,
           ${SUMS("p.data")},
           COUNT(*) AS requests
      FROM part p
      JOIN message m ON m.id = p.message_id
     WHERE ${partTime} >= :t7d
       AND json_extract(m.data, '$.role') = 'assistant'
       AND json_extract(p.data, '$.type') = 'step-finish'
       ${alsoV2 ? "AND NOT EXISTS (SELECT 1 FROM session_message n WHERE n.id = m.id)" : ""}
     GROUP BY providerId, modelId, bucket`;
}

function schemaOf(cols: Columns): OpencodeSchema | null {
  const v2 = has(cols, "session_message", "id", "type", "time_created", "data");
  const v1 = has(cols, "message", "id", "time_created", "data") && has(cols, "part", "message_id", "data");
  if (v2 && v1) return "mixed";
  if (v2) return "v2";
  if (v1) return "v1";
  return null;
}

function num(value: unknown): number {
  const n = typeof value === "bigint" ? Number(value) : Number(value);
  return Number.isFinite(n) && n > 0 ? n : 0;
}

function merge(rows: OpencodeRow[]): OpencodeRow[] {
  const byKey = new Map<string, OpencodeRow>();
  for (const row of rows) {
    const key = JSON.stringify([row.providerId, row.modelId, row.bucket]);
    const prev = byKey.get(key);
    if (!prev) {
      byKey.set(key, { ...row });
      continue;
    }
    prev.input += row.input;
    prev.output += row.output;
    prev.reasoning += row.reasoning;
    prev.cacheRead += row.cacheRead;
    prev.cacheWrite += row.cacheWrite;
    prev.cost += row.cost;
    prev.requests += row.requests;
  }
  return [...byKey.values()];
}

/** Sums per model for the last five hours, day and week, as of `now`. */
export function readOpencodeUsage(options: {
  now: number;
  dataDir?: string;
  env?: NodeJS.ProcessEnv;
}): OpencodeReadResult {
  const env = options.env ?? process.env;
  const dataDir = options.dataDir ?? opencodeDataDir(env);
  const dbPath = findOpencodeDb(dataDir, env);
  if (!dbPath) return { status: "not_found", dbPath: null, schema: null, rows: [] };
  let db: DatabaseSync | null = null;
  try {
    db = new DatabaseSync(dbPath, { readOnly: true });
    // OpenCode writes in WAL mode; a reader waits out a checkpoint instead of failing.
    db.exec("PRAGMA busy_timeout = 3000");
    db.exec("PRAGMA query_only = true");
    const cols = columnsOf(db);
    const schema = schemaOf(cols);
    if (!schema) {
      return { status: "error", dbPath, schema: null, rows: [], message: "Unrecognised OpenCode database layout." };
    }
    const params = {
      t5h: options.now - BUCKET_EDGES_MS[0],
      t24h: options.now - BUCKET_EDGES_MS[1],
      t7d: options.now - BUCKET_EDGES_MS[2],
    };
    const raw: Array<Record<string, unknown>> = [];
    // One snapshot for both queries: a step finishing in between is not counted twice.
    db.exec("BEGIN");
    try {
      if (schema !== "v1") raw.push(...(db.prepare(v2Query(cols)).all(params) as Array<Record<string, unknown>>));
      if (schema !== "v2") raw.push(...(db.prepare(v1Query(cols, schema === "mixed")).all(params) as Array<Record<string, unknown>>));
    } finally {
      db.exec("COMMIT");
    }
    const rows: OpencodeRow[] = [];
    for (const r of raw) {
      const bucket = Number(r.bucket);
      if (bucket !== 0 && bucket !== 1 && bucket !== 2) continue;
      rows.push({
        providerId: typeof r.providerId === "string" && r.providerId ? r.providerId : "unknown",
        modelId: typeof r.modelId === "string" && r.modelId ? r.modelId : "unknown",
        bucket,
        input: num(r.input),
        output: num(r.output),
        reasoning: num(r.reasoning),
        cacheRead: num(r.cacheRead),
        cacheWrite: num(r.cacheWrite),
        cost: num(r.cost),
        requests: num(r.requests),
      });
    }
    return { status: "ok", dbPath, schema, rows: merge(rows) };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    return { status: "error", dbPath, schema: null, rows: [], message };
  } finally {
    try {
      db?.close();
    } catch {
      // Already closed.
    }
  }
}
