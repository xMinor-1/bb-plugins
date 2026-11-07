// The plugin's own view of a tracker issue, whatever the tracker's JSON looks like.
// The panel and the agent tools see only this shape.
import { displayName, getPath, listOf, scalar, textOf } from "./json-path";
import { categoryOf, type Category, type Profile } from "./profile";

export type Kind = "epic" | "story" | "task" | "bug";

export interface Issue {
  key: string;
  /** The tracker's internal id, when it differs from the key. */
  id: string | null;
  queue: string | null;
  summary: string;
  description: string | null;
  type: string;
  kind: Kind;
  status: string;
  statusName: string | null;
  category: Category;
  priority: string | null;
  assignee: string | null;
  assigneeName: string | null;
  author: string | null;
  authorName: string | null;
  parent: string | null;
  labels: string[];
  components: string[];
  due: string | null;
  start: string | null;
  created: string | null;
  updated: string | null;
}

export interface Person {
  id: string;
  name: string;
}

export interface Comment {
  id: string;
  text: string;
  author: string | null;
  authorName: string | null;
  created: string | null;
}

export const KEY_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,31}-\d{1,9}$/;
export const QUEUE_PATTERN = /^[A-Za-z][A-Za-z0-9_]{0,31}$/;

/** The first issue key in a text or a link, for example the key at the end of a tracker URL. */
export function findKey(text: string): string | null {
  const parts = text.slice(0, 1000).split(/[^A-Za-z0-9_-]+/);
  for (const part of parts) if (KEY_PATTERN.test(part)) return part.toUpperCase();
  return null;
}

/** `[BE] Saved cards` → `{ prefix: "BE", rest: "Saved cards" }`. */
export function splitPrefix(summary: string): { prefix: string; rest: string } {
  if (!summary.startsWith("[")) return { prefix: "", rest: summary };
  const end = summary.indexOf("]");
  if (end < 2 || end > 9) return { prefix: "", rest: summary };
  const prefix = summary.slice(1, end);
  if (!/^[A-Za-z0-9]+$/.test(prefix)) return { prefix: "", rest: summary };
  return { prefix, rest: summary.slice(end + 1).trimStart() };
}

function kindOf(type: string, profile: Profile): Kind {
  const lower = type.toLowerCase();
  const has = (list: readonly string[]) => list.some((item) => item.toLowerCase() === lower);
  if (has(profile.kinds.epic)) return "epic";
  if (has(profile.kinds.story)) return "story";
  if (has(profile.kinds.bug)) return "bug";
  return "task";
}

const date = (value: unknown): string | null => {
  const text = textOf(value);
  return text && text.length <= 40 ? text : null;
};

function strings(value: unknown): string[] {
  return listOf(value)
    .map((item) => displayName(item) ?? scalar(item))
    .filter((item): item is string => item !== null)
    .slice(0, 200);
}

/** Reads one issue. Null for an entry without a key or a summary. */
export function issueFrom(raw: unknown, profile: Profile, statusNames?: ReadonlyMap<string, { name: string; category: string | null }>): Issue | null {
  const f = profile.fields;
  const key = scalar(getPath(raw, f.key));
  if (!key) return null;
  const summary = textOf(getPath(raw, f.summary)) ?? "";
  const typeValue = getPath(raw, f.type);
  const type = scalar(typeValue) ?? "task";
  const statusValue = getPath(raw, f.status);
  const status = scalar(statusValue) ?? "";
  const known = profile.statuses.find((item) => item.key === status);
  const fetched = statusNames?.get(status);
  const statusName = textOf(getPath(raw, f.statusName)) ?? (typeof statusValue === "object" ? displayName(statusValue) : null) ?? known?.name ?? fetched?.name ?? null;
  const categoryText =
    textOf(getPath(raw, f.statusCategory)) ??
    (statusValue && typeof statusValue === "object" ? textOf((statusValue as Record<string, unknown>).category) : null) ??
    known?.category ??
    fetched?.category ??
    status;
  const assigneeValue = f.assignee ? getPath(raw, f.assignee) : undefined;
  const authorValue = f.author ? getPath(raw, f.author) : undefined;
  return {
    key,
    id: f.id ? scalar(getPath(raw, f.id)) : null,
    queue: f.queue ? scalar(getPath(raw, f.queue)) : key.includes("-") ? key.slice(0, key.lastIndexOf("-")) : null,
    summary,
    description: f.description ? textOf(getPath(raw, f.description)) : null,
    type,
    kind: kindOf(type, profile),
    status,
    statusName,
    category: categoryOf(categoryText),
    priority: f.priority ? scalar(getPath(raw, f.priority)) : null,
    assignee: scalar(assigneeValue),
    assigneeName: (f.assigneeName ? displayName(getPath(raw, f.assigneeName)) : null) ?? (typeof assigneeValue === "object" ? displayName(assigneeValue) : null),
    author: scalar(authorValue),
    authorName: (f.authorName ? displayName(getPath(raw, f.authorName)) : null) ?? (typeof authorValue === "object" ? displayName(authorValue) : null),
    parent: f.parent ? scalar(getPath(raw, f.parent)) : null,
    labels: f.labels ? strings(getPath(raw, f.labels)) : [],
    components: f.components ? strings(getPath(raw, f.components)) : [],
    due: f.due ? date(getPath(raw, f.due)) : null,
    start: f.start ? date(getPath(raw, f.start)) : null,
    created: f.created ? date(getPath(raw, f.created)) : null,
    updated: f.updated ? date(getPath(raw, f.updated)) : null,
  };
}

export function personFrom(raw: unknown, profile: Profile): Person | null {
  const id = scalar(getPath(raw, profile.userFields.id));
  if (!id) return null;
  const name = displayName(getPath(raw, profile.userFields.name)) ?? (profile.userFields.login ? scalar(getPath(raw, profile.userFields.login)) : null) ?? id;
  return { id, name };
}

export function commentFrom(raw: unknown, profile: Profile): Comment | null {
  const c = profile.commentFields;
  const text = textOf(getPath(raw, c.text));
  if (text === null) return null;
  const authorValue = c.author ? getPath(raw, c.author) : undefined;
  return {
    id: scalar(getPath(raw, c.id)) ?? "",
    text: text.slice(0, 20_000),
    author: scalar(authorValue),
    authorName: (c.authorName ? displayName(getPath(raw, c.authorName)) : null) ?? (typeof authorValue === "object" ? displayName(authorValue) : null),
    created: c.created ? date(getPath(raw, c.created)) : null,
  };
}

/** The chain of parents above an issue, nearest last, within the given set. */
export function ancestors(issue: Issue, byKey: ReadonlyMap<string, Issue>): Issue[] {
  const out: Issue[] = [];
  const seen = new Set([issue.key]);
  let next = issue.parent ? byKey.get(issue.parent) : undefined;
  while (next && !seen.has(next.key) && out.length < 20) {
    out.unshift(next);
    seen.add(next.key);
    next = next.parent ? byKey.get(next.parent) : undefined;
  }
  return out;
}
