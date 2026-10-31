# Fleet Kit

Keeps a bb in line with a build manifest. An organization that hands the same
bb setup to many people describes it once — plugins, bb settings, the OpenCode
models people may use, the secrets those need — and Fleet Kit on every machine
brings bb to that description and keeps it there.

- **Plugins**: installs what the build lists, updates it when its source offers
  a newer release, re-enables it if someone turned it off, reinstalls it when
  the build moves it to another source, and removes what the build lists in
  `removePlugins`. bb itself does not update plugins on its own; Fleet Kit does.
- **bb settings**: holds the general settings the build sets (telemetry,
  default provider and so on).
- **bb's AI services**: holds which service writes thread titles and commit
  messages and transcribes voice input — off, bb's automatic choice, or a
  service a plugin provides.
- **Agents**: keeps only the agents the build allows turned on in bb. An agent
  someone turns on again is turned off on the next sync, with one notice.
- **OpenCode**: merges the build's OpenCode 2 block into `opencode.json` —
  providers, default model, `enabled_providers` — and leaves everything else in
  the file alone.
- **Secrets**: asks for each key once, keeps it in the operating system's
  credential store, and gives it to OpenCode at request time. The key never
  lands in `opencode.json`, in logs, or in the panel.
- **Panel**: a **Fleet Kit** page in the sidebar shows the build version, what
  the last sync changed, any errors, whether OpenCode is limited to the build's
  models, and a **Sync now** button. The panel is in English and Russian, with
  a switch in its header.
- **First run**: a **First run** page lists the build's setup steps (the gateway
  key, mail, reports and so on), each done or still to do, with a button to the
  plugin's own page or the key's field right on the page. Until every step is
  done or skipped, the sidebar entry shows how many are left and the Fleet Kit
  page shows a reminder. A build without steps has no First run entry in the
  sidebar. An installer can open bb on `/plugins/fleet-kit/setup`.

## Install

```sh
bb plugin install "git:https://github.com/xMinor-1/bb-plugins.git@semver:fleet-kit/:>=0.2.0 <1.0.0" --plugin fleet-kit --yes
bb plugin config fleet-kit set manifestUrl https://builds.example.com/manifest.json
```

Install Fleet Kit with exactly the `source` its manifest entry names: Fleet Kit
updates itself only when the installed source matches. Give Fleet Kit a range
over a whole major version (`>=0.2.0 <1.0.0`), not `^0.2.0`: under `^0.x` a new
minor release would need another source, and Fleet Kit cannot switch its own
source.

Fleet Kit syncs fifteen seconds after bb starts, every 30 minutes after that,
whenever a setting changes, and on **Sync now**. Until `manifestUrl` is set it
does nothing.

## Settings

| Key | Meaning |
| --- | --- |
| `manifestUrl` | Where the manifest lives: an `https://` URL, a `file://` URL, or an absolute path (a synced folder works). `http://` and relative paths are refused. |
| `manifestToken` | Secret. Sent as `Authorization: Bearer` when fetching an `https://` manifest. |
| `syncIntervalMinutes` | 5 to 1440, default 30. |
| `opencodeConfigDir` | Keep this bb's OpenCode configuration in its own directory (see [A separate OpenCode directory](#a-separate-opencode-directory)). Empty: OpenCode's default, or `OPENCODE_CONFIG_DIR` if bb runs with it. |
| `secretStore` | `auto` (the OS credential store) or `file` (a 0600 file). |
| `paused` | Stop syncing. |
| `allowDevSources` | Test machines only, set by hand; a manifest cannot turn it on. Allows `path:`, `npm:` and local git plugin sources and `http://localhost` gateways. |

## Commands

```sh
bb fleet-kit status [--json]      # build, last sync, OpenCode protection, secrets
bb fleet-kit sync [--json]        # sync now and wait; exits 1 when the sync had errors
bb fleet-kit setup [--json]       # the First run steps and which are done
bb fleet-kit secret set <name> --value-stdin < key.txt
bb fleet-kit secret clear <name>
```

Secrets are entered in the panel's password field or piped on stdin with
`--value-stdin`, so a value never lands in shell history. No command prints a
secret.

