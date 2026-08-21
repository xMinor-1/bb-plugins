# Usage Meter

Claude subscription limits, as two rings around a sidebar footer button.

- **Outer ring** — the five-hour session, the `Current session` window.
- **Inner ring** — the weekly limit, the `Weekly limit` window. Smaller radius,
  thinner stroke, a visible gap between the two.

Both fill clockwise from twelve o'clock and colour independently by their own
value: muted below 60%, amber from 60%, red above 85%. The popup names those
thresholds in words — the neighbouring footer button uses different ones.

The per-model limit (`Fable`) gets no third ring: on a 32×32 button it stops
being readable, so it lives as a row in the popup. Staying silent about it is
not an option either — the moment it passes 60%, a dot lights up in the top
right corner of the button in the same colour the rings take at that value, and
the popup row is marked with the same dot.

- **Hover** — a popup with every limit window: percentage and reset time in
  local time, plus the subscription plan and the account email.
- **Click** — the same popup, pinned: it survives the cursor leaving. Closes on
  a second click, on Escape, or on a click outside.

The outer ring repeats the geometry of the neighbouring
[server-status](../server-status) plugin: same path along the button's edge,
same thickness, same animation. The two buttons sit next to each other in the
footer and should read as one system. The neighbour's colour thresholds are its
own (80% and 90% of RAM usage) — different quantities, under no obligation to
match.

## Install

```sh
bb plugin install git:https://github.com/xMinor-1/bb-plugins.git --plugin usage-meter
```

## How it works

`server.ts` polls once for the whole server. A background service calls
`bb.sdk.system.usageLimits()` and keeps the snapshot in memory; the `state` RPC
method serves that same snapshot, so the number of open tabs adds no load on the
API. Realtime does not apply here: the channel subscription lives only in the
`useRealtime` React hook, and the rings are drawn by a content script that
cannot reach hooks. So the snapshot is simply polled — every 60 seconds and when
the tab comes back into view.

| Detail | Handling |
| --- | --- |
| The provider rejects frequent calls ("Claude usage is rate limited right now") | Poll every 5 minutes; after a failure the period doubles up to half an hour |
| A one-off network failure | The previous numbers stay on screen: the rings keep showing them, and a dedicated popup row states their age (`okAt`) and the reason |
| `not_installed` / `unauthenticated` / `expired` | The snapshot is cleared: the old numbers are no longer about this account |
| The same complaint every minute | Only a change of reason reaches the log |

`app.tsx` holds the rings and the popup. The host renders the
`sidebarFooterAction` slot as an icon only, so the rings come from a content
script: its own `<svg>` goes inside the host button, absolutely positioned over
the icon and transparent to pointer events. Nodes the plugin does not own are
never moved or removed — the application blocks that; everything it does own
(node, listeners, timers, `MutationObserver`) is torn down by a disposer.

| Detail | Handling |
| --- | --- |
| The button does not exist yet when the script starts | A `MutationObserver` waits for it and restores the rings if React re-renders the footer |
| Hidden tab | The 60-second poll stays silent until the tab is visible again; returning from the background refreshes the numbers at once |
| The API returns a different set of windows | A ring is drawn only for a window that was found; the rest simply appear in the popup list |
| A cleared snapshot (`expired` and friends) | Both rings stand grey and empty, and the reason moves into the popup |
| An English provider message | Known ones are translated; an unknown one never reaches the interface — it goes into the row's tooltip |
| A long window label from the API | Truncated with an ellipsis inside the panel; the full text stays available as a tooltip |
| The host button's own tooltip | The popup notices it and moves higher so it does not cover it |
| A zero value | The arc hides entirely: a round stroke cap would leave a dot at twelve o'clock |
| A collapsed sidebar | A ring with no room is skipped rather than drawn as an inside-out path |

## Development

```sh
npm install
npx tsc --noEmit
bb plugin build .
bb plugin dev .
```

## License

MIT — see [LICENSE](LICENSE).
