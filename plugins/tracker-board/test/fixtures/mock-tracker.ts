// A small REST task tracker for tests and local runs: issues in memory, an API key
// in a header, search with a tiny query language, and separate endpoints for
// transitions, assignment and parents — the shape many trackers have.
//
//   node --experimental-strip-types test/fixtures/mock-tracker.ts 8787
//
// Imports nothing but Node, so it runs without the plugin's dependencies.
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";

export const MOCK_KEY = "test-key-123";

export interface MockIssue {
  id: string;
  key: string;
  queue_key: string;
  summary: string;
  description: string;
  type: string;
  status: string;
  priority: string;
  assignee_id: string | null;
  reporter_id: string;
  parent_key: string | null;
  labels: string[];
  due_date: string | null;
  created_at: string;
  updated_at: string;
}

export interface MockState {
  issues: MockIssue[];
  users: { id: string; display_name: string; email: string }[];
  comments: Map<string, { id: string; content: string; author_id: string; created_at: string }[]>;
  components: Map<string, string[]>;
  next: number;
  requests: { method: string; path: string; body: unknown; key: string | null }[];
  /** Set to make the next requests fail with this status. */
  failWith: number | null;
}

const STATUSES = [
  { code: "open", name: "Open", category: "todo" },
  { code: "ready", name: "Ready for development", category: "todo" },
  { code: "in_progress", name: "In progress", category: "in_progress" },
  { code: "review", name: "In review", category: "in_progress" },
  { code: "testing", name: "Testing", category: "in_progress" },
  { code: "done", name: "Done", category: "done" },
];

const Q = "Q426";

function seed(): MockState {
  const day = "2026-11-06T10:00:00Z";
  const issue = (key: string, type: string, summary: string, status: string, assignee: string | null, parent: string | null, labels: string[] = [], due: string | null = null, description = ""): MockIssue => ({
    id: `uuid-${key.toLowerCase()}`,
    key,
    queue_key: key.split("-")[0]!,
    summary,
    description,
    type,
    status,
    priority: type === "bug" ? "critical" : "medium",
    assignee_id: assignee,
    reporter_id: "u1",
    parent_key: parent,
    labels,
    due_date: due,
    created_at: "2026-10-10T09:00:00Z",
    updated_at: day,
  });
  const issues = [
    issue("PAY-101", "epic", "Card payment in the mobile app", "in_progress", "u1", null, [`TEAM-EPIC-${Q}`], "2026-12-20", "The buyer pays by card in the app, without a courier terminal.\n\n**Done when** card payment works on iOS and Android."),
    issue("PAY-110", "story", "[S] Card payment at checkout", "in_progress", "u1", "PAY-101", [], "2026-11-28", "At the Payment step the buyer picks *Card online* and returns to the app with the order status."),
    issue("PAY-111", "task", "[D] Card payment at checkout", "done", "u3", "PAY-110", [`TEAM-DESIGN-${Q}`], "2026-10-24", "Payment step layouts."),
    issue("PAY-112", "task", "[BE] Card payment at checkout", "review", "u2", "PAY-110", [`TEAM-BACKEND-${Q}`], "2026-11-14", "Create the payment, receive the callback, idempotency by order number."),
    issue("PAY-113", "task", "[FE] Card payment at checkout", "in_progress", "u4", "PAY-110", [`TEAM-FRONTEND-${Q}`], "2026-11-18"),
    issue("PAY-114", "task", "[A] Card payment at checkout", "done", "u1", "PAY-110", [`TEAM-ANALYSIS-${Q}`], "2026-10-20"),
    issue("PAY-115", "task", "[QA] Card payment at checkout", "open", null, "PAY-110", [`TEAM-QA-${Q}`], "2026-11-25"),
    issue("PAY-120", "story", "[S] Saved cards", "ready", "u1", "PAY-101", [], "2026-12-05"),
    issue("PAY-121", "task", "[D] Saved cards", "in_progress", "u3", "PAY-120", [`TEAM-DESIGN-${Q}`], "2026-11-12"),
    issue("PAY-122", "task", "[BE] Saved cards", "ready", "u2", "PAY-120", [`TEAM-BACKEND-${Q}`], "2026-11-21"),
    issue("PAY-130", "story", "[S] Receipts and refunds", "open", null, "PAY-101", [], "2026-12-15"),
    issue("PAY-131", "task", "[A] Receipts and refunds", "in_progress", "u1", "PAY-130", [`TEAM-ANALYSIS-${Q}`], "2026-11-13"),
    issue("PAY-140", "bug", "Double charge on a repeated Pay tap", "testing", "u2", "PAY-110", [`TEAM-BACKEND-${Q}`], "2026-11-06", "On a slow network a second tap creates a second payment."),
    issue("PAY-150", "task", "Acquirer contract: test terminal", "done", "u6", "PAY-101", [], "2026-10-31"),
    issue("OPS-1", "task", "Rotate staging certificates", "open", "u5", null),
  ];
  return {
    issues,
    users: [
      { id: "u1", display_name: "Anna Smirnova", email: "anna@example.com" },
      { id: "u2", display_name: "Igor Vetrov", email: "igor@example.com" },
      { id: "u3", display_name: "Maria Kim", email: "maria@example.com" },
      { id: "u4", display_name: "Oleg Lebedev", email: "oleg@example.com" },
      { id: "u5", display_name: "Dina Orlova", email: "dina@example.com" },
      { id: "u6", display_name: "Pavel Gusev", email: "pavel@example.com" },
    ],
    comments: new Map([["PAY-110", [{ id: "c1", content: "The acquirer callback comes before the redirect.", author_id: "u2", created_at: "2026-11-04T12:00:00Z" }]]]),
    components: new Map([["PAY", ["Design", "Backend", "Frontend", "Analysis", "QA"]]]),
    next: 160,
    requests: [],
    failWith: null,
  };
}

