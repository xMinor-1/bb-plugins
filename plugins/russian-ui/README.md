# Russian UI

Russian text for the parts of bb that are hard to read in a foreign language: settings, the first-run
screens, confirmation dialogs and the agent's permission requests. The rest of bb stays in English on purpose:
the thread list, the composer, buttons like Send, and everything an agent or a person wrote.

There is no fork and no patched file: the plugin works in the page, and turning it off brings English back at once.

## What is translated

| Screen | Covered |
| --- | --- |
| Settings | Every section, including the settings pages of bb's built-in plugins and of this repository's plugins |
| First run | The onboarding steps: agents, machines, projects, remote access |
| Dialogs | Confirmations (archive thread, remove project, uninstall plugin, update bb) and dialogs opened from settings |
| Permission requests | "Run this command?", "Grant this permission?", plan review |

Never touched: chat messages, rendered Markdown, code, terminals, editors, command previews, text boxes'
values, the command palette and the thread list. Plugin, product and people's names stay as they are.

A string without a translation simply stays English, so a bb update never breaks a screen: new text shows
in English until the dictionary catches up.

## Language

The plugin follows the interface language shared by this repository's plugins (`xminor-plugins.lang` in the
page's local storage). Until someone picks one in a plugin's language switch, the browser's language decides:
Russian if the browser's first language is Russian, English otherwise. In English the plugin does nothing.

## Install

```sh
bb plugin install git:github.com/xMinor-1/bb-plugins --plugin russian-ui --yes
```

## How it works

A content script runs in every bb window. It translates text nodes and the `placeholder` and `title`
attributes inside a fixed set of screens, found by bb's own markers (`data-testid` of the settings content,
the settings sidebar, onboarding, permission requests; `role="dialog"`). A `MutationObserver` keeps new and
re-rendered text translated; everything outside those screens is checked once and skipped. The original text
of every changed node is kept, and the undo restores it.

The dictionary is plain JSON in `src/dictionary/`: exact strings, plus a few patterns in `index.ts` for
strings that carry a name or a number ("Update to 0.2.1").

## Keeping up with bb

After a bb update:

```sh
node scripts/missing-strings.mjs
```

It reads the newest bb build under `~/.bb/app-versions` and prints settings and first-run strings that the
dictionary does not cover. Translate them following [TRANSLATING.md](TRANSLATING.md) (a model can do it with
that file as the brief) and add them to `src/dictionary/settings.json`; a string that should stay English goes to `scripts/keep-english.json`, so the next run does not list it again. Strings that plugins declare in their
own settings and the keyboard commands are not in the screens this script reads: open those settings pages with the plugin on and look for English left over.

If a bb release renames one of the markers above, that screen stays English until the selector in
`src/translate.ts` is updated; nothing breaks.

## Development

```sh
npm install
npx tsc --noEmit
npx vitest run
bb plugin build .
```
