# Obfuscation Proxy

Shows above the message box whether a thread's external model traffic is
masked, lets people switch it per thread, and lists every model request with
what was masked in it.

Masking itself is done by a local masking proxy binary you supply: it replaces
secrets, internal host names and personal data in the request with
placeholders before anything leaves the machine, and puts the real values
back into the streamed answer, so the agent keeps working with real code.

Interface in English and Russian.

## What people see

- A segment in the context row above the message box of every thread with an
  external model: **Masking on** (green) with the thread's request and masked
  value counts, or **Masking off** (red). A switch at the row's end turns it
  on or off for that thread; the next request follows it, no restart needed.
- Click the segment to open the thread's feed: time, model, whether the
  request went masked, unmasked or was not sent, what was masked by kind
  (secrets, keys in code, personal data, internal hosts, terms…), status and
  duration. Token counting requests are tallied, not listed.
- Threads on in-network models (see settings) show nothing.

## How it works

1. For Claude Code sessions the plugin sets `ANTHROPIC_BASE_URL` to its own
   route on the bb server and adds two headers through
   `ANTHROPIC_CUSTOM_HEADERS`: the thread id and a routing key.
2. Each request is sent through the masking proxy when masking is on for its
   thread, or straight to the original upstream when it is off. The original
   upstream is the bb server's own `ANTHROPIC_BASE_URL`, or
   `https://api.anthropic.com` when it has none: nobody picks an address.
3. **Fail closed:** with masking on and the proxy not running, the request is
   refused with a clear error and nothing is sent.
4. The plugin starts the proxy on a free loopback port with a generated config
   (listen address, upstream, JSON logs, plus your extra YAML) and reads its
   log lines: `listening`, the per-request masking report (`detect.debug`,
   matched to its request by body size) and errors. Request bodies are never
   logged by the proxy nor stored by the plugin; the feed keeps only metadata.

## Settings

| Setting | What it does |
|---|---|
| Mask new threads by default | Masking starts on in every thread with an external model (default on). |
| Proxy binary path | Absolute path to the binary on the bb server machine. |
| Proxy download URL | Used when the path is empty. `{os}`, `{arch}`, `{ext}` are filled in; a `.sha256` file next to the binary is required and checked. The verified copy is reused offline. |
| In-network models | Comma-separated model id prefixes that never leave your network. Every other model counts as external. |
| Extra proxy configuration | YAML appended to the generated config (masking rules, egress proxy). `server`, `upstream` and `log` are set by the plugin. |

The proxy must accept `serve --config <file>`, read `server.addr`,
`upstream.routes.anthropic.base_url` and `log.format: json`, and print JSON log
lines to stdout.

## Limits

- Claude Code only for now. Other agents with an external model show
  "Masking is not available for this agent".
- The route is set when a session starts: a session started before the plugin
  was installed goes direct and its feed stays empty until it restarts.
- An `ANTHROPIC_BASE_URL` in Claude Code's own `settings.json` overrides the
  plugin's, and that traffic bypasses it.
- The proxy runs on the bb server machine. Masking happens there, so put bb
  where the data is allowed to be (usually the person's own computer).

## Development

```sh
npm install
npm test                                          # unit tests
MASKING_PROXY_BIN=/path/to/proxy npm test         # plus end to end with a real proxy
npx tsc --noEmit && bb plugin build .
```

Install from this repository:

```sh
bb plugin install path:"<repo>" --plugin obfuscation-proxy --yes
bb plugin config obfuscation-proxy set binaryPath /path/to/proxy
```
