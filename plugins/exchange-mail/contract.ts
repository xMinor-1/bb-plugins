// The contract between the server entry and the host entry. The host entry runs
// on the person's machine: that machine reaches Exchange, signs in as the person
// (Windows sign-in, a Kerberos ticket, or a password in the OS store) and keeps
// the connection settings and the list of drafts prepared through bb. Mail
// itself stays in Exchange; the server passes it on to the panel and to
// approved agents and keeps none of it.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";

export const FOLDERS = ["inbox", "sent", "drafts", "deleted"] as const;
export const folderSchema = z.enum(FOLDERS);
export type Folder = z.infer<typeof folderSchema>;

export const authSchema = z.enum(["negotiate", "password"]);

/** The panel's language, for text the machine with the mailbox writes itself: the system window that confirms a send. */
export const langSchema = z.enum(["en", "ru"]);
export type Lang = z.infer<typeof langSchema>;
export type AuthMode = z.infer<typeof authSchema>;

export const addressSchema = z.object({ name: z.string().nullable(), email: z.string() }).strict();
export type MailAddress = z.infer<typeof addressSchema>;

export const connectionStatusSchema = z
  .object({
    platform: z.string(),
    curl: z
      .object({ path: z.string(), version: z.string().nullable(), negotiate: z.boolean(), ntlm: z.boolean() })
      .strict()
      .nullable(),
    curlError: z.string().nullable(),
    url: z.string().nullable(),
    auth: authSchema.nullable(),
    user: z.string().nullable(),
    hasPassword: z.boolean(),
    passwordStore: z.string().nullable(),
    /** Why sign-in is paused: Exchange refused the password for this login. */
    blocked: z.string().nullable(),
    /** While paused: the earliest time (ms) bb may try this login again, whoever asks. */
    retryAt: z.number().nullable(),
    lastCheck: z.object({ ok: z.boolean(), at: z.number(), message: z.string() }).strict().nullable(),
  })
  .strict();
export type ConnectionStatus = z.infer<typeof connectionStatusSchema>;

export const messageSummarySchema = z
  .object({
    ref: z.string(),
    kind: z.string(),
    subject: z.string(),
    from: addressSchema.nullable(),
    displayTo: z.string(),
    received: z.string().nullable(),
    isRead: z.boolean(),
    hasAttachments: z.boolean(),
    preview: z.string(),
  })
  .strict();
export type MessageSummary = z.infer<typeof messageSummarySchema>;

export const messageSchema = messageSummarySchema
  .extend({
    to: z.array(addressSchema),
    cc: z.array(addressSchema),
    sent: z.string().nullable(),
    body: z.string(),
    attachments: z.array(z.object({ name: z.string(), size: z.number().nullable() }).strict()),
  })
  .strict();
export type MailMessage = z.infer<typeof messageSchema>;

export const listInputSchema = z
  .object({
    folder: folderSchema.optional(),
    offset: z.number().int().min(0).max(100_000).optional(),
    limit: z.number().int().min(1).max(100).optional(),
    unreadOnly: z.boolean().optional(),
    /** Outlook search syntax: words, from:, subject:, received:… */
    query: z.string().max(500).optional(),
  })
  .strict();
export type ListInput = z.infer<typeof listInputSchema>;

export const listOutputSchema = z
  .object({ messages: z.array(messageSummarySchema), total: z.number().int(), more: z.boolean(), unread: z.number().int().nullable() })
  .strict();
export type ListOutput = z.infer<typeof listOutputSchema>;

export const draftKindSchema = z.enum(["new", "reply", "replyAll"]);
export type DraftKind = z.infer<typeof draftKindSchema>;

/** How Exchange stores the body. Anything but text goes out with formatting the plain-text view does not show. */
export const bodyFormatSchema = z.enum(["text", "html", "rtf", "unknown"]);
export type BodyFormat = z.infer<typeof bodyFormatSchema>;

export const attachmentSchema = z.object({ name: z.string(), size: z.number().nullable() }).strict();

const recipientList = z.array(z.string().min(3).max(320)).max(100);

export const draftInputSchema = z
  .object({
    kind: draftKindSchema,
    /** The message answered (a ref from a list or read); required for replies. */
    replyTo: z.string().max(64).optional(),
    /** "Name <email>" or "email". Replies: omitted keeps the recipients Exchange picks. */
    to: recipientList.optional(),
    cc: recipientList.optional(),
    subject: z.string().max(500).optional(),
    body: z.string().max(100_000),
    /** A draft this one replaces, for a revised version. */
    replaces: z.string().max(64).optional(),
    threadId: z.string().max(200).nullable().optional(),
    source: z.enum(["agent", "person"]),
  })
  .strict();
export type DraftInput = z.infer<typeof draftInputSchema>;

