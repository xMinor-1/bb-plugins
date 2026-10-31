// bb-plugin-sticker-note — backend.
//
// The board's cards live in one bb.storage.kv record. Every write publishes
// "cards-changed" so open boards (and the sidebar badge) refetch. Phrases are
// understood by the rule-based parser in src/parse.ts: it is instant, and bb
// has no text-model API for plugins. Agent chats are ordinary bb threads.
import { randomUUID } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { decide } from "./src/compose";
import { addDays } from "./src/dates";
import {
  cardSchema,
  columnOf,
  columnSchema,
  dueSchema,
  importanceSchema,
  kindSchema,
  parseResultSchema,
  type Card,
  type Due,
  type ParseResult,
} from "./src/model";
import { parsePhrase } from "./src/parse";

export type { Card, ParseResult } from "./src/model";

const nowSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}$/),
});
const textSchema = z.string().trim().min(1).max(2000);
const changedSchema = z.object({ card: cardSchema.nullable(), undoToken: z.string() });

export const rpcContract = defineRpcContract({
  cards_list: {
    input: z.null(),
    output: z.object({ cards: z.array(cardSchema) }),
  },
  /** A dictated or typed phrase from the board: a new task or a command. */
  capture: {
    input: z.object({ text: textSchema, now: nowSchema, spoken: z.boolean() }).strict(),
    output: z.object({
      parse: parseResultSchema,
      card: cardSchema.nullable(),
      undoToken: z.string().nullable(),
    }),
  },
  card_update: {
    input: z
      .object({
        id: z.string(),
        patch: z
          .object({
            title: z.string().trim().min(1).max(500).optional(),
            importance: importanceSchema.optional(),
            kind: kindSchema.optional(),
            due: dueSchema.nullable().optional(),
            links: z.array(z.string().trim().min(1).max(2000)).max(50).optional(),
            notes: z.array(z.string().trim().min(1).max(4000)).max(200).optional(),
            done: z.boolean().optional(),
          })
          .strict(),
      })
      .strict(),
    output: changedSchema,
  },
  /** Drag to a column: the due date follows the column. */
  card_move: {
    input: z.object({ id: z.string(), column: columnSchema, now: nowSchema }).strict(),
    output: changedSchema,
  },
  card_delete: {
    input: z.object({ id: z.string() }).strict(),
    output: changedSchema,
  },
  /** A phrase said inside an open card: a note, or a request for an agent chat. */
  card_compose: {
    input: z.object({ id: z.string(), text: textSchema }).strict(),
    output: z.object({ decision: z.enum(["note", "chat"]), card: cardSchema, undoToken: z.string() }),
  },
  undo: {
    input: z.object({ token: z.string() }).strict(),
    output: z.object({ restored: z.boolean() }),
  },
});

