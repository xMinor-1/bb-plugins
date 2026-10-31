// bb-plugin-sticker-note — backend.
//
// The board's cards live in one bb.storage.kv record. Every write publishes
// "cards-changed" so open boards (and the sidebar badge) refetch. Phrases are
// understood by the rule-based parser in src/parse.ts: it is instant, and bb
// has no text-model API for plugins.
//
// Cards and agent chats work both ways. A job said on the board or inside a
// card starts an ordinary bb thread; the card follows it (working, answered,
// waiting for the user) and keeps the agent's last answer, and what the user
// says in the card next goes on to that thread. The other way, an agent in any
// thread makes and changes stickers through the `bb sticker-note` command and
// native tools (src/agent-surface.ts), and the app adds a "To sticker" action
// to chat messages.
import { randomUUID } from "node:crypto";
import { defineRpcContract, type BbPluginApi } from "@get-bb/plugin-sdk";
import { z } from "zod";

import { liveChat } from "./src/agent-state";
import { registerAgentSurface, type AddInput, type UpdateInput } from "./src/agent-surface";
import { asksUser, decide, isAgentJob, isExplicitNote, jobText, wantsNewChat } from "./src/compose";
import { addDays, type LocalNow } from "./src/dates";
import {
  actionSchema,
  cardSchema,
  columnOf,
  columnSchema,
  dueSchema,
  importanceSchema,
  kindSchema,
  parseResultSchema,
  type Card,
  type Chat,
  type Due,
  type ParseResult,
} from "./src/model";
import { draftOf, linksIn, parsePhrase, parseWhen } from "./src/parse";
import { clip, firstSentence, plainText } from "./src/text";

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
  /** A dictated or typed phrase from the board: a new task, a job for an agent, or a command. */
  capture: {
    input: z
      .object({
        text: textSchema,
        now: nowSchema,
        spoken: z.boolean(),
        /** The card the user dealt with last, for phrases like "close the task". */
        contextId: z.string().max(64).nullable().optional(),
      })
      .strict(),
    output: z.object({
      parse: parseResultSchema,
      /** The first card created, changed or opened. */
      card: cardSchema.nullable(),
      /** Every card the phrase touched, as it is now (as it was, if deleted). */
      cards: z.array(cardSchema),
      /** The new card went to an agent as a job. */
      agent: z.boolean(),
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
            notes: z.array(z.string().trim().min(1).max(8000)).max(200).optional(),
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
  /** The user opened the card: the agent's answers on it are seen. */
  card_seen: {
    input: z.object({ id: z.string() }).strict(),
    output: z.null(),
  },
  /**
   * A phrase said inside an open card: a note, a command on this card, a new
   * agent chat, or the next message in the card's chat.
   */
  card_compose: {
    input: z.object({ id: z.string(), text: textSchema, now: nowSchema }).strict(),
    output: z.object({
      decision: z.enum(["note", "chat", "sent", "command"]),
      /** For "command". */
      action: actionSchema.nullable(),
      /** The note or message as stored or sent. */
      text: z.string(),
      /** The card before the change, for the log line ("Closed: …", "Deleted: …"). */
      before: cardSchema,
      /** Null when the command deleted it. */
      card: cardSchema.nullable(),
      /** Null for a message sent to a chat: it cannot be taken back. */
      undoToken: z.string().nullable(),
    }),
  },
  /** "To sticker" on a chat message: a card with the message, linked to its thread. */
  chat_to_card: {
    input: z
      .object({
        threadId: z.string().min(1).max(64),
        text: z.string().trim().min(1).max(50_000),
        /** The user highlighted this text: all of it is the task. */
        selected: z.boolean(),
        now: nowSchema,
      })
      .strict(),
    output: z.object({ card: cardSchema, undoToken: z.string() }),
  },
  undo: {
    input: z.object({ token: z.string() }).strict(),
    output: z.object({ restored: z.boolean() }),
  },
});

const CARDS_KEY = "cards";
/** The last sticker number given out; numbers are never reused. */
const SEQ_KEY = "seq";
/** Minutes between the user's clock and UTC, learned from the board. */
const TZ_KEY = "tz-offset";
const CHANGED = "cards-changed";
/** Finished cards older than this are dropped to keep the record small. */
const DONE_KEEP_DAYS = 60;
const UNDO_KEEP = 30;
/** An agent's answer kept on the card; the whole answer stays in the chat. */
const REPLY_MAX = 6000;
const NOTE_MAX = 8000;

export default async function plugin(bb: BbPluginApi) {
  const settings = bb.settings.define({
    hotkey: {
      type: "string",
      label: "Dictation hotkey",
      description:
        "Press to start dictating, press again to add. Works anywhere in bb: elsewhere it opens the board first. Examples: Alt+S, Ctrl+Shift+Space, Cmd+J, F2. Letters follow the physical key, so the keyboard layout does not matter. Empty turns the hotkey off.",
      default: "Alt+S",
    },
    chatProject: {
      type: "project",
      label: "Project for agent chats",
      description:
        "Where a job said on the board or inside a card starts its chat, in that project's default environment. Empty: your personal threads, in a personal workspace with no copy of any repository.",
    },
    workChatProject: {
      type: "project",
      label: "Project for agent chats about work",
      description:
        "Jobs on cards marked Work start their chats here, in this project's own default environment: for example a project on the machine that reaches your work mail. Empty: the project above.",
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

  /** Threads whose cards follow them: events from every other thread are ignored without a read. */
  let followed = new Set<string>();
  function index(cards: Card[]) {
    followed = new Set(cards.flatMap((c) => c.chats.filter((ch) => ch.follow && ch.threadId).map((ch) => ch.threadId!)));
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
    index(kept);
    bb.realtime.publish(CHANGED, { count: kept.length });
  }

  // Undo puts back only the cards an action touched, so pressing it minutes
  // later never wipes edits made to other cards in between.
  const undoStack = new Map<string, Map<string, Card | null>>();
  function remember(before: Card[], ids: string[]): string {
    const token = randomUUID();
    const entry = new Map<string, Card | null>();
    for (const id of ids) {
      const card = before.find((c) => c.id === id);
      entry.set(id, card ? structuredClone(card) : null);
    }
    undoStack.set(token, entry);
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
      const token = remember(cards, [id]);
      const next = mutate(card, cards) ?? cards;
      await writeCards(next);
      const after = next.find((c) => c.id === id) ?? null;
      return { card: after, undoToken: token };
    });
  }

  /** The next sticker number. Call inside serial(). */
  async function nextNum(): Promise<number> {
    const seq = ((await bb.storage.kv.get<number>(SEQ_KEY)) ?? 0) + 1;
    await bb.storage.kv.set(SEQ_KEY, seq);
    return seq;
  }

  // Cards from before numbering get numbers in the order they were created.
  await serial(async () => {
    const raw = (await bb.storage.kv.get<Record<string, unknown>[]>(CARDS_KEY)) ?? [];
    const missing = raw.filter((c) => typeof c.num !== "number");
    if (missing.length === 0) return;
    let seq = Math.max((await bb.storage.kv.get<number>(SEQ_KEY)) ?? 0, ...raw.map((c) => (typeof c.num === "number" ? c.num : 0)));
    missing.sort((a, b) => String(a.createdAt).localeCompare(String(b.createdAt)));
    for (const card of missing) card.num = ++seq;
    await bb.storage.kv.set(CARDS_KEY, raw);
    await bb.storage.kv.set(SEQ_KEY, seq);
    bb.log.info(`numbered ${missing.length} cards`);
  });
  index(await readCards());

  function newCard(fields: Partial<Card> & Pick<Card, "title" | "num">): Card {
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

  function newChat(fields: Partial<Chat> & Pick<Chat, "text">): Chat {
    return {
      id: randomUUID().slice(0, 8),
      threadId: null,
      error: null,
      createdAt: new Date().toISOString(),
      origin: "card",
      follow: true,
      status: "starting",
      reply: null,
      replyAt: null,
      unread: false,
      ...fields,
    };
  }

  function setDone(card: Card, done: boolean) {
    card.done = done;
    card.doneAt = done ? new Date().toISOString() : null;
  }

  // ---------- the user's clock ----------

  // Agents have no browser: "tomorrow at 10" from them is read on the user's
  // clock, learned from the last phrase the board sent.
  let tzOffset = (await bb.storage.kv.get<number>(TZ_KEY)) ?? -new Date().getTimezoneOffset();
  async function learnClock(now: LocalNow) {
    const local = Date.parse(`${now.date}T${now.time}:00Z`);
    if (Number.isNaN(local)) return;
    const offset = Math.round((local - Date.now()) / 60_000 / 15) * 15;
    if (offset === tzOffset || Math.abs(offset) > 14 * 60) return;
    tzOffset = offset;
    await bb.storage.kv.set(TZ_KEY, offset);
  }
  function userNow(): LocalNow {
    const iso = new Date(Date.now() + tzOffset * 60_000).toISOString();
    return { date: iso.slice(0, 10), time: iso.slice(11, 16) };
  }

  // ---------- agent chats ----------

  /**
   * Where a job's chat runs. By default bb's personal project in a personal
   * workspace: jobs need no repository, and a project whose default is a git
   * worktree would get a full copy of itself for every job. A project chosen in
   * the settings keeps its own environment, which can be another machine.
   */
  async function chatPlace(card: Card): Promise<{ projectId: string; environment: Parameters<typeof bb.sdk.threads.spawn>[0]["environment"] }> {
    const { chatProject, workChatProject } = await settings.get();
    const chosen = card.kind === "work" && workChatProject ? workChatProject : chatProject;
    const projects = await bb.sdk.projects.list({ includePersonal: true });
    const personal = projects.find((p) => p.kind === "personal");
    if (chosen && chosen !== personal?.id) return { projectId: chosen, environment: { type: "project-default" } };
    if (personal) return { projectId: personal.id, environment: { type: "host", workspace: { type: "personal" } } };
    const first = projects.find((p) => p.kind === "standard");
    if (!first) throw new Error("bb has no project to start a chat in");
    return { projectId: first.id, environment: { type: "project-default" } };
  }

  function chatPrompt(card: Card, request: string): string {
    const lines = [
      `A job from the user's Sticker Note board (their personal task board in bb), sticker #${card.num}.`,
      "",
      `Sticker: ${card.title}`,
      `When: ${card.due ? `${card.due.date}${card.due.time ? ` ${card.due.time}` : ""}` : "no date"}`,
      `Kind: ${card.kind}`,
    ];
    if (card.notes.length) lines.push("Notes:", ...card.notes.map((n) => `- ${n}`));
    if (card.links.length) lines.push("Links:", ...card.links.map((l) => `- ${l}`));
    lines.push(
      "",
      `Job: ${request}`,
      "",
      "Do the job. Your final answer is copied onto the sticker, so end with a short result: what you did or found, " +
        "and a question only when you need the user's decision. The user may answer from the sticker; it arrives here as the next message.",
      `Put what the user will need later on the sticker with the sticker_note_update tool (or \`bb sticker-note update ${card.num}\`): ` +
        "links, a short summary, file paths. Mark it done only when the job completes the task itself.",
      "Answer in the language of the job.",
    );
    return lines.join("\n");
  }

  /** Changes the chats of a thread on every card that follows it, and saves. */
  function onChat(threadId: string, mutate: (chat: Chat, card: Card) => void) {
    if (!followed.has(threadId)) return Promise.resolve();
    return serial(async () => {
      const cards = await readCards();
      let hit = false;
      for (const card of cards) {
        for (const chat of card.chats) {
          if (chat.threadId !== threadId || !chat.follow) continue;
          mutate(chat, card);
          hit = true;
        }
      }
      if (hit) await writeCards(cards);
    });
  }

  async function startChat(cardId: string, chatId: string, request: string) {
    let threadId: string | null = null;
    let error: string | null = null;
    try {
      const card = (await readCards()).find((c) => c.id === cardId);
      if (!card) return;
      const thread = await bb.sdk.threads.spawn({
        ...(await chatPlace(card)),
        prompt: chatPrompt(card, request),
        title: clip(request, 80),
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
      // The thread may already have reported in; only a fresh chat is moved on.
      if (chat.status === "starting") chat.status = error ? "failed" : "working";
      await writeCards(cards);
    });
  }

  async function sendToChat(threadId: string, text: string) {
    await bb.sdk.threads.send({ threadId, mode: "auto", input: [{ type: "text", text, mentions: [] }] });
  }

  bb.events.on("thread.active", ({ thread }) =>
    onChat(thread.id, (chat) => {
      chat.status = "working";
      chat.error = null;
    }),
  );
  bb.events.on("thread.idle", ({ thread, lastAssistantText }) =>
    onChat(thread.id, (chat) => {
      const reply = lastAssistantText?.trim() || null;
      chat.status = asksUser(reply) ? "waiting" : "answered";
      if (reply) {
        chat.reply = clip(reply, REPLY_MAX);
        chat.replyAt = new Date().toISOString();
        chat.unread = true;
      }
    }),
  );
  bb.events.on("interaction.pending", ({ thread }) =>
    onChat(thread.id, (chat) => {
      chat.status = "waiting";
      chat.unread = true;
    }),
  );
  bb.events.on("thread.failed", ({ thread, error }) =>
    onChat(thread.id, (chat) => {
      chat.status = "failed";
      chat.error = error ?? "The agent stopped with an error.";
    }),
  );
  bb.events.on("thread.deleted", ({ thread }) =>
    onChat(thread.id, (chat) => {
      chat.status = "failed";
      chat.error = "The chat was deleted.";
      chat.follow = false;
    }),
  );

  // ---------- phrases ----------

  /** Applies a command to every card it names. */
  function applyCommand(cards: Card[], parse: Extract<ParseResult, { type: "command" }>): Card[] {
    return parse.targetIds.reduce((list, id) => applyOne(list, parse, id), cards);
  }

  function applyOne(cards: Card[], parse: Extract<ParseResult, { type: "command" }>, id: string): Card[] {
    const card = cards.find((c) => c.id === id) ?? notFound(id);
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
      case "open":
        return cards;
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

  /** A due date from words: undefined when the words name no day or time, null for "someday". */
  function dueFromPhrase(phrase: string, now: LocalNow): Due | null | undefined {
    const when = parseWhen(phrase, now);
    if (when.someday) return null;
    return when.date === null ? undefined : { date: when.date, time: when.time };
  }

  // ---------- operations agents use too ----------

  async function addCard(input: AddInput, threadId: string | null): Promise<Card> {
    const now = userNow();
    const draft = draftOf(input.title, now);
    const due = input.when ? dueFromPhrase(input.when, now) : draft.due;
    return serial(async () => {
      const cards = await readCards();
      const card = newCard({
        num: await nextNum(),
        title: clip(draft.title, 300),
        due: due ?? null,
        remind: (due ?? null) !== null,
        importance: input.importance ?? draft.importance,
        kind: input.work === undefined ? draft.kind : input.work ? "work" : "personal",
        links: [...new Set([...draft.links, ...(input.links ?? [])])].slice(0, 50),
        notes: (input.notes ?? []).map((n) => clip(n.trim(), NOTE_MAX)).filter(Boolean),
        chats: threadId
          ? [newChat({ text: clip(input.title, 300), threadId, origin: "chat", follow: false, status: "answered" })]
          : [],
      });
      await writeCards([...cards, card]);
      return card;
    });
  }

  async function updateCard(num: number, input: UpdateInput): Promise<Card> {
    const now = userNow();
    return serial(async () => {
      const cards = await readCards();
      const card = cards.find((c) => c.num === num);
      if (!card) throw new Error(`No sticker #${num}. List them with \`bb sticker-note list\`.`);
      if (input.title) card.title = clip(input.title.trim(), 300);
      if (input.when !== undefined) {
        const due = dueFromPhrase(input.when, now);
        if (due === undefined) throw new Error(`Could not read a date or time in "${input.when}".`);
        card.due = due;
        card.remind = due !== null;
      }
      if (input.importance) card.importance = input.importance;
      if (input.work !== undefined) card.kind = input.work ? "work" : "personal";
      if (input.notes?.length) card.notes = [...card.notes, ...input.notes.map((n) => clip(n.trim(), NOTE_MAX)).filter(Boolean)].slice(-200);
      if (input.links?.length) card.links = [...new Set([...card.links, ...input.links])].slice(0, 50);
      if (input.done !== undefined && input.done !== card.done) setDone(card, input.done);
      stamp(card);
      await writeCards(cards);
      return card;
    });
  }

  /** What the board does with a phrase, said by an agent instead of the user. */
  async function sayPhrase(text: string): Promise<{ parse: ParseResult; cards: Card[] }> {
    const now = userNow();
    return serial(async () => {
      const cards = await readCards();
      const parse = parsePhrase({ text, now, cards });
      if (parse.type === "create") {
        const card = newCard({ num: await nextNum(), ...parse.draft, remind: parse.draft.due !== null });
        await writeCards([...cards, card]);
        return { parse, cards: [card] };
      }
      if (parse.type !== "command" || parse.action === "open") return { parse, cards: [] };
      const next = applyCommand(cards, parse);
      await writeCards(next);
      const touched = parse.targetIds
        .map((id) => next.find((c) => c.id === id) ?? cards.find((c) => c.id === id))
        .filter((c): c is Card => c !== undefined);
      return { parse, cards: touched };
    });
  }

  registerAgentSurface(bb, {
    list: readCards,
    userNow,
    add: addCard,
    update: updateCard,
    say: sayPhrase,
  });

  // ---------- RPC ----------

  bb.rpc.register(rpcContract, {
    cards_list: async () => ({ cards: await readCards() }),

    capture: async ({ text, now, spoken, contextId }) => {
      void learnClock(now);
      const result = await serial(async () => {
        const cards = await readCards();
        const parse = parsePhrase({ text, now, cards, contextId: contextId ?? null });
        if (parse.type === "ambiguous" || parse.type === "notFound") return { parse, card: null, cards: [], agent: false, undoToken: null };
        if (parse.type === "command" && parse.action === "open") {
          const card = cards.find((c) => c.id === parse.targetId) ?? null;
          return { parse, card, cards: card ? [card] : [], agent: false, undoToken: null };
        }
        if (parse.type === "create") {
          // "Найди письмо от поставщика и подготовь ответ": a card that an agent works on.
          const agent = isAgentJob(text);
          const job = agent ? jobText(text) : null;
          const draft = job ? { ...draftOf(job, now), due: parse.draft.due } : parse.draft;
          const card = newCard({
            num: await nextNum(),
            ...draft,
            title: clip(draft.title, 300),
            remind: draft.due !== null,
            said: spoken ? text : null,
            chats: job ? [newChat({ text: job })] : [],
          });
          const token = remember(cards, [card.id]);
          await writeCards([...cards, card]);
          return { parse, card, cards: [card], agent, undoToken: token };
        }
        const token = remember(cards, parse.targetIds);
        const before = cards.filter((c) => parse.targetIds.includes(c.id)).map((c) => structuredClone(c));
        const next = applyCommand(cards, parse);
        await writeCards(next);
        const touched = parse.targetIds
          .map((id) => next.find((c) => c.id === id) ?? before.find((c) => c.id === id))
          .filter((c): c is Card => c !== undefined);
        return { parse, card: touched[0] ?? null, cards: touched, agent: false, undoToken: token };
      });
      const chat = result.agent ? result.card?.chats[0] : undefined;
      if (result.card && chat) void startChat(result.card.id, chat.id, chat.text);
      return result;
    },

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

    card_seen: ({ id }) =>
      serial(async () => {
        const cards = await readCards();
        const card = cards.find((c) => c.id === id);
        if (!card || !card.chats.some((ch) => ch.unread)) return null;
        for (const chat of card.chats) chat.unread = false;
        await writeCards(cards);
        return null;
      }),

    card_compose: async ({ id, text, now }) => {
      void learnClock(now);
      const chatId = randomUUID().slice(0, 8);
      const result = await serial(async () => {
        const cards = await readCards();
        const card = cards.find((c) => c.id === id) ?? notFound(id);
        const before = structuredClone(card);
        const fresh = wantsNewChat(text);
        const live = fresh ? null : liveChat(card);
        // "Закрой", "перенеси на понедельник": a command about this very card,
        // unless the phrase is plainly a note or meant for a new chat.
        if (!isExplicitNote(text) && !fresh) {
          const parse = parsePhrase({ text, now, cards: [card], contextId: card.id });
          if (parse.type === "command") {
            const token = remember(cards, [id]);
            const next = applyCommand(cards, parse);
            await writeCards(next);
            const after = next.find((c) => c.id === id) ?? null;
            return { decision: "command" as const, action: parse.action, text, before, card: after, undoToken: token, send: null };
          }
        }
        const decision = decide(text, { agentAsks: live?.status === "waiting", chatLive: live?.follow === true });
        if (decision.type === "chat" && live) {
          // The next message in the card's chat: the card follows it from now on.
          live.follow = true;
          live.status = "working";
          live.unread = false;
          stamp(card);
          await writeCards(cards);
          return { decision: "sent" as const, action: null, text: decision.text, before, card, undoToken: null, send: live.threadId };
        }
        const token = remember(cards, [id]);
        if (decision.type === "note") card.notes = [...card.notes, decision.text];
        else card.chats = [...card.chats, newChat({ id: chatId, text: decision.text })];
        stamp(card);
        await writeCards(cards);
        return { decision: decision.type, action: null, text: decision.text, before, card, undoToken: token, send: null };
      });
      if (result.decision === "chat") void startChat(id, chatId, result.text);
      if (result.send) {
        try {
          await sendToChat(result.send, result.text);
        } catch (cause) {
          const error = cause instanceof Error ? cause.message : String(cause);
          await onChat(result.send, (chat) => {
            chat.status = "failed";
            chat.error = error;
          });
          throw new Error(`Could not send to the agent: ${error}`);
        }
      }
      const { send: _send, ...out } = result;
      return out;
    },

    chat_to_card: async ({ threadId, text, selected, now }) => {
      void learnClock(now);
      // The message's own words are the title: unlike dictation, nothing is cut
      // out of it. A day and time count only in a highlighted piece; in a whole
      // answer they are as likely to be a busy slot as the task's.
      const plain = plainText(text);
      const head = selected ? plain.replace(/\s+/g, " ") : firstSentence(plain);
      const title = clip(head, 140);
      const parsed = draftOf(clip(head, 200), now);
      const draft = { ...parsed, due: selected ? parsed.due : null };
      const rest = plain.replace(/\s+/g, " ") === title ? null : clip(plain, NOTE_MAX);
      return serial(async () => {
        const cards = await readCards();
        const card = newCard({
          num: await nextNum(),
          title,
          due: draft.due,
          remind: draft.due !== null,
          importance: draft.importance,
          kind: draft.kind,
          links: [...new Set([...draft.links, ...linksIn(text)])].slice(0, 50),
          notes: rest ? [rest] : [],
          chats: [newChat({ text: title, threadId, origin: "chat", follow: false, status: "answered" })],
        });
        const token = remember(cards, [card.id]);
        await writeCards([...cards, card]);
        return { card, undoToken: token };
      });
    },

    undo: ({ token }) =>
      serial(async () => {
        const entry = undoStack.get(token);
        if (!entry) return { restored: false };
        undoStack.delete(token);
        let cards = await readCards();
        for (const [id, previous] of entry) {
          const at = cards.findIndex((c) => c.id === id);
          if (previous === null) cards = cards.filter((c) => c.id !== id);
          else if (at === -1) cards.push(previous);
          else cards[at] = previous;
        }
        await writeCards(cards);
        return { restored: true };
      }),
  });

  bb.log.info("loaded");
}
