# Qlik Sense

Connect agents to Qlik Sense Enterprise reports using the user's own account.
Plugin ID: `qlik-sense`.

**Development in progress. Not ready for installation or release.** The setup
and report catalog UX is awaiting owner approval. This branch publishes reusable
modules for fleet-kit; it is not an installable plugin release. Authentication,
MCP activation and the UI are not included in this module snapshot. No company
connection is made during development.

## Fleet preconfiguration

The plugin declares these settings, writable through `bb plugin config`:

| Key | Default | Meaning |
| --- | --- | --- |
| `url` | empty | HTTPS Qlik base URL, including a virtual-proxy prefix if needed. No embedded credentials, query or fragment. |
| `allowedProviders` | empty | Explicit OpenCode provider IDs separated by commas or whitespace. No wildcards. Empty means provider restrictions are disabled; setup must visibly warn before connecting. |

Example for a fleet's private manifest (the public repository contains no company addresses):

```sh
bb plugin config qlik-sense set url https://qlik.example/proxy
```

```sh
bb plugin config qlik-sense set allowedProviders x5
```

Passwords must never be passed through these settings or written into
OpenCode's MCP configuration. The planned credential stores are macOS Keychain
and Windows Credential Manager. Windows Node is supplied by the fleet
installer (22.19+); the MCP launcher must pass `--use-system-ca`.

## OpenCode configuration ownership

The config writer in `src/host/opencode-config.ts` is host-local. Its caller
must determine the installed version using `opencode --version`; it refuses
unknown versions instead of guessing the configuration format.

- OpenCode 2 (fleet baseline: **2.2.5**): owns only `mcp.servers.qlik-sense`.
- OpenCode 1 (including 1.18.x): owns only `mcp.qlik-sense`.
- A manually configured `mcp.qlik` is preserved. The writer reports its presence
  so setup can explain the potential duplicate and let the person handle it.
- Providers, default models, remote MCP servers and policy belong to the fleet
  manager and are never modified by this plugin.

The writer accepts JSON and JSONC, preserves unrelated text and comments,
refuses invalid/duplicate keys, and copies an existing file once to
`<config-path>.before-qlik-sense.bak`. The backup is never overwritten. Updates
use a temporary file in the same directory, flushed before atomic rename.
An existing file retains its permissions; new files request mode 0600.

**Shared writer lock:** every writer, including fleet-kit, must acquire a
lock by creating the directory `<config-path>.bb-config-lock` before reading
and hold it through replacement. Immediately write `owner.json` inside it:
`{plugin, pid, host, createdAt}` (the Qlik implementation adds a release token).
Wait 0.2, 0.5, 1, 2 seconds, then 5 seconds between attempts. After two minutes,
report the busy plugin and its start time. Waiting is cancellable.

A lock older than 60 seconds may be recovered only when its owner process is
dead on the same host, or when it has no owner file. Live processes, owners on
other hosts, malformed owner metadata and recent locks are preserved. Recovery
renames the stale directory before deleting it and acquiring a fresh lock.
Recoverers serialize through `<config-path>.bb-config-lock.recovery`. This
short-lived guard is not automatically recovered: if a process crashes inside
recovery, setup must offer an explicit **Reset configuration lock** action,
enabled only after verifying that the owner processes are dead. That UI action
is pending; employees must not be asked to diagnose lock directories manually.
The recovery guard records its own owner metadata for that check. Reaping it
automatically would reintroduce the race where a second recoverer removes a
new writer's lock.

Right before replacement, compare the current file's SHA-256 with the original.
If it changed, release the lock and repeat the read/merge/write cycle, up to
five attempts. Atomic rename alone cannot prevent lost updates between
uncoordinated writers: a small race remains for editors that ignore the lock.
Keep backups private: an existing OpenCode config may contain other services'
credentials.

This module does not enable MCP by itself. Activation must first pass the
OpenCode configuration check.
If that cannot be verified, corporate mode must refuse activation and tool
calls. No corporate MCP may be registered with other agents. The provider
MCP activation and launcher integration remain to be implemented.

The primary guard (`src/shared/available-models.ts`) validates the output of
`opencode models`, run without a provider filter with the ACP environment and
project directory. OpenCode 2.2.5 applies its policies before
returning this list. Success requires exit code zero, a nonempty valid list,
and every model's provider ID in `allowedProviders`. Failed, empty, oversized
or unrecognized output is denied. Never log unparsed output or whole provider
API responses. The host runner is `src/host/check-models.ts`; activation/tool-call
wiring is pending.
`provider-policy.ts` is a secondary conservative check for already effective,
ordered rules, not an implementation of OpenCode's config merging.

Verified against the official 2.2.5
[models CLI](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/cli/src/commands/handlers/models.ts),
[model API](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/server/src/handlers/model.ts)
and [policy filter](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/core/src/config/plugin/policy.ts).

The runner calls `--version`, then `models --standalone` with an absolute
project directory as cwd. Its `environment` argument must be the environment
used to launch acp-opencode, including the same `OPENCODE_*` and `XDG_*` values;
it does not merge in the plugin server's environment. A caller must resolve
that host environment before invoking the check.

This is a **configuration check**, not a proof about an already running agent.
The system policy enforced by OpenCode itself is the control that prevents use
of external providers. Standalone mode avoids leaving a shared background
server behind. OpenCode additionally applies its saved service environment to
the standalone server; this check does not attest an existing ACP process.
The runner waits for process close, bounds stdout, discards stderr, and kills
the process tree on timeout or cancellation (POSIX process group; Windows
`taskkill /T /F`). Default timeout is 20 seconds per command.

`command` defaults to `["opencode"]`. For an npm Windows installation, pass
`[absoluteNodePath, absolutePathToAtOpencodeCliBinOpencodeCjs]`, resolving the
installed `@opencode/cli/bin/opencode.cjs`. This avoids cmd.exe, shell quoting
and .cmd shim execution. A native executable path is also accepted.

When `allowedProviders` is nonempty, OpenCode 1.x is refused before the model
probe with an upgrade-to-2.x message. The manually configured legacy MCP remains
untouched during migration. Empty `allowedProviders` returns an explicit
unrestricted warning without starting a process.

Standalone lifecycle verified against the official
[implementation](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/cli/src/services/standalone.ts)
and [tests](https://github.com/anomalyco/opencode/blob/v2.2.5/packages/cli/test/standalone.test.ts).

OpenCode 2 uses managed system policy to restrict provider use; user/project
configuration is insufficient to prove that restriction. See the official
[config guide](https://opencode.ai/v2/docs/config/) and
[policy guide](https://opencode.ai/v2/docs/policies/).

## Verification

Fleet-kit can copy these module files and focused tests, preserving their relative
layout. Runtime dependencies are `jsonc-parser` (^3.3.1) and `zod` (^4.6.5);
tests use Vitest, TypeScript and Node types. Keep `config-lock.ts` synchronized
between both plugins. The focused tests use temporary local fixtures only:

```sh
npx vitest run test/opencode-config.test.ts test/provider-policy.test.ts test/available-models.test.ts test/check-models.test.ts
```

```sh
npx tsc -p test/tsconfig.modules.json
```

Before a release, the complete plugin still requires typecheck, plugin build,
Qlik Core integration tests, and macOS/Windows credential-store validation.
Releases use tags named `qlik-sense/vX.Y.Z`.
