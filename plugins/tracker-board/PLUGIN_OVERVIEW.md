Work with your team's task tracker from bb: a board of cards, child tasks from
templates, bulk edits, and an agent next to the board that changes tasks after you
confirm, or at once with Undo if you prefer.

## What you get

- A board and a list in the sidebar: a queue, or an epic or a story with everything
  under it. Columns by status, rows by story or by person, drag to change status.
- My boards: the boards you switch between, pinned with a star and in your order,
  with shared boards from your team's setup. Find a queue by name, an epic by its
  title, or paste a link.
- Cards you set up yourself: which fields they show and how many lines of
  description. The epic is a coloured tag; a story's card has one row of done-of-total
  cells by role, however many tasks the story has.
- A task opens in bb's side panel: status, assignee, priority, description, child
  tasks, comments and labels.
- Templates that create the usual child tasks of an epic or a story in one go, with
  labels for the current quarter. Your own templates sit on top of the shared ones.
- Bulk edits of status, assignee, labels and parent with a preview of what changes and
  what is skipped.
- One chat beside the board or below it. Select tasks, press "To chat", say what to do: the agent
  proposes, a form above the composer lists each change, and only what you approve
  is applied. Turn confirmation off and the agent changes tasks at once; its reply
  lists what changed, with Undo.
- Export and import of your settings as JSON. English and Russian interface.

## Configure, don't code

The tracker's address, its API requests and field paths, statuses, templates and the
guide for agents are settings, so your tracker's details stay in your own private
configuration. Any tracker with a JSON REST API and a key per person fits.

## Guards

- The API key stays in the OS credential store on your machine and goes only to the
  tracker's address; redirects are not followed.
- Agent changes go through your confirmation unless you turn it off. Without it, the
  agent's reply lists every change with Undo, which puts back only what nobody has
  changed since.
- Only the models you list get the tools, and a thread that read tracker data cannot
  move to another model.

These guards are built for mistakes, not for a malicious agent: an agent with a shell
runs as the same user as the key store.
