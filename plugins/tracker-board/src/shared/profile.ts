// The API profile: how this plugin talks to one tracker's REST API. It comes from
// the build's settings as JSON, so the same plugin serves different trackers; the
// README documents every field. Nothing here knows a particular tracker.
import { z } from "zod";
import type { Json } from "./json-path";

const jsonSchema: z.ZodType<Json> = z.lazy(() =>
  z.union([z.null(), z.boolean(), z.number(), z.string(), z.array(jsonSchema), z.record(z.string(), jsonSchema)]),
);

const requestSchema = z
  .object({
    method: z.enum(["GET", "POST", "PATCH", "PUT", "DELETE"]).default("GET"),
    path: z.string().min(1).max(500).startsWith("/"),
    query: z.record(z.string().max(100), z.string().max(2000)).optional(),
    body: jsonSchema.optional(),
  })
  .strict();
export type RequestTemplate = z.infer<typeof requestSchema>;

const pathSchema = z.string().max(300);

const issueFieldsSchema = z
  .object({
    key: pathSchema.default("key"),
    id: pathSchema.optional(),
    queue: pathSchema.optional(),
    summary: pathSchema.default("summary"),
    description: pathSchema.optional(),
    type: pathSchema.default("type"),
    status: pathSchema.default("status"),
    statusName: pathSchema.optional(),
    statusCategory: pathSchema.optional(),
    priority: pathSchema.optional(),
    assignee: pathSchema.optional(),
    assigneeName: pathSchema.optional(),
    author: pathSchema.optional(),
    authorName: pathSchema.optional(),
    parent: pathSchema.optional(),
    labels: pathSchema.optional(),
    components: pathSchema.optional(),
    due: pathSchema.optional(),
    start: pathSchema.optional(),
    created: pathSchema.optional(),
    updated: pathSchema.optional(),
  })
  .strict();
export type IssueFields = z.infer<typeof issueFieldsSchema>;

const statusSchema = z
  .object({
    key: z.string().min(1).max(100),
    name: z.string().max(100).optional(),
    /** todo, progress or done; anything else counts as progress. */
    category: z.string().max(50).optional(),
    /** `always`: a board column even when empty (default); `used`: only names and the category, a column when a card is in it. */
    show: z.enum(["always", "used"]).default("always"),
  })
  .strict();
export type StatusConfig = z.infer<typeof statusSchema>;

const namedSchema = z.object({ key: z.string().min(1).max(100), name: z.string().max(100).optional() }).strict();

