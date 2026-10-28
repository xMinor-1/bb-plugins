// Review state in the plugin's own SQLite database: one row per reviewed
// document, one per comment, and one per message in a comment's thread. The
// file itself is never modified.
import { createHash, randomBytes } from "node:crypto";
import { UNNAMED, type SharedComment } from "./share.js";
import type { Anchor, CommentReply, CommentStatus, DocKind, ReviewComment } from "./types.js";

/** The subset of better-sqlite3 this module uses. */
export interface Db {
  prepare(sql: string): {
    run(...params: unknown[]): { changes: number };
    get(...params: unknown[]): unknown;
    all(...params: unknown[]): unknown[];
  };
  transaction<T extends (...args: never[]) => unknown>(fn: T): T;
}

/** Append-only: never edit or reorder a shipped statement. */
export const MIGRATIONS = [
  `CREATE TABLE docs (
     id TEXT PRIMARY KEY,
     host_id TEXT,
     abs_path TEXT NOT NULL,
     kind TEXT NOT NULL,
     next_seq INTEGER NOT NULL DEFAULT 1,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL
   )`,
  `CREATE TABLE comments (
     id TEXT PRIMARY KEY,
     doc_id TEXT NOT NULL REFERENCES docs(id) ON DELETE CASCADE,
     seq INTEGER NOT NULL,
     status TEXT NOT NULL,
     anchor TEXT NOT NULL,
     body TEXT NOT NULL,
     doc_version TEXT,
     created_at INTEGER NOT NULL,
     updated_at INTEGER NOT NULL,
     sent_at INTEGER,
     sent_thread_id TEXT,
     agent_note TEXT,
     resolved_at INTEGER
   )`,
  `CREATE INDEX comments_doc ON comments(doc_id, seq)`,
  `CREATE INDEX comments_status ON comments(status, sent_thread_id)`,
  // 0.2: PowerPoint joined Word and Excel under family names.
  `UPDATE docs SET kind = 'presentation' WHERE kind = 'pptx'`,
  // 0.4: a comment keeps its conversation with the agent.
  `CREATE TABLE replies (
     id TEXT PRIMARY KEY,
     comment_id TEXT NOT NULL REFERENCES comments(id) ON DELETE CASCADE,
     author TEXT NOT NULL,
     body TEXT NOT NULL,
     outcome TEXT,
     created_at INTEGER NOT NULL,
     sent_at INTEGER
   )`,
  `CREATE INDEX replies_comment ON replies(comment_id)`,
  `INSERT INTO replies (id, comment_id, author, body, outcome, created_at, sent_at)
     SELECT 'r_' || lower(hex(randomblob(6))), id, 'agent', agent_note,
       CASE status WHEN 'resolved' THEN 'resolved' ELSE 'replied' END,
       COALESCE(resolved_at, updated_at), COALESCE(resolved_at, updated_at)
     FROM comments WHERE agent_note IS NOT NULL AND agent_note != ''`,
  // 0.6: comments and replies imported from another reviewer's PDF.
  `ALTER TABLE comments ADD COLUMN author TEXT`,
  `ALTER TABLE comments ADD COLUMN origin_id TEXT`,
  `ALTER TABLE comments ADD COLUMN origin_file TEXT`,
  `ALTER TABLE replies ADD COLUMN name TEXT`,
  `ALTER TABLE replies ADD COLUMN origin_id TEXT`,
];

export interface DocRow {
  id: string;
  hostId: string | null;
  absPath: string;
  kind: DocKind;
}

interface RawDoc {
  id: string;
  host_id: string | null;
  abs_path: string;
  kind: DocKind;
}

interface RawComment {
  id: string;
  doc_id: string;
  seq: number;
  status: CommentStatus;
  anchor: string;
  body: string;
  doc_version: string | null;
  created_at: number;
  updated_at: number;
  sent_at: number | null;
  sent_thread_id: string | null;
  agent_note: string | null;
  resolved_at: number | null;
  author: string | null;
  origin_id: string | null;
  origin_file: string | null;
}

interface RawReply {
  id: string;
  comment_id: string;
  author: CommentReply["author"];
  name: string | null;
  origin_id: string | null;
  body: string;
  outcome: CommentReply["outcome"];
  created_at: number;
  sent_at: number | null;
}

/** Sent messages in the order they reached the other side, then the draft. */
const REPLY_ORDER = `r.sent_at IS NULL, r.sent_at, r.created_at, r.rowid`;

export interface CommentWithDoc extends ReviewComment {
  doc: DocRow;
}

