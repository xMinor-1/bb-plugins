Connect your company's MCP servers to bb's agents and see whether each one
works — made for platforms where every person creates their own server
instance with its own address and token.

## What you get

- An **MCP** page in the sidebar: your servers by a name people understand
  and one line of what each does — taken from the platform's template list or
  from the server itself — with an on/off switch, their health (works, not
  answering, token not accepted) and since when, and the number of tools. Ids,
  addresses and call timeouts sit under Details.
- **Connect in three steps**: a button opens the platform page where you
  create your server, you copy its client settings (OpenCode, `mcpServers` or
  VS Code shape) and paste them — several servers at once. A new token is
  pasted the same way.
- **From a chat**, agents on the models you approve list your servers and
  switch them on or off; the change shows in a new thread.

## How it works

Everything runs on the machine where the agent runs. Tokens go to the macOS
Keychain or Windows Credential Manager and never into bb. For servers that are
on, the plugin writes OpenCode 2's `opencode.json` — only its own
`mcp.servers` entries, under Fleet Kit's write lock — and the token is
referenced from a private file (`{file:…}`) rather than written as text. Each
server is checked with an MCP handshake every few minutes, without following
redirects. Interface in English and Russian.
