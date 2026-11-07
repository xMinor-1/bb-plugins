// Checking and applying changes. `plan` reads every issue a batch touches as it is
// now and says, change by change, what would happen; `apply` sends the approved
// ones in order, creating parents before their children.
import type { Change, ChangeResult, PlannedChange, SkipReason } from "../shared/changes";
import type { Json } from "../shared/json-path";
import type { Issue, Person } from "../shared/model";
import type { Tracker } from "./tracker";
import { TrackerError } from "./tracker";

export interface PlanContext {
  tracker: Tracker;
  /** Names for person ids, for the descriptions. */
  people: ReadonlyMap<string, string>;
  /** Known statuses: key → name. Empty when the tracker gives no list. */
  statuses: ReadonlyMap<string, string>;
  /** Issues already loaded, to save requests. Re-read anyway before applying. */
  known?: ReadonlyMap<string, Issue>;
}

const CONCURRENCY = 6;

export async function mapLimit<T, R>(items: readonly T[], limit: number, run: (item: T) => Promise<R>): Promise<R[]> {
  const out: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from({ length: Math.min(limit, items.length) }, async () => {
    while (next < items.length) {
      const index = next++;
      out[index] = await run(items[index]!);
    }
  });
  await Promise.all(workers);
  return out;
}

function keysOf(change: Change): string[] {
  if (change.kind === "create") return change.parentKey ? [change.parentKey] : [];
  if (change.kind === "parent") return change.to ? [change.key, change.to] : [change.key];
  return [change.key];
}

/** Reads fresh copies of the issues a batch touches. A missing issue maps to null. */
export async function readIssues(tracker: Tracker, keys: readonly string[]): Promise<Map<string, Issue | null>> {
  const unique = [...new Set(keys)];
  const found = await mapLimit(unique, CONCURRENCY, async (key) => {
    try {
      return await tracker.issue(key);
    } catch (error) {
      if (error instanceof TrackerError && error.code === "notFound") return null;
      throw error;
    }
  });
  return new Map(unique.map((key, index) => [key, found[index] ?? null]));
}

function supported(tracker: Tracker, change: Change): boolean {
  switch (change.kind) {
    case "status":
      return tracker.has("transition") || tracker.uses("update", "status");
    case "assignee":
      return change.to === null ? tracker.has("unassign") || tracker.uses("update", "assignee") : tracker.has("assign") || tracker.uses("update", "assignee");
    case "priority":
      return tracker.uses("update", "priority");
    case "labels":
      return tracker.uses("update", "labels") || tracker.uses("update", "labelsAdd") || tracker.uses("update", "labelsRemove");
    case "parent":
      return change.to === null ? tracker.has("clearParent") || tracker.uses("update", "parent") : tracker.has("setParent") || tracker.uses("update", "parent");
    case "summary":
      return tracker.uses("update", "summary");
    case "description":
      return tracker.uses("update", "description");
    case "comment":
      return tracker.has("addComment");
    case "create":
      return tracker.has("create");
  }
}

const short = (text: string, max = 80) => (text.length > max ? `${text.slice(0, max - 1)}…` : text);

/** The change that puts an issue back as it was before `change`, read from the issue as it is now. */
export function inverseOf(change: Change, issue: Issue): Change | null {
  switch (change.kind) {
    case "status":
      return { kind: "status", key: issue.key, to: issue.status };
    case "assignee":
      return { kind: "assignee", key: issue.key, to: issue.assignee };
    case "priority":
      // A tracker takes a priority but rarely "no priority": nothing to go back to.
      return issue.priority ? { kind: "priority", key: issue.key, to: issue.priority } : null;
    case "labels": {
      const added = change.add.filter((label) => !issue.labels.includes(label));
      const removed = change.remove.filter((label) => issue.labels.includes(label));
      return { kind: "labels", key: issue.key, add: removed, remove: added };
    }
    case "parent":
      return { kind: "parent", key: issue.key, to: issue.parent };
    case "summary":
      return { kind: "summary", key: issue.key, to: issue.summary };
    case "description":
      return { kind: "description", key: issue.key, to: issue.description ?? "" };
    case "comment":
    case "create":
      return null;
  }
}