/** Stable id for a file: the same path on the same host is the same doc. */
export function docIdFor(hostId: string | null, absPath: string): string {
  const digest = createHash("sha256")
    .update(`${hostId ?? ""}\u0000${absPath}`)
    .digest("hex");
  return `d_${digest.slice(0, 16)}`;
}

const ID_ALPHABET = "abcdefghijkmnpqrstuvwxyz23456789";

function newId(prefix: string): string {
  const bytes = randomBytes(6);
  let id = prefix;
  for (const byte of bytes) id += ID_ALPHABET[byte % ID_ALPHABET.length];
  return id;
}

function toDoc(raw: RawDoc): DocRow {
  return {
    id: raw.id,
    hostId: raw.host_id,
    absPath: raw.abs_path,
    kind: raw.kind,
  };
}

function toReply(raw: RawReply): CommentReply {
  return {
    id: raw.id,
    author: raw.author,
    name: raw.name,
    originId: raw.origin_id,
    body: raw.body,
    outcome: raw.outcome,
    createdAt: raw.created_at,
    sentAt: raw.sent_at,
  };
}

function toComment(raw: RawComment, thread: CommentReply[]): ReviewComment {
  const lastAgent = thread.filter((reply) => reply.author === "agent").at(-1);
  return {
    id: raw.id,
    seq: raw.seq,
    status: raw.status,
    anchor: JSON.parse(raw.anchor) as Anchor,
    body: raw.body,
    author: raw.author,
    originId: raw.origin_id,
    originFile: raw.origin_file,
    docVersion: raw.doc_version,
    createdAt: raw.created_at,
    updatedAt: raw.updated_at,
    sentAt: raw.sent_at,
    sentThreadId: raw.sent_thread_id,
    agentNote: lastAgent?.body ?? null,
    resolvedAt: raw.resolved_at,
    thread,
  };
}

export class ReviewStore {
  constructor(private readonly db: Db) {}

  upsertDoc(hostId: string | null, absPath: string, kind: DocKind): DocRow {
    // Windows separators identify the same file; keep its existing comment ids.
    const existing = /^[a-z]:[\\/]/i.test(absPath)
      ? this.db.prepare(`SELECT * FROM docs WHERE host_id IS ? AND replace(abs_path, char(92), '/') = ? ORDER BY created_at, id LIMIT 1`)
          .get(hostId, absPath.replace(/\\/g, "/")) as RawDoc | undefined
      : undefined;
    if (existing) absPath = existing.abs_path;
    const id = existing?.id ?? docIdFor(hostId, absPath);
    const now = Date.now();
    this.db
      .prepare(
        `INSERT INTO docs (id, host_id, abs_path, kind, created_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(id) DO UPDATE SET kind = excluded.kind, updated_at = excluded.updated_at`,
      )
      .run(id, hostId, absPath, kind, now, now);
    return { id, hostId, absPath, kind };
  }

  getDoc(id: string): DocRow | null {
    const raw = this.db.prepare(`SELECT * FROM docs WHERE id = ?`).get(id) as
      | RawDoc
      | undefined;
    return raw ? toDoc(raw) : null;
  }

  findDocsByPath(absPath: string): DocRow[] {
    return (
      this.db
        .prepare(`SELECT * FROM docs WHERE abs_path = ?`)
        .all(absPath) as RawDoc[]
    ).map(toDoc);
  }

  /** Documents that have comments, most recently active first. */
  listDocsWithCounts(limit: number): (DocRow & {
    counts: Record<CommentStatus, number>;
    lastActivity: number;
  })[] {
    const rows = this.db
      .prepare(
        `SELECT d.*,
           SUM(c.status = 'draft') AS draft,
           SUM(c.status = 'sent') AS sent,
           SUM(c.status = 'replied') AS replied,
           SUM(c.status = 'resolved') AS resolved,
           MAX(c.updated_at) AS last_activity
         FROM docs d JOIN comments c ON c.doc_id = d.id
         GROUP BY d.id ORDER BY last_activity DESC LIMIT ?`,
      )
      .all(limit) as (RawDoc & Record<CommentStatus, number> & { last_activity: number })[];
    return rows.map((row) => ({
      ...toDoc(row),
      counts: { draft: row.draft, sent: row.sent, replied: row.replied, resolved: row.resolved },
      lastActivity: row.last_activity,
    }));
  }

  listComments(docId: string): ReviewComment[] {
    const rows = this.db
      .prepare(`SELECT * FROM comments WHERE doc_id = ? ORDER BY seq`)
      .all(docId) as RawComment[];
    const replies = this.db
      .prepare(
        `SELECT r.* FROM replies r JOIN comments c ON c.id = r.comment_id
         WHERE c.doc_id = ? ORDER BY ${REPLY_ORDER}`,
      )
      .all(docId) as RawReply[];
    return this.withThreads(rows, replies);
  }

