# Tracker Board

A board and a list for a task tracker that has a REST API, inside bb. Cards show what each
task is about, an epic or a story comes with everything nested under it, templates create
the usual child tasks in one go, and an agent in a chat next to the board changes tasks after
the person confirms, or at once with Undo when the person turns confirmation off.

The plugin names no tracker. How to talk to the API comes from an **API profile** in settings,
so a build keeps its tracker's address, request shapes, templates and labels in its own
private configuration.

The interface is in English and Russian.

## What people see

- **A page in the sidebar.** In bb's title bar: what to show (a queue, an epic or a story with
  everything under it, tasks assigned to me, or a search query if the build allows it), Board or
  List, the chat, refresh and settings.
- **My boards.** The board list in the title bar starts with the person's own boards in their
  order, then "Assigned to me" and recent boards. A star pins a board; rows are dragged, or moved
  with the arrow keys on their handle. The search finds queues by name or key, epics and stories
  by words of their title, and opens a key or a link as is. The build's shared boards (setting
  `defaultBoards`) are there for everyone: they can be hidden, not removed.
- **What are you interested in.** After the API key, a first-run step suggests the queues and open
  epics of the person's own tasks and fills My boards; it can be skipped.
- **Board.** Columns by status, optionally rows by story or by person. Drag a card to change its
  status; a toast offers Undo for that one task. Filters by text, assignee, type and "mine".
- **Cards.** Which fields a card shows is up to the person: type, key, priority, description
  lines, labels, the epic, due date, assignee. The epic is a tag with a colour of its own; a click
  opens it. A story's card has one row of cells, one per template part and one for other tasks,
  each with done of total, however many tasks the story has.
- **List.** The same tasks as a tree under their parents; the Parent column shows the path with
  titles. Parents that live on another board load too.
- **A task in bb's side panel.** Click a card. The parents come first, one row each down to
  "This task": type, key, status and title, the story with its composition row, the epic with
  done of total and a bar by status; a click opens the parent. A parent from another board looks
  the same: its tasks load from the tracker and stay cached for two minutes. Below: status,
  assignee, priority, description, child tasks and missing template parts, comments, labels.
- **Child tasks from templates.** Under an epic or a story: the missing parts, all parts, a
  bundle (a story with its tasks), or the person's own templates. Rows can be edited before
  creating.
- **Bulk edits.** Select cards (checkbox, Ctrl or Cmd click): status, assignee, labels, parent.
  A preview shows what changes and what is skipped and why, then applies.
- **Chat.** One bb thread beside the board or below it, with a splitter. "To chat" puts the
  selected tasks in as pills; "+" starts a new chat; the thread can also be opened in full.
- **Settings.** The machine that talks to the tracker, the API key, My boards, the person's own
  templates and people list, card appearance, export and import of these settings as JSON,
  language.
- **An onboarding step for a build's setup page.** The `setupStatus` RPC answers `done`, `todo`
  or `problem` from the saved key state, without calling the tracker.

## What agents get

| Tool | What it does |
|---|---|
| `tracker_guide` | The build's guide, the statuses, types and priorities, what the API profile allows |
| `tracker_search` | Search by text, by queue, "mine", or children of given tasks |
| `tracker_get_issues` | Full tasks by key, optionally with comments |
| `tracker_people` | Find people to assign |
| `tracker_propose_changes` | Change tasks: after the person confirms, or at once when confirmation is off |

The skill `tracker-board` tells agents how to use them. `tracker_propose_changes` checks every
change against the task as it is now; what happens next is a setting. The build sets the default
(`confirmAgentChanges`, on unless set) and each person can switch it in the panel's settings,
under "Agent in the chat".

- **Confirmation on.** A form above the chat composer lists a checkbox per change and the skipped
  ones with reasons, and only what the person approves applies. Rejecting changes nothing.
- **Confirmation off.** The changes apply at once. The tool keeps how to undo each one and hands
  the agent a `::tracker-changes{id="…"}` line for its reply, which renders as a card: what
  changed, what failed, and Undo. Undo puts back only what still holds the agent's value: a
  field someone changed since stays theirs, labels go back as a difference, and comments and
  new tasks cannot be undone. A batch keeps its Undo for 14 days, and the 200 newest batches
  are kept.

Tasks can also be mentioned in any composer as `@` pills; the agent gets the key and the title
and reads the rest with the tools.

## Settings

| Key | What it is |
|---|---|
| `trackerName` | What people and agents call the tracker |
| `baseUrl` | The `https://` address the profile's paths are relative to (`http://` only for localhost) |
| `apiProfile` | JSON, below |
| `templates` | JSON templates and bundles everyone gets; people add their own on top |
| `guide` | Markdown guide for agents: queues, statuses, what labels mean |
| `defaultBoards` | Shared boards: queue keys, issue keys or links, one per line, on top of everyone's My boards |
| `confirmAgentChanges` | Whether an agent's changes wait for a confirmation form by default (on unless set). Each person can switch it in the panel |
| `allowQuery` | Let people open a board from the tracker's own query language |
| `allowedModels` | One rule per line, `<provider-id> <model-glob>`. Empty means no agent gets the tools |