function send(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(body));
}

async function readBody(req: IncomingMessage): Promise<unknown> {
  const chunks: Buffer[] = [];
  for await (const chunk of req) chunks.push(chunk as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? JSON.parse(text) : null;
}

/** `queue = PAY`, `key = PAY-1`, `parent in (A, B)`, `assignee = me()`, `summary ~ "text"`, joined by AND. */
function matches(issue: MockIssue, query: string, me: string): boolean {
  return query
    .split(/\s+AND\s+/i)
    .map((part) => part.trim())
    .filter(Boolean)
    .every((part) => {
      let m = /^queue\s*=\s*(\S+)$/i.exec(part);
      if (m) return issue.queue_key === m[1];
      m = /^key\s*=\s*(\S+)$/i.exec(part);
      if (m) return issue.key === m[1];
      m = /^parent\s+in\s*\(([^)]*)\)$/i.exec(part);
      if (m) return m[1]!.split(",").map((key) => key.trim()).includes(issue.parent_key ?? "");
      m = /^assignee\s*=\s*me\(\)$/i.exec(part);
      if (m) return issue.assignee_id === me;
      m = /^summary\s*~\s*"([^"]*)"$/i.exec(part);
      if (m) return issue.summary.toLowerCase().includes(m[1]!.toLowerCase()) || issue.key.toLowerCase().includes(m[1]!.toLowerCase());
      return false;
    });
}

