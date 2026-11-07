// What a board shows: a queue, a query, or one issue with everything nested under it.
import { LIMITS } from "../shared/limits";
import type { Issue } from "../shared/model";
import { mapLimit } from "./engine";
import type { Tracker } from "./tracker";

export type { Source } from "../shared/prefs";
import { sourceFromText, type Source } from "../shared/prefs";

export interface Board {
  source: Source;
  root: Issue | null;
  issues: Issue[];
  /** The board stopped at the size limit. */
  truncated: boolean;
}

export function sourceKey(source: Source): string {
  switch (source.kind) {
    case "queue":
      return `queue:${source.queue}`;
    case "issue":
      return `issue:${source.key}`;
    case "query":
      return `query:${source.query}`;
    case "mine":
      return "mine";
  }
}

/** A typed source: an issue key or a link to one, a queue key, or a query. */
/** What a typed or pasted text opens; see `sourceFromText`. */
export function parseSource(text: string, allowQuery: boolean): Source | null {
  return sourceFromText(text, allowQuery);
}

function fill(template: string, vars: Record<string, string>): string {
  return template.replace(/\{([A-Za-z]+)\}/g, (match, name: string) => vars[name] ?? match);
}

/** Everything below `root` in `pool`, by parent links. */
export function descendants(rootKey: string, pool: readonly Issue[]): Issue[] {
  const children = new Map<string, Issue[]>();
  for (const issue of pool) {
    if (!issue.parent) continue;
    const list = children.get(issue.parent) ?? [];
    list.push(issue);
    children.set(issue.parent, list);
  }
  const out: Issue[] = [];
  const seen = new Set([rootKey]);
  const queue = [rootKey];
  while (queue.length > 0) {
    const key = queue.shift()!;
    for (const child of children.get(key) ?? []) {
      if (seen.has(child.key)) continue;
      seen.add(child.key);
      out.push(child);
      queue.push(child.key);
    }
  }
  return out;
}

const CHILD_BATCH = 40;
const MAX_DEPTH = 5;
const PARENT_BATCH = 40;
/** Parents read one by one when the profile cannot ask for several keys at once. */
const PARENT_SINGLE_MAX = 60;
const PARENT_CONCURRENCY = 4;
export const MAX_PARENTS = 200;

function missingParents(issues: readonly Issue[], known: ReadonlyMap<string, Issue>): string[] {
  return [...new Set(issues.map((issue) => issue.parent).filter((key): key is string => Boolean(key) && !known.has(key!)))];
}

async function readByKeys(tracker: Tracker, keys: readonly string[]): Promise<Issue[]> {
  const query = tracker.profile.queries.keys;
  if (query) {
    const out: Issue[] = [];
    for (let i = 0; i < keys.length; i += PARENT_BATCH) {
      const batch = keys.slice(i, i + PARENT_BATCH);
      const page = await tracker.search(fill(query, { keys: batch.join(", "), key: batch[0]! }), batch.length);
      out.push(...page.issues);
    }
    return out;
  }
  const single = keys.slice(0, PARENT_SINGLE_MAX);
  const found = await mapLimit(single, PARENT_CONCURRENCY, (key) => tracker.issue(key).catch(() => null));
  return found.filter((issue): issue is Issue => issue !== null);
}

/**
 * The parents above `issues` that `issues` do not hold, level by level up to the top:
 * a task on "assigned to me" shows its story and epic though both live on other boards.
 * Best effort: whatever fails to load is left out, the board itself stays.
 */
export async function loadParents(tracker: Tracker, issues: readonly Issue[], max: number = MAX_PARENTS): Promise<Issue[]> {
  const known = new Map(issues.map((issue) => [issue.key, issue]));
  const out: Issue[] = [];
  let wanted = missingParents(issues, known);
  for (let depth = 0; depth < MAX_DEPTH && wanted.length > 0 && out.length < max; depth += 1) {
    let found: Issue[];
    try {
      found = await readByKeys(tracker, wanted.slice(0, max - out.length));
    } catch {
      break;
    }
    const fresh = found.filter((issue) => !known.has(issue.key));
    for (const issue of fresh) {
      known.set(issue.key, issue);
      out.push(issue);
    }
    wanted = missingParents(fresh, known);
  }
  return out;
}

export async function loadBoard(tracker: Tracker, source: Source, max: number = LIMITS.boardIssues): Promise<Board> {
  const queries = tracker.profile.queries;
  if (source.kind === "queue") {
    const { issues, truncated } = await tracker.search(fill(queries.queue, { queue: source.queue }), max);
    return { source, root: null, issues, truncated };
  }
  if (source.kind === "query") {
    const { issues, truncated } = await tracker.search(source.query, max);
    return { source, root: null, issues, truncated };
  }
  if (source.kind === "mine") {
    if (!queries.mine) return { source, root: null, issues: [], truncated: false };
    const { issues, truncated } = await tracker.search(queries.mine, max);
    return { source, root: null, issues, truncated };
  }
  const root = await tracker.issue(source.key);
  if (queries.children) {
    // Level by level: the children of every issue found on the previous level.
    const found = new Map<string, Issue>();
    let level = [root.key];
    let truncated = false;
    for (let depth = 0; depth < MAX_DEPTH && level.length > 0 && !truncated; depth += 1) {
      const next: string[] = [];
      for (let i = 0; i < level.length && !truncated; i += CHILD_BATCH) {
        const keys = level.slice(i, i + CHILD_BATCH);
        const page = await tracker.search(fill(queries.children, { keys: keys.join(", "), key: keys[0]! }), max - found.size);
        for (const issue of page.issues) {
          if (issue.key === root.key || found.has(issue.key)) continue;
          found.set(issue.key, issue);
          next.push(issue.key);
        }
        truncated = page.truncated || found.size >= max;
      }
      level = next;
    }
    return { source, root, issues: [root, ...descendants(root.key, [...found.values()])], truncated };
  }
  // No query for children: read the root's queue and follow parent links.
  const queue = root.queue;
  if (!queue) return { source, root, issues: [root], truncated: false };
  const { issues, truncated } = await tracker.search(fill(queries.queue, { queue }), max);
  return { source, root, issues: [root, ...descendants(root.key, issues)], truncated };
}
