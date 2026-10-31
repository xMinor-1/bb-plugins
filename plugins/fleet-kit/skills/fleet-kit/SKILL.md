---
name: fleet-kit
description: Inspect or run Fleet Kit, the plugin that keeps this bb in line with a build manifest (plugins, bb settings, OpenCode models), and store build secrets. Use when the user asks about the build version, why a plugin was installed, updated or removed, whether OpenCode is limited to the build's models, or to sync now.
---

# Fleet Kit

Fleet Kit reads a build manifest and brings this bb to it: it installs,
updates and removes plugins, holds bb general settings, and merges the
build's OpenCode block into `opencode.json`. The panel **Fleet Kit** in the
sidebar shows the same information as the commands below.

## Commands

```bash
bb fleet-kit status [--json]     # build version, last sync, OpenCode protection, secrets
bb fleet-kit sync [--json]       # sync now and wait; exit 1 when the sync had errors
printf '%s\n' "$VALUE" | bb fleet-kit secret set <name> --value-stdin
bb fleet-kit secret clear <name>
```

- Never pass a secret as an argument or print it. Ask the user to paste it in
  the Fleet Kit panel, or pipe it with `--value-stdin`.
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

## What not to do

- Do not edit `opencode.json` keys that Fleet Kit owns (`providers.<build provider>`,
  `model`, `enabled_providers`, other top-level keys from the manifest's
  `opencode` block); the next sync puts them back. Other keys are safe.
- Do not edit `plugins/fleet-kit-secrets.js` in the OpenCode configuration
  directory; Fleet Kit rewrites it.
- Do not install or remove plugins that the manifest lists; change the
  manifest instead.
