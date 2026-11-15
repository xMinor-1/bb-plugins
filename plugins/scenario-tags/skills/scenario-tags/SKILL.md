---
name: scenario-tags
description: Write or fix the Scenario Tags catalog (the tags above the message box) and check it with `bb scenario-tags check`. Use when the user asks to add, change, or debug a scenario tag, its form questions, or the prompt it inserts.
---

# Scenario Tags catalog

The tags above the message box come from one setting, `scenarios`, holding JSON:

- `groups`: `[{ "id", "label" }]`, the sections of the expanded view, in order.
- `scenarios`: `[{ "id", "label", "group", "pinned", "description", "fields", "prompt" }]`.
- `fields`: `[{ "id", "label", "type", "required", "placeholder", "hint", "default" }]`.
  `type` is `text`, `textarea`, `select` (needs `options`), or `attachment`
  (a file on the message; `answer` is what `{{id}}` becomes once attached).
- `prompt`: the inserted text. `{{field}}` takes an answer, `{{answers}}` lists the
  answers the template does not use. A line whose placeholders are all empty is
  dropped. Name the tool or skill the agent must use in plain words: some agents do
  not run a skill from a leading `/name`.

Ids: letters, digits, `_ . -`, up to 64. Labels up to 60 characters.

## Commands

| Command | Effect |
| --- | --- |
| `bb plugin config scenario-tags set scenarios "$(cat catalog.json)"` | Replace the catalog. |
| `bb scenario-tags check` | List scenarios, the pinned row, and every problem; exit 1 on a problem. |
| `bb scenario-tags reset-pins` | Drop the person's own pins. |

If a build manifest writes the setting, change the catalog in the manifest's
source instead: the next sync overwrites a hand edit.
