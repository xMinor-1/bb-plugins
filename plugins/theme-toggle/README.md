# Theme Toggle

Theme switching one click away, in the bb sidebar footer.

- **Click** — cycle to the next palette.
- **Hold (400 ms) or right-click** — a menu with light / dark / system
  appearance and the full palette list, including palettes contributed by
  other plugins.

## Install

```sh
bb plugin install git:https://github.com/xMinor-1/bb-plugins.git --plugin theme-toggle
```

## How it works

`server.ts` exposes three RPC methods over `bb.sdk.theme`:

| Method | What it does |
| --- | --- |
| `state` | active palette plus the full list (built-in, custom, plugin-provided) |
| `cycle` | switches to the next palette |
| `select` | applies a palette by id |

The two settings live in different places, so the plugin touches both:

| Setting | Owner | How the plugin changes it |
| --- | --- | --- |
| Palette | bb server (`bb.sdk.theme`) | the RPC methods above |
| Light / dark / system | browser (`localStorage` key `bb.theme`) | written client-side, with a synthetic `storage` event so bb re-renders |

`sidebarFooterAction` is rendered by the host, so the hold gesture is attached
by a content script to the host's button (matched by its stable `data-testid`),
and the menu is plain DOM positioned next to that button. It styles itself from
the app's CSS custom properties, so it follows whichever palette is active.

## Development

```sh
npm install
npx tsc --noEmit
bb plugin build .
bb plugin dev .
```

## License

MIT — see [LICENSE](LICENSE).
