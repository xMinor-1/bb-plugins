// RPC contract between the review panel (app.tsx) and the backend. app.tsx
// imports only its type, so zod never reaches the frontend bundle.
import { defineRpcContract } from "@get-bb/plugin-sdk";
import { z } from "zod";
import type { SheetData } from "../lib/sheet-model.js";
import { DRAW_TOOLS } from "./types.js";

const rectSchema = z
  .object({
    x: z.number().min(0).max(1),
    y: z.number().min(0).max(1),
    w: z.number().min(0).max(1),
    h: z.number().min(0).max(1),
  })
  .strict();

const MAX_QUOTE = 4000;
const MAX_URL = 2000;
/** The page of a live site a comment was left on. */
const pageUrlSchema = z
  .string()
  .max(MAX_URL)
  .refine((value) => /^https?:\/\//i.test(value), "Only http and https pages.")
  .optional();
const MAX_SELECTOR = 1000;
const MAX_HTML = 2000;
const MAX_STROKES = 60;
/** Coordinates per stroke: 2000 points. */
const MAX_STROKE_NUMBERS = 4000;

export const strokeSchema = (coordinate: z.ZodNumber) =>
  z
    .object({
      tool: z.enum(DRAW_TOOLS),
      points: z.array(coordinate).min(2).max(MAX_STROKE_NUMBERS),
    })
    .strict()
    .refine((stroke) => stroke.points.length % 2 === 0, "A stroke needs x and y for every point.");

const drawMarkSchema = z
  .object({
    stroke: z.number().int().min(0),
    role: z.enum(["over", "around", "from", "to"]),
    selector: z.string().min(1).max(MAX_SELECTOR),
    tag: z.string().min(1).max(40),
    text: z.string().max(400),
    frame: z.string().min(1).max(MAX_SELECTOR).optional(),
  })
  .strict();

export const anchorSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("doc") }).strict(),
  z
    .object({
      kind: z.literal("md-text"),
      quote: z.string().min(1).max(MAX_QUOTE),
      prefix: z.string().max(200),
      suffix: z.string().max(200),
      startLine: z.number().int().min(1),
      endLine: z.number().int().min(1),
    })
    .strict(),
  z
    .object({
      kind: z.literal("page-text"),
      page: z.number().int().min(1),
      quote: z.string().min(1).max(MAX_QUOTE),
      rects: z.array(rectSchema).min(1).max(200),
    })
    .strict(),
  z
    .object({
      kind: z.literal("page-area"),
      page: z.number().int().min(1),
      rect: rectSchema,
      text: z.string().max(MAX_QUOTE),
    })
    .strict(),
  z
    .object({
      kind: z.literal("cell"),
      sheet: z.string().min(1).max(200),
      sheetIndex: z.number().int().min(0),
      ref: z.string().regex(/^[A-Z]{1,3}[0-9]{1,7}(:[A-Z]{1,3}[0-9]{1,7})?$/),
      text: z.string().max(MAX_QUOTE),
    })
    .strict(),
  z
    .object({
      kind: z.literal("html-text"),
      quote: z.string().min(1).max(MAX_QUOTE),
      prefix: z.string().max(200),
      suffix: z.string().max(200),
      selector: z.string().max(MAX_SELECTOR),
      frame: z.string().min(1).max(MAX_SELECTOR).optional(),
      url: pageUrlSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("html-element"),
      selector: z.string().min(1).max(MAX_SELECTOR),
      tag: z.string().min(1).max(40),
      text: z.string().max(MAX_QUOTE),
      html: z.string().max(MAX_HTML),
      frame: z.string().min(1).max(MAX_SELECTOR).optional(),
      url: pageUrlSchema,
    })
    .strict(),
  z
    .object({
      kind: z.literal("page-drawing"),
      page: z.number().int().min(1),
      strokes: z.array(strokeSchema(z.number().min(0).max(1))).min(1).max(MAX_STROKES),
      text: z.string().max(MAX_QUOTE),
    })
    .strict(),
  z
    .object({
      kind: z.literal("html-drawing"),
      strokes: z.array(strokeSchema(z.number().min(-1e6).max(1e7))).min(1).max(MAX_STROKES),
      viewport: z.object({ w: z.number().min(1).max(20000), h: z.number().min(1).max(20000) }).strict(),
      marks: z.array(drawMarkSchema).max(MAX_STROKES * 3),
      url: pageUrlSchema,
    })
    .strict(),
]);