## The manifest

One JSON file describes the build. Fleet Kit refuses to apply a manifest with
errors — nothing changes on the machine until the manifest is fixed, except
Fleet Kit's own update — and applies one with warnings. Fields Fleet Kit does
not know at the root and in `plugins[]` are warnings, so a manifest written for
a newer Fleet Kit can still deliver it.

```json
{
  "schema": 1,
  "name": "Example build",
  "version": "1.2.0",
  "install": { "bb": "0.48.1", "opencode": "2.2.5" },
  "bb": { "minVersion": "0.48.0", "settings": { "telemetryEnabled": false, "defaultProviderId": "acp-opencode" } },
  "aiServices": { "thread-title": "off", "commit-message": "off", "voice": "off" },
  "agents": { "allowed": ["acp-opencode"] },
  "plugins": [
    { "id": "fleet-kit", "source": "git:https://github.com/xMinor-1/bb-plugins.git@semver:fleet-kit/:>=0.2.0 <1.0.0", "plugin": "fleet-kit", "status": "required" },
    { "id": "notes", "source": "git:https://git.example.com/plugins.git@semver:notes/:^1.0.0", "plugin": "notes", "status": "required",
      "config": { "greeting": "hello" } },
    { "id": "later", "source": null, "status": "planned" }
  ],
  "removePlugins": ["old-thing"],
  "secrets": [{ "name": "gateway-key", "title": "Gateway key", "hint": "From the access portal" }],
  "allowedProviders": ["corp"],
  "opencode": {
    "providers": {
      "corp": {
        "name": "Corp gateway",
        "package": "@opencode/ai/providers/openai-compatible",
        "settings": { "baseURL": "https://llm.example.com/v1", "apiKey": "{secret:gateway-key}" },
        "models": { "big-model": { "name": "Big model" } }
      }
    },
    "model": "corp/big-model",
    "update": "disable"
  },
  "mcp": [],
  "onboarding": [
    { "id": "key", "title": "Gateway key", "secret": "gateway-key" },
    { "id": "notes", "title": "Notes", "hint": "Sign in once", "plugin": "notes" },
    { "id": "later", "title": "Later", "plugin": "later", "optional": true }
  ]
}
```

- `schema` — the manifest format. From a manifest newer than this Fleet Kit,
  only Fleet Kit's own update applies; the panel says a newer Fleet Kit is
  needed.
- `install` — the versions an installer should put on a new machine. Fleet Kit
  only checks that `install.bb` is not below `bb.minVersion`.
- `bb.minVersion` — Fleet Kit stops with an error on an older bb.
- `bb.settings` — keys of bb's general settings (`bb settings general`). An
  unknown key or a value of the wrong type is an error, not a silent skip.
- `aiServices` — bb's AI service tasks (`bb settings ai-services`):
  `thread-title`, `commit-message`, `voice`. Each value is `"off"`,
  `"automatic"` (bb picks), or the id of a service, such as one a plugin adds;
  when two plugins offer the same id, write `{ "service": "<id>", "plugin":
  "<plugin id>" }`. A task the manifest leaves out is not touched.
- `agents.allowed` — the bb agents (providers, `bb provider list`) that stay
  enabled; every other agent is turned off, including ones a later bb adds.
  `bb.settings.defaultProviderId`, when set, must be in the list.
- `marketplaces` — bb marketplaces to add if missing.
- `plugins` — `source` is a `git:https://` source. For one plugin from a
  monorepo with tags like `notes/v1.2.0`, write the tag prefix into the source:
  `git:<url>@semver:notes/:^1.0.0`; `@ref:<branch or tag>` pins a ref. `plugin`,
  when given, must equal `id`. `config` sets plain plugin settings; secret
  settings are left to the person. `planned` entries are shown and skipped.
  Fleet Kit itself must be listed as `required`, and updates itself only from a
  source pinned with `@semver:` or `@ref:`.
- `removePlugins` — the only way to remove a plugin. A plugin dropped from
  `plugins` stays installed; Fleet Kit never removes plugins bundled with bb.
