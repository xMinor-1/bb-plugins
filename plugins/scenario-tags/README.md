# Scenario Tags

A row of scenario tags above the message box. Each tag is a task people repeat
with agents. Clicking one opens a short form with that scenario's questions.
Required questions must be answered first. The answers then become a ready
prompt in the message box, which the person reads and sends. The plugin never
sends anything by itself.

- Collapsed, the row shows the pinned tags. **Scenarios** expands the
  scenarios the person kept, by group, each with a pin. A catalog scenario
  also has a cross that hides it: it leaves the row and the list, and
  **Hidden (N)** at the bottom brings it back.
- **All scenarios** lists the whole catalog by group, with each scenario's
  description and form questions, a search box, and **Add to my row** and
  **Hide** (or **Show again**) on each. A scenario that arrives in a later
  catalog is marked **new** there, and the **Scenarios** toggle shows a dot,
  until the person opens All scenarios; it does not join the row by itself
  unless the catalog pins it.
- The catalog (groups, tags, questions, prompt templates) is one setting,
  usually written by a build manifest, so a new tag reaches everyone with the
  next release. Each person can pin their own tags on top of it.
- A question can ask for a file: the form then waits until a file is attached
  to the message.
- People make their own scenarios without editing the catalog. **New
  scenario** puts a prompt into the message box; the agent asks about the task
  and saves the tag with the `scenario_save` tool after the person confirms a
  preview of the tag and its form. **Save this conversation as a scenario**
  (also in the `+` menu) does the same from a conversation that worked. Own
  scenarios show first under **Mine**, with **Change**, **Delete** and
  **Suggest to everyone** (download, copy or email the scenario as a catalog
  entry). They live in the plugin's storage on that bb, so restarts and catalog
  updates keep them. Own scenarios are not hidden: they have **Delete**.
- Pins, hidden scenarios and what counts as seen are kept per person in the
  plugin's storage, so restarts and catalog updates keep them too. The catalog
  the person starts with sets the baseline: nothing in it is marked new.

The interface is in English and Russian.

## Install

```sh
bb plugin install path:"/path/to/bb-plugins" --plugin scenario-tags --yes
bb plugin config scenario-tags set scenarios "$(cat catalog.json)"
bb scenario-tags check
```

## The catalog

```json
{
  "groups": [{ "id": "reports", "label": "Reports" }],
  "scenarios": [
    {
      "id": "report-guide",
      "label": "Reports",
      "group": "reports",
      "pinned": true,
      "description": "Ask which report answers a question",
      "fields": [
        { "id": "question", "label": "Question", "type": "textarea", "required": true },
        { "id": "period", "label": "Period", "type": "text", "placeholder": "Q3 2026" },
        { "id": "side", "label": "Our side", "type": "select", "options": ["Buyer", "Seller"] },
        { "id": "file", "label": "Contract", "type": "attachment", "required": true, "answer": "see the attached file" }
      ],
      "prompt": "Read the reports guide first.\nQuestion: {{question}}\nPeriod: {{period}}\n{{answers}}"
    }
  ]
}
```

| Key | Meaning |
| --- | --- |
| `groups[]` | Sections of the expanded view, in this order. A scenario without a group goes under **Other**. |
| `scenarios[].pinned` | In the collapsed row until the person picks their own tags. A tag pinned in a later catalog joins their row too, once. |
| `fields[].type` | `text`, `textarea`, `select` (with `options`), or `attachment` (a file on the message; `answer` is the text it puts into the prompt). |
| `fields[].required` | The form will not insert the prompt without it. |
| `fields[].default`, `placeholder`, `hint` | Optional help in the form. |
| `prompt` | The text for the message box. `{{field}}` takes an answer; `{{answers}}` lists every answer the template does not use, as `Label: answer`. A line whose placeholders are all empty is left out. Without `prompt` the text is the list of answers. |

Name the tool or skill the agent should use in the prompt itself. Some agents
do not run a skill from a leading `/name`; they read it as plain text.

## Settings

| Setting | Meaning |
| --- | --- |
| `scenarios` | The catalog above. |
| `builderPrompt` | What **New scenario** puts into the message box. |
| `saveChatPrompt` | What **Save this conversation as a scenario** puts in. |
| `editPrompt` | What **Change** puts in; `{{label}}`, `{{id}}` and `{{scenario}}` (its JSON) are filled in. |
| `suggestEmail` | Where **Suggest to everyone** offers to send the file; empty: download and copy only. |
| `suggestHint` | Who adds suggested scenarios to the catalog and how to send them. |

The defaults are in English; a build manifest usually sets them in its own language.

A broken entry is left out and the rest still show; `bb scenario-tags check`
lists every problem and exits with code 1 when there is one.

## Commands

| Command | Effect |
| --- | --- |
| `bb scenario-tags check [--json]` | Check the catalog and show what the row holds, what is hidden and what is new. |
| `bb scenario-tags reset-pins` | Return the row to the catalog's pinned tags. |
| `bb scenario-tags remove-own <id>` | Delete one of the person's own scenarios. |
| `bb scenario-tags unhide <id>` | Show a hidden catalog scenario again; `--all` shows every one. |

## Agent tool

`scenario_save` takes `label`, `description`, `fields` and `prompt` (and `id`
to change an own scenario). It checks the scenario with the catalog rules,
shows the person a preview in place of the message box, and stores it only
after **Save**. The answer comes back to the agent when the person decides.

## How it works

- `server.ts` defines the settings, keeps the person's pins, own scenarios and
  curation (hidden and seen ids) in the plugin's storage (`pins_get`,
  `pins_set`, `own_list`, `own_delete`, `curation_get`, `curation_update`),
  registers `scenario_save` and the CLI. It sets the seen baseline from the
  first non-empty catalog.
- `app.tsx` registers a bare composer banner for thread and new-thread
  composers. It reads the catalog with `useSettings`, opens the form inline
  and puts the prompt in with `useComposer().insert`.
- `src/catalog.ts` holds parsing, pins, hiding, new marks, search, own
  scenarios and prompt rendering as plain functions; `src/app/` holds the form
  fields, the All scenarios view, the save preview (a `pendingInteraction`
  slot) and the own-scenario controls.

## Changes

- **0.3.0** Hide catalog scenarios with a cross, **Hidden (N)** to bring them
  back, the **All scenarios** view with search, and new marks for scenarios
  added to the catalog later. `bb scenario-tags unhide`; `check` lists hidden
  and new scenarios.
- **0.2.0** Own scenarios made in a conversation, with a save preview.
- **0.1.1** Runs on bb 0.48 (SDK 0.6.104).
- **0.1.0** Tags above the message box with a short form and a ready prompt.

## Development

```sh
npm install
npx tsc --noEmit
npx vitest run
bb plugin build .
```