const CARDS_KEY = "cards";
const CHANGED = "cards-changed";
/** Finished cards older than this are dropped to keep the record small. */
const DONE_KEEP_DAYS = 60;
const UNDO_KEEP = 30;

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    chatProject: {
      type: "project",
      label: "Project for agent chats",
      description:
        "Where a request said inside a card starts its chat. Empty: a project named Personal (Личное) if there is one, otherwise the first project.",
    },
  });

  // ---------- storage ----------

  // Writes are serialized: two quick commands must not read the same old list.
  let queue: Promise<unknown> = Promise.resolve();
  function serial<T>(work: () => Promise<T>): Promise<T> {
    const next = queue.then(work, work);
    queue = next.catch(() => undefined);
    return next;
  }

  async function readCards(): Promise<Card[]> {
    const raw = (await bb.storage.kv.get<unknown[]>(CARDS_KEY)) ?? [];
    const cards: Card[] = [];
    for (const item of raw) {
      const parsed = cardSchema.safeParse(item);
      if (parsed.success) cards.push(parsed.data);
      else bb.log.warn(`dropping an unreadable card (${parsed.error.issues.length} issues)`);
    }
    return cards;
  }

  async function writeCards(cards: Card[]): Promise<void> {
    const cutoff = Date.now() - DONE_KEEP_DAYS * 86_400_000;
    const kept = cards.filter((c) => !c.done || c.doneAt === null || Date.parse(c.doneAt) > cutoff);
    await bb.storage.kv.set(CARDS_KEY, kept);
    bb.realtime.publish(CHANGED, { count: kept.length });
  }

  const undoStack = new Map<string, Card[]>();
  function remember(before: Card[]): string {
    const token = randomUUID();
    undoStack.set(token, structuredClone(before));
    while (undoStack.size > UNDO_KEEP) undoStack.delete(undoStack.keys().next().value!);
    return token;
  }

  function stamp(card: Card): Card {
    card.updatedAt = new Date().toISOString();
    return card;
  }

  function notFound(id: string): never {
    throw new Error(`No card with id ${id}`);
  }

  /** Runs a change on the list and returns the touched card and an undo token. */
  function change(id: string, mutate: (card: Card, cards: Card[]) => Card[] | void) {
    return serial(async () => {
      const cards = await readCards();
      const card = cards.find((c) => c.id === id) ?? notFound(id);
      const token = remember(cards);
      const next = mutate(card, cards) ?? cards;
      await writeCards(next);
      const after = next.find((c) => c.id === id) ?? null;
      return { card: after, undoToken: token };
    });
  }

  function newCard(fields: Partial<Card> & Pick<Card, "title">): Card {
    const at = new Date().toISOString();
    return {
      id: randomUUID().slice(0, 8),
      notes: [],
      links: [],
      importance: "normal",
      kind: "personal",
      due: null,
      remind: false,
      done: false,
      doneAt: null,
      said: null,
      chats: [],
      createdAt: at,
      updatedAt: at,
      ...fields,
    };
  }

  function setDone(card: Card, done: boolean) {
    card.done = done;
    card.doneAt = done ? new Date().toISOString() : null;
  }

  // ---------- agent chats ----------

  async function chatProjectId(): Promise<string> {
    const { chatProject } = await settings.get();
    if (chatProject) return chatProject;
    const projects = await bb.sdk.projects.list();
    const personal = projects.find((p) => /^(personal|личное)$/iu.test(p.name.trim()));
    const first = personal ?? projects[0];
    if (!first) throw new Error("bb has no projects to start a chat in");
    return first.id;
  }

  function chatPrompt(card: Card, request: string): string {
    const lines = [
      "A request from the user's Sticker Note board (a personal task list in bb).",
      "",
      `Task: ${card.title}`,
      `When: ${card.due ? `${card.due.date}${card.due.time ? ` ${card.due.time}` : ""}` : "no date"}`,
      `Kind: ${card.kind}`,
    ];
    if (card.notes.length) lines.push("Notes:", ...card.notes.map((n) => `- ${n}`));
    if (card.links.length) lines.push("Links:", ...card.links.map((l) => `- ${l}`));
    lines.push("", `Request: ${request}`, "", "Do what the request asks. Answer in the language of the request.");
    return lines.join("\n");
  }

  async function startChat(cardId: string, chatId: string, request: string) {
    let threadId: string | null = null;
    let error: string | null = null;
    try {
      const card = (await readCards()).find((c) => c.id === cardId);
      if (!card) return;
      const thread = await bb.sdk.threads.spawn({
        projectId: await chatProjectId(),
        environment: { type: "project-default" },
        prompt: chatPrompt(card, request),
        title: request.length > 80 ? `${request.slice(0, 77)}…` : request,
        pluginMetadata: { cardId },
      });
      threadId = thread.id;
    } catch (cause) {
      error = cause instanceof Error ? cause.message : String(cause);
      bb.log.warn(`agent chat did not start: ${error}`);
    }
    await serial(async () => {
      const cards = await readCards();
      const chat = cards.find((c) => c.id === cardId)?.chats.find((ch) => ch.id === chatId);
      if (!chat) return;
      chat.threadId = threadId;
      chat.error = error;
      await writeCards(cards);
    });
  }

  // ---------- phrases ----------

  function applyCommand(cards: Card[], parse: Extract<ParseResult, { type: "command" }>): Card[] {
    const card = cards.find((c) => c.id === parse.targetId) ?? notFound(parse.targetId);
    switch (parse.action) {
      case "done":
        setDone(card, true);
        break;
      case "undone":
        setDone(card, false);
        break;
      case "move":
        card.due = parse.due ?? null;
        card.remind = card.due !== null;
        if (card.done) setDone(card, false);
        break;
      case "importance":
        card.importance = parse.importance ?? "high";
        break;
      case "delete":
        return cards.filter((c) => c !== card);
    }
    stamp(card);
    return cards;
  }

  function dueForColumn(card: Card, column: z.infer<typeof columnSchema>, today: string): Due | null {
    if (column === "later") return null;
    if (column === "today") return { date: today, time: card.due?.time ?? null };
    // "soon": keep a date that already falls in the next week, else tomorrow.
    if (card.due && columnOf({ done: false, due: card.due }, today) === "soon") return card.due;
    return { date: addDays(today, 1), time: card.due?.time ?? null };
  }

  bb.rpc.register(rpcContract, {
    cards_list: async () => ({ cards: await readCards() }),

    capture: ({ text, now, spoken }) =>
      serial(async () => {
        const cards = await readCards();
        const parse = parsePhrase({ text, now, cards });
        if (parse.type === "ambiguous" || parse.type === "notFound") return { parse, card: null, undoToken: null };
        const token = remember(cards);
        if (parse.type === "create") {
          const card = newCard({
            ...parse.draft,
            remind: parse.draft.due !== null,
            said: spoken ? text : null,
          });
          await writeCards([...cards, card]);
          return { parse, card, undoToken: token };
        }
        const target = cards.find((c) => c.id === parse.targetId) ?? null;
        const before = target ? structuredClone(target) : null;
        const next = applyCommand(cards, parse);
        await writeCards(next);
        return { parse, card: next.find((c) => c.id === parse.targetId) ?? before, undoToken: token };
      }),

    card_update: ({ id, patch }) =>
      change(id, (card) => {
        if (patch.title !== undefined) card.title = patch.title;
        if (patch.importance !== undefined) card.importance = patch.importance;
        if (patch.kind !== undefined) card.kind = patch.kind;
        if (patch.links !== undefined) card.links = patch.links;
        if (patch.notes !== undefined) card.notes = patch.notes;
        if (patch.due !== undefined) {
          card.due = patch.due;
          card.remind = patch.due !== null;
        }
        if (patch.done !== undefined && patch.done !== card.done) setDone(card, patch.done);
        stamp(card);
      }),

    card_move: ({ id, column, now }) =>
      change(id, (card) => {
        if (column === "done") {
          if (!card.done) setDone(card, true);
        } else {
          if (card.done) setDone(card, false);
          card.due = dueForColumn(card, column, now.date);
          card.remind = card.due !== null;
        }
        stamp(card);
      }),

    card_delete: ({ id }) => change(id, (card, cards) => cards.filter((c) => c !== card)),

    card_compose: async ({ id, text }) => {
      const decision = decide(text);
      const chatId = randomUUID().slice(0, 8);
      const result = await change(id, (card) => {
        if (decision.type === "note") card.notes = [...card.notes, decision.text];
        else
          card.chats = [
            ...card.chats,
            { id: chatId, text: decision.text, threadId: null, error: null, createdAt: new Date().toISOString() },
          ];
        stamp(card);
      });
      if (decision.type === "chat") void startChat(id, chatId, decision.text);
      return { decision: decision.type, card: result.card!, undoToken: result.undoToken };
    },

    undo: ({ token }) =>
      serial(async () => {
        const before = undoStack.get(token);
        if (!before) return { restored: false };
        undoStack.delete(token);
        await writeCards(before);
        return { restored: true };
      }),
  });

  bb.log.info("loaded");
}