/**
 * What a drawing looked like, for the image the agent gets: a finished PNG
 * (pages compose it from the page image), the HTML page as it stood when it
 * was drawn on, which the server photographs with the strokes on top, or a
 * screenshot of a live page that the server took and keeps (`web.capture`).
 */
export const captureSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("png"), data: z.string().min(1).max(16 * 1024 * 1024) }).strict(),
  z.object({ kind: z.literal("shot"), token: z.string().uuid() }).strict(),
  z
    .object({
      kind: z.literal("html"),
      html: z.string().min(1).max(24 * 1024 * 1024),
      /** Where the page was scrolled, in CSS pixels. */
      scroll: z.object({ x: z.number(), y: z.number() }).strict(),
    })
    .strict(),
]);

const statusSchema = z.enum(["draft", "sent", "replied", "resolved"]);

const replySchema = z.object({
  id: z.string(),
  author: z.enum(["user", "agent"]),
  name: z.string().nullable(),
  originId: z.string().nullable(),
  body: z.string(),
  outcome: z.enum(["replied", "resolved"]).nullable(),
  createdAt: z.number(),
  sentAt: z.number().nullable(),
});

export const commentSchema = z.object({
  id: z.string(),
  seq: z.number(),
  status: statusSchema,
  anchor: anchorSchema,
  body: z.string(),
  author: z.string().nullable(),
  originId: z.string().nullable(),
  originFile: z.string().nullable(),
  docVersion: z.string().nullable(),
  createdAt: z.number(),
  updatedAt: z.number(),
  sentAt: z.number().nullable(),
  sentThreadId: z.string().nullable(),
  agentNote: z.string().nullable(),
  resolvedAt: z.number().nullable(),
  thread: z.array(replySchema),
  imageUrl: z.string().optional(),
});

const kindSchema = z.enum(["md", "pdf", "text", "presentation", "spreadsheet", "html", "web"]);

const docSchema = z.object({
  id: z.string(),
  kind: kindSchema,
  name: z.string(),
  absPath: z.string(),
  hostId: z.string().nullable(),
  version: z.string(),
  htmlUrl: z.string().nullable(),
});

export const openerSourceSchema = z
  .object({
    kind: z.enum(["host", "thread-storage", "workspace"]),
    threadId: z.string().nullable(),
    environmentId: z.string().nullable(),
    projectId: z.string().nullable(),
    experimental_hostId: z.string().nullable().optional(),
  })
  .strip();

const linkSchema = z.object({ url: z.string(), expiresAtMs: z.number() });

const needsLibreOfficeSchema = z.object({
  status: z.literal("needs-libreoffice"),
  /** The LibreOffice module this file needs. */
  component: z.enum(["writer", "impress"]),
  /** False when no LibreOffice was found at all. */
  installed: z.boolean(),
  /** The server's platform: install instructions are for that machine. */
  platform: z.enum(["linux", "darwin", "win32", "other"]),
});

const workbookSummarySchema = z.object({
  sheets: z.array(
    z.object({
      name: z.string(),
      hidden: z.boolean(),
      kind: z.enum(["worksheet", "chartsheet", "other"]),
    }),
  ),
  activeSheet: z.number().int(),
});

/**
 * The readers build the grid; validating up to 100k cells field by field on
 * every response would cost more than it protects.
 */
const sheetDataSchema = z.custom<SheetData>(
  (value) =>
    typeof value === "object" &&
    value !== null &&
    Array.isArray((value as { rows?: unknown }).rows),
);

/** BCP 47 tag from the browser; formats dates and numbers like Excel would there. */
const localeSchema = z.string().max(64).optional();

const recentSchema = z.object({
  path: z.string(),
  name: z.string(),
  hostId: z.string().nullable(),
  openedAtMs: z.number(),
});

const sendTargetSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("thread"), threadId: z.string().min(1), mode: z.enum(["queue-if-active", "steer-if-active"]).optional() }).strict(),
  z
    .object({
      kind: z.literal("new-thread"),
      /** The thread the panel is open in, if any: its project and model are reused. */
      sourceThreadId: z.string().nullable(),
      projectId: z.string().nullable(),
      environmentId: z.string().nullable(),
    })
    .strict(),
]);

const BODY_MAX = 8000;
const signerSchema = z.string().trim().max(120).nullable();

