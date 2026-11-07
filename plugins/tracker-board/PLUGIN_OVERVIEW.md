Work with your team's task tracker from bb: a board of cards, child tasks from
templates, bulk edits, and an agent next to the board that changes tasks only after
you confirm.

## What you get

- A board and a list in the sidebar: a queue, or an epic or a story with everything
  under it. Columns by status, rows by story or by person, drag to change status.
- Cards you set up yourself: which fields they show and how many lines of
  description. A story's card shows which of its template tasks exist and which are
  missing.
- A task opens in bb's side panel: status, assignee, priority, description, child
  tasks, comments and labels.
- Templates that create the usual child tasks of an epic or a story in one go, with
  labels for the current quarter. Your own templates sit on top of the shared ones.
- Bulk edits of status, assignee, labels and parent with a preview of what changes and
  what is skipped.
- One chat next to the board. Select tasks, press "To chat", say what to do: the agent
  proposes, a form above the composer lists each change, and only what you approve
  is applied.
- Export and import of your settings as JSON. English and Russian interface.

## Configure, don't code

The tracker's address, its API requests and field paths, statuses, templates and the
guide for agents are settings, so your tracker's details stay in your own private
configuration. Any tracker with a JSON REST API and a key per person fits.

## Guards

- The API key stays in the OS credential store on your machine and goes only to the
  tracker's address; redirects are not followed.
- Agents have no tool that changes a task directly: every change goes through your
  confirmation.
- Only the models you list get the tools, and a thread that read tracker data cannot
  move to another model.

These guards are built for mistakes, not for a malicious agent: an agent with a shell
runs as the same user as the key store.