export function startMockTracker(port = 0): Promise<{ url: string; state: MockState; server: Server; close: () => Promise<void> }> {
  const state = seed();
  const me = "u1";
  const server = createServer(async (req, res) => {
    const url = new URL(req.url ?? "/", "http://localhost");
    const path = url.pathname;
    const key = (req.headers["x-api-key"] as string | undefined) ?? null;
    let body: unknown = null;
    try {
      body = await readBody(req);
    } catch {
      return send(res, 400, { error: "bad json" });
    }
    state.requests.push({ method: req.method ?? "GET", path: `${path}${url.search}`, body, key });
    if (path === "/redirect") {
      res.writeHead(302, { location: "https://elsewhere.example.com/" });
      return res.end();
    }
    if (key !== MOCK_KEY) return send(res, 401, { error: "bad key" });
    if (state.failWith) return send(res, state.failWith, { error: "failing on purpose" });
    const base = "/api/v1";
    if (!path.startsWith(base)) return send(res, 404, { error: "no such path" });
    const p = path.slice(base.length);
    const find = (k: string) => state.issues.find((issue) => issue.key === decodeURIComponent(k));
    const touch = (issue: MockIssue) => {
      issue.updated_at = new Date().toISOString();
    };
    let m: RegExpExecArray | null;
    if (req.method === "GET" && p === "/auth/me") return send(res, 200, { data: { account: { id: me, display_name: "Anna Smirnova", email: "anna@example.com" } } });
    if (req.method === "GET" && p === "/statuses") return send(res, 200, { data: { statuses: [...STATUSES, { code: "open", name: "Open (other workflow)", category: null }] } });
    if (req.method === "GET" && p === "/users") {
      const q = (url.searchParams.get("search") ?? "").toLowerCase();
      return send(res, 200, { data: { users: state.users.filter((user) => user.display_name.toLowerCase().includes(q) || user.email.startsWith(q)) } });
    }
    if (req.method === "GET" && (m = /^\/users\/([^/]+)$/.exec(p))) {
      const user = state.users.find((item) => item.id === m![1]);
      return user ? send(res, 200, { data: { user: { display_name: user.display_name, email: user.email } } }) : send(res, 404, { error: "no user" });
    }
    if (req.method === "POST" && p === "/issues/_search") {
      const { query = "", limit = 50, offset = 0 } = (body ?? {}) as { query?: string; limit?: number; offset?: number };
      const all = state.issues.filter((issue) => matches(issue, query, me));
      return send(res, 200, { data: { issues: all.slice(offset, offset + limit), total: all.length } });
    }
    if (req.method === "POST" && p === "/issues") {
      const input = (body ?? {}) as { queue_key?: string; summary?: string; type?: string; priority?: string; labels?: string[]; assignee_id?: string; description?: string };
      if (!input.queue_key || !input.summary) return send(res, 400, { error: "queue_key and summary are required" });
      const created: MockIssue = {
        id: `uuid-new-${state.next}`,
        key: `${input.queue_key}-${state.next++}`,
        queue_key: input.queue_key,
        summary: input.summary,
        description: input.description ?? "",
        type: input.type ?? "task",
        status: "open",
        priority: input.priority ?? "medium",
        assignee_id: input.assignee_id ?? null,
        reporter_id: me,
        parent_key: null,
        labels: input.labels ?? [],
        due_date: null,
        created_at: new Date().toISOString(),
        updated_at: new Date().toISOString(),
      };
      state.issues.push(created);
      return send(res, 201, { data: { issue: { key: { value: created.key }, id: created.id } } });
    }
    if ((m = /^\/issues\/([^/]+)$/.exec(p))) {
      const issue = find(m[1]!);
      if (!issue) return send(res, 404, { error: "no such issue" });
      if (req.method === "GET") return send(res, 200, { data: { issue: { ...issue, status: { code: issue.status, name: STATUSES.find((s) => s.code === issue.status)?.name } } } });
      if (req.method === "PATCH") {
        const patch = (body ?? {}) as Partial<MockIssue>;
        for (const field of ["summary", "description", "priority", "type", "labels", "due_date"] as const) if (field in patch) (issue as unknown as Record<string, unknown>)[field] = patch[field];
        touch(issue);
        return send(res, 200, { data: patch });
      }
    }
    if (req.method === "POST" && (m = /^\/issues\/([^/]+)\/transitions$/.exec(p))) {
      const issue = find(m[1]!);
      const to = (body as { to_status_code?: string } | null)?.to_status_code;
      if (!issue) return send(res, 404, { error: "no such issue" });
      if (!STATUSES.some((status) => status.code === to)) return send(res, 400, { error: "no transition" });
      issue.status = to!;
      touch(issue);
      return send(res, 200, { data: {} });
    }
    if (req.method === "PUT" && (m = /^\/issues\/([^/]+)\/parent$/.exec(p))) {
      const issue = find(m[1]!);
      const parent = (body as { parent_issue_key?: string | null } | null)?.parent_issue_key ?? null;
      if (!issue) return send(res, 404, { error: "no such issue" });
      if (parent && !find(parent)) return send(res, 400, { error: "no such parent" });
      issue.parent_key = parent;
      touch(issue);
      return send(res, 200, { data: {} });
    }
    if (req.method === "POST" && (m = /^\/issues\/([^/]+)\/(assign|unassign)$/.exec(p))) {
      const issue = find(m[1]!);
      if (!issue) return send(res, 404, { error: "no such issue" });
      issue.assignee_id = m[2] === "assign" ? (body as { assignee?: string } | null)?.assignee ?? null : null;
      touch(issue);
      return send(res, 200, { data: {} });
    }
    if ((m = /^\/issues\/([^/]+)\/comments$/.exec(p))) {
      const issue = find(m[1]!);
      if (!issue) return send(res, 404, { error: "no such issue" });
      const list = state.comments.get(issue.key) ?? [];
      if (req.method === "GET") return send(res, 200, { data: { comments: list } });
      if (req.method === "POST") {
        list.push({ id: `c${list.length + 2}`, content: (body as { content?: string } | null)?.content ?? "", author_id: me, created_at: new Date().toISOString() });
        state.comments.set(issue.key, list);
        return send(res, 201, { data: {} });
      }
    }
    if (req.method === "GET" && p === "/components") {
      const queue = url.searchParams.get("queue_key") ?? "";
      return send(res, 200, { data: { components: (state.components.get(queue) ?? []).map((name, index) => ({ id: `comp-${index}`, name })) } });
    }
    if (req.method === "POST" && (m = /^\/issues\/([^/]+)\/components$/.exec(p))) return send(res, 201, { data: {} });
    return send(res, 404, { error: `no route ${req.method} ${p}` });
  });
  return new Promise((resolve) => {
    server.listen(port, "127.0.0.1", () => {
      const address = server.address();
      const actual = typeof address === "object" && address ? address.port : port;
      resolve({ url: `http://127.0.0.1:${actual}/api/v1`, state, server, close: () => new Promise((done) => server.close(() => done())) });
    });
  });
}

