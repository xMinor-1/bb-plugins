---
paths:
  - "plugins/mcp-catalog/**"
---

# MCP Catalog

- Токен не попадает никуда, кроме хранилища ОС и файлов 0600 в `tokens/`: ни в `state.json`, ни в
  `opencode.json`, ни в kv bb, ни в ответы RPC и инструментов, ни в тексты ошибок. Тест
  `service.test.ts` это проверяет — новые места хранения добавлять в его проверку.
- Хост-воркер bb получает урезанное окружение (HOME, PATH и служебные), без `OPENCODE_CONFIG_DIR`
  и `XDG_CONFIG_HOME`. Их передаёт сервер в `config.serverEnvironment`, и только для основной машины
  bb (`primaryHostId`); иначе плагин пишет не тот `opencode.json`, что fleet-kit и OpenCode.
  Флаг разработчика `BB_MCP_CATALOG_ALLOW_HTTP` тоже читает сервер, а не хост.
- Тесты сервиса — всегда с `userHome` и `serverEnvironment` во временной папке: 31.10.2026 тест с
  пустыми значениями записал настоящий `~/.config/opencode/opencode.json` на сервере.
- Файл токена называется с версией (`t-<id>.<version>`): OpenCode 2.2.5 следит за `opencode.json`,
  но не за файлами по `{file:}`. Новое имя меняет ссылку, и OpenCode перечитывает конфиг сам.
- Пишем только `mcp.servers.<свои имена>`; чужое имя — только по явной кнопке «Replace it»
  (`replace: true`), тогда же убирается запись OpenCode 1 `mcp.<имя>`.
- Репозиторий публичный: в коде, тестах и README нет названия платформы, доменов и адресов
  компании. Примеры — `mcp.example.com`, `corp_wiki_ab12cd34`, токены `tok-synthetic-…`.
- После правок: `npx tsc --noEmit`, `npm test`, `bb plugin build .`, импорт `dist/server.js` и
  `dist/host.js`; панель — `e2e/panel-smoke.mjs` на отдельном bb в docker.
