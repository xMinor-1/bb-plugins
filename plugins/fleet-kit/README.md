# Fleet Kit

Keeps a bb in line with a build manifest. An organization that hands the same
bb setup to many people describes it once — plugins, bb settings, the OpenCode
models people may use, the secrets those need — and Fleet Kit on every machine
brings bb to that description and keeps it there.

- **Plugins**: installs what the build lists, updates it when its source offers
  a newer release, re-enables it if someone turned it off, reinstalls it when
  the build moves it to another source, and removes what the build drops.
  bb itself does not update plugins on its own; Fleet Kit does.
- **bb settings**: holds the general settings the build sets (telemetry,
  default provider and so on).
- **OpenCode**: merges the build's OpenCode 2 block into `opencode.json` —
  providers, default model, `enabled_providers` — and leaves everything else in
  the file alone.
- **Secrets**: asks for each key once, keeps it in the operating system's
  credential store, and gives it to OpenCode at request time. The key never
  lands in `opencode.json`, in logs, or in the panel.
- **Panel**: a **Fleet Kit** page in the sidebar shows the build version, what
  the last sync changed, any errors, whether OpenCode is limited to the build's
  models, and a **Sync now** button.

## Install

```sh
bb plugin install git:https://github.com/xMinor-1/bb-plugins.git --plugin fleet-kit --yes
bb plugin config fleet-kit set manifestUrl https://builds.example.com/manifest.json
```

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

## Commands

```sh
bb fleet-kit status [--json]      # build, last sync, OpenCode protection, secrets
bb fleet-kit sync [--json]        # sync now and wait; exits 1 when the sync had errors
bb fleet-kit secret set <name> --value-stdin < key.txt
bb fleet-kit secret clear <name>
```

Secrets are entered in the panel's password field or piped on stdin. There is
no way to pass one as an argument, and no command prints one.

## The manifest

One JSON file describes the build. Fleet Kit refuses to apply a manifest with
errors — nothing changes on the machine until the manifest is fixed — and
applies one with warnings.

```json
{
  "schema": 1,
  "name": "Example build",
  "version": "1.2.0",
  "install": { "bb": "0.48.1", "opencode": "2.2.5" },
  "bb": { "minVersion": "0.48.0", "settings": { "telemetryEnabled": false } },
  "plugins": [
    { "id": "fleet-kit", "source": "git:https://github.com/xMinor-1/bb-plugins.git", "plugin": "fleet-kit", "status": "required" },
    { "id": "notes", "source": "git:https://git.example.com/plugins.git@semver:notes/:^1.0.0", "plugin": "notes", "status": "required",
      "config": { "greeting": "hello", "token": "{secret:gateway-key}" } },
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
  "mcp": []
}
```

- `schema` — the manifest format. A manifest newer than this Fleet Kit is
  refused with "Update Fleet Kit".
- `install` — the versions an installer should put on a new machine. Fleet Kit
  only checks that `install.bb` is not below `bb.minVersion`.
- `bb.minVersion` — Fleet Kit stops with an error on an older bb.
- `bb.settings` — keys of bb's general settings (`bb settings general`). An
  unknown key or a value of the wrong type is an error, not a silent skip.
- `marketplaces` — bb marketplaces to add if missing.
- `plugins` — `source` is a bb plugin source string. For one plugin from a
  monorepo with tags like `notes/v1.2.0`, write the tag prefix into the source:
  `git:<url>@semver:notes/:^1.0.0`. `config` sets plugin settings; a
  `{secret:name}` value is taken from the credential store. `planned` entries
  are shown and skipped. Fleet Kit itself must be listed as `required`.
- `removePlugins` — plugins to remove if present.
- `secrets` — every `{secret:name}` the manifest uses must be declared here.
- `allowedProviders` — the only OpenCode providers people may use. Fleet Kit
  writes it to `enabled_providers`, and passes it to installed plugins that
  declare a setting of that name.
- `opencode` — a native OpenCode 2 configuration fragment, merged as is.
  `providers` and `model` are required; every provider and the provider of
  `model` must be in `allowedProviders`. `{secret:name}` is allowed only as a
  provider's whole `settings.apiKey` or inside `settings.headers`.
- `mcp`, `skills` — validated; this version does not apply them yet.

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
again.

Fleet Kit updates itself the same way: when its source offers a newer
release, it finishes the current sync and then asks bb to install it.

Fleet Kit removes only plugins listed in `removePlugins` and plugins it
installed itself that the build no longer lists. Plugins a person installed by
hand stay.

### opencode.json

Other writers share this file — the person who uses OpenCode, and plugins such
as an MCP integration. Fleet Kit follows the contract they share:

- It writes only the keys that come from the manifest: `providers.<id>` for each
  build provider, the other top-level keys of the `opencode` block (such as
  `model` and `update`), and `enabled_providers`. It remembers which keys it
  wrote and removes one only when the build drops it. Comments and formatting of
  the rest of the file are kept.
- Writers take a lock directory `<config>.bb-config-lock` with an `owner.json`
  (plugin, pid, host, time), wait and retry while another writer holds it, and
  recover an abandoned lock under `.recovery`. The panel shows who holds the
  lock; when it has been held for more than two minutes, **Reset lock** breaks
  it. Fleet Kit never breaks a lock on its own.
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
command line. `opencode.json` gets no key at all: the provider entry is written
without `apiKey`, and Fleet Kit installs a small OpenCode plugin,
`plugins/fleet-kit-secrets.js` in the OpenCode configuration directory, that
reads the key from the same store and sets the `Authorization` header (or the
headers the manifest names) on each request to that provider. A changed key
takes effect within a minute without restarting anything.

Plugin settings with `{secret:name}` are filled from the store and rewritten
only when the secret changes.

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
e2e/x.sh 'bb plugin install git:/home/tester/fleet.git --plugin fleet-kit --yes'
e2e/x.sh 'bb plugin config fleet-kit set manifestUrl file:///home/tester/build/manifest.json'
e2e/x.sh 'bb fleet-kit sync'                  # the first sync learns the build's secrets
e2e/x.sh 'bb fleet-kit secret set gateway-key --value-stdin < ~/.fk-e2e/expected-key'
e2e/x.sh 'bb fleet-kit status'
```

The fixture build installs a local fixture plugin and a public one, removes a
plugin, sets bb settings, and points OpenCode at a fake OpenAI-compatible
gateway on `127.0.0.1:4010`. The gateway answers "Pong" and logs whether each
request carried the expected key (`~/.fk-e2e/gateway.log`), never the key
itself, so a thread on `acp-opencode` with `corp/model-large` shows the whole
path. `e2e/run.sh --build-arg OPENCODE_PACKAGE=opencode-ai@1.19.5` checks the
OpenCode 1.x path.

`e2e/panel-smoke.mjs` clicks through the panel in headless Chromium inside the
container — Sync now, removing the key and entering it again through the form —
and fails on console errors or if the key shows up on the page:

```sh
docker exec -u root fleet-kit-e2e bash -c 'apt-get update -qq && apt-get install -y -qq chromium'
e2e/x.sh 'mkdir -p ~/pw && cd ~/pw && npm init -y >/dev/null && npm install playwright-core@1'
docker cp e2e/panel-smoke.mjs fleet-kit-e2e:/home/tester/pw/panel-smoke.mjs
e2e/x.sh 'node ~/pw/panel-smoke.mjs'
```

## License

MIT — see [LICENSE](LICENSE).