- `secrets` — every `{secret:name}` the manifest uses must be declared here.
- `allowedProviders` — the only OpenCode providers people may use. Fleet Kit
  writes it to `enabled_providers`, and passes it to installed plugins that
  declare a setting of that name.
- `opencode` — a native OpenCode 2 configuration fragment, merged as is. Only
  `providers`, `model`, `small_model` and `update` are allowed; `providers` and
  `model` are required, and every provider and the providers of the models must
  be in `allowedProviders`. `{secret:name}` is allowed only as a provider's whole
  `settings.apiKey` or inside `settings.headers`, and such a provider needs an
  `https://` `settings.baseURL`. OpenCode's own `{env:...}` and `{file:...}` are
  refused anywhere in the manifest, in names as well as in values (a header
  named `x-{env:GITHUB_TOKEN}` is refused too): OpenCode would send the
  client's value to the manifest's address. A provider's `package` must be one
  of OpenCode's own, `@opencode/ai/providers/<name>`; any other package is
  accepted only on a machine with `allowDevSources`.
- `mcp`, `skills` — validated; this version does not apply them yet.
- `onboarding` — the First run steps, in order: `id`, `title`, `hint`,
  `optional`, and exactly one of `secret` (a name from `secrets`) or `plugin`
  (an id from `plugins`). `path` (`/plugins/<id>/<panel>`) is where a plugin
  step's button leads when the plugin cannot report its state. A step that
  names an unknown secret or plugin, or repeats an id, is left out with a
  warning; the rest of the build still applies. Fleet Kit 0.2.x ignores the
  block with a warning.

A manifest whose remote MCP server has no URL yet, or that names a pre-release
bb, gets a warning.

## How it works

### Plugins

The backend calls bb's own plugin API (`bb.sdk.plugins`): `list`, `install`,
`checkUpdates` and `applyUpdate`, `enable`, `remove`, `getSettings` and
`updateSettings`. No external script or second process is involved, so the
same code works on macOS, Windows and Linux.

When the build moves a plugin to another source, bb cannot switch it in place.
Fleet Kit saves the plugin's plain settings, removes it, installs it from the
new source, puts the settings back, and applies the manifest's `config`. Secret
settings cannot be read back, so the panel shows a notice asking to enter them
again. If the new source does not install, Fleet Kit puts the previous one back
(with the same subdirectory or plugin name), shows the same notice, and reports
the error. It tries a new source at most twice a day, an hour apart; between
tries the plugin stays on its previous source and the sync leaves it alone. A
source that installs a plugin with another id is removed again and reported.

An install that does not finish in ten minutes may still finish in bb, so
Fleet Kit never installs another source under the same id after it. It looks
at what bb lists: the new source counts as switched, a running install is
left to the next sync, and only an install that is gone without a result gets
the previous source back. A first install that times out is waited for the
same way. If the build drops the plugin, or marks it `planned`, while such a
switch is unfinished, Fleet Kit still puts the previous source back rather than
leave the plugin removed.

Fleet Kit's own update is the first step of every sync and reads only its own
entry, before the rest of the manifest is checked. When its source offers a
newer release, Fleet Kit finishes the sync and asks bb to install it. If the
new version does not come up, bb rolls back; Fleet Kit tries the same version at
most twice a day. A sync that runs while the update is still going neither
counts a try nor starts a second update.

With a source such as `@semver:fleet-kit/:>=0.2.0 <1.0.0` the source string
stays the same from release to release, so every new tag in the range reaches
every machine on its next sync: tagging a release is shipping it. Fleet Kit
cannot move itself to another source. When the manifest names another one,
for example `>=0.2.0 <1.0.0` on a machine installed from `^0.1.0`, the sync
warns and Fleet Kit stays where it is; reinstall it once (`bb plugin remove
fleet-kit`, then the installer). The key stays in the OS credential store.

Fleet Kit removes only plugins listed in `removePlugins`, never one bundled
with bb. A plugin dropped from `plugins` stays and the sync says so once.

### bb's AI services