  getComment(id: string): CommentWithDoc | null {
    const raw = this.db.prepare(`SELECT * FROM comments WHERE id = ?`).get(id) as
      | RawComment
      | undefined;
    if (!raw) return null;
    const doc = this.getDoc(raw.doc_id);
    if (!doc) return null;
    return { ...toComment(raw, this.threadOf(id)), doc };
  }

  private threadOf(commentId: string): CommentReply[] {
    return (
      this.db
        .prepare(`SELECT r.* FROM replies r WHERE r.comment_id = ? ORDER BY ${REPLY_ORDER}`)
        .all(commentId) as RawReply[]
    ).map(toReply);
  }

  private withThreads(rows: RawComment[], replies: RawReply[]): ReviewComment[] {
    const threads = new Map<string, CommentReply[]>();
    for (const reply of replies) {
      const thread = threads.get(reply.comment_id) ?? [];
      thread.push(toReply(reply));
      threads.set(reply.comment_id, thread);
    }
    return rows.map((row) => toComment(row, threads.get(row.id) ?? []));
  }

  /** Comments across documents, newest documents first, for the CLI. */
  queryComments(filter: {
    statuses: CommentStatus[];
    threadId?: string | null;
    docIds?: string[];
    limit: number;
  }): CommentWithDoc[] {
    const clauses = [
      `status IN (${filter.statuses.map(() => "?").join(", ")})`,
    ];
    const params: unknown[] = [...filter.statuses];
    if (filter.threadId) {
      clauses.push(`sent_thread_id = ?`);
      params.push(filter.threadId);
    }
    if (filter.docIds) {
      if (filter.docIds.length === 0) return [];
      clauses.push(`doc_id IN (${filter.docIds.map(() => "?").join(", ")})`);
      params.push(...filter.docIds);
    }
    params.push(filter.limit);
    const rows = this.db
      .prepare(
        `SELECT * FROM comments WHERE ${clauses.join(" AND ")}
         ORDER BY doc_id, seq LIMIT ?`,
      )
      .all(...params) as RawComment[];
    const docs = new Map<string, DocRow | null>();
    const result: CommentWithDoc[] = [];
    for (const raw of rows) {
      if (!docs.has(raw.doc_id)) docs.set(raw.doc_id, this.getDoc(raw.doc_id));
      const doc = docs.get(raw.doc_id);
      if (doc) result.push({ ...toComment(raw, this.threadOf(raw.id)), doc });
    }
    return result;
  }

  createComment(input: {
    docId: string;
    anchor: Anchor;
    body: string;
    docVersion: string | null;
  }): ReviewComment {
    const create = this.db.transaction(() => {
      const doc = this.db
        .prepare(`SELECT next_seq FROM docs WHERE id = ?`)
        .get(input.docId) as { next_seq: number } | undefined;
      if (!doc) throw new Error(`Unknown document ${input.docId}`);
      const id = newId("c_");
      const now = Date.now();
      this.db
        .prepare(
          `INSERT INTO comments (id, doc_id, seq, status, anchor, body, doc_version, created_at, updated_at)
           VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?)`,
        )
        .run(
          id,
          input.docId,
          doc.next_seq,
          JSON.stringify(input.anchor),
          input.body,
          input.docVersion,
          now,
          now,
        );
      this.db
        .prepare(`UPDATE docs SET next_seq = next_seq + 1 WHERE id = ?`)
        .run(input.docId);
      return id;
    });
    const id = create();
    return this.requireComment(id);
  }

