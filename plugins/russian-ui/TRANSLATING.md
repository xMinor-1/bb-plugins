# Translating bb's settings into Russian

This file is the brief for whoever adds strings to the dictionary, a person or a model.
The reader is a Russian-speaking manager or developer with weak English: the translation should explain,
not copy word by word.

## Input and output

Input: the English strings printed by `node scripts/missing-strings.mjs`.

Output: entries for `src/dictionary/settings.json`, `{ "<English exactly as printed>": "<Russian>" }`.
Copy the key byte for byte: spaces, punctuation, quotes, `...` or `…`. Write the file with
`ensure_ascii=False` (or the equivalent): no `\uXXXX` escapes. Leave out a string that should stay English.

## Leave in English

- Names of plugins, products, agents, companies and people: Chime, Doc Review, Voice Ink, Concurrency limit,
  Claude Code provider, bb connect, GitHub, and so on.
- Versions, commands, paths, addresses, environment variables, values like `TextMate`.
- Key names (Alt, Control, Meta, Shift), icon and color names that are identifiers.

## Glossary

| English | Russian |
| --- | --- |
| thread / child thread | тред / дочерний тред |
| environment / environment variables | окружение / переменные окружения |
| provider | провайдер |
| project | проект |
| machine / host | машина / хост |
| agent | агент |
| plugin | плагин |
| marketplace | каталог плагинов |
| skill | скилл |
| worktree | worktree |
| branch / commit / pull request | ветка / коммит / PR |
| prompt box, composer | поле ввода |
| prompt | запрос |
| queue | очередь |
| follow-up | следующее сообщение |
| archive / unarchive | перенести в архив / вернуть из архива |
| context clear | очистка контекста |
| remote access | удалённый доступ |
| notification | уведомление |
| turn (of an agent) | ход |
| quick palette | быстрая палитра |
| secondary panel / chat pane | рабочая панель / панель чата |
| reasoning effort | степень рассуждения |
| Toggle X (keyboard command) | Показать или скрыть X |
| Enable / Disable | Включить / Выключить |
| Default | По умолчанию |
| System default | Как в системе |
| General / Appearance / Keyboard / Mobile | Общие / Оформление / Клавиатура / Телефон |
| Installed plugins / Plugin marketplaces | Установленные плагины / Каталоги плагинов |
| bb, BB | bb (not declined) |

## Style

- Short: the interface is narrow. Keep within 1.3 times the English length; buttons and filters even
  shorter (at 400 px "Категория" pushed the next filter off screen and became "Тип").
- Formal "вы" in lowercase; imperative on buttons: «Установить», «Сбросить».
- Capitalize labels and headings; no trailing period unless the English has one.
- A fragment (starts lowercase or stops mid-sentence) is translated so that it joins its neighbors.
- Terms without a settled Russian word stay in Latin letters: localhost, JSON, URL, API.
- Plain words, no officialese: «включить», not «осуществить включение».
- No middle dot `·` as a separator: use a comma, a dash or a semicolon.

## Check

```sh
npx vitest run      # the dictionary test rejects empty, unchanged and middle-dot translations
```

Then open the changed settings page with the language set to Russian and look for text that overflows a
button or a filter row at 400, 600 and 900 px.
