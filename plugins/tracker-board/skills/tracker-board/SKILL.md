---
name: tracker-board
description: Read and change issues in the task tracker configured for this bb, using the tracker_* tools. Use when the user talks about tracker tasks, epics, stories, statuses or assignees, or mentions a task with @.
---

# Task tracker

The tracker_* tools read and change issues in the user's task tracker, signed in with
the user's own API key. If they are not listed directly, find them with your tool
search first.

## Reading

- `tracker_search` takes an issue key (that issue and everything nested under it), a
  queue key, or a query in the tracker's own language. One line per issue.
- `tracker_get_issues` reads issues in full: fields, description and, on request,
  comments. Read an issue again before you change it.
- `tracker_people` finds a person's id for an assignee change. `@me` is the user.
- `tracker_guide` lists the statuses, types, priorities, templates and query hints.
  Call it once before the first change in a thread.

A task the user mentions with @ arrives as its key and title only: read it with
`tracker_get_issues` before acting on it.

## Changing

- Change issues only with `tracker_propose_changes`. Put every change for one request
  in one call, with a one-sentence `summary` of what and why.
- What happens next is the user's setting, and the result tells you which:
  - Confirmation on: the user sees a form in the chat and approves or rejects each
    change. Nothing changes before that. Do not ask "shall I?" in a message first:
    propose, and the form asks. Do not try to approve the form yourself. The result
    lists what was applied, what the user left out, what failed and why; do not retry
    what the user left out.
  - Confirmation off: the changes are applied at once. The result ends with a
    `::tracker-changes{id="…"}` line: put it on its own line in your reply, unchanged.
    There the user sees what changed and can undo it. Then say in a sentence or two
    what you did and what failed. Since nothing asks first, be sure of the request
    before you call: ask in a message when it is ambiguous, or when it touches many
    issues the user did not name.
- Report the result in plain words.
- New child issues follow the templates from `tracker_guide`: the title is the template
  prefix plus the parent's title without its own prefix, for example `[BE] Saved cards`
  under `[S] Saved cards`. Create a story and its tasks in one call: give the story a
  `ref` and the tasks `parentRef` with that ref.
- Status values are status keys from `tracker_guide`, not their names.

## Rules

- Never ask for the API key in chat, and never repeat one if someone sends it. Only
  the user saves it, on the Tasks page in the bb sidebar (Settings).
- If a tool says the key is missing or refused, tell the user to open that page. Do
  not retry.
- Do not write your own HTTP requests to the tracker. These tools are the only way in.
- Report errors in plain words and never make up issues, keys or statuses.
