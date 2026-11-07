import { DatabaseSync } from "node:sqlite";
import { mkdtempSync, rmSync, writeFileSync, utimesSync } from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { findOpencodeDb, opencodeDataDir, readOpencodeUsage, type OpencodeRow } from "../src/opencode/reader";

const NOW = Date.UTC(2026, 10, 7, 12, 0, 0);
const H = 60 * 60_000;
const dirs: string[] = [];

function tempDir(): string {
  const dir = mkdtempSync(path.join(os.tmpdir(), "mu-oc-"));
  dirs.push(dir);
  return dir;
}

afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

const tokens = (input: number, output: number, reasoning = 0, read = 0, write = 0) => ({
  input,
  output,
  reasoning,
  cache: { read, write },
});

function v2Db(file: string): DatabaseSync {
  const db = new DatabaseSync(file);
  db.exec("PRAGMA journal_mode = WAL");
  db.exec(`CREATE TABLE session_v2 (id TEXT PRIMARY KEY, parent_id TEXT, fork_session_id TEXT, time_created INTEGER);
           CREATE TABLE session_message (id TEXT PRIMARY KEY, session_id TEXT, type TEXT, seq INTEGER, time_created INTEGER, time_updated INTEGER, data TEXT);`);
  return db;
}

function addV2(db: DatabaseSync, id: string, session: string, type: string, at: number, data: object) {
  db.prepare("INSERT INTO session_message (id, session_id, type, seq, time_created, time_updated, data) VALUES (?, ?, ?, 0, ?, ?, ?)").run(id, session, type, at, at, JSON.stringify(data));
}

function v1Tables(db: DatabaseSync) {
  db.exec(`CREATE TABLE message (id TEXT PRIMARY KEY, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);
           CREATE TABLE part (id TEXT PRIMARY KEY, message_id TEXT, session_id TEXT, time_created INTEGER, time_updated INTEGER, data TEXT);`);
}

function addV1(db: DatabaseSync, id: string, at: number, providerID: string, modelID: string, steps: Array<{ at: number; tokens: object; cost?: number }>) {
  db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES (?, 's1', ?, ?, ?)").run(id, at, at, JSON.stringify({ role: "assistant", providerID, modelID, tokens: steps.at(-1)?.tokens }));
  steps.forEach((step, i) => {
    db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, 's1', ?, ?, ?)").run(`${id}-p${i}`, id, step.at, step.at, JSON.stringify({ type: "step-finish", tokens: step.tokens, cost: step.cost ?? 0 }));
  });
  db.prepare("INSERT INTO part (id, message_id, session_id, time_created, time_updated, data) VALUES (?, ?, 's1', ?, ?, ?)").run(`${id}-text`, id, at, at, JSON.stringify({ type: "text", text: "secret reply" }));
}

const find = (rows: OpencodeRow[], model: string, bucket: number) => rows.find((r) => r.modelId === model && r.bucket === bucket);

describe("opencode data dir", () => {
  it("follows XDG_DATA_HOME only when it is absolute", () => {
    expect(opencodeDataDir({ XDG_DATA_HOME: "/x/data" }, "/home/u")).toBe("/x/data/opencode");
    expect(opencodeDataDir({ XDG_DATA_HOME: "rel" }, "/home/u")).toBe("/home/u/.local/share/opencode");
    expect(opencodeDataDir({}, "/home/u")).toBe("/home/u/.local/share/opencode");
  });

  it("prefers OPENCODE_DB, then opencode.db, then the newest channel file", () => {
    const dir = tempDir();
    expect(findOpencodeDb(dir, {})).toBeNull();
    writeFileSync(path.join(dir, "opencode-beta.db"), "");
    writeFileSync(path.join(dir, "opencode-local.db"), "");
    writeFileSync(path.join(dir, "opencode-local.db-wal"), "");
    utimesSync(path.join(dir, "opencode-beta.db"), new Date(NOW - H), new Date(NOW - H));
    utimesSync(path.join(dir, "opencode-local.db"), new Date(NOW), new Date(NOW));
    expect(findOpencodeDb(dir, {})).toBe(path.join(dir, "opencode-local.db"));
    writeFileSync(path.join(dir, "opencode.db"), "");
    expect(findOpencodeDb(dir, {})).toBe(path.join(dir, "opencode.db"));
    expect(findOpencodeDb(dir, { OPENCODE_DB: "opencode-beta.db" })).toBe(path.join(dir, "opencode-beta.db"));
    expect(findOpencodeDb(dir, { OPENCODE_DB: path.join(dir, "missing.db") })).toBeNull();
  });
});