### API profile

Every request is a template: `method` (`GET`, `POST`, `PATCH`, `PUT` or `DELETE`), `path`,
optional `query` and `body`. `{name}` alone as a JSON value keeps the variable's type (a list
stays a list, `null` stays `null`); inside a longer string it is text. A key whose variable is
missing is dropped from the body. Variables in a path are URL-encoded.

```json
{
  "auth": { "header": "X-API-Key", "format": "{key}" },
  "unwrap": ["data"],
  "webUrl": "https://tracker.example.com/{key}",
  "keyHelp": "Profile → API keys in the tracker.",
  "requests": {
    "myself": { "method": "GET", "path": "/auth/me" },
    "issue": { "method": "GET", "path": "/issues/{key}" },
    "search": { "method": "POST", "path": "/issues/_search", "body": { "query": "{query}", "limit": "{limit}", "offset": "{offset}" } },
    "create": { "method": "POST", "path": "/issues", "body": { "queue_key": "{queue}", "summary": "{summary}", "type": "{type}", "priority": "{priority}", "labels": "{labels}", "assignee_id": "{assignee}", "description": "{description}" } },
    "update": { "method": "PATCH", "path": "/issues/{key}", "body": { "summary": "{summary}", "description": "{description}", "priority": "{priority}", "labels": "{labels}" } },
    "transition": { "method": "POST", "path": "/issues/{key}/transitions", "body": { "to_status_code": "{status}" } },
    "setParent": { "method": "PUT", "path": "/issues/{key}/parent", "body": { "parent_issue_key": "{parent}" } },
    "clearParent": { "method": "DELETE", "path": "/issues/{key}/parent" },
    "assign": { "method": "POST", "path": "/issues/{key}/assign", "body": { "assignee": "{assignee}" } },
    "unassign": { "method": "POST", "path": "/issues/{key}/unassign" },
    "comments": { "method": "GET", "path": "/issues/{key}/comments" },
    "addComment": { "method": "POST", "path": "/issues/{key}/comments", "body": { "content": "{text}" } },
    "users": { "method": "GET", "path": "/users", "query": { "search": "{text}" } },
    "user": { "method": "GET", "path": "/users/{id}" },
    "statuses": { "method": "GET", "path": "/statuses" },
    "components": { "method": "GET", "path": "/components", "query": { "queue_key": "{queue}" } },
    "addComponent": { "method": "POST", "path": "/issues/{issueId}/components", "body": { "component_id": "{component}" } },
    "queues": { "method": "GET", "path": "/queues", "query": { "search": "{text}", "limit": "20" } }
  },
  "queries": { "queue": "queue = {queue}", "children": "parent in ({keys})", "keys": "key in ({keys})", "text": "summary ~ \"{text}\"", "mine": "assignee = me()" },
  "paging": { "limit": 100, "mode": "offset" },
  "responses": { "issues": "issues", "total": "total", "issue": "issue", "created": "issue", "myself": "account", "users": "users", "user": "user", "statuses": "statuses", "comments": "comments", "components": "components", "queues": "queues" },
  "fields": { "key": "key", "id": "id", "queue": "queue_key", "summary": "summary", "description": "description", "type": "type", "status": "status", "statusCategory": "status_category", "priority": "priority", "assignee": "assignee_id", "author": "reporter_id", "parent": "parent_key", "labels": "labels", "due": "due_date", "created": "created_at", "updated": "updated_at" },
  "userFields": { "id": "id", "name": "display_name", "login": "email" },
  "statusFields": { "key": "code", "name": "name", "category": "category" },
  "queueFields": { "key": "key", "name": "name", "archived": "is_archived" },
  "statuses": [
    { "key": "open", "name": "Open", "category": "todo" },
    { "key": "in_progress", "name": "In progress", "category": "progress" },
    { "key": "done", "name": "Done", "category": "done" }
  ],
  "kinds": { "epic": ["epic"], "story": ["story"], "bug": ["bug"] },
  "types": [{ "key": "task", "name": "Task" }, { "key": "story", "name": "Story" }],
  "priorities": [{ "key": "high", "name": "High" }, { "key": "medium", "name": "Medium" }],
  "labelUpdate": "set"
}
```

| Field | Meaning |
|---|---|
| `auth` | The header that carries the key and its format; `{key}` appears once. Default `Authorization: Bearer {key}` |
| `headers` | Static, non-secret headers. A header equal to the auth header or `Cookie` is dropped |
| `unwrap` | Wrapper keys stripped from every answer when present, such as `data` |
| `webUrl`, `keyHelp` | The task's page in a browser; where people get a key |
| `requests` | `myself`, `issue` and `search` are required. Without the others the matching actions are hidden or skipped with a reason |
| `queries` | Templates for `search`'s `{query}`. Without `children` a board of an epic walks the epic's queue. With `keys` the parents of a board's tasks load in batches of 40; without it one by one, up to 60 |
| `paging` | Page size, and whether `{offset}` counts items (`offset`) or pages (`page`, from `firstPage`) |
| `responses` | Where the useful part of each answer is; `""` is the answer itself |
| `fields`, `userFields`, `statusFields`, `commentFields`, `componentFields`, `queueFields` | Paths into one object: `a.b`, `a[].b` for a list, `x\|y` for the first that exists, and an empty alternative for the value itself (`issue\|` reads a wrapped or a bare answer). An object in place of a value gives its `key`, `value`, `code`, `id` or `login` |
| `statuses` | Board order with categories `todo`, `progress`, `done`. `"show": "used"` keeps a status's name and category without an empty column. A status not listed goes by its category; a tracker's own status list joins boards and menus only when it has 60 entries or fewer |
| `kinds` | Which types are epics, stories and bugs; any other type is a task |
| `types`, `priorities` | Menus when creating and editing |
| `labelUpdate` | `set` sends the whole list as `{labels}`; `delta` sends `{labelsAdd}` and `{labelsRemove}` |
| `createDefaults` | Values for `create` variables nobody gave, such as `{ "priority": "medium" }` when the tracker requires one |