export const draftSchema = z
  .object({
    id: z.string(),
    kind: draftKindSchema,
    source: z.enum(["agent", "person"]),
    threadId: z.string().nullable(),
    createdAt: z.number(),
    subject: z.string(),
    to: z.array(addressSchema),
    cc: z.array(addressSchema),
    /** Blind copies: added in Outlook, for example. The person must see them before sending. */
    bcc: z.array(addressSchema),
    attachments: z.array(attachmentSchema),
    bodyFormat: bodyFormatSchema,
    /** What Exchange holds now, as plain text: the new text and, for replies, the quoted message. */
    body: z.string(),
    /** The text written for this draft, without the quote. */
    text: z.string(),
    replyTo: z.object({ ref: z.string(), subject: z.string(), from: addressSchema.nullable() }).strict().nullable(),
    /** Exchange's change key: Send must name the version the person saw. */
    revision: z.string(),
  })
  .strict();
export type Draft = z.infer<typeof draftSchema>;

export const sendResultSchema = z
  .discriminatedUnion("status", [
    z.object({ status: z.literal("sent"), at: z.number() }).strict(),
    z.object({ status: z.literal("changed"), message: z.string() }).strict(),
    z.object({ status: z.literal("gone"), message: z.string() }).strict(),
    /** The person did not confirm in the system window, or no window could be shown. Nothing was sent. */
    z.object({ status: z.literal("cancelled"), reason: z.enum(["cancelled", "timeout", "unavailable", "busy"]), message: z.string() }).strict(),
  ]);
export type SendResult = z.infer<typeof sendResultSchema>;

/** What an agent may ask for. There is deliberately no send. */
export const toolInputSchema = z.discriminatedUnion("tool", [
  z.object({ tool: z.literal("list"), folder: folderSchema.optional(), unreadOnly: z.boolean().optional(), limit: z.number().int().min(1).max(50).optional(), offset: z.number().int().min(0).max(10_000).optional() }).strict(),
  z.object({ tool: z.literal("search"), query: z.string().min(1).max(500), folder: z.enum(["inbox", "sent", "all"]).optional(), limit: z.number().int().min(1).max(50).optional() }).strict(),
  z.object({ tool: z.literal("read"), ref: z.string().min(1).max(64), maxChars: z.number().int().min(500).max(100_000).optional() }).strict(),
  z
    .object({
      tool: z.literal("draft"),
      threadId: z.string().max(200),
      replyTo: z.string().max(64).optional(),
      replyAll: z.boolean().optional(),
      to: recipientList.optional(),
      cc: recipientList.optional(),
      subject: z.string().max(500).optional(),
      body: z.string().min(1).max(100_000),
      replaces: z.string().max(64).optional(),
    })
    .strict(),
]);
export type ToolInput = z.infer<typeof toolInputSchema>;

export const toolOutputSchema = z.object({ text: z.string(), isError: z.boolean(), draftId: z.string().nullable() }).strict();

export const saveConnectionInputSchema = z
  .object({
    url: z.string().min(1).max(500),
    auth: authSchema,
    user: z.string().max(200).optional(),
    /** Omitted keeps the stored password. */
    password: z.string().min(1).max(500).optional(),
  })
  .strict();

const empty = z.object({}).strict();
/** A draft by id. With `threadId`, only a draft prepared in that thread answers: a card in a thread shows its own drafts. */
const draftRef = z.object({ id: z.string().min(1).max(64), threadId: z.string().min(1).max(200).optional() }).strict();

export const hostContract = defineRpcContract({
  status: { input: empty, output: connectionStatusSchema, experimental_retryable: true },
  saveConnection: { input: saveConnectionInputSchema, output: connectionStatusSchema },
  forget: { input: empty, output: connectionStatusSchema },
  check: { input: z.object({ retry: z.boolean().optional() }).strict(), output: z.object({ ok: z.boolean(), message: z.string(), unread: z.number().int().nullable() }).strict() },
  list: { input: listInputSchema, output: listOutputSchema, experimental_retryable: true },
  read: { input: z.object({ ref: z.string().min(1).max(64), markRead: z.boolean().optional() }).strict(), output: messageSchema },
  drafts: { input: empty, output: z.object({ drafts: z.array(draftSchema) }).strict(), experimental_retryable: true },
  draft: { input: draftRef, output: draftSchema.nullable(), experimental_retryable: true },
  saveDraft: { input: draftInputSchema, output: draftSchema },
  discardDraft: { input: draftRef, output: z.object({ ok: z.boolean() }).strict() },
  send: { input: draftRef.extend({ revision: z.string().min(1).max(512), lang: langSchema.optional() }).strict(), output: sendResultSchema },
  tool: { input: toolInputSchema, output: toolOutputSchema },
});
