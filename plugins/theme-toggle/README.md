# Theme Toggle

Theme switching one click away, in the bb sidebar footer.

- **Click** — flip light ⇄ dark.
- **Hover and wait (600 ms)** — the menu opens on its own, no click needed.
  Mouse only, and it closes again once the cursor leaves.
- **Hold (400 ms) or right-click** — the same menu, for touch and for people
  who would rather ask for it.

The menu lists light / dark / system appearance and every palette on the host,
including ones contributed by other plugins.

The button wears a square split along the diagonal: day above the cut, night
below it. The half that is on is filled and holds its symbol punched through
it, the other half is an empty outline with its symbol drawn small — so the
fill moves from one half to the other on every flip, and the button shows the
state it is in, not only the one it would move to.

## Install

```sh
bb plugin install git:https://github.com/xMinor-1/bb-plugins.git --plugin theme-toggle
```

## How it works

`server.ts` exposes two RPC methods over `bb.sdk.theme`:

| Method | What it does |
| --- | --- |
| `state` | active palette plus the full list (built-in, custom, plugin-provided) |
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

The same content script paints the switch. bb renders `branding.icon` as a CSS
mask over a span inside its own button, so the plugin swaps that one mask
between the two faces and leaves the host's chrome alone; `icon.svg` is the
night face and stays the still version bb shows in the plugin catalog. If the
markup ever moves, nothing is repainted and the button keeps that still icon.

Two things the artwork depends on. A mask reads alpha, so the symbol on the
filled half is cut out through an SVG `mask` rather than painted in a lighter
colour. And the drawing uses the whole canvas: bb fits the entire viewBox into
16 px of chrome, so empty margin in the file is size the icon loses next to its
neighbours.

## Development

```sh
npm install
npx tsc --noEmit
bb plugin build .
bb plugin dev .
```

## License

MIT — see [LICENSE](LICENSE).