/**
 * Whether an issue still holds what `change` set. Undo goes back only then: a value
 * someone changed since stays theirs. Labels go back as a difference, so always.
 */
export function stillAsSet(change: Change, issue: Issue): boolean {
  switch (change.kind) {
    case "status":
      return issue.status === change.to;
    case "assignee":
      return issue.assignee === change.to;
    case "priority":
      return issue.priority === change.to;
    case "parent":
      return issue.parent === change.to;
    case "summary":
      return issue.summary === change.to;
    case "description":
      return (issue.description ?? "") === change.to;
    case "labels":
      return true;
    case "comment":
    case "create":
      return false;
  }
}

export async function plan(ctx: PlanContext, changes: readonly Change[]): Promise<PlannedChange[]> {
  const issues = await readIssues(ctx.tracker, changes.flatMap(keysOf));
  const person = (id: string | null) => (id === null ? "nobody" : ctx.people.get(id) ?? id);
  const status = (key: string) => ctx.statuses.get(key) ?? key;
  const refs = new Set<string>();
  const seen = new Set<string>();
  return changes.map((change, index): PlannedChange => {
    const id = `c${index + 1}`;
    const skip = (reason: SkipReason, title: string, key: string | null = null): PlannedChange => ({ id, change, key, title, ok: false, skip: reason, from: null, to: null });
    const ok = (key: string | null, title: string, from: string | null, to: string | null): PlannedChange => {
      const issue = change.kind === "create" ? null : issues.get(change.key);
      return { id, change, key, title, ok: true, skip: null, from, to, undo: issue ? inverseOf(change, issue) : null };
    };
    if (change.kind === "create") {
      const title = change.summary;
      if (!supported(ctx.tracker, change)) return skip("notSupported", title);
      if (change.parentRef && !refs.has(change.parentRef)) return skip("noParent", title);
      if (change.parentKey && !issues.get(change.parentKey)) return skip("noParent", title);
      if (refs.has(change.ref)) return skip("duplicate", title);
      refs.add(change.ref);
      const under = change.parentKey ?? (change.parentRef ? `new ${change.parentRef}` : null);
      return ok(null, title, null, under ? `under ${under}` : null);
    }
    const issue = issues.get(change.key) ?? null;
    if (!issue) return skip("noIssue", change.key, change.key);
    const title = issue.summary;
    if (!supported(ctx.tracker, change)) return skip("notSupported", title, issue.key);
    const signature = JSON.stringify(change);
    if (seen.has(signature)) return skip("duplicate", title, issue.key);
    seen.add(signature);
    switch (change.kind) {
      case "status":
        if (issue.status === change.to) return skip("same", title, issue.key);
        if (ctx.statuses.size > 0 && !ctx.statuses.has(change.to)) return skip("unknownStatus", title, issue.key);
        return ok(issue.key, title, issue.statusName ?? status(issue.status), status(change.to));
      case "assignee":
        if (issue.assignee === change.to) return skip("same", title, issue.key);
        return ok(issue.key, title, issue.assigneeName ?? person(issue.assignee), person(change.to));
      case "priority":
        if (issue.priority === change.to) return skip("same", title, issue.key);
        return ok(issue.key, title, issue.priority ?? "none", change.to);
      case "labels": {
        const add = change.add.filter((label) => !issue.labels.includes(label));
        const remove = change.remove.filter((label) => issue.labels.includes(label));
        if (add.length === 0 && remove.length === 0) return skip(change.add.length + change.remove.length === 0 ? "noLabels" : "same", title, issue.key);
        return ok(issue.key, title, null, [...add.map((label) => `+${label}`), ...remove.map((label) => `−${label}`)].join(", "));
      }
      case "parent": {
        if (change.to === issue.key) return skip("selfParent", title, issue.key);
        if (issue.parent === change.to) return skip("same", title, issue.key);
        if (change.to) {
          const target = issues.get(change.to);
          if (!target) return skip("noParent", title, issue.key);
          // The new parent must not sit below this issue.
          let walk: Issue | null | undefined = target;
          for (let depth = 0; walk && depth < 20; depth += 1) {
            if (walk.parent === issue.key) return skip("cycle", title, issue.key);
            walk = walk.parent ? issues.get(walk.parent) ?? ctx.known?.get(walk.parent) : null;
          }
        }
        return ok(issue.key, title, issue.parent ?? "none", change.to ?? "none");
      }
      case "summary":
        if (issue.summary === change.to) return skip("same", title, issue.key);
        return ok(issue.key, title, short(issue.summary), short(change.to));
      case "description":
        if ((issue.description ?? "") === change.to) return skip("same", title, issue.key);
        return ok(issue.key, title, null, short(change.to.replace(/\s+/g, " "), 120));
      case "comment":
        return ok(issue.key, title, null, short(change.text.replace(/\s+/g, " "), 120));
    }
  });
}

