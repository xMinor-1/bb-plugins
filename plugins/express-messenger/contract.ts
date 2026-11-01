// The contract between the server entry and the host entry. The host entry runs on the person's
// machine: it drives the eXpress web client in a browser without a window, signed in as the
// person, and keeps the directory of chats on that machine. Messages stay in the messenger; the
// server passes answers on to the panel and to approved agents and keeps none of them.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

/** The panel's language, for the system window that confirms a send. */
export const langSchema = z.enum(["en", "ru"]);
export type Lang = z.infer<typeof langSchema>;

/** The web client's address, from the plugin settings. https, or http to this machine for a developer's stub. */
export const webClientUrlSchema = z
  .string()
  .min(1)
  .max(500)
  .refine((value) => {
    try {
      const url = new URL(value);
      return url.protocol === "https:" || (url.protocol === "http:" && (url.hostname === "127.0.0.1" || url.hostname === "localhost"));
    } catch {
      return false;
    }
  }, "An https address of the eXpress web client");

const withUrl = z.object({ url: webClientUrlSchema }).strict();

/** Kinds of chats as the client names them, reduced to what a person calls them. */
export const CHAT_KINDS = ["personal", "group", "channel", "bot", "notes", "other"] as const;
export type ChatKind = (typeof CHAT_KINDS)[number];

export const personSchema = z
  .object({ name: z.string().nullable(), position: z.string().nullable(), department: z.string().nullable(), email: z.string().nullable() })
  .strict();

export const chatSchema = z
  .object({
    id: z.string(),
    kind: z.enum(CHAT_KINDS),
    name: z.string(),
    unread: z.number().int(),
    members: z.number().int(),
    lastAt: z.number().nullable(),
    person: personSchema.nullable(),
  })
  .strict();
export type Chat = z.infer<typeof chatSchema>;

export const statusSchema = z
  .object({
    platform: z.string(),
    /** The Chromium-based browser this machine drives, or null when none is installed. */
    browser: z.string().nullable(),
    /** The browser is running now (signed-in session kept for the watcher and recent calls). */
    open: z.boolean(),
    /** Known from the last time the client loaded: true signed in, false asks to sign in, null never tried. */
    signedIn: z.boolean().nullable(),
    directory: z.object({ at: z.number(), chats: z.number().int(), people: z.number().int() }).strict().nullable(),
    lastError: z.string().nullable(),
  })
  .strict();
export type Status = z.infer<typeof statusSchema>;

/** What an agent may ask for. Sending is checked again on the host: an exact chat, then the system window. */
export const toolCallSchema = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("find"), query: z.string().min(1).max(200), limit: z.number().int().min(1).max(10).optional() }).strict(),
  z.object({ tool: z.literal("unread"), limit: z.number().int().min(1).max(100).optional() }).strict(),
  z.object({ tool: z.literal("read"), chat: z.string().min(1).max(200), last: z.number().int().min(1).max(100).optional() }).strict(),
  z
    .object({
      tool: z.literal("send"),
      chat: z.string().min(1).max(200),
      text: z.string().min(1).max(4000),
      /** Ask the person in a system window first (the `confirmSend` setting). */
      confirm: z.boolean(),
      lang: langSchema.optional(),
    })
    .strict(),
]);
export type ToolCall = z.infer<typeof toolCallSchema>;

export const toolOutputSchema = z
  .object({
    text: z.string(),
    isError: z.boolean(),
    /** The chat the call was about, when one was found: for the server's log and the watch rules. */
    chat: z.object({ id: z.string(), name: z.string(), kind: z.enum(CHAT_KINDS) }).strict().nullable(),
  })
  .strict();
export type ToolOutput = z.infer<typeof toolOutputSchema>;

export const matchesSchema = z
  .object({ matches: z.array(chatSchema.extend({ score: z.number() }).strict()), ambiguous: z.boolean() })
  .strict();
export type Matches = z.infer<typeof matchesSchema>;

/** For the watcher: per chat id, the unread count and the time of the last event. */
export const snapshotSchema = z
  .object({
    chats: z.record(z.string(), z.object({ unread: z.number().int(), lastEventAt: z.number() }).strict()),
    error: z.string().nullable(),
  })
  .strict();
export type Snapshot = z.infer<typeof snapshotSchema>;

const outcome = z.object({ ok: z.boolean(), message: z.string() }).strict();

export const hostContract = defineRpcContract({
  status: { input: withUrl, output: statusSchema, experimental_retryable: true },
  /** Opens a browser window to sign in; answers once the client has loaded the chats, or the window closed. */
  signIn: { input: withUrl, output: outcome },
  /** Rebuilds the directory: chats, and the people of personal chats with their names in other alphabets. */
  sync: { input: withUrl, output: outcome.extend({ chats: z.number().int(), people: z.number().int() }).strict() },
  findChats: { input: withUrl.extend({ query: z.string().min(1).max(200), limit: z.number().int().min(1).max(10).optional() }).strict(), output: matchesSchema },
  chat: { input: withUrl.extend({ id: z.string().min(1).max(200) }).strict(), output: chatSchema.nullable() },
  tool: { input: withUrl.extend({ call: toolCallSchema }).strict(), output: toolOutputSchema },
  snapshot: { input: withUrl.extend({ ids: z.array(z.string().min(1).max(200)).max(200) }).strict(), output: snapshotSchema },
  /** Closes the browser now. */
  close: { input: z.object({}).strict(), output: outcome },
  /** Forgets the sign-in and the directory on this machine. */
  forget: { input: z.object({}).strict(), output: outcome },
});
