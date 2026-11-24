# bb-plugin-automation-hub

Interface in English and Russian.

Talk an agent into a recurring job, a one-time job or a frequent watch, and
keep all of them in one panel.

The hub is a layer over bb's built-in **Automations** plugin and keeps no
schedule of its own. It reads and drives it with `bb.sdk.plugins.callRpc`
(`automations_overview`, `automations_get`, `automations_runs`,
`automations_pause`, `automations_resume`, `automations_run`,
`automations_create`, `automations_delete`).

## Files

| File | What |
|---|---|
| `server.ts` | RPC for the page, the `automation_hub_create` agent tool, the background service that forwards watch findings, settings |
| `app.tsx` | The **Automation Hub** nav panel with title-bar counts and badge, the segment and menu above every chat's composer, palette commands with default keys |
| `src/messages.ts`, `lib/i18n.tsx` | Interface texts in English and Russian; `lib/i18n.tsx` is a copy of `shared/i18n.tsx` |
| `src/schedule.ts` | Pure helpers: classify automations, cron in words, cron and wrapper script for a watch |
| `skills/automation-hub/SKILL.md` | How an agent turns a request into an automation |
| `src/restore.ts` | A stored automation back into create input, for undoing a deletion |
| `test/*.test.ts` | `npm test` |

## Kinds

- **schedule**: an agent task on a cron timetable.
- **once**: one agent task at a set time.
- **watch**: a script on a 30 s to 1 h interval. bb's cron ticks once a
  minute at most, so a 30 s watch runs its check twice inside each one-minute
  tick (`subMinuteWrapper`). A check prints nothing when there is nothing new;
  any output is a finding. bb records an empty run as a quiet tick, and the
  hub's `forward-findings` service sends new findings to the chat the watch was
  created in, at most once every two minutes, with the instruction agreed at
  set-up.

Agent tasks run with the provider, model and environment of the chat that
created them.

## Settings

- **Templates (JSON)**: cards under "Start from a template", an array of
  `{ "title", "description", "prompt" }`. Empty shows the built-in examples.
- **Time zone for new automations**: IANA name; empty uses the server's.

## State

`bb.storage.kv` key `meta` holds what the hub knows about automations it
created: kind, watch interval, active hours, what to do with a finding, the
chat to send findings to and the last forwarded run. Automations created
elsewhere show on the page without it.

Key `trash` keeps, for a day, what is needed to recreate a deleted
automation (`src/restore.ts`): its create input, with the script read back from
bb's stored file, and the hub's facts. Undo creates it again under a new id.

## Build

```
npm install
npx tsc --noEmit
npm test
bb plugin build .
```