Variables: `{key}` and `{issueId}` (the task's id, or its key without one) in every per-task
request; `{query}`, `{limit}`, `{offset}`, `{page}` in `search`; `{queue}`, `{summary}`,
`{type}`, `{priority}`, `{assignee}`, `{labels}`, `{description}`, `{parent}` in `create` and
`update`; `{status}` in `transition` or `update`; `{text}` in `addComment`, `users` and
`queues` (without `queues` queues are opened by key only, and archived ones are left out);
`{id}` in `user`; `{component}` and `{componentName}` in `addComponent`.

When `create` has no `{parent}` or `{assignee}`, the plugin sets them after creating with
`setParent` and `assign`. Components named by a template are matched by name in the queue's
`components` and added one by one.

### Templates

```json
{
  "templates": [
    { "id": "S", "title": "Story", "prefix": "[S]", "type": "story", "under": "epic", "assignee": "@me", "priority": "inherit" },
    { "id": "BE", "title": "Backend", "prefix": "[BE]", "type": "task", "under": "story", "labels": ["TEAM-BACKEND-Q{Q}{YY}"], "components": ["Backend"] },
    { "id": "QA", "title": "Testing", "prefix": "[QA]", "type": "task", "under": "story", "labels": ["TEAM-QA-Q{Q}{YY}"] }
  ],
  "bundles": [
    { "id": "STORY", "title": "Story with tasks", "under": "epic", "items": [{ "template": "S", "children": ["BE", "QA"] }] }
  ]
}
```

- `prefix` goes before the parent's title: `[BE] Saved cards`. A task whose title starts with a
  template's prefix counts as that template's part, so a story knows what is missing.
- `under` is `epic`, `story` or `any`.
- `assignee`: empty, `@me`, `@parent`, or a user id. `priority`: empty, `inherit` or a key.
- Labels expand `{Q}` (quarter), `{YY}` and `{YYYY}` (year) on the day of creating.
- A person's own template with the same `id` as a build template is ignored.

## How the data is kept safe

- **The key stays on the person's machine.** macOS Keychain or Windows Credential Manager; on
  other systems a file only the user can read, and the settings say so. bb's server never holds
  it. People enter it in the plugin's own settings, not in a chat.
- **The key goes to one address.** Requests stay on the origin of `baseUrl`, redirects are not
  followed, and the key is bound to the origin it was saved for: when the address moves, the
  plugin asks for the key again.
- **Agents change tasks the way the person chose.** With confirmation on, the only changing tool
  proposes, the person approves each change in a form, and only approved ones apply, after
  re-reading each task. With it off, changes apply at once and the reply carries Undo.
- **Only allowed models.** Tools, the skill and the guide go only to pairs in `allowedModels`.
  A thread that has read tracker data, or a message with task pills, is not sent to another model,
  and neither is any fork down its line.
- **Bounded.** An answer over 4 MiB is refused, a board stops at 3000 tasks and says so, a
  proposal holds up to 200 changes. A non-JSON answer, such as a sign-in page, is an error.

**These guards are built for mistakes, not for a malicious agent.** An agent with a shell runs as
the same user as the key store and the `bb` command: it could read the key, call the tracker or the
plugin's RPC itself, or answer the confirmation form. What keeps a model outside the list away is
that it never gets the tools and a thread that touched the data never reaches it. Do not rely on
this plugin to contain an agent you do not trust.

The tracker decides what each key may see and change.

## Install

```sh
bb plugin install git:https://github.com/xMinor-1/bb-plugins.git@^0.1.0 --plugin tracker-board --tag-prefix tracker-board/
```

The machine that talks to the tracker must trust its certificate. With a corporate root
certificate, run bb with `NODE_USE_SYSTEM_CA=1`.

## Develop

```sh
npm test
npx tsc --noEmit
bb plugin build .
```

`test/fixtures/mock-tracker.ts` is a small tracker API with sample data for trying the panel:

```sh
node --experimental-strip-types test/fixtures/mock-tracker.ts 8787
```

Then set `baseUrl` to `http://127.0.0.1:8787/api/v1`, `apiProfile` and `templates` to
`MOCK_PROFILE` and `MOCK_TEMPLATES` from that file, and use the key `test-key-123`.
