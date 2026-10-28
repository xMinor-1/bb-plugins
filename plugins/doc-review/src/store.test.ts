import { DatabaseSync } from "node:sqlite";
import Database from "better-sqlite3";
import { describe, expect, it } from "vitest";
import { buildShared } from "./share";
import { MIGRATIONS, ReviewStore, type Db } from "./store";

function setup(migrations = MIGRATIONS) {
  const db = new Database(":memory:");
  for (const statement of migrations) db.exec(statement);
  const store = new ReviewStore(db as unknown as Db);
  const doc = store.upsertDoc(null, "/notes/plan.md", "md");
  return { db, store, doc };
}

function sentComment(store: ReviewStore, docId: string) {
  const comment = store.createComment({
    docId,
    anchor: { kind: "doc" },
    body: "Move the block to settings",
    docVersion: null,
  });
  store.markSent([comment.id], "thr_a");
  return comment;
}

describe("comment threads", () => {
  it("keeps every answer and reply in order", () => {
    const { store, doc } = setup();
    const comment = sentComment(store, doc.id);

    store.reply(comment.id, "Into the board settings?");
    const drafted = store.saveReply(comment.id, "Yes, and keep it on check-in");
    expect(drafted.status).toBe("draft");
    expect(drafted.thread.map((reply) => [reply.author, reply.sentAt === null])).toEqual([
      ["agent", false],
      ["user", true],
    ]);

    // Writing again replaces the unsent reply instead of adding another.
    expect(store.saveReply(comment.id, "Yes, keep it on check-in").thread).toHaveLength(2);

    store.markSent([comment.id], "thr_b");
    const done = store.resolve(comment.id, "Moved, check-in kept");
    expect(done.status).toBe("resolved");
    expect(done.agentNote).toBe("Moved, check-in kept");
    expect(done.thread.map((reply) => `${reply.author}: ${reply.body}`)).toEqual([
      "agent: Into the board settings?",
      "user: Yes, keep it on check-in",
      "agent: Moved, check-in kept",
    ]);
  });

  it("keeps a reply the user is writing when the agent answers meanwhile", () => {
    const { store, doc } = setup();
    const comment = sentComment(store, doc.id);
    store.reply(comment.id, "Which block?");
    store.saveReply(comment.id, "The mood one");
    const answered = store.resolve(comment.id, "Done anyway");
    expect(answered.status).toBe("draft");
    expect(answered.thread.at(-1)).toMatchObject({ author: "user", sentAt: null });
  });

  it("returns a discarded reply's comment to where the thread left it", () => {
    const { store, doc } = setup();
    const comment = sentComment(store, doc.id);
    store.reply(comment.id, "Which block?");
    store.saveReply(comment.id, "The mood one");
    expect(store.discardReply(comment.id)).toMatchObject({
      status: "replied",
      thread: [{ author: "agent" }],
    });

    store.resolve(comment.id, "Removed it");
    store.saveReply(comment.id, "Not removed, moved");
    const back = store.discardReply(comment.id);
    expect(back.status).toBe("resolved");
    expect(back.resolvedAt).not.toBeNull();
  });

  it("deletes the thread with its comment", () => {
    const { db, store, doc } = setup();
    const comment = sentComment(store, doc.id);
    store.reply(comment.id, "Why?");
    store.deleteComment(comment.id);
    expect(db.prepare(`SELECT COUNT(*) AS n FROM replies`).get()).toEqual({ n: 0 });
  });

  it("moves notes written before threads into them", () => {
    const shipped = MIGRATIONS.slice(0, 5);
    const { db, store, doc } = setup(shipped);
    db.prepare(
      `INSERT INTO comments (id, doc_id, seq, status, anchor, body, created_at, updated_at, agent_note)
       VALUES ('c_old', ?, 1, 'replied', '{"kind":"doc"}', 'Shorter', 1, 2, 'Old question')`,
    ).run(doc.id);
    for (const statement of MIGRATIONS.slice(5)) db.exec(statement);
    expect(store.getComment("c_old")?.thread).toMatchObject([
      { author: "agent", body: "Old question", outcome: "replied" },
    ]);
  });
});