  /**
   * Comments from another reviewer's export, merged into a document. One seen
   * before (by its id here, or the id it had where it came from) only gains
   * the replies it lacks, and asks for attention if it was already sent. A new
   * one arrives as a draft under its author's name, with its thread.
   */
  importComments(input: {
    docId: string;
    docVersion: string | null;
    /** The file the comments were written on, kept when it is not this one. */
    originFile: string | null;
    comments: readonly SharedComment[];
  }): { added: number; updated: number } {
    const now = Date.now();
    const find = this.db.prepare(`SELECT id, status FROM comments WHERE doc_id = ? AND (id = ? OR origin_id = ?)`);
    const known = this.db.prepare(`SELECT id, origin_id FROM replies WHERE comment_id = ?`);
    const addReply = this.db.prepare(
      `INSERT INTO replies (id, comment_id, author, body, outcome, created_at, sent_at, name, origin_id)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)`,
    );
    const run = this.db.transaction(() => {
      let added = 0;
      let updated = 0;
      for (const shared of input.comments) {
        const thread = shared.thread.map((reply) => ({
          ...reply,
          // Someone else's words always carry a name, so they never read as "You".
          name: reply.name ?? (reply.author === "agent" ? null : UNNAMED),
        }));
        const existing = find.get(input.docId, shared.id, shared.id) as { id: string; status: CommentStatus } | undefined;
        if (existing) {
          const ids = new Set(
            (known.all(existing.id) as { id: string; origin_id: string | null }[]).flatMap((row) => [row.id, row.origin_id]),
          );
          const fresh = thread.filter((reply) => !ids.has(reply.id));
          for (const reply of fresh) {
            addReply.run(newId("r_"), existing.id, reply.author, reply.body, reply.outcome, reply.createdAt, reply.createdAt, reply.name, reply.id);
          }
          if (fresh.length > 0) {
            this.db
              .prepare(
                `UPDATE comments SET status = CASE WHEN status = 'draft' THEN 'draft' ELSE 'replied' END,
                   resolved_at = CASE WHEN status = 'draft' THEN resolved_at ELSE NULL END, updated_at = ?
                 WHERE id = ?`,
              )
              .run(now, existing.id);
            updated += 1;
          }
          continue;
        }
        const doc = this.db.prepare(`SELECT next_seq FROM docs WHERE id = ?`).get(input.docId) as
          | { next_seq: number }
          | undefined;
        if (!doc) throw new Error(`Unknown document ${input.docId}`);
        const id = newId("c_");
        this.db
          .prepare(
            `INSERT INTO comments (id, doc_id, seq, status, anchor, body, doc_version, created_at, updated_at,
               author, origin_id, origin_file)
             VALUES (?, ?, ?, 'draft', ?, ?, ?, ?, ?, ?, ?, ?)`,
          )
          .run(
            id,
            input.docId,
            doc.next_seq,
            JSON.stringify(shared.anchor),
            shared.body,
            input.docVersion,
            shared.createdAt,
            now,
            shared.author ?? UNNAMED,
            shared.id,
            input.originFile,
          );
        this.db.prepare(`UPDATE docs SET next_seq = next_seq + 1 WHERE id = ?`).run(input.docId);
        for (const reply of thread) {
          addReply.run(newId("r_"), id, reply.author, reply.body, reply.outcome, reply.createdAt, reply.createdAt, reply.name, reply.id);
        }
        added += 1;
      }
      return { added, updated };
    });
    return run();
  }

  /** How many of these comments an import would bring into the document: missing, or missing a reply. */
  countPending(docId: string, comments: readonly SharedComment[]): number {
    const find = this.db.prepare(`SELECT id FROM comments WHERE doc_id = ? AND (id = ? OR origin_id = ?)`);
    const replies = this.db.prepare(`SELECT id, origin_id FROM replies WHERE comment_id = ?`);
    return comments.filter((comment) => {
      const row = find.get(docId, comment.id, comment.id) as { id: string } | undefined;
      if (!row) return true;
      const known = new Set(
        (replies.all(row.id) as { id: string; origin_id: string | null }[]).flatMap((reply) => [reply.id, reply.origin_id]),
      );
      return comment.thread.some((reply) => !known.has(reply.id));
    }).length;
  }

  /** Documents holding any of these comments (by their id or the id they came with), most first. */
  docsHolding(ids: readonly string[]): string[] {
    if (ids.length === 0) return [];
    const marks = ids.map(() => "?").join(", ");
    return (
      this.db
        .prepare(
          `SELECT doc_id, COUNT(*) AS n FROM comments WHERE id IN (${marks}) OR origin_id IN (${marks})
           GROUP BY doc_id ORDER BY n DESC`,
        )
        .all(...ids, ...ids) as { doc_id: string }[]
    ).map((row) => row.doc_id);
  }

  updateBody(id: string, body: string): ReviewComment {
    this.db
      .prepare(`UPDATE comments SET body = ?, updated_at = ? WHERE id = ?`)
      .run(body, Date.now(), id);
    return this.requireComment(id);
  }

  deleteComment(id: string): boolean {
    const remove = this.db.transaction(() => {
      this.db.prepare(`DELETE FROM replies WHERE comment_id = ?`).run(id);
      return this.db.prepare(`DELETE FROM comments WHERE id = ?`).run(id).changes > 0;
    });
    return remove();
  }

