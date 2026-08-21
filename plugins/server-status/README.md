# Server Status

The health of the machine that runs bb, as a ring around a sidebar footer
button.

- **Ring** — RAM usage. Muted below 80%, amber from 80%, red above 90%.
  Refreshed every five seconds.
- **Click** — a panel with the full summary. Closes on Escape, on a click
  outside, or on a second click of the button.

The panel shows the CPU with its core count, memory in percent and gigabytes,
swap as a separate row with a warning, disk (used, total, free), load average
over 1, 5 and 15 minutes, uptime with the date of the last boot, and the OS and
kernel version. Sizes print in gigabytes, and in terabytes past a terabyte, one
unit per row.

The ring repeats the geometry of the [usage-meter](../usage-meter) plugin — same
thickness, same radius, same animation. The two buttons sit next to each other
in the footer and should read as one system.

## Install

```sh
bb plugin install git:https://github.com/xMinor-1/bb-plugins.git --plugin server-status
```

## Settings

```sh
bb plugin config server-status set diskPath /
```

`diskPath` is the mount point the disk figures are read from. Defaults to `/`.

## How it works

`server.ts` reads metrics straight from the kernel, with no dependencies and no
shelling out:

| Metric | Source | Detail |
| --- | --- | --- |
| CPU | `/proc/stat` | load is the delta between two samples; a single read says nothing. `iowait` counts as idle |
| Memory | `/proc/meminfo`, `MemAvailable` | the kernel's own estimate of what a new process would get. Read from `MemFree`, an idle machine would report 95% |
| Swap | `/proc/meminfo`, `SwapTotal`/`SwapFree` | `null` when there is no swap |
| Disk | `statfs` | percentage as in `df(1)`: `used / (used + available)`, root-reserved blocks excluded. Polled once a minute — it is the most expensive read |
| Uptime, kernel, load average | `os` | the boot moment travels to the frontend, and the tab grows uptime on its own |
| OS name | `/etc/os-release`, `PRETTY_NAME` | read once at startup |

A single background `metrics` service ticks every five seconds for the whole
server and keeps a fresh snapshot in memory; the `state` RPC method serves that
snapshot, so the cost of collecting metrics does not grow with the number of
open tabs. The snapshot is not published to the realtime channel: it has no
subscribers there, and frames would reach every tab even while it is hidden and
polling is silent.

The host renders `sidebarFooterAction` as an icon only, so the ring comes from a
content script: its own `<svg>` goes inside the host button (found by a stable
`data-testid`), absolutely positioned over the icon and transparent to pointer
events — the click and the tooltip stay with the button. The panel is plain DOM
in `body`, styled from the application's CSS variables, so it follows the active
palette. A content script has no React hooks and therefore no `useRealtime`: it
polls `state` on the same five-second tick and stays silent while the tab is
hidden.

The plugin never moves or removes nodes it does not own; its own nodes,
listeners, timers and observers are torn down by the content script's disposer.

## Development

```sh
npm install
npx tsc --noEmit
bb plugin build .
bb plugin dev .
```

## License

MIT — see [LICENSE](LICENSE).
