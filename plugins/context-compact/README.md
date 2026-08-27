# Context Compact

The context ring under the composer becomes a compact button. Click it and the
thread compacts its context — the same request `/compact` and
`bb thread compact` make — instead of only showing a hover card with the token
figures.

![the ring sits at the right end of the composer's footer row](./icon.svg)

## What it does

- **Click the ring → compaction.** No typing, no menu. A toast reports the
  result: `Compacting context…` when BB accepted the request, or the reason it
  did not.
- **Hover is untouched.** The stock hover card with `used / total tokens` and
  `% left` still opens on hover; only the click changes.
- **Split layouts hit the right thread.** Each composer publishes its own thread
  id, so the ring in a split pane compacts that pane's thread, not the one in
  the address bar.

BB only compacts an idle or errored thread. Click the ring while the agent is
working and the toast says so — nothing is queued behind your back.

## Install

```sh
bb plugin install git:https://github.com/xMinor-1/bb-plugins.git@main --plugin context-compact
```

## How it works

BB renders the ring as a button labelled `Context window 42% used` whose only
behavior is the hover card. A **content script** intercepts that button's click
in the capture phase (so the hover card never sees it) and calls the plugin's
`compact` RPC method, which runs `bb.sdk.threads.compact({ threadId })` on the
server.

The click needs to know which thread it belongs to, and BB puts no thread id in
the composer's DOM. A **composer customization** supplies one: an action
component that renders a single hidden marker carrying its composer scope's
thread id. The script reads the marker inside the clicked pane and falls back to
the thread id in the URL where no marker exists (a compact layout drops plugin
composer actions).

Both halves fail quietly. If a future BB release renames or restructures the
ring, the selector stops matching and the ring goes back to being a plain hover
card — nothing else in the composer changes.

| File        | What lives there                                            |
| ----------- | ----------------------------------------------------------- |
| `server.ts` | the `compact` RPC method over `bb.sdk.threads.compact`       |
| `app.tsx`   | the content script (click interception) and the thread marker |
| `icon.svg`  | the plugin mark: a ring with two arrows pressing inward      |
