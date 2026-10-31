# Qlik Sense for bb

Agents read Qlik Sense Enterprise reports — sheets, tables, charts, pivots and
KPIs — with filters, recalculated by the Qlik engine on every call. Read-only:
nothing in Qlik changes.

Setup is one page in the bb sidebar:

1. **Sign in.** Qlik address, `DOMAIN\user` login and password → *Save and check
   sign-in*.
2. **Reports agents may use.** Tick the apps agents may read — they are the
   boundary, every other app is refused. Inside an app, tick the sheets to
   start from and say what each one answers. The agent gets these notes and
   links to open the sheets in the browser. *Can't find a report?* — paste its
   link: the plugin checks whether your account can open it and, if not,
   writes an access request for the app owner.
3. **Agents that may read Qlik data.** Tick the provider/model pairs your
   company approved for its data. Nothing is ticked at first.

Interface: English and Russian — the EN | RU switch is at the top of the page.

## Install

```sh
bb plugin install git:github.com/xMinor-1/bb-plugins --plugin qlik-sense --yes
```

## Who gets the data

Company data should reach only the models the company approved. The plugin
enforces that in bb, not in the agent:

- The Qlik tools and the `qlik-sense` skill are offered only to sessions whose
  provider and model match the allow-list. Other agents never see them.
- Every tool call re-checks the model the thread is running *now*, so switching
  models mid-thread does not keep the tools working.
- A thread that has received Qlik answers is marked. bb refuses to send that
  thread — or a fork of it — to a model outside the list, because the whole
  history, Qlik answers included, would go to that model.

The allow-list is one rule per line, `<provider-id> <model-glob>`:

```text
acp-opencode corp/*
```

Set it in the panel or with
`bb plugin config qlik-sense set allowedModels "acp-opencode corp/*"`.
A pre-configured install can also set `url`, the Qlik address suggested in the
panel, so people only type their login and password.

What this does not cover: an agent with shell access running as the same OS
user can read anything that user can, including the password store. The guard
keeps Qlik data from reaching models by accident; it is not a sandbox. bb's own
AI services (thread titles, commit messages) send thread text to their
service — turn them off in Settings → AI services when threads hold company data.

## The password

The password stays on the machine where agents run, never on the bb server:

| OS | Store |
| --- | --- |
| macOS | login Keychain (`security`, service `bb-qlik-sense`) |
| Windows | encrypted with the Windows account (DPAPI through PowerShell, cmdlets allowed in Constrained Language Mode) |
| Linux, or when the OS store refuses | a file readable only by the user |

The password never appears on a command line. If Qlik rejects the login or
password, the plugin stops signing in — across restarts — until you enter the
password again or press *Try once more*. Every new agent session would
otherwise retry a stale password, and a domain locks the account after a few
failures.

## Agent tools

| Tool | What it does |
| --- | --- |
| `qlik_reports` | the enabled apps, recommended sheets, notes and links — called first |
| `qlik_list_sheets` | sheets of an enabled app |
| `qlik_sheet_objects` | objects of a sheet: ids, dimensions, measures, filter fields |
| `qlik_list_fields` | data model fields, master dimensions, master measures with formulas |
| `qlik_field_values` | values of a field, with what remains possible under filters |
| `qlik_get_data` | data of a sheet object with filters, as a table |
| `qlik_query` | a custom breakdown: fields or master dimensions × master measures or formulas |

Filters: `{ "Region": "North" }`, `{ "Region": ["North", "East"] }`, or Qlik
search strings (`"*Nor*"`, `">=01.10.2026<=31.10.2026"`). Each call starts from
clean selections, in the agent's own engine session, so the person's open
Qlik tab never moves.

## How it works

```
bb server (server.ts)                     machine where agents run (src/host.ts)
  allow-list, tool gating, dispatch hook ──► Qlik sign-in, engine WebSocket,
  panel RPC                                  password store, report catalog
```

- `server.ts` registers the tools, selects them per session with
  `bb.agents.configure`, records each turn's model and refuses tainted turns in
  the `message.dispatch` hook, and relays panel calls. It stores no company
  data: only the allow-list and per-thread markers.
- `src/host.ts` runs on the machine where the thread runs — the one that can
  reach Qlik, often only inside a corporate network or VPN. It signs in through
  the standard Qlik form (`internal_forms_authentication`), keeps the proxy
  session cookie, re-signs in once when the session expires, and talks to the
  engine (Engine API, JSON-RPC over WebSocket). State lives in the plugin's
  data directory on that machine.
- **Setup status for other plugins.** `setupStatus` answers a build's
  onboarding page, such as Fleet Kit's. Input
  `{ lang?: "en" | "ru", hostId?: string }`; without `hostId` it asks the
  machine the Qlik page used last, else bb's own machine. Output
  `{ state: "done" | "todo" | "problem", summary, path }`: `done` once the
  sign-in passed its last check and at least one report is enabled for agents.
  `summary` is one line in `lang` with no address, login or report names,
  `path` is the Qlik page. It reads the saved state only and sends nothing to Qlik;
  a machine's answer serves for 5 seconds, and a change on the panel drops it.
  It is the only RPC method other plugins may call: the panel's methods refuse
  any caller but the panel, the bb CLI and agents.
- The password store is asked whether a password is there without reading it
  (Keychain item attributes, the DPAPI or private file's presence), so frequent
  status checks do not touch the password.
- bb runs its processes with `--use-system-ca`, so corporate certificate
  authorities trusted by the OS are trusted here too.

## Development

```sh
npm install
npm run typecheck
npm test            # unit tests, no Qlik needed
npm run test:e2e    # starts Qlik Core in docker (test/engine.sh) and runs the engine suite
bb plugin build .
```

The end-to-end suite seeds a test app in a local Qlik Core engine
(`test/helpers/seed.ts`) and also runs through a stand-in proxy with forms
sign-in (`test/helpers/mock-proxy.ts`). The Qlik Core image's licence has
expired, so `test/engine.sh` fakes the engine's clock with libfaketime.
