// What a person sets up for themselves: how cards look, their own templates, the
// people they assign most, and recent boards. Kept by the server; the export file
// holds exactly this and never the API key.
import { z } from "zod";
import { LIMITS } from "./limits";
import { KEY_PATTERN, QUEUE_PATTERN } from "./model";
import { templateSchema } from "./templates";

export const CARD_FIELDS = ["type", "key", "priority", "description", "composition", "labels", "components", "parent", "due", "assignee", "comments"] as const;
export type CardField = (typeof CARD_FIELDS)[number];
export const DEFAULT_FIELDS: CardField[] = ["type", "key", "priority", "description", "composition", "labels", "parent", "due", "assignee"];

export const sourceSchema = z.discriminatedUnion("kind", [
  z.object({ kind: z.literal("queue"), queue: z.string().min(1).max(60) }).strict(),
  z.object({ kind: z.literal("issue"), key: z.string().min(1).max(60) }).strict(),
  z.object({ kind: z.literal("query"), query: z.string().min(1).max(2000) }).strict(),
  z.object({ kind: z.literal("mine") }).strict(),
]);

export const displaySchema = z
  .object({
    view: z.enum(["board", "list"]).default("board"),
    group: z.enum(["none", "story", "assignee"]).default("none"),
    fields: z.array(z.enum(CARD_FIELDS)).max(CARD_FIELDS.length).default(DEFAULT_FIELDS),
    clamp: z.union([z.literal(2), z.literal(3), z.literal(99)]).default(3),
    width: z.enum(["narrow", "normal", "wide"]).default("normal"),
    /** The chat beside the board or below it; the same on every board. */
    chat: z.enum(["right", "bottom"]).default("right"),
    /** The chat's share of the page's height when it is below, in per cent. */
    chatHeight: z.number().int().min(20).max(80).default(45),
  })
  .strict();
export type Display = z.infer<typeof displaySchema>;

export const personSchema = z.object({ id: z.string().min(1).max(200), name: z.string().min(1).max(200) }).strict();

export const prefsSchema = z
  .object({
    display: displaySchema.default(displaySchema.parse({})),
    templates: z.array(templateSchema).max(LIMITS.templates).default([]),
    people: z.array(personSchema).max(LIMITS.people).default([]),
    source: sourceSchema.nullable().default(null),
    recent: z.array(z.object({ source: sourceSchema, title: z.string().max(300) }).strict()).max(LIMITS.recent).default([]),
  })
  .strict();
export type Prefs = z.infer<typeof prefsSchema>;

const recentSchema = z.array(z.object({ source: sourceSchema, title: z.string().max(300) }).strict()).max(LIMITS.recent);

/**
 * A change to some of the prefs. Not `prefsSchema.partial()`: zod 4 fills a missing
 * key's default there, so saving the display alone would reset the board in view.
 */
export const prefsPatchSchema = z
  .object({
    display: displaySchema.optional(),
    templates: z.array(templateSchema).max(LIMITS.templates).optional(),
    people: z.array(personSchema).max(LIMITS.people).optional(),
    source: sourceSchema.nullable().optional(),
    recent: recentSchema.optional(),
  })
  .strict();
export type PrefsInput = z.input<typeof prefsSchema>;

export const EXPORT_KIND = "bb-tracker-board-settings";

/** The export file: prefs without the board in view. */
export const exportSchema = z
  .object({
    kind: z.literal(EXPORT_KIND),
    version: z.literal(1),
    display: displaySchema.optional(),
    templates: z.array(templateSchema).max(LIMITS.templates).optional(),
    people: z.array(personSchema).max(LIMITS.people).optional(),
    recent: z.array(z.object({ source: sourceSchema, title: z.string().max(300) }).strict()).max(LIMITS.recent).optional(),
  })
  .strict();
export type ExportFile = z.infer<typeof exportSchema>;

export function toExport(prefs: Prefs): ExportFile {
  return { kind: EXPORT_KIND, version: 1, display: prefs.display, templates: prefs.templates, people: prefs.people, recent: prefs.recent };
}

/** Settings from a file replace the matching parts; the board in view stays. */
export function fromExport(prefs: Prefs, file: ExportFile): Prefs {
  return prefsSchema.parse({
    ...prefs,
    ...(file.display ? { display: file.display } : {}),
    ...(file.templates ? { templates: file.templates } : {}),
    ...(file.people ? { people: file.people } : {}),
    ...(file.recent ? { recent: file.recent } : {}),
  });
}
export type Source = z.infer<typeof sourceSchema>;

/**
 * What a typed or pasted text opens: an issue key, a queue, a link to an issue (with or
 * without its scheme), else a query when the build allows them. A link without a key
 * opens nothing: sent as a query it only makes the tracker answer with a parse error.
 */
export function sourceFromText(text: string, allowQuery: boolean): Source | null {
  const trimmed = text.trim().slice(0, 2000);
  if (trimmed === "") return null;
  if (KEY_PATTERN.test(trimmed)) return { kind: "issue", key: trimmed.toUpperCase() };
  if (QUEUE_PATTERN.test(trimmed)) return { kind: "queue", queue: trimmed.toUpperCase() };
  if (!/\s/.test(trimmed) && trimmed.includes("/")) {
    for (const part of trimmed.split(/[/?#]/).reverse()) if (KEY_PATTERN.test(part)) return { kind: "issue", key: part.toUpperCase() };
    return null;
  }
  return allowQuery ? { kind: "query", query: trimmed } : null;
}
