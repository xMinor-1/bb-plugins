# App Branding

Shows your name and logo in place of bb's, for a company build of bb that should look like its own product.
There is no fork and no patched file: the plugin works in the page, and removing it brings bb's look back at once.

## What changes

- The bb logo on the onboarding screen, in the Skills filter and on bb's own plugin cards.
- The favicon and the touch icon of the page. bb's dot for unread threads no longer appears on the favicon.
- The page title `bb` on the home route. Titles of threads and settings pages stay as they are.

## What does not change

- Text that says "bb" inside sentences, such as "Open bb settings".
- The app icon, Dock and taskbar name: they belong to the desktop app package, not to the page.
- The web app manifest, used only when a browser installs the page as an app.
- The first moment of each load: bb's logo and title show until plugins start.

## Settings

| Setting | Meaning |
| --- | --- |
| `appName` | Page title in place of `bb`. Empty keeps it |
| `logoSvg` | SVG source of the logo, up to 64 KB. Empty keeps bb's logo |

```sh
bb plugin config app-branding set appName "Acme"
bb plugin config app-branding set logoSvg "$(cat logo.svg)"
```

The logo is drawn as an image, so a script inside the SVG does not run. Use a square logo that stays readable at 16 px.

## How it works

A content script runs in every window, also on the onboarding screen, where overlays and other slots are not mounted
yet. It reads the settings from this plugin's own route (`GET /branding`) and checks again every 30 seconds, because
settings can arrive after the plugin starts. It adds one stylesheet and a `MutationObserver` on `<head>`, because bb
rewrites the title and icons as the route, theme and unread state change. Everything is undone when the plugin stops.

The selector matches bb's built asset name (`/assets/bb-logo-*`). If a bb release renames the file, the logo
falls back to bb's and nothing breaks.

## Development

```sh
npm install
npx tsc --noEmit
npx vitest run
bb plugin build .
```
