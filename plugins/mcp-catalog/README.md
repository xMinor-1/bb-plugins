# MCP Catalog for bb

Connect your company's MCP servers to bb's agents and see at a glance whether
each one works. Built for platforms where every person creates their own MCP
server instances (their own address and token), so a fixed list in a build
manifest cannot work.

- **MCP** page in the bb sidebar:
  - **Your MCP servers** — each with an on/off switch, its health (*works*,
    *not answering*, *token not accepted*) and since when, the number of tools,
    a call timeout, Check and Remove.
  - **Connect servers** — paste the client settings the platform gives you;
    several servers at once.
  - **Catalog** — the MCP servers your company offers, with descriptions and a
    *Create on the platform* button.
- **From a chat**, agents on approved models can list your servers with their
  health and switch one on or off.
- Tokens go to the OS credential store. They are not kept in bb, not shown
  again and not written into `opencode.json` as text.

Interface: English and Russian — switch with **EN | RU** at the top of the page.

## Install

```sh
bb plugin install git:github.com/xMinor-1/bb-plugins --plugin mcp-catalog --yes
```

## Use

1. In **Catalog**, press *Create on the platform* and create your server there.
2. On the platform, copy the server's settings for OpenCode (or any MCP client).
3. On the **MCP** page, paste them into **Connect servers** and press **Add**.
   The plugin checks each server right away and switches it on.
4. Start a new thread: OpenCode loads MCP servers when a session starts.

A token stopped working? Copy fresh settings from the platform and paste them
again: the server is updated in place.

Accepted shapes, whole files or fragments:

| Client | Shape |
| --- | --- |
| OpenCode 2 | `{"mcp": {"servers": {"<name>": {"type": "remote", "url", "headers"}}}}` |
| OpenCode 1 | `{"mcp": {"<name>": {"type": "remote", "url", "headers"}}}` |
| Claude, Cursor and most clients | `{"mcpServers": {"<name>": {"url", "headers"}}}` |
| VS Code | `{"servers": {"<name>": {"type": "http", "url", "headers"}}}` |

Only remote servers over `https://` are taken. Local (command) servers,
addresses with a token in them and values that refer to environment variables
or files are skipped with a reason.

## Settings

`bb plugin config mcp-catalog`, usually set once by whoever builds bb for the
company:

| Key | Default | What it does |
| --- | --- | --- |
| `catalogUrl` | empty | A JSON list of servers people can create, read without signing in: a list at the root or under `items`, `templates`, `servers`, `data` or `results`, each with `id`, `name`, `description`. Empty hides the catalog. |
| `platformUrl` | empty | The page *Create on the platform* opens; `{id}` is replaced with the catalog item's id. |
| `allowedModels` | empty | Agents that get the chat tools, one `<provider-id> <model-glob>` per line, for example `acp-opencode corp/*`. Empty: no agent. |
| `callTimeoutSeconds` | 30 | How long OpenCode waits for one tool call (`timeout.execution`), unless a server has its own on the page. 0 keeps OpenCode's default. |
| `checkIntervalMinutes` | 10 | How often each machine checks its servers in the background; 0 turns it off. The page checks when opened. |
| `opencodeConfigDir` | empty | Where `opencode.json` lives. Empty: `OPENCODE_CONFIG_DIR`, else `~/.config/opencode`, the same rule as Fleet Kit. |

## How it works

- **Where things run.** The server list, tokens and health checks live on the
  machine where the agent runs (the plugin's host entry), the one inside the
  company network. The bb server keeps only counts (for `setupStatus`) and
  which machine was last used.
- **Tokens.** A credential header (`Authorization`, `*token*`, `*key*`, …) is
  split into its scheme and the token; the token goes to the macOS Keychain,
  Windows Credential Manager or, elsewhere, a 0600 file under
  `~/.local/share/bb-mcp-catalog/secrets`. For a server that is on, the token
  is also written to a 0600 file in the plugin's data directory, and
  `opencode.json` refers to it: `"Authorization": "Bearer {file:/…/tokens/t-…}"`.
  OpenCode 2 replaces the reference with the file's content when it loads the
  configuration (checked on OpenCode 2.2.5). Switching a server off removes
  the entry and then the file; the token stays in the OS store until you
  remove the server. A new token is stored under a new name, so its file name
  changes too and OpenCode, which watches `opencode.json`, picks it up; the
  old token is deleted only after `opencode.json` stops referring to it. A
  paste that cannot be saved completely changes nothing. Headers are treated
  as credentials by name or by a token-like value (long, no spaces, letters
  and digits).
- **`opencode.json`.** The plugin writes only `mcp.servers.<name>` for servers
  that are on, with `oauth: false` and `timeout.execution`, under the same
  write lock as Fleet Kit (`<file>.bb-config-lock`), and keeps one backup of
  the original (`opencode.json.before-mcp-catalog.bak`). Everything outside
  `mcp` stays byte for byte. A server of the same name that the plugin did not
  write is left alone; the page offers *Replace it*, which also removes an
  OpenCode 1 style `mcp.<name>` entry with its plain-text token. The plugin
  writes the OpenCode 2 format and refuses to write when it finds OpenCode 1.
- **Health.** An MCP `initialize`, then `tools/list`, with the server's own
  headers and a 10-second limit, at most three servers at a time. 401 or 403
  means the token was not accepted; anything else that is not an MCP answer
  means the server is not answering. Redirects are never followed, so a token
  goes only to the address it was pasted with.
- **Agents.** Tools `mcp_servers`, `mcp_enable`, `mcp_disable` are offered only
  to the provider/model pairs in `allowedModels`, and each call re-checks the
  model the thread is running at that moment. Agents never see tokens or
  headers, and cannot add servers.
- **`setupStatus`.** Other plugins (a build's first-run checklist) may call
  this one RPC method: `done` when at least one switched-on server works,
  `todo` before anything is connected, `problem` otherwise. It answers from
  the last status heard, without network calls. All other methods answer only
  bb clients.

## Development

```sh
npm install
npx tsc --noEmit
npm test
bb plugin build .
```

`e2e/` has a stub catalog and MCP server (`stub-servers.mjs`), an RPC helper
and a headless panel check (`panel-smoke.mjs`), for a throwaway bb in docker —
never your own. Plain-http stubs need `BB_MCP_CATALOG_ALLOW_HTTP=1` in that
bb's environment.