export interface ApplyContext {
  tracker: Tracker;
  me: Person | null;
  /** Called after each change, for progress. */
  onResult?: (result: ChangeResult) => void;
  signal?: AbortSignal;
}

function failure(id: string, error: unknown): ChangeResult {
  if (error instanceof TrackerError) return { id, ok: false, key: null, code: error.code, detail: error.detail };
  return { id, ok: false, key: null, code: "error", detail: error instanceof Error ? error.message.slice(0, 300) : String(error).slice(0, 300) };
}

/**
 * Sends the approved changes one by one. Each change re-reads its issue first, so a
 * label change keeps labels someone added in the meantime. A failed create skips the
 * rows planned under it.
 */
export async function apply(ctx: ApplyContext, planned: readonly PlannedChange[], approved: ReadonlySet<string>): Promise<ChangeResult[]> {
  const { tracker } = ctx;
  const created = new Map<string, { key: string; id: string | null }>();
  const failedRefs = new Set<string>();
  const results: ChangeResult[] = [];
  const push = (result: ChangeResult) => {
    results.push(result);
    ctx.onResult?.(result);
  };
  for (const item of planned) {
    if (!item.ok || !approved.has(item.id)) continue;
    if (ctx.signal?.aborted) break;
    const change = item.change;
    try {
      if (change.kind === "create") {
        if (change.parentRef && failedRefs.has(change.parentRef)) {
          failedRefs.add(change.ref);
          push({ id: item.id, ok: false, key: null, code: "parentFailed", detail: null });
          continue;
        }
        const parentKey = change.parentKey ?? (change.parentRef ? created.get(change.parentRef)?.key ?? null : null);
        const parent = parentKey ? await tracker.issue(parentKey) : null;
        const result = await createIssue(ctx, change, parent);
        created.set(change.ref, result);
        push({ id: item.id, ok: true, key: result.key, code: null, detail: null });
        continue;
      }
      const issue = await tracker.issue(change.key);
      await applyOne(ctx, change, issue);
      push({ id: item.id, ok: true, key: issue.key, code: null, detail: null });
    } catch (error) {
      if (change.kind === "create") failedRefs.add(change.ref);
      push(failure(item.id, error));
    }
  }
  return results;
}

function labelVars(tracker: Tracker, issue: Issue, add: readonly string[], remove: readonly string[]): Record<string, Json> {
  if (tracker.profile.labelUpdate === "delta") return { labelsAdd: [...add], labelsRemove: [...remove] };
  const next = issue.labels.filter((label) => !remove.includes(label));
  for (const label of add) if (!next.includes(label)) next.push(label);
  return { labels: next };
}

