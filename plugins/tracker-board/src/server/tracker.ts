// The tracker as the server sees it: named requests from the API profile, sent
// through the host entry of one machine. Each method builds a request from its
// template, and reads the answer with the profile's field paths.
import type { FailureCode, RequestInput, RequestOutput } from "../../contract";
import { displayName, fillJson, fillPath, fillQuery, getPath, listOf, mentions, scalar, TemplateError, type Json, type Vars } from "../shared/json-path";
import { LIMITS } from "../shared/limits";
import { commentFrom, issueFrom, personFrom, type Comment, type Issue, type Person } from "../shared/model";
import type { Profile, RequestTemplate } from "../shared/profile";

export type Send = (input: RequestInput) => Promise<RequestOutput>;
export type RequestName = keyof Profile["requests"];

export class TrackerError extends Error {
  constructor(
    readonly code: FailureCode | "notConfigured" | "badAnswer",
    readonly status: number | null = null,
    readonly detail: string | null = null,
  ) {
    super(detail ? `${code}: ${detail}` : code);
  }
}

export interface StatusInfo {
  name: string;
  category: string | null;
}

export class Tracker {
  constructor(
    readonly profile: Profile,
    readonly baseUrl: string,
    private readonly send: Send,
    private readonly statusNames: ReadonlyMap<string, StatusInfo> = new Map(),
  ) {}

  has(name: RequestName): boolean {
    return this.profile.requests[name] !== undefined;
  }

  /** Whether a request's template uses a variable: then one call carries it and no follow-up is needed. */
  uses(name: RequestName, variable: string): boolean {
    const template = this.profile.requests[name];
    if (!template) return false;
    return mentions(template.path, variable) || mentions(template.body, variable) || Object.values(template.query ?? {}).some((value) => mentions(value, variable));
  }

  async call(name: RequestName, vars: Vars, exposeHeaders: string[] = []): Promise<{ json: unknown; headers: Record<string, string> }> {
    const template: RequestTemplate | undefined = this.profile.requests[name];
    if (!template) throw new TrackerError("notConfigured", null, `The API profile has no "${name}" request`);
    let path: string;
    try {
      path = fillPath(template.path, vars);
    } catch (error) {
      throw new TrackerError("notConfigured", null, error instanceof TemplateError ? error.message : String(error));
    }
    const bodyJson = template.body === undefined ? (template.method === "GET" ? null : {}) : fillJson(template.body, vars);
    const body = bodyJson === null ? null : JSON.stringify(bodyJson);
    if (body !== null && body.length > LIMITS.requestBody) throw new TrackerError("badRequest", null, "The request is too large");
    const output = await this.send({
      baseUrl: this.baseUrl,
      auth: this.profile.auth,
      method: template.method,
      path,
      query: fillQuery(template.query, vars),
      body,
      headers: this.profile.headers,
      exposeHeaders,
    });
    if (!output.ok) throw new TrackerError(output.code, output.status, output.detail);
    if (output.truncated) throw new TrackerError("badAnswer", output.status, "The answer is larger than the plugin reads");
    let json: unknown = null;
    if (output.text.trim() !== "") {
      try {
        json = JSON.parse(output.text);
      } catch {
        throw new TrackerError("notJson", output.status);
      }
    }
    return { json: this.unwrap(json), headers: output.headers };
  }

  private unwrap(json: unknown): unknown {
    let current = json;
    for (let i = 0; i < 3; i += 1) {
      const wrapper = this.profile.unwrap.find((name) => current && typeof current === "object" && !Array.isArray(current) && name in (current as object));
      if (!wrapper) break;
      current = (current as Record<string, unknown>)[wrapper];
    }
    return current;
  }

  issueOf(raw: unknown): Issue | null {
    return issueFrom(raw, this.profile, this.statusNames);
  }

  async myself(): Promise<Person> {
    const { json } = await this.call("myself", {});
    const person = personFrom(getPath(json, this.profile.responses.myself), this.profile);
    if (!person) throw new TrackerError("badAnswer", null, "The tracker did not say who the key belongs to");
    return person;
  }

  async issue(key: string): Promise<Issue> {
    const { json } = await this.call("issue", { key });
    const issue = this.issueOf(getPath(json, this.profile.responses.issue));
    if (!issue) throw new TrackerError("badAnswer", null, `The tracker's answer for ${key} has no key`);
    return issue;
  }