/** An API profile for this mock: the README's example, with the tracker's address. */
export const MOCK_PROFILE = {
  auth: { header: "X-API-Key", format: "{key}" },
  unwrap: ["data"],
  webUrl: "https://tracker.example.com/{key}",
  keyHelp: "Profile → API keys in the tracker.",
  requests: {
    myself: { method: "GET", path: "/auth/me" },
    issue: { method: "GET", path: "/issues/{key}" },
    search: { method: "POST", path: "/issues/_search", body: { query: "{query}", limit: "{limit}", offset: "{offset}" } },
    create: {
      method: "POST",
      path: "/issues",
      body: { queue_key: "{queue}", summary: "{summary}", type: "{type}", priority: "{priority}", labels: "{labels}", assignee_id: "{assignee}", description: "{description}" },
    },
    update: { method: "PATCH", path: "/issues/{key}", body: { summary: "{summary}", description: "{description}", priority: "{priority}", labels: "{labels}" } },
    transition: { method: "POST", path: "/issues/{key}/transitions", body: { to_status_code: "{status}" } },
    setParent: { method: "PUT", path: "/issues/{key}/parent", body: { parent_issue_key: "{parent}" } },
    clearParent: { method: "PUT", path: "/issues/{key}/parent", body: { parent_issue_key: null } },
    assign: { method: "POST", path: "/issues/{key}/assign", body: { assignee: "{assignee}" } },
    unassign: { method: "POST", path: "/issues/{key}/unassign" },
    comments: { method: "GET", path: "/issues/{key}/comments" },
    addComment: { method: "POST", path: "/issues/{key}/comments", body: { content: "{text}" } },
    users: { method: "GET", path: "/users", query: { search: "{text}" } },
    user: { method: "GET", path: "/users/{id}" },
    statuses: { method: "GET", path: "/statuses", query: { limit: "1000" } },
    components: { method: "GET", path: "/components", query: { queue_key: "{queue}", limit: "1000" } },
    addComponent: { method: "POST", path: "/issues/{issueId}/components", body: { issue_key: "{key}", component_id: "{component}" } },
  },
  queries: { queue: "queue = {queue}", text: 'summary ~ "{text}"', mine: "assignee = me()" },
  paging: { limit: 100, mode: "offset" },
  responses: { issues: "issues", total: "total", issue: "issue", created: "issue", myself: "account", user: "user", users: "users", statuses: "statuses", comments: "comments", components: "components" },
  fields: {
    key: "key",
    id: "id",
    queue: "queue_key",
    summary: "summary",
    description: "description",
    type: "type",
    status: "status",
    statusCategory: "status_category",
    priority: "priority",
    assignee: "assignee_id",
    author: "reporter_id",
    parent: "parent_key",
    labels: "labels",
    due: "due_date",
    created: "created_at",
    updated: "updated_at",
  },
  userFields: { id: "id", name: "display_name", login: "email" },
  statusFields: { key: "code", name: "name", category: "category" },
  commentFields: { id: "id", text: "content|text", author: "author_id", created: "created_at" },
  statuses: [
    { key: "open", name: "Open", category: "todo" },
    { key: "ready", name: "Ready", category: "todo" },
    { key: "in_progress", name: "In progress", category: "progress" },
    { key: "review", name: "Review", category: "progress" },
    { key: "testing", name: "Testing", category: "progress" },
    { key: "done", name: "Done", category: "done" },
  ],
  kinds: { epic: ["epic"], story: ["story"], bug: ["bug"] },
  types: [
    { key: "task", name: "Task" },
    { key: "story", name: "Story" },
    { key: "bug", name: "Bug" },
    { key: "epic", name: "Epic" },
  ],
  priorities: [
    { key: "blocker", name: "Blocker" },
    { key: "critical", name: "Critical" },
    { key: "high", name: "High" },
    { key: "medium", name: "Medium" },
    { key: "low", name: "Low" },
    { key: "trivial", name: "Trivial" },
  ],
  labelUpdate: "set",
};