export const rpcContract = defineRpcContract({
  "doc.open": {
    input: z
      .object({
        path: z.string().min(1),
        source: openerSourceSchema,
        /** Add it to the Doc Review page's recent files. */
        remember: z.boolean().optional(),
      })
      .strict(),
    output: z.object({ doc: docSchema }),
  },
  /**
   * Files attached to the thread's messages, newest first; with `seq`, the
   * files on that message.
   */
  "attachments.list": {
    input: z.object({ threadId: z.string().min(1), seq: z.number().int().nullable() }).strict(),
    output: z.object({
      files: z.array(z.object({ name: z.string(), path: z.string(), supported: z.boolean() })),
    }),
  },
  /** Copies an attachment into the thread's storage for review; returns its path there. */
  "attachments.open": {
    input: z
      .object({ threadId: z.string().min(1), path: z.string().min(1).max(512), name: z.string().min(1).max(512) })
      .strict(),
    output: z.object({ path: z.string() }),
  },
  /** A live site opened in bb's browser: one document per origin. */
  "web.open": {
    input: z.object({ url: z.string().min(1).max(MAX_URL) }).strict(),
    output: z.object({ doc: docSchema }),
  },
  /**
   * A screenshot of a Browser tab in bb Desktop, for a drawing's picture.
   * The server keeps it and returns a token for `comments.create`, so the
   * picture does not travel back to the panel; fails when no connected
   * desktop app has the tab.
   */
  "web.capture": {
    input: z.object({ threadId: z.string().min(1), tabId: z.string().min(1) }).strict(),
    output: z.object({ token: z.string() }),
  },
  "doc.get": {
    input: z.object({ docId: z.string() }).strict(),
    output: z.object({ doc: docSchema }),
  },
  "docs.list": {
    input: z.null(),
    output: z.object({
      docs: z.array(
        z.object({
          id: z.string(),
          kind: kindSchema,
          name: z.string(),
          absPath: z.string(),
          hostId: z.string().nullable(),
          counts: z.object({
            draft: z.number(),
            sent: z.number(),
            replied: z.number(),
            resolved: z.number(),
          }),
          lastActivity: z.number(),
        }),
      ),
    }),
  },
  "doc.version": {
    input: z.object({ docId: z.string() }).strict(),
    output: z.object({ version: z.string().nullable() }),
  },
  "doc.html": {
    input: z.object({ docId: z.string() }).strict(),
    /** A same-origin URL that serves the page with the bridge, for a sandboxed frame. */
    output: z.object({ version: z.string(), url: z.string() }),
  },
  "doc.markdown": {
    input: z.object({ docId: z.string() }).strict(),
    output: z.object({
      version: z.string(),
      content: z.string(),
      /** Base URL that serves files next to the document, for relative images. */
      assetBaseUrl: z.string().nullable(),
    }),
  },
  "doc.pages": {
    input: z.object({ docId: z.string() }).strict(),
    output: z.discriminatedUnion("status", [
      z.object({
        status: z.literal("ready"),
        version: z.string(),
        pages: z.array(
          z.object({
            n: z.number(),
            width: z.number(),
            height: z.number(),
            url: z.string(),
          }),
        ),
      }),
      needsLibreOfficeSchema,
    ]),
  },
  /** URLs for the classic PDF view (null when there is no PDF) and the original file. */
  "doc.links": {
    input: z.object({ docId: z.string() }).strict(),
    output: z.object({ document: linkSchema.nullable(), download: linkSchema }),
  },
  "sheet.open": {
    input: z.object({ docId: z.string(), locale: localeSchema }).strict(),
    output: z.object({
      version: z.string(),
      workbook: workbookSummarySchema,
      sheet: sheetDataSchema,
      /** "basic" when only values and fills could be read. */
      fidelity: z.enum(["full", "basic"]),
    }),
  },
  "sheet.read": {
    input: z
      .object({ docId: z.string(), index: z.number().int().min(0), locale: localeSchema })
      .strict(),
    output: z.object({ sheet: sheetDataSchema }),
  },
  hosts: {
    input: z.null(),
    output: z.object({
      hosts: z.array(
        z.object({
          id: z.string(),
          name: z.string(),
          status: z.enum(["connected", "disconnected"]),
        }),
      ),
    }),
  },
  browse: {
    input: z
      .object({
        hostId: z.string().nullable().optional(),
        path: z.string().nullable().optional(),
      })
      .strict(),
    output: z.object({
      hostId: z.string(),
      directory: z.string(),
      parent: z.string().nullable(),
      entries: z.array(
        z.object({
          name: z.string(),
          path: z.string(),
          kind: z.enum(["directory", "file"]),
        }),
      ),
    }),
  },
  recents: {
    input: z.null(),
    output: z.object({ recents: z.array(recentSchema) }),
  },
  "recents.clear": {
    input: z.null(),
    output: z.object({ recents: z.array(recentSchema) }),
  },
  "doc.pageText": {
    input: z
      .object({
        docId: z.string(),
        version: z.string(),
        n: z.number().int().min(1),
      })
      .strict(),
    output: z.object({
      n: z.number(),
      lines: z.array(
        z.array(
          z.tuple([z.number(), z.number(), z.number(), z.number(), z.string()]),
        ),
      ),
    }),
  },
  "comments.list": {
    input: z.object({ docId: z.string() }).strict(),
    output: z.object({ comments: z.array(commentSchema) }),
  },
  "comments.create": {
    input: z
      .object({
        docId: z.string(),
        anchor: anchorSchema,
        body: z.string().trim().min(1).max(BODY_MAX),
        docVersion: z.string().nullable(),
        /** For drawings: what to make the agent's image from. */
        capture: captureSchema.optional(),
      })
      .strict(),
    output: commentSchema,
  },
  "comments.update": {
    input: z
      .object({ id: z.string(), body: z.string().trim().min(1).max(BODY_MAX) })
      .strict(),
    output: commentSchema,
  },
  /** The user's answer in a comment's thread, kept as a draft until sent. */
  "comments.reply": {
    input: z
      .object({ id: z.string(), body: z.string().trim().min(1).max(BODY_MAX) })
      .strict(),
    output: commentSchema,
  },
  "comments.discardReply": {
    input: z.object({ id: z.string() }).strict(),
    output: commentSchema,
  },
  "comments.delete": {
    input: z.object({ id: z.string() }).strict(),
    output: z.object({ deleted: z.boolean() }),
  },
  "comments.reopen": {
    input: z.object({ id: z.string() }).strict(),
    output: commentSchema,
  },
  "comments.send": {
    input: z
      .object({
        docId: z.string(),
        /** Omit to send every draft of the document. */
        ids: z.array(z.string()).max(500).optional(),
        target: sendTargetSchema,
      })
      .strict(),
    output: z.object({ threadId: z.string(), sent: z.number() }),
  },
  "comments.handoffPrompt": {
    input: z
      .object({ docId: z.string(), ids: z.array(z.string()).max(500).optional() })
      .strict(),
    output: z.object({ prompt: z.string(), ids: z.array(z.string()) }),
  },
  "comments.markSent": {
    input: z
      .object({ ids: z.array(z.string()).min(1).max(500), threadId: z.string().nullable() })
      .strict(),
    output: z.object({ sent: z.number() }),
  },
  /** The name the user signs exported comments with, as last used. */
  "export.signer": {
    input: z.null(),
    output: z.object({ signer: z.string().nullable() }),
  },
  /** A PDF of a paged document with its comments, to download. */
  "doc.export": {
    input: z.object({ docId: z.string(), signer: signerSchema }).strict(),
    output: z.object({ link: linkSchema, name: z.string(), count: z.number() }),
  },
  /** Comments a PDF carries from another bb's export, if any. */
  "doc.shared": {
    input: z.object({ docId: z.string() }).strict(),
    output: z.object({
      shared: z
        .object({
          by: z.string().nullable(),
          file: z.string(),
          count: z.number(),
          newHere: z.number(),
          original: z.object({ path: z.string(), kind: kindSchema, newThere: z.number() }).nullable(),
        })
        .nullable(),
    }),
  },
  /** Brings those comments in: into this PDF, or into the file they were written on. */
  "comments.import": {
    input: z.object({ docId: z.string(), into: z.enum(["here", "original"]) }).strict(),
    output: z.object({ docId: z.string(), name: z.string(), added: z.number(), updated: z.number() }),
  },
});

export type RpcContract = typeof rpcContract;
export type Capture = z.infer<typeof captureSchema>;
export type ViewerLink = z.infer<typeof linkSchema>;
export type NeedsLibreOffice = z.infer<typeof needsLibreOfficeSchema>;
export type WorkbookSummary = z.infer<typeof workbookSummarySchema>;
export type RecentDocument = z.infer<typeof recentSchema>;