bb sends thread titles, commit messages and voice input to the service each
task is set to. Fleet Kit reads the current choice with
`bb.sdk.system.aiServices()` and sets the manifest's with
`setAiServiceSelection`. A service id that this bb does not offer yet (its
plugin is not installed or not up) or that two plugins offer, without
`plugin` to pick one, turns the task off with a warning: Fleet Kit never
falls back to bb's automatic choice, which may be a cloud service.

### Agents

`agents.allowed` is a list of the agents to keep, not of the ones to turn off,
so an agent a new bb release adds is off as soon as Fleet Kit sees it. Each
sync reads bb's provider catalog: an allowed agent that is off is turned on,
any other agent that is on is turned off. When an agent Fleet Kit already
turned off is on again, the sync reports it and the panel shows one notice
naming the agents the build allows.

The person must never be left without a working agent. An allowed agent counts
only when bb can run it (its program is found and its plugin is on). Until one
allowed agent is on and ready, Fleet Kit turns nothing off and the sync reports
an error; it does not ask bb to turn on an allowed agent bb cannot run, so it
does not repeat a refused call on every sync. The same holds when none of the
allowed agents is in this bb's catalog.

Removing the `agents` block from the manifest stops this check but does not
turn the agents Fleet Kit turned off back on: turn them on in bb's settings or
with `bb provider enable <id>`.

### opencode.json

The person who uses OpenCode edits this file too, so Fleet Kit:

- It writes only the keys that come from the manifest: `providers.<id>` for each
  build provider, the other top-level keys of the `opencode` block (such as
  `model` and `update`), and `enabled_providers`. It remembers which keys it
  wrote and removes one only when the build drops it. Comments and formatting of
  the rest of the file are kept.
- Writes under a lock directory `<config>.bb-config-lock` with an `owner.json`
  (plugin, pid, host, time, token), so two syncs — or a sync and a lock reset —
  never write at once. `owner.json` is written whole (a synced temporary file
  linked into place), so a writer killed half way leaves no empty owner file. A writer waits and retries while the lock is held,
  recovers an abandoned one under `.recovery`, and removes only a directory
  that still carries its own token. The panel shows who holds the lock; when it
  has been held for more than two minutes — or a minute, when its `owner.json`
  is missing, empty or broken — **Reset lock** breaks it under the same
  recovery guard, after checking again that it is the lock it saw. Fleet
  Kit never breaks a live lock on its own.
- The file is re-read and its hash compared just before the atomic rename; a
  change made in between restarts the write.
- Before its first change Fleet Kit saves the original as
  `<config>.before-fleet-kit.bak`, once.
- A file Fleet Kit cannot parse unambiguously (broken JSON, duplicate keys,
  `providers` that is not an object) is left untouched and reported.

OpenCode 1.x reads a different format, so Fleet Kit does not touch its
configuration and shows "Update OpenCode to 2.x".

### Secrets

| System | Store |
| --- | --- |
| macOS | Keychain, service `fleet-kit`, through `/usr/bin/security` |
| Windows | Credential Manager, target `fleet-kit:<name>`, through PowerShell |
| Linux | `~/.local/share/fleet-kit/secrets/<name>`, file 0600 in a 0700 directory |

Values travel on stdin or in a child process's environment, never in a
command line; on Windows the helper clears the variable before it starts the C#
compiler. `opencode.json` gets no key at all: the provider entry is written
without `apiKey`, and Fleet Kit installs a small OpenCode plugin,
`plugins/fleet-kit-secrets.js` in the OpenCode configuration directory. Its
`http.request` hook sees each outgoing request to the build's provider and adds
the `Authorization` header (or the headers the manifest names) only when the
request goes to the origin of the provider's `baseURL` in the manifest. A
project's `opencode.json` can override a provider's address; the key does not
follow it there, and a keyed request does not follow redirects either: a
gateway answering with a redirect gets an error, not the key at a second
address. A wrong address or a missing key leaves the header out and
writes a warning, without the value, to `fleet-kit.log` in OpenCode's log
directory (`~/.local/share/opencode/log/`, next to `opencode.log`). A changed key takes
effect within a minute without restarting anything.

### Is OpenCode limited to the build's models?