describe("readOpencodeUsage", () => {
  it("reports a machine without OpenCode as not found", () => {
    expect(readOpencodeUsage({ now: NOW, dataDir: tempDir(), env: {} }).status).toBe("not_found");
  });

  it("sums 2.x steps per model and bucket, skipping unfinished steps, user turns and copied fork history", () => {
    const dir = tempDir();
    const db = v2Db(path.join(dir, "opencode.db"));
    db.prepare("INSERT INTO session_v2 (id, fork_session_id, time_created) VALUES ('a', NULL, ?), ('fork', 'a', ?)").run(NOW - 50 * H, NOW - 2 * H);
    const model = { providerID: "corp", id: "code-large" };
    addV2(db, "m1", "a", "assistant", NOW - 1 * H, { model, tokens: tokens(100, 10, 5, 1000, 50), cost: 0.5 });
    addV2(db, "m2", "a", "assistant", NOW - 3 * H, { model, tokens: tokens(200, 20, 0, 2000, 0), cost: 0 });
    addV2(db, "m3", "a", "assistant", NOW - 10 * H, { model, tokens: tokens(300, 30) });
    addV2(db, "m4", "a", "compaction", NOW - 30 * H, { model, tokens: tokens(400, 40) });
    addV2(db, "m5", "a", "assistant", NOW - 8 * 24 * H, { model, tokens: tokens(999, 999) });
    addV2(db, "m6", "a", "assistant", NOW - 1 * H, { model }); // still streaming: no tokens yet
    addV2(db, "m7", "a", "user", NOW - 1 * H, { text: "hello", tokens: tokens(7, 7) });
    // The fork carries a copy of m3 with its original time, then a step of its own.
    addV2(db, "f1", "fork", "assistant", NOW - 10 * H, { model, tokens: tokens(300, 30) });
    addV2(db, "f2", "fork", "assistant", NOW - 1 * H, { model, tokens: tokens(1, 1) });
    db.close();

    const result = readOpencodeUsage({ now: NOW, dataDir: dir, env: {} });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.schema).toBe("v2");
    const b0 = find(result.rows, "code-large", 0)!;
    expect(b0).toMatchObject({ providerId: "corp", input: 301, output: 31, reasoning: 5, cacheRead: 3000, cacheWrite: 50, requests: 3, cost: 0.5 });
    expect(find(result.rows, "code-large", 1)).toMatchObject({ input: 300, output: 30, requests: 1 });
    expect(find(result.rows, "code-large", 2)).toMatchObject({ input: 400, output: 40, requests: 1 });
    expect(result.rows.reduce((a, r) => a + r.input, 0)).toBe(1001);
  });

  it("sums every 1.x step, not only the last one a message keeps", () => {
    const dir = tempDir();
    const db = new DatabaseSync(path.join(dir, "opencode.db"));
    v1Tables(db);
    addV1(db, "m1", NOW - 2 * H, "zen", "free-model", [
      { at: NOW - 2 * H, tokens: tokens(10, 1, 0, 100, 5), cost: 0.01 },
      { at: NOW - 2 * H + 1000, tokens: tokens(20, 2, 1, 200, 0), cost: 0.02 },
    ]);
    addV1(db, "m2", NOW - 6 * H, "zen", "free-model", [{ at: NOW - 6 * H, tokens: tokens(30, 3) }]);
    db.prepare("INSERT INTO message (id, session_id, time_created, time_updated, data) VALUES ('u1', 's1', ?, ?, ?)").run(NOW - H, NOW - H, JSON.stringify({ role: "user" }));
    db.close();

    const result = readOpencodeUsage({ now: NOW, dataDir: dir, env: {} });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.schema).toBe("v1");
    expect(find(result.rows, "free-model", 0)).toMatchObject({ providerId: "zen", input: 30, output: 3, reasoning: 1, cacheRead: 300, cacheWrite: 5, requests: 2 });
    expect(find(result.rows, "free-model", 0)!.cost).toBeCloseTo(0.03);
    expect(find(result.rows, "free-model", 1)).toMatchObject({ input: 30, requests: 1 });
  });

  it("counts a message imported from 1.x into 2.x once", () => {
    const dir = tempDir();
    const db = v2Db(path.join(dir, "opencode.db"));
    v1Tables(db);
    db.prepare("INSERT INTO session_v2 (id, fork_session_id, time_created) VALUES ('s1', NULL, ?)").run(NOW - 100 * H);
    addV1(db, "old", NOW - 2 * H, "zen", "m", [{ at: NOW - 2 * H, tokens: tokens(10, 1) }]);
    addV1(db, "only-v1", NOW - 2 * H, "zen", "m", [{ at: NOW - 2 * H, tokens: tokens(5, 1) }]);
    addV2(db, "old", "s1", "assistant", NOW - 2 * H, { model: { providerID: "zen", id: "m" }, tokens: tokens(10, 1) });
    db.close();

    const result = readOpencodeUsage({ now: NOW, dataDir: dir, env: {} });
    expect(result.status).toBe("ok");
    if (result.status !== "ok") return;
    expect(result.schema).toBe("mixed");
    expect(find(result.rows, "m", 0)).toMatchObject({ input: 15, output: 2, requests: 2 });
  });

  it("reads while OpenCode holds the database open in WAL mode", () => {
    const dir = tempDir();
    const writer = v2Db(path.join(dir, "opencode.db"));
    writer.prepare("INSERT INTO session_v2 (id, fork_session_id, time_created) VALUES ('a', NULL, ?)").run(NOW - 50 * H);
    addV2(writer, "m1", "a", "assistant", NOW - H, { model: { providerID: "p", id: "x" }, tokens: tokens(1, 1) });
    const result = readOpencodeUsage({ now: NOW, dataDir: dir, env: {} });
    writer.close();
    expect(result.status).toBe("ok");
    if (result.status === "ok") expect(result.rows).toHaveLength(1);
  });

  it("returns an error, not an exception, for a file that is not OpenCode's", () => {
    const dir = tempDir();
    const db = new DatabaseSync(path.join(dir, "opencode.db"));
    db.exec("CREATE TABLE something (id TEXT)");
    db.close();
    const result = readOpencodeUsage({ now: NOW, dataDir: dir, env: {} });
    expect(result.status).toBe("error");
    writeFileSync(path.join(dir, "opencode.db"), "not a database at all");
    expect(readOpencodeUsage({ now: NOW, dataDir: dir, env: {} }).status).toBe("error");
  });
});