async function applyOne(ctx: ApplyContext, change: Exclude<Change, { kind: "create" }>, issue: Issue): Promise<void> {
  const { tracker } = ctx;
  const base = { key: issue.key, issueId: issue.id ?? issue.key };
  switch (change.kind) {
    case "status":
      if (tracker.has("transition")) return tracker.run("transition", { ...base, status: change.to });
      return tracker.run("update", { ...base, status: change.to });
    case "assignee":
      if (change.to === null) {
        if (tracker.has("unassign")) return tracker.run("unassign", base);
        return tracker.run("update", { ...base, assignee: null });
      }
      if (tracker.has("assign")) return tracker.run("assign", { ...base, assignee: change.to });
      return tracker.run("update", { ...base, assignee: change.to });
    case "priority":
      return tracker.run("update", { ...base, priority: change.to });
    case "labels":
      return tracker.run("update", { ...base, ...labelVars(tracker, issue, change.add, change.remove) });
    case "parent":
      if (change.to === null) {
        if (tracker.has("clearParent")) return tracker.run("clearParent", base);
        return tracker.run("update", { ...base, parent: null });
      }
      if (tracker.has("setParent")) return tracker.run("setParent", { ...base, parent: change.to });
      return tracker.run("update", { ...base, parent: change.to });
    case "summary":
      return tracker.run("update", { ...base, summary: change.to });
    case "description":
      return tracker.run("update", { ...base, description: change.to });
    case "comment":
      return tracker.run("addComment", { ...base, text: change.text });
  }
}

function resolveAssignee(value: string, me: Person | null, parent: Issue | null): string | null {
  if (value === "") return null;
  if (value === "@me") return me?.id ?? null;
  if (value === "@parent") return parent?.assignee ?? null;
  return value;
}

/** Creates one issue, then whatever the create request could not carry: parent, assignee, components. */
async function createIssue(ctx: ApplyContext, change: Extract<Change, { kind: "create" }>, parent: Issue | null): Promise<{ key: string; id: string | null }> {
  const { tracker } = ctx;
  const profile = tracker.profile;
  const queue = change.queue ?? parent?.queue ?? null;
  const assignee = resolveAssignee(change.assignee, ctx.me, parent);
  const type = change.type || profile.types[0]?.key || "";
  const vars: Record<string, Json | undefined> = {
    queue: queue ?? undefined,
    summary: change.summary,
    type: type || undefined,
    priority: change.priority || undefined,
    assignee: assignee ?? undefined,
    labels: change.labels.length > 0 ? change.labels : undefined,
    description: change.description || undefined,
    parent: parent?.key,
  };
  for (const [name, value] of Object.entries(profile.createDefaults)) if (vars[name] === undefined) vars[name] = value;
  const result = await tracker.create(vars);
  const base = { key: result.key, issueId: result.id ?? result.key };
  if (parent && !tracker.uses("create", "parent")) {
    if (tracker.has("setParent")) await tracker.run("setParent", { ...base, parent: parent.key });
    else if (tracker.uses("update", "parent")) await tracker.run("update", { ...base, parent: parent.key });
  }
  if (assignee && !tracker.uses("create", "assignee") && tracker.has("assign")) await tracker.run("assign", { ...base, assignee });
  if (change.components.length > 0 && tracker.has("addComponent") && tracker.has("components") && queue) {
    const ids = await tracker.queueComponents(queue);
    for (const name of change.components) {
      const component = ids.get(name.toLowerCase());
      if (component) await tracker.run("addComponent", { ...base, component, componentName: name });
    }
  }
  return result;
}

/** One line per planned change, for the agent and the timeline. */
export function describe(item: PlannedChange): string {
  const c = item.change;
  const head = c.kind === "create" ? `create "${c.summary}"` : `${c.key}`;
  const what = (() => {
    switch (c.kind) {
      case "status":
        return `status ${item.from} → ${item.to}`;
      case "assignee":
        return `assignee ${item.from} → ${item.to}`;
      case "priority":
        return `priority ${item.from} → ${item.to}`;
      case "labels":
        return `labels ${item.to ?? ""}`;
      case "parent":
        return `parent ${item.from} → ${item.to}`;
      case "summary":
        return `title "${item.from}" → "${item.to}"`;
      case "description":
        return "new description";
      case "comment":
        return `comment "${item.to}"`;
      case "create":
        return item.to ?? "";
    }
  })();
  return `${head}: ${what}`.trim();
}
