# Bug Report Button

A small bug button in the top bar of bb, on every screen. A click opens your bug report form in the browser, so people can report
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

In the top bar of the window, in the free space between the thread title and the actions on the right. bb draws that
bar on every route, so the button stays in one place on threads, Home and Settings, over dialogs, with the sidebar
collapsed, and on the onboarding screen. A very long title in a narrow window can run under it.

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
