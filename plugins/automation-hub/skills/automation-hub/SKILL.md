---
name: automation-hub
description: Set up a recurring job, a one-time job or a frequent watch for the user with the `automation_hub_create` tool, from a plain description of what to do, how often, which data to collect, where to put the results and what to do with them. Use when the user asks to do something regularly, every morning, every Monday, every N minutes, to keep an eye on a page, folder, feed or API, to remind them later, or opens a chat from the Automation Hub page.
---

# Automation Hub

People describe a routine in their own words; you turn it into a bb automation
with the `automation_hub_create` tool. Everything you create shows on the
Automation Hub page, where the person can pause it, run it now, read its runs
and see failures.

## 1. Get the five answers, ask only for what is missing

| What | Example |
|---|---|
| What to do | "collect yesterday's orders", "check the price on this page" |
| How often | "every weekday at 9", "every 5 minutes during work hours" |
| Which data, from where | a URL, a folder, a report, an API |
| Where to put results | this chat, a file, a folder, a doc |
| What to do with them | "tell me only if it drops below 100", "summarise in 5 lines" |

Read what the person already said before asking. If they named the time, do not
ask for it again. Ask everything still missing in one short message.

## 2. Pick the kind

- **schedule**: an agent does a task on a timetable (digests, reports, reviews).
  The run starts in a new chat without this conversation, so `task` must be
  self-contained: what to read, what to produce, where to save it, whom to tell.
- **once**: one agent task at a set time ("tomorrow at 10 remind me to ...").
  `run_at` is ISO 8601 with the person's offset.
- **watch**: a frequent check, every 30 s to 1 h, that runs a small script
  without the model. The model runs only when the check finds something; the
  finding arrives in this chat with the `on_hit` instruction. Use it for
  "tell me when X changes / appears / crosses Y".

Intervals for a watch: 30, 60, 300, 600, 900, 1800 or 3600 seconds. Choose the
slowest the person can live with. 30 s only for sources the person or their team
owns; public sites and shared services every 5 minutes or slower, since many
people polling one source overload it. `active_hours: "weekdays_9_19"` when the
person only cares during work hours.

## 3. Write the check script (watch only)

The check must:

- print **nothing** when there is nothing new, and a short, human-readable
  finding when there is. Output is the only signal: any output is a finding;
- remember what it saw in a state file in the current directory, named after
  the watch (`.hub-state-price-page`), since the directory is shared by all
  scripts. On the first run save the baseline and print nothing;
- exit 0 when the check worked, non-zero only when the check itself broke (no
  network, bad credentials), so failures show on the Automation Hub page;
- finish well within the interval; a network call gets a timeout (`curl -m 10`);
- never contain secrets. Read them from a file the person points to;
- be plain bash with `curl`, `grep`, `sed`: python3 and node may be missing on
  the person's computer. Use them only after checking they run there.

On Windows the tool refuses watches; offer a schedule instead.

Run the script yourself twice in the shell before proposing it: the first run
prints nothing, the second prints nothing while the source has not changed.

## 4. Draft, confirm, create

1. Call `automation_hub_create` with `confirm: false`. It checks the fields and
   returns the draft. Nothing is created yet.
2. Show the draft to the person in their language, in a few lines: name, when,
   what it does, where results go. Ask them to confirm.
3. Only after a clear yes, call it again with the same fields and
   `confirm: true`.
4. Tell them it is created, when it first runs, and that it is on the
   Automation Hub page.

The tool takes the agent, model and environment from this chat. Name the
automation in the person's language, short, the way they would look for it in a
list.

## Changing, pausing, deleting

Use the `bb automation` command (`bb automation --help`): `list`, `show`,
`update`, `pause`, `resume`, `runs`, `delete` (needs `--yes`). Ask the person before deleting. To fix a
failing automation, read its last runs with `bb automation runs`, find the
cause, fix the script or task, then run it once with `bb automation run` and
check the result.