  /**
   * The user's answer in a comment's thread. It waits as a draft, and the
   * comment with it, until the drafts are sent; writing again replaces it.
   */
  saveReply(id: string, body: string): ReviewComment {
    const now = Date.now();
    const save = this.db.transaction(() => {
      const changed = this.db
        .prepare(
          `UPDATE replies SET body = ?, created_at = ?
           WHERE comment_id = ? AND author = 'user' AND sent_at IS NULL`,
        )
        .run(body, now, id).changes;
      if (changed === 0) {
        this.db
          .prepare(
            `INSERT INTO replies (id, comment_id, author, body, outcome, created_at, sent_at)
             VALUES (?, ?, 'user', ?, NULL, ?, NULL)`,
          )
          .run(newId("r_"), id, body, now);
      }
      this.db
        .prepare(
          `UPDATE comments SET status = 'draft', resolved_at = NULL, updated_at = ? WHERE id = ?`,
        )
        .run(now, id);
    });
    save();
    return this.requireComment(id);
  }

  /** Drops the unsent reply; the comment returns to where its thread left it. */
  discardReply(id: string): ReviewComment {
    const discard = this.db.transaction(() => {
      this.db
        .prepare(`DELETE FROM replies WHERE comment_id = ? AND author = 'user' AND sent_at IS NULL`)
        .run(id);
      const last = this.threadOf(id).at(-1);
      const raw = this.db.prepare(`SELECT sent_at FROM comments WHERE id = ?`).get(id) as
        | { sent_at: number | null }
        | undefined;
      const status: CommentStatus =
        last?.author === "agent"
          ? last.outcome === "resolved"
            ? "resolved"
            : "replied"
          : raw?.sent_at
            ? "sent"
            : "draft";
      this.db
        .prepare(
          `UPDATE comments SET status = ?,
             resolved_at = CASE WHEN ? = 'resolved' THEN ? ELSE NULL END, updated_at = ?
           WHERE id = ?`,
        )
        .run(status, status, last?.createdAt ?? null, Date.now(), id);
    });
    discard();
    return this.requireComment(id);
  }

  /** Back to draft so it can be edited and sent again; the agent note stays visible. */
  reopen(id: string): ReviewComment {
    this.db
      .prepare(
        `UPDATE comments SET status = 'draft', resolved_at = NULL, updated_at = ? WHERE id = ?`,
      )
      .run(Date.now(), id);
    return this.requireComment(id);
  }

  markSent(ids: string[], threadId: string | null): number {
    const now = Date.now();
    const statement = this.db.prepare(
      `UPDATE comments SET status = 'sent', sent_at = ?, sent_thread_id = ?,
         resolved_at = NULL, updated_at = ?
       WHERE id = ?`,
    );
    const replies = this.db.prepare(
      `UPDATE replies SET sent_at = ? WHERE comment_id = ? AND author = 'user' AND sent_at IS NULL`,
    );
    const run = this.db.transaction(() => {
      let changed = 0;
      for (const id of ids) {
        changed += statement.run(now, threadId, now, id).changes;
        replies.run(now, id);
      }
      return changed;
    });
    return run();
  }

  resolve(id: string, note: string | null): ReviewComment {
    return this.answer(id, "resolved", note);
  }

  reply(id: string, note: string): ReviewComment {
    return this.answer(id, "replied", note);
  }

  /**
   * The agent's answer joins the thread. A reply the user is still writing
   * keeps the comment a draft, so it is not lost behind the new status.
   */
  private answer(id: string, outcome: "replied" | "resolved", note: string | null): ReviewComment {
    const now = Date.now();
    const run = this.db.transaction(() => {
      if (note) {
        this.db
          .prepare(
            `INSERT INTO replies (id, comment_id, author, body, outcome, created_at, sent_at)
             VALUES (?, ?, 'agent', ?, ?, ?, ?)`,
          )
          .run(newId("r_"), id, note, outcome, now, now);
      }
      this.db
        .prepare(
          `UPDATE comments SET
             status = CASE WHEN EXISTS (
               SELECT 1 FROM replies WHERE comment_id = comments.id AND author = 'user' AND sent_at IS NULL
             ) THEN 'draft' ELSE ? END,
             agent_note = ?, resolved_at = ?, updated_at = ?
           WHERE id = ?`,
        )
        .run(outcome, note, outcome === "resolved" ? now : null, now, id);
    });
    run();
    return this.requireComment(id);
  }

  private requireComment(id: string): ReviewComment {
    const comment = this.getComment(id);
    if (!comment) throw new Error(`No comment with id ${id}`);
    const { doc: _doc, ...rest } = comment;
    return rest;
  }
}
