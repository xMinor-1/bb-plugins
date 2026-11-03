# Bug Report Button

A small bug button on every screen of bb. A click opens your bug report form in the browser, so people can report
a problem from wherever they noticed it. The plugin holds no address of its own and sends nothing anywhere.

## Settings

| Setting | Meaning |
| --- | --- |
| `formUrl` | The http or https address of the form. Empty hides the button |
| `label` | Tooltip and screen reader name of the button. Empty shows `Report a bug` |

```sh
bb plugin config bug-report-button set formUrl "https://example.com/forms/bugs"
bb plugin config bug-report-button set label "Report a bug"
```

## Where the button is

Fixed to the right edge of the window at mid-height. The corners hold the composer's send button, the sidebar footer
and the panel toggle. The button stays there on every route, over dialogs, with the sidebar collapsed, and on the
onboarding screen. It can cover a little of the content on the right edge of a narrow window.

## Where the form opens

The button is an ordinary link with `target="_blank"`:

- In the desktop app, bb's window-open handler passes it to the system browser, with the user's own sign-ins.
- In a web browser, it opens a new tab.

It does not use bb's in-app browser, which keeps a separate session and would ask the user to sign in again.

## How it works

A content script runs in every window, because overlays are not mounted on the onboarding screen. It reads the settings
from this plugin's own route (`GET /config`) and checks again every 30 seconds, because settings can arrive after the
plugin starts. Everything is undone when the plugin stops.

## Development

```sh
npm install
npm test
npm run typecheck
npm run build
```
