---
name: fleet-kit
description: Inspect or run Fleet Kit, the plugin that keeps this bb in line with a build manifest (plugins, bb settings, bb's AI services, allowed agents, OpenCode models), and store build secrets. Use when the user asks about the build version, why a plugin was installed, updated or removed, why an agent was turned off, whether OpenCode is limited to the build's models, or to sync now.
---

# Fleet Kit

Fleet Kit reads a build manifest and brings this bb to it: it installs,
updates and removes plugins, holds bb general settings and bb's AI service
choices (`bb settings ai-services`), keeps only the build's allowed agents
enabled, and merges the build's OpenCode block into `opencode.json`. The panel **Fleet Kit** in the
sidebar shows the same information as the commands below.

## Commands

```bash
bb fleet-kit status [--json]     # build version, last sync, OpenCode protection, secrets
bb fleet-kit sync [--json]       # sync now and wait; exit 1 when the sync had errors
bb fleet-kit setup [--json]      # First run steps: done, todo, problem, installing, later
bb fleet-kit secret clear <name>
```

- Never handle a secret value yourself: do not ask for it in chat, put it in a
  command, a file or a variable, or print it. Ask the user to enter it in the
  Fleet Kit panel. A person at a terminal can pipe it from a file they own:
  `bb fleet-kit secret set <name> --value-stdin < key.txt`.
- Secret names come from the manifest's `secrets` list (`bb fleet-kit status`
  lists them).

## Settings

`bb plugin config fleet-kit` shows them; `bb plugin config fleet-kit set <key> <value>`
changes one and triggers a sync.

- `manifestUrl`: `https://` URL, `file://` URL, or absolute path.
- `manifestToken` (secret): bearer token for a private `https://` manifest.
- `syncIntervalMinutes`: 5 to 1440, default 30.
- `opencodeConfigDir`: write OpenCode configuration to this directory instead
  of OpenCode's default, and give OpenCode run by this bb `OPENCODE_CONFIG_DIR`.
  bb's model picker sees the directory only when bb itself runs with the same
  `OPENCODE_CONFIG_DIR`; the sync warns until it does.
- `secretStore`: `auto` (OS credential store) or `file` (0600 file).
- `paused`: stop syncing.
- `allowDevSources`: test machines only; allows `path:`, `npm:` and local git
  plugin sources, `http://localhost` gateways and OpenCode provider packages
  other than `@opencode/ai/providers/*`. Never turn it on for a person.

## What not to do

- Do not edit `opencode.json` keys that Fleet Kit owns (`providers.<build provider>`,
  `model`, `enabled_providers`, other top-level keys from the manifest's
  `opencode` block); the next sync puts them back. Other keys are safe.
- Do not edit `plugins/fleet-kit-secrets.js` in the OpenCode configuration
  directory; Fleet Kit rewrites it.
- Do not reinstall a plugin that the sync reports as "Kept on its previous
  source": switching to the manifest's source failed, and Fleet Kit tries again
  at most twice a day, an hour apart. Fix the source in the manifest instead.
- Do not turn on an agent the manifest does not allow (`bb provider enable`)
  or change an AI service task the manifest sets: the next sync undoes it.
  The allowed agents are in the manifest's `agents.allowed`.
- Do not install or remove plugins that the manifest lists; change the
  manifest instead. Fleet Kit removes a plugin only when the manifest lists it
  in `removePlugins`; dropping it from `plugins` leaves it installed.