describe("comments from another reviewer", () => {
  const file = { name: "deck.pptx", kind: "presentation" as const, pages: 3 };

  function deck(store: ReviewStore, path: string) {
    return store.upsertDoc(null, path, "presentation");
  }

  it("arrive as drafts under their author and come back with the colleague's replies", () => {
    // Фома comments on the deck and exports it.
    const mine = setup();
    const doc = deck(mine.store, "/fom/deck.pptx");
    const comment = mine.store.createComment({ docId: doc.id, anchor: { kind: "page-area", page: 2, rect: { x: 0, y: 0, w: 0.5, h: 0.5 }, text: "" }, body: "Убрать график", docVersion: null });
    mine.store.markSent([comment.id], "thr_a");
    const out = buildShared({ comments: mine.store.listComments(doc.id), file, signer: "Фома" });

    // Коля imports it into his own copy of the deck.
    const theirs = setup();
    const copy = deck(theirs.store, "/kol/deck.pptx");
    expect(theirs.store.importComments({ docId: copy.id, docVersion: "v1", originFile: null, comments: out.comments })).toEqual({ added: 1, updated: 0 });
    const [imported] = theirs.store.listComments(copy.id);
    expect(imported).toMatchObject({ status: "draft", author: "Фома", originId: comment.id, body: "Убрать график", docVersion: "v1" });

    // Importing the same file again adds nothing.
    expect(theirs.store.importComments({ docId: copy.id, docVersion: "v1", originFile: null, comments: out.comments })).toEqual({ added: 0, updated: 0 });

    // He answers and sends the deck back.
    theirs.store.saveReply(imported!.id, "График нужен для отчёта");
    theirs.store.markSent([imported!.id], "thr_k");
    const back = buildShared({ comments: theirs.store.listComments(copy.id), file, signer: "Коля" });
    expect(back.comments[0]!.id).toBe(comment.id);

    // Фома imports the answer: it joins his comment's thread, which now needs him.
    expect(mine.store.importComments({ docId: doc.id, docVersion: null, originFile: null, comments: back.comments })).toEqual({ added: 0, updated: 1 });
    const [updated] = mine.store.listComments(doc.id);
    expect(updated!.status).toBe("replied");
    expect(updated!.thread.map((reply) => [reply.author, reply.name, reply.body])).toEqual([["user", "Коля", "График нужен для отчёта"]]);

    // And a second import of the same answer changes nothing.
    expect(mine.store.importComments({ docId: doc.id, docVersion: null, originFile: null, comments: back.comments })).toEqual({ added: 0, updated: 0 });
  });

  it("counts a known comment with a new reply as still to import, and finds where it lives", () => {
    const { store } = setup();
    const doc = deck(store, "/fom/deck.pptx");
    const mine = store.createComment({ docId: doc.id, anchor: { kind: "doc" }, body: "Ок?", docVersion: null });
    const back = [{ id: mine.id, author: "Фома", anchor: { kind: "doc" as const }, body: "Ок?", createdAt: 1, thread: [{ id: "r_k", author: "user" as const, name: "Коля", body: "Да", outcome: null, createdAt: 2 }] }];
    expect(store.countPending(doc.id, back)).toBe(1);
    expect(store.docsHolding([mine.id])).toEqual([doc.id]);
    store.importComments({ docId: doc.id, docVersion: null, originFile: null, comments: back });
    expect(store.countPending(doc.id, back)).toBe(0);
  });

  it("names a reviewer who did not sign", () => {
    const { store } = setup();
    const doc = deck(store, "/x/deck.pptx");
    store.importComments({
      docId: doc.id,
      docVersion: null,
      originFile: "deck.pptx",
      comments: [{ id: "c_far", author: null, anchor: { kind: "doc" }, body: "Ок", createdAt: 1, thread: [{ id: "r_far", author: "user", name: null, body: "Да", outcome: null, createdAt: 2 }] }],
    });
    const [comment] = store.listComments(doc.id);
    expect(comment!.author).toBe("Reviewer");
    expect(comment!.originFile).toBe("deck.pptx");
    expect(comment!.thread[0]!.name).toBe("Reviewer");
  });
});

it("keeps Windows document identity across separators and isolates hosts", () => {
  const db = new DatabaseSync(":memory:");
  try {
    for (const sql of MIGRATIONS) db.exec(sql);
    const store = new ReviewStore(db as unknown as Db);
    const original = store.upsertDoc("windows", "D:\\Reports/audit.html", "html");
    expect(store.upsertDoc("windows", "D:/Reports/audit.html", "html")).toEqual(original);
    expect(store.upsertDoc("another-host", "D:/Reports/audit.html", "html").id).not.toBe(original.id);
    expect(db.prepare("SELECT count(*) AS count FROM docs").get()?.count).toBe(2);
  } finally {
    db.close();
  }
});