export const MOCK_TEMPLATES = {
  templates: [
    { id: "S", title: "Story", prefix: "[S]", type: "story", under: "epic", assignee: "@me", priority: "inherit" },
    { id: "D", title: "Design", prefix: "[D]", type: "task", under: "story", labels: ["TEAM-DESIGN-Q{Q}{YY}"], components: ["Design"] },
    { id: "BE", title: "Backend", prefix: "[BE]", type: "task", under: "story", labels: ["TEAM-BACKEND-Q{Q}{YY}"], components: ["Backend"] },
    { id: "FE", title: "Frontend", prefix: "[FE]", type: "task", under: "story", labels: ["TEAM-FRONTEND-Q{Q}{YY}"], components: ["Frontend"] },
    { id: "A", title: "Analysis", prefix: "[A]", type: "task", under: "story", labels: ["TEAM-ANALYSIS-Q{Q}{YY}"], components: ["Analysis"] },
    { id: "QA", title: "Testing", prefix: "[QA]", type: "task", under: "story", labels: ["TEAM-QA-Q{Q}{YY}"], components: ["QA"] },
  ],
  bundles: [
    { id: "STORY5", title: "Story with five tasks", under: "epic", items: [{ template: "S", children: ["D", "BE", "FE", "A", "QA"] }] },
    { id: "STORY", title: "Story only", under: "epic", items: [{ template: "S" }] },
  ],
};

if (import.meta.url === `file://${process.argv[1]}`) {
  const port = Number(process.argv[2] ?? 8787);
  void startMockTracker(port).then(({ url }) => console.log(`mock tracker at ${url}, key ${MOCK_KEY}`));
}
