# Model Usage

One place for what your agents spend: plan limits of every provider, tokens per
model for Claude Code and OpenCode over the last 5 hours, day and week, and
where Claude Code's usage went.

The interface is in English and Russian.

## What you get

**A footer button with two rings.** The outer ring is Claude Code's five-hour
session, the inner one the weekly limit: muted below 60%, amber from 60%, red
above 85%. A dot in the corner lights up when a per-model weekly limit passes
60%. Without Claude Code figures the button shows a plain chart glyph.

**A card behind the button.** With more than one provider, tabs: *All* and one
per provider. The *All* tab
shows the plan limits and a *Total* block with a 5h / 24h / 7d switch: tokens
per tool, corporate models first if you named them (see Settings). The link at
the bottom opens the page.

**The Model usage page.**

- *Plan limits* — every window each provider reports, with the time to reset.
- *Tokens by model* — one table for Claude Code and OpenCode: requests, input,
  output (reasoning included), cache read, cache write and the total, a header
  row per tool and machine. Corporate models get their own group with your label
  and a tinted row.
- *Claude Code activity* — the breakdown Usage Meter had: where the weighted
  cost went, behaviours worth knowing, skills, workflow runs, projects, threads.
- A machine filter when more than one machine reports, a 5h / 24h / 7d switch,
  Refresh, and the language switch.

## Install

```sh
bb plugin install git:https://github.com/xMinor-1/bb-plugins.git --plugin model-usage
```

It replaces [Usage Meter](../usage-meter): remove that one once this one shows
your figures (`bb plugin remove usage-meter`). bb's built-in *Provider usage*
can stay; hide its footer item if you don't want two buttons.

## Settings

| Setting | What it does |
| --- | --- |
| `corporateModels` | Model prefixes, one per line or comma-separated, matched against `provider/model` as OpenCode names them (`acme/` or `acme/coder-*`). Matching models are grouped and shown first. Empty — no corporate group |
| `corporateLabel` | The name of that group. Empty — "Corporate models" |
| `corporateOnly` | Show only the corporate models: no plan limits, no Claude Code, no other OpenCode providers. For setups where only those models are in use |

```sh
bb plugin config model-usage set corporateModels "acme/"
bb plugin config model-usage set corporateLabel "Acme Copilot"
```

## How it works

### Plan limits

The plugin does not ask providers itself. It reads the `provider-usage.v1`
source contract that bb's provider plugins publish, the same one bb's built-in
*Provider usage* panel reads, so the figures match it.

| Detail | Handling |
| --- | --- |
| Provider rate limits | Sources are asked every 5 minutes without forcing a fresh check; Refresh forces one, and a second press within 30 seconds reuses the answer |
| A source that fails | Its last figures stay, marked with their age; the next try waits 5, 10, 20, 40, then 60 minutes |
| A machine that is offline | Not asked; its resources are skipped until it is back |
| The same account seen through two sources | Shown once per machine |
| A provider not installed on a machine | Not shown |

**The limits file.** When Claude Code's own check fails (its usage endpoint
rejects frequent calls), the plugin falls back to `limits-feed.json`, a file an
external watcher can write with the same windows. It looks in its own data
directory and in Usage Meter's, takes the freshest, and ignores one older than
15 minutes. Figures from the file are labelled as such. While it serves them,
the plugin also publishes them as a `provider-usage.v1` source, so bb's
*Provider usage* panel shows them too.

```json
{
  "fetchedAt": "2026-11-08T09:00:00Z",
  "windows": [
    { "label": "Current session", "usedPercent": 31, "resetsAt": "2026-11-08T12:00:00Z" },
    { "label": "Weekly limit", "usedPercent": 8, "resetsAt": "2026-11-14T18:00:00Z" }
  ]
}
```

### OpenCode tokens

OpenCode keeps its history in a SQLite database on the machine it runs on, which
may not be the machine bb runs on (a laptop connected to a remote bb). So the
plugin has a host entry: bb runs it on every connected machine, and it reads
the database there.

| Detail | Handling |
| --- | --- |
| Where the database is | `$OPENCODE_DB`, else `opencode.db`, else the newest `opencode-<channel>.db` in `$XDG_DATA_HOME/opencode` (`~/.local/share/opencode`) |
| OpenCode is running and writing | Opened read-only with a busy timeout; both reads run in one transaction |
| OpenCode 1.x and 2.x schemas | Both are read (`message`/`part` and `session_message`); a database holding both is deduplicated by message id; forked sessions are not counted twice |
| What is read | Model and provider ids, token counts, cost, timestamps. Never message text |
| A machine goes offline | Its last reading stays for up to 7 days, marked "offline, as of …" |
| Polling | Every 10 minutes, and on Refresh |

### Claude Code tokens and activity

Claude Code's transcripts under `~/.claude/projects` on bb's server are scanned
in the background (the Usage Meter scanner): calls are deduplicated by message
id, only the tails of changed files are read after the first pass, and message
bodies are never read into the summary.

### The interface

`app.tsx` registers the footer button (its icon is a React component, so the
rings are part of it), the card, the page and a content script that refreshes
the shared figures every 5 minutes while the window is visible. The page and the
card read one client store. Layouts that depend on room measure the card, not
the window: the token table drops the requests column below 600 px and turns
into a list below 440 px.

## Development

```sh
npm install
npx tsc --noEmit
npx vitest run
bb plugin build .
bb plugin dev .
```

## License

MIT — see [LICENSE](LICENSE). Parts of the limits code are adapted from bb's
built-in *Provider usage* plugin (MIT), see
[THIRD_PARTY_NOTICES.md](THIRD_PARTY_NOTICES.md).