  /** One search, every page up to `max` issues. */
  async search(query: string, max: number): Promise<{ issues: Issue[]; truncated: boolean }> {
    const { limit, mode, firstPage } = this.profile.paging;
    const issues: Issue[] = [];
    const seen = new Set<string>();
    const totalHeader = this.profile.responses.totalHeader;
    for (let page = 0; issues.length < max && page < 200; page += 1) {
      const size = Math.min(limit, max - issues.length);
      const offset = mode === "offset" ? page * limit : page + firstPage;
      const { json, headers } = await this.call("search", { query, limit: size, offset, page: page + firstPage }, totalHeader ? [totalHeader] : []);
      const items = listOf(getPath(json, this.profile.responses.issues));
      let added = 0;
      for (const raw of items) {
        const issue = this.issueOf(raw);
        if (issue && !seen.has(issue.key)) {
          seen.add(issue.key);
          issues.push(issue);
          added += 1;
        }
      }
      const totalValue = this.profile.responses.total ? getPath(json, this.profile.responses.total) : totalHeader ? headers[totalHeader.toLowerCase()] : undefined;
      const total = typeof totalValue === "number" ? totalValue : typeof totalValue === "string" && /^\d+$/.test(totalValue) ? Number(totalValue) : null;
      if (items.length < size || added === 0) return { issues, truncated: false };
      if (total !== null && (mode === "offset" ? offset + items.length >= total : issues.length >= total)) return { issues, truncated: false };
    }
    return { issues, truncated: issues.length >= max };
  }

  async users(text: string): Promise<Person[]> {
    const { json } = await this.call("users", { text });
    return listOf(getPath(json, this.profile.responses.users))
      .map((raw) => personFrom(raw, this.profile))
      .filter((person): person is Person => person !== null)
      .slice(0, 50);
  }

  async user(id: string): Promise<Person | null> {
    const { json } = await this.call("user", { id });
    const raw = getPath(json, this.profile.responses.user) ?? json;
    const name = displayName(getPath(raw, this.profile.userFields.name)) ?? (this.profile.userFields.login ? scalar(getPath(raw, this.profile.userFields.login)) : null);
    return name ? { id, name } : null;
  }

  async statuses(): Promise<Map<string, StatusInfo>> {
    const { json } = await this.call("statuses", {});
    const out = new Map<string, StatusInfo>();
    const sf = this.profile.statusFields;
    for (const raw of listOf(getPath(json, this.profile.responses.statuses))) {
      const key = scalar(getPath(raw, sf.key));
      if (!key) continue;
      const name = scalar(getPath(raw, sf.name)) ?? key;
      const category = sf.category ? scalar(getPath(raw, sf.category)) : null;
      // Some trackers list a status once per workflow: keep the first entry that names a category.
      const previous = out.get(key);
      if (!previous || (previous.category === null && category !== null)) out.set(key, { name, category });
    }
    return out;
  }

  async comments(issue: Issue): Promise<Comment[]> {
    const { json } = await this.call("comments", { key: issue.key, issueId: issue.id ?? issue.key });
    return listOf(getPath(json, this.profile.responses.comments))
      .map((raw) => commentFrom(raw, this.profile))
      .filter((comment): comment is Comment => comment !== null)
      .slice(0, 200);
  }

  async components(issue: Issue): Promise<string[]> {
    const { json } = await this.call("issueComponents", { key: issue.key, issueId: issue.id ?? issue.key });
    const cf = this.profile.componentFields;
    return listOf(getPath(json, this.profile.responses.components))
      .map((raw) => scalar(getPath(raw, cf.name)) ?? (typeof raw === "string" ? raw : null))
      .filter((name): name is string => name !== null)
      .slice(0, 50);
  }

  async queueComponents(queue: string): Promise<Map<string, string>> {
    const { json } = await this.call("components", { queue });
    const cf = this.profile.componentFields;
    const out = new Map<string, string>();
    for (const raw of listOf(getPath(json, this.profile.responses.components))) {
      const id = scalar(getPath(raw, cf.id));
      const name = scalar(getPath(raw, cf.name));
      if (id && name) out.set(name.toLowerCase(), id);
    }
    return out;
  }

  /** The created issue's key and id. */
  async create(vars: Vars): Promise<{ key: string; id: string | null }> {
    const { json } = await this.call("create", vars);
    const raw = getPath(json, this.profile.responses.created);
    const key = scalar(getPath(raw, this.profile.fields.key)) ?? scalar(getPath(json, this.profile.fields.key));
    if (!key) throw new TrackerError("badAnswer", null, "The tracker created an issue but did not return its key");
    const id = this.profile.fields.id ? scalar(getPath(raw, this.profile.fields.id)) ?? scalar(getPath(json, this.profile.fields.id)) : null;
    return { key, id };
  }

  async run(name: RequestName, vars: Record<string, Json | undefined>): Promise<void> {
    await this.call(name, vars);
  }
}
