# Scenario Tags

A row of scenario tags above the message box. Each tag is a task people repeat
with agents. Clicking one opens a short form with that scenario's questions.
Required questions must be answered first. The answers then become a ready
prompt in the message box, which the person reads and sends. The plugin never
sends anything by itself.

- Collapsed, the row shows the pinned tags. **Scenarios** expands every
  scenario by group, each with a pin.
- The catalog (groups, tags, questions, prompt templates) is one setting,
  usually written by a build manifest, so a new tag reaches everyone with the
  next release. Each person can pin their own tags on top of it.
- A question can ask for a file: the form then waits until a file is attached
  to the message.

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

A broken entry is left out and the rest still show; `bb scenario-tags check`
lists every problem and exits with code 1 when there is one.

## Commands

| Command | Effect |
| --- | --- |
| `bb scenario-tags check [--json]` | Check the catalog and show what the row holds. |
| `bb scenario-tags reset-pins` | Return the row to the catalog's pinned tags. |

## How it works

- `server.ts` defines the `scenarios` setting, keeps the person's pins in the
  plugin's storage (`pins_get`, `pins_set`) and registers the CLI.
- `app.tsx` registers a bare composer banner for thread and new-thread
  composers. It reads the catalog with `useSettings`, opens the form inline
  and puts the prompt in with `useComposer().insert`.
- `src/catalog.ts` holds parsing, pins and prompt rendering as plain functions.

## Development

```sh
npm install
npx tsc --noEmit
npx vitest run
bb plugin build .
```