After each sync Fleet Kit asks OpenCode itself — `opencode models` in an empty
directory, with the environment bb gives OpenCode — and compares the answer with
`allowedProviders`. The panel then shows one of:

- **Models: only corp (system policy)** — the restriction also sits in
  OpenCode's system configuration (`/Library/Application Support/opencode` on
  macOS, `%ProgramData%\opencode` on Windows, `/etc/opencode` on Linux), which a
  user cannot override. Writing it needs administrator rights, so an installer
  puts it there; Fleet Kit only reads it.
- **Models: only corp (user setting)** — the restriction comes from
  `enabled_providers` in the user's `opencode.json`. It holds, but the user
  could change it.
- **Models are not limited to corp** — with the reason.

### A separate OpenCode directory

A second bb on the same machine — say, a build bb next to a personal one —
should not change the personal OpenCode configuration. Set
`opencodeConfigDir` to an absolute directory: Fleet Kit writes the
configuration and the secret plugin there, removes its keys from the previous
file, and gives OpenCode started by this bb `OPENCODE_CONFIG_DIR`.

bb 0.48 builds its model picker without variables contributed by plugins, so
the picker keeps showing the default configuration's models. Start that bb with
`OPENCODE_CONFIG_DIR` set to the same directory; Fleet Kit warns until it is.
When bb already runs with `OPENCODE_CONFIG_DIR`, the setting can stay empty —
Fleet Kit uses the variable.

### First run

The page reads the steps the last sync saved and asks, every time it opens and
every 15 seconds while it is open:

- a **secret** step: is the secret in the credential store. The page has the
  password field itself.
