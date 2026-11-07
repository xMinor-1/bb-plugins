# Model Usage

What your agents spend, in one panel: plan limits of every provider, tokens per
model for Claude Code and OpenCode, and where Claude Code's usage went.

## In the sidebar

A footer button with two rings: Claude Code's five-hour session outside, the
weekly limit inside. Muted below 60%, amber from 60%, red above 85%; a dot in the
corner when a per-model weekly limit passes 60%. Click it for a card with every
plan window, time to reset, and token totals per tool for the last 5 hours, day
or week.

## The page

- **Plan limits** from every provider plugin that publishes the standard usage
  source, the same data bb's built-in Provider usage panel shows.
- **Tokens by model**: one table for Claude Code and OpenCode with requests,
  input, output, cache read, cache write and total, grouped by tool and machine.
- **Claude Code activity**: weighted cost by behaviour, skills, workflow runs,
  projects and threads.
- A machine filter, a 5h / 24h / 7d switch, English and Russian.

## OpenCode on any machine

OpenCode keeps its history on the machine it runs on, often a laptop connected
to a remote bb. The plugin reads that database on each connected machine,
read-only, and keeps the last reading of a machine that went offline. Only model
ids, token counts and timestamps are read, never message text.

## Your own model groups

Name model prefixes in the settings (`acme/`), give the group a label, and those
models are shown first with their own row colour. A setting hides everything
else for setups that only use those models.

## When the provider's check fails

If Claude Code's usage check is refused, the plugin can show figures from a
local limits file written by your own watcher, marks them as such, and publishes
them to bb's Provider usage panel too.
