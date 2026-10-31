// Data model shared by the server (zod schemas at the RPC boundary) and the
// app (types only: app code imports this file with `import type`).
import { z } from "zod";

export const importanceSchema = z.enum(["high", "normal", "low"]);
export const kindSchema = z.enum(["work", "personal"]);
export const columnSchema = z.enum(["today", "soon", "later", "done"]);

export const dueSchema = z.object({
  date: z.string().regex(/^\d{4}-\d{2}-\d{2}$/),
  time: z.string().regex(/^\d{2}:\d{2}$/).nullable(),
});

/** Where an agent chat stands, as the card shows it. */
export const chatStatusSchema = z.enum(["starting", "working", "answered", "waiting", "failed"]);

export const chatSchema = z.object({
  id: z.string(),
  /** The request that started the chat, or the message the card was made from. */
  text: z.string(),
  threadId: z.string().nullable(),
  error: z.string().nullable(),
  createdAt: z.string(),
  /** "card": started from the card; "chat": the card was made from this chat. */
  origin: z.enum(["card", "chat"]).default("card"),
  /** The card mirrors this chat: status and the agent's last answer. Chats a card was made from start unfollowed. */
  follow: z.boolean().default(true),
  status: chatStatusSchema.default("working"),
  /** The agent's last answer, clipped. */
  reply: z.string().nullable().default(null),
  replyAt: z.string().nullable().default(null),
  /** An answer the user has not opened the card to see yet. */
  unread: z.boolean().default(false),
});

export const cardSchema = z.object({
  id: z.string(),
  /** The sticker's number on the board, never reused: "move sticker 112 to done". */
  num: z.number().int().positive(),
  title: z.string(),
  notes: z.array(z.string()),
  links: z.array(z.string()),
  importance: importanceSchema,
  kind: kindSchema,
  due: dueSchema.nullable(),
  remind: z.boolean(),
  done: z.boolean(),
  doneAt: z.string().nullable(),
  said: z.string().nullable(),
  chats: z.array(chatSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});

export type Importance = z.infer<typeof importanceSchema>;
export type Kind = z.infer<typeof kindSchema>;
export type Column = z.infer<typeof columnSchema>;
export type Due = z.infer<typeof dueSchema>;
export type Chat = z.infer<typeof chatSchema>;
export type ChatStatus = z.infer<typeof chatStatusSchema>;
export type Card = z.infer<typeof cardSchema>;

/** What a phrase was understood as. Offsets point into the original text. */
export const spanSchema = z.object({
  start: z.number().int().nonnegative(),
  end: z.number().int().nonnegative(),
  kind: z.enum(["when", "importance", "work", "link", "action", "target"]),
});
export type Span = z.infer<typeof spanSchema>;

export const draftSchema = z.object({
  title: z.string(),
  due: dueSchema.nullable(),
  importance: importanceSchema,
  kind: kindSchema,
  links: z.array(z.string()),
});
export type Draft = z.infer<typeof draftSchema>;

/** "open" only shows the card; the board does it. */
export const actionSchema = z.enum(["done", "undone", "move", "importance", "delete", "open"]);
export type Action = z.infer<typeof actionSchema>;

export const parseResultSchema = z.discriminatedUnion("type", [
  z.object({ type: z.literal("create"), draft: draftSchema, spans: z.array(spanSchema) }),
  z.object({
    type: z.literal("command"),
    action: actionSchema,
    /** The first card; "open" shows it. */
    targetId: z.string(),
    /** Every card the command applies to ("закрой задачи 6 и 1"), targetId first. */
    targetIds: z.array(z.string()).min(1),
    /** For "move": the new due date; null clears it. */
    due: dueSchema.nullable().optional(),
    /** For "importance". */
    importance: importanceSchema.optional(),
    spans: z.array(spanSchema),
  }),
  z.object({ type: z.literal("ambiguous"), action: actionSchema, candidateIds: z.array(z.string()), spans: z.array(spanSchema) }),
  z.object({
    type: z.literal("notFound"),
    action: actionSchema,
    /** False when the phrase named no task at all ("закрой задачу" with several open). */
    named: z.boolean(),
    spans: z.array(spanSchema),
  }),
]);
export type ParseResult = z.infer<typeof parseResultSchema>;

export { columnOf } from "./board";