- a **plugin** step: the plugin, through `bb.sdk.plugins.callRpc`, method
  `setupStatus`. A plugin with a setup step registers it with
  `experimental_discoverable` and answers from what it has saved, without
  network calls, within a few seconds:

  ```ts
  setupStatus: {
    input: z.object({ lang: z.enum(["en", "ru"]).optional(), hostId: z.string().optional() }).strict(),
    output: z.object({
      state: z.enum(["done", "todo", "problem"]),
      summary: z.string().max(200),          // one line in `lang`, no addresses, logins or passwords
      path: z.string().regex(/^\/plugins\//).optional(), // the page where the person does the step
    }).strict(),
  }
  ```

  Without `hostId` the plugin picks the machine itself (the one its page used
  last, else bb's primary machine). Fleet Kit always sends `lang`. Exchange
  Mail and Qlik Sense answer it.

The page waits up to 1.5 seconds for each plugin: a slower one shows as
**Checking**, and its answer appears on its own once it comes (a call gives up
after 8 seconds and the step shows as not answering). An answer serves for 4
seconds, so the page, its banner and the sidebar badge do not ask a plugin
three times.

A plugin without `setupStatus` (bb answers `unknown_method`) gets **Mark as
done**; Fleet Kit refuses a hand mark on a step whose plugin reports its state
itself, or one it could not ask. A plugin that fails or is gone is a problem,
not a manual step. One that is not installed or enabled yet shows as
installing; one the manifest lists as `planned` shows as coming later and does
not count. An optional step can be skipped.

bb draws a sidebar entry for every registered page, so the First run entry is
registered only when the build had steps the last time this browser looked;
a build that gains or loses its steps changes the entry from the next page
load, and until then the Fleet Kit entry shows the count. Passwords and
tokens of plugins never pass through Fleet Kit: the person types them in the
plugin's own form. **Start working** on the finished page opens a new thread.

## Known limits

- Fleet Kit manages the bb it runs in and the machine that bb's server runs
  on. A remote host bb connects to is not configured.
- The Windows credential store path and the PowerShell helper have not been
  run on Windows yet. Machines whose policy blocks PowerShell's `Add-Type`
  need `secretStore` set to `file`.
- The macOS system policy is read only from the JSON file; a configuration
  profile (MDM plist) is not read.
- Removing Fleet Kit leaves what it wrote in `opencode.json` and the secret
  plugin in place; the original file is in `opencode.json.before-fleet-kit.bak`.
- `mcp` and `skills` entries are validated but not applied yet.
- In the Russian panel, manifest check messages and error details that come
  from bb stay in English.

## Development

```sh
npm install
npx tsc --noEmit
npm test               # vitest: manifest rules, opencode.json merge and lock, secret store, sync against a fake bb
bb plugin build .
node -e "import('./dist/server.js').then(m => console.log(typeof m.default))"   # prints "function"
```

The last line catches dependencies the bundle cannot load.

### End to end

Never try Fleet Kit on a bb you use: it installs and removes plugins. The
`e2e/` folder runs a throwaway bb in Docker with its own home, data directory
and limits:

```sh
e2e/run.sh                                     # build the image, start the container, prepare a fixture build
e2e/x.sh 'bash /tmp/scenario.sh'               # install, sync, enter the key, run threads; one line per check
```

The run takes several minutes. To survive a lost terminal, start it detached
and read its log from the container:

```sh
docker exec -d fleet-kit-e2e bash -c 'bash /tmp/scenario.sh > /tmp/scenario.log 2>&1; echo "exit=$?" >> /tmp/scenario.log'
docker exec fleet-kit-e2e cat /tmp/scenario.log
```

`e2e/scenario.sh` installs Fleet Kit from the container's git repository, sets
`allowDevSources` (the fixture uses a local git source and a gateway on
`127.0.0.1`), points it at the fixture manifest, enters the key with
`--value-stdin`, and checks the result. The fixture build installs a local
fixture plugin and a public one, removes a plugin, sets bb settings, and points
OpenCode at a fake OpenAI-compatible gateway on `127.0.0.1:4010`. The gateway
answers "Pong" and logs whether each request carried the expected key
(`~/.fk-e2e/gateway.log`), never the key itself. A thread on `acp-opencode`
with `corp/model-large` must get "Pong" with the key. A second gateway on
`127.0.0.1:4011` (`~/.fk-e2e/other-gateway.log`) stands in for another
address: a project whose `opencode.json` points `providers.corp.settings.baseURL`
there must reach it without the key, and `fleet-kit.log` must name it. Last,
the key must not appear in any log, configuration or project file.

To check Fleet Kit's own update, start from an earlier release:

```sh
FLEET_KIT_BASE_REF=fleet-kit/v0.1.2 e2e/run.sh
e2e/x.sh 'bash /tmp/scenario.sh'
```

The container's repository then holds only that release. The scenario
installs it, releases the working copy as a new tag (`e2e/release-current.sh`),
sets the sync interval to five minutes, and waits for the installed version
to update itself on its schedule, without a manual sync, then for the new
version's first sync. When the working copy is a new minor release, outside
the installed `^` range, the scenario instead checks that the earlier release
applies the manifest with only warnings for fields it does not know, moves the
manifest to the new range, checks the "different source" warning, and
reinstalls Fleet Kit the way the installer does; the key must survive. Then it
checks bb's AI services and agents: all three tasks off, only `acp-opencode`
enabled, and an agent turned on by hand turned off again with one notice.
`e2e/run.sh --build-arg OPENCODE_PACKAGE=opencode-ai@1.19.5` checks the
OpenCode 1.x path.

`e2e/panel-smoke.mjs` clicks through the panel in headless Chromium inside the
container — Sync now, removing the key and entering it again through the form,
then the panel in Russian (English panel texts left over, buttons whose text
overflows or sticks out, at 1280, 900, 600 and 400 px) — and fails on console errors or if the key
shows up on the page. Stop OpenCode's `serve` processes first: Chromium and
them do not fit in the container's 2 GB.

```sh
docker exec -u root fleet-kit-e2e bash -c 'apt-get update -qq && apt-get install -y -qq chromium'
e2e/x.sh 'mkdir -p ~/pw && cd ~/pw && npm init -y >/dev/null && npm install playwright-core@1'
docker cp e2e/panel-smoke.mjs fleet-kit-e2e:/home/tester/pw/panel-smoke.mjs
e2e/x.sh 'node ~/pw/panel-smoke.mjs'
```

## License

MIT — see [LICENSE](LICENSE).