export const profileSchema = z
  .object({
    auth: z
      .object({
        header: z.string().regex(/^[A-Za-z0-9-]{1,64}$/).default("Authorization"),
        format: z.string().max(200).default("Bearer {key}"),
      })
      .strict()
      .default({ header: "Authorization", format: "Bearer {key}" }),
    /** Static, non-secret headers sent with every request. */
    headers: z.record(z.string().regex(/^[A-Za-z0-9-]{1,64}$/), z.string().max(500)).default({}),
    /** Wrappers some APIs put around every answer, stripped when present: `data`. */
    unwrap: z.array(z.string().max(50)).max(5).default([]),
    /** The issue's page in a browser: `https://tracker.example.com/{key}`. */
    webUrl: z.string().max(500).optional(),
    /** Where people create an API key, shown next to the key field. */
    keyHelp: z.string().max(500).optional(),
    requests: z
      .object({
        myself: requestSchema,
        issue: requestSchema,
        search: requestSchema,
        create: requestSchema.optional(),
        update: requestSchema.optional(),
        transition: requestSchema.optional(),
        setParent: requestSchema.optional(),
        clearParent: requestSchema.optional(),
        assign: requestSchema.optional(),
        unassign: requestSchema.optional(),
        comments: requestSchema.optional(),
        addComment: requestSchema.optional(),
        users: requestSchema.optional(),
        user: requestSchema.optional(),
        statuses: requestSchema.optional(),
        components: requestSchema.optional(),
        issueComponents: requestSchema.optional(),
        addComponent: requestSchema.optional(),
      })
      .strict(),
    /** Query-language templates for the search request's {query}. */
    queries: z
      .object({
        queue: z.string().max(500),
        /** Direct children of one or more issues: {keys}. Without it a board walks the whole queue. */
        children: z.string().max(500).optional(),
        keys: z.string().max(500).optional(),
        text: z.string().max(500).optional(),
        mine: z.string().max(500).optional(),
      })
      .strict(),
    paging: z
      .object({
        limit: z.number().int().min(1).max(1000).default(100),
        /** offset or page: what {offset} counts. */
        mode: z.enum(["offset", "page"]).default("offset"),
        firstPage: z.number().int().min(0).max(1).default(1),
      })
      .strict()
      .default({ limit: 100, mode: "offset", firstPage: 1 }),
    responses: z
      .object({
        issues: pathSchema.default(""),
        total: pathSchema.optional(),
        totalHeader: z.string().regex(/^[A-Za-z0-9-]{1,64}$/).optional(),
        issue: pathSchema.default(""),
        created: pathSchema.default(""),
        myself: pathSchema.default(""),
        user: pathSchema.default(""),
        users: pathSchema.default(""),
        statuses: pathSchema.default(""),
        comments: pathSchema.default(""),
        components: pathSchema.default(""),
      })
      .strict()
      .default({ issues: "", issue: "", created: "", myself: "", user: "", users: "", statuses: "", comments: "", components: "" }),
    fields: issueFieldsSchema.default({ key: "key", summary: "summary", type: "type", status: "status" }),
    userFields: z
      .object({ id: pathSchema.default("id"), name: pathSchema.default("display_name|name"), login: pathSchema.optional() })
      .strict()
      .default({ id: "id", name: "display_name|name" }),
    statusFields: z
      .object({ key: pathSchema.default("key"), name: pathSchema.default("name"), category: pathSchema.optional() })
      .strict()
      .default({ key: "key", name: "name" }),
    commentFields: z
      .object({
        id: pathSchema.default("id"),
        text: pathSchema.default("text"),
        author: pathSchema.optional(),
        authorName: pathSchema.optional(),
        created: pathSchema.optional(),
      })
      .strict()
      .default({ id: "id", text: "text" }),
    componentFields: z
      .object({ id: pathSchema.default("id"), name: pathSchema.default("name") })
      .strict()
      .default({ id: "id", name: "name" }),
    /** Statuses in board order. A status the tracker reports that is not listed goes by its category. */
    statuses: z.array(statusSchema).max(100).default([]),
    /** Which tracker types are epics, stories and bugs; every other type is a task. */
    kinds: z
      .object({
        epic: z.array(z.string().max(100)).default(["epic"]),
        story: z.array(z.string().max(100)).default(["story"]),
        bug: z.array(z.string().max(100)).default(["bug"]),
      })
      .strict()
      .default({ epic: ["epic"], story: ["story"], bug: ["bug"] }),
    /** Types people can pick when creating, in menu order. */
    types: z.array(namedSchema).max(50).default([]),
    priorities: z.array(namedSchema).max(20).default([]),
    /** Changing labels sends the whole list (`set`) or the added and removed ones (`delta`). */
    labelUpdate: z.enum(["set", "delta"]).default("set"),
    /** Values for the create request's variables nobody gave, such as a priority the tracker requires. */
    createDefaults: z.record(z.string().regex(/^[A-Za-z][A-Za-z0-9_]{0,40}$/), z.string().max(200)).default({}),
  })
  .strict();
export type Profile = z.infer<typeof profileSchema>;

export class ProfileError extends Error {}

export function parseProfile(text: string): Profile {
  if (text.trim() === "") throw new ProfileError("The API profile is not set");
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch (error) {
    throw new ProfileError(`The API profile is not valid JSON: ${error instanceof Error ? error.message : String(error)}`);
  }
  const parsed = profileSchema.safeParse(raw);
  if (!parsed.success) {
    const issue = parsed.error.issues[0];
    throw new ProfileError(`The API profile is invalid at ${issue?.path.join(".") || "(root)"}: ${issue?.message ?? "unknown problem"}`);
  }
  if (parsed.data.auth.format.split("{key}").length !== 2) throw new ProfileError("auth.format must contain {key} exactly once");
  return parsed.data;
}

export type Category = "todo" | "progress" | "done";

const TODO_WORDS = ["todo", "to_do", "new", "open", "backlog", "initial", "created", "draft"];
const DONE_WORDS = ["done", "closed", "resolved", "complete", "completed", "final", "cancelled", "canceled", "finished"];

export function categoryOf(value: string | null | undefined): Category {
  const word = (value ?? "").toLowerCase().replace(/[\s-]+/g, "_");
  if (TODO_WORDS.includes(word)) return "todo";
  if (DONE_WORDS.includes(word)) return "done";
  return "progress";
}

export function normalizeBaseUrl(text: string): string {
  const trimmed = text.trim();
  let url: URL;
  try {
    url = new URL(trimmed);
  } catch {
    throw new ProfileError(`The tracker address is not a URL: ${trimmed}`);
  }
  const local = url.hostname === "localhost" || url.hostname === "127.0.0.1" || url.hostname === "[::1]";
  if (url.protocol !== "https:" && !(url.protocol === "http:" && local)) throw new ProfileError("The tracker address must start with https://");
  if (url.username || url.password) throw new ProfileError("The tracker address must not contain a login");
  if (url.search || url.hash) throw new ProfileError("The tracker address must not contain ? or #");
  return url.toString().replace(/\/+$/, "");
}
