Set up routines by describing them to an agent, and see all of them in one place.

## What you get

- An **Automation Hub** page in the left sidebar with every automation in bb,
  grouped by what it needs from you: needs attention, watching, scheduled,
  paused, finished.
- A strip above the message box of every chat: how many automations failed,
  run now, are on and watching. Click it, or press Ctrl+Alt+M (⌥⌘M on a Mac),
  for a menu with what failed, what is next, and shortcuts: make the current
  chat a recurring automation, start a new one, open the hub.
- Commands in bb's quick palette with default keys: open the hub (Ctrl+Alt+A),
  new automation (Ctrl+Alt+N), make this chat regular (Ctrl+Alt+R).
- A badge on the sidebar entry while something is failing, and counts in the
  page's title bar.
- Pause and resume with a switch, run now, read recent runs and open the chat
  of any agent run.
- Delete an automation, and bring it back with Undo right after (its run
  history does not come back).
- **Fix with an agent** and **Change with an agent** open a new chat with the
  automation's details filled in.
- Templates that open a new chat with a ready request. You can replace them in
  the plugin settings.
- **Watches**: checks every 30 seconds to an hour that run without the model.
  The model runs only when a check finds something, and the finding arrives in
  the chat where the watch was set up.

The interface is in English and Russian.

## How it works

The hub has no scheduler of its own. Every automation lives in bb's built-in
Automations, so it keeps running if the hub is turned off. Agents create them
with the bundled `automation_hub_create` tool: it shows a draft first and
creates the automation only after you agree.

Automations run on the computer where bb runs, while bb is running. A run
missed while bb was off happens when bb starts again.
