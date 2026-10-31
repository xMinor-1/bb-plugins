---
paths:
  - "plugins/qlik-sense/**"
---

# Qlik Sense

- Обычный MCP не получает доверенный id модели OpenCode. Нельзя обещать проверку
  модели только по stdio-запросу. В корпоративном режиме нужна проверка списка
  моделей OpenCode: все провайдеры входят в allowedProviders; при невозможности
  проверки доступ закрыт. Не регистрировать корпоративный MCP у других агентов.
- Главная проверка для OpenCode 2.2.5 — результат opencode models без фильтра,
  в абсолютном cwd проекта с теми же OPENCODE_*/XDG_* и прочим окружением ACP:
  непустой корректный список,
  каждый provider входит в allowedProviders. Ошибка — отказ. Debug config v2
  возвращает массив Config.Entry, а не плоский effective config; не реализовывать
  заново merge и порядок policy OpenCode.
- Это проверка конфигурации, а запрет внешних моделей выполняет сам OpenCode:
  enabled_providers и системная policy там, где хватило прав на установку.
  Endpoint действующего ACP для неё не нужен. Запускать
  models --standalone, дождаться close, при таймауте завершать дерево процессов.
- Каталог OpenCode: opencodeConfigDir > OPENCODE_CONFIG_DIR из ACP env >
  XDG_CONFIG_HOME/opencode > os.homedir()/.config/opencode (также Windows).
  Один resolver для writer и model check. plugins/fleet-kit-* не трогать:
  там пульт поставляет Authorization через model.request, ключа в json нет.
- Windows: path.win32.isAbsolute принимает /config и \config без буквы диска.
  Для общего пути writer/runner разрешать только drive-qualified путь либо UNC.
- При таймауте/отмене close родительского launcher не отменяет добивание группы:
  потомок мог пережить SIGTERM и закрыть stdio. Дождаться SIGKILL дерева отдельно.
- Версию OpenCode определять через --version: v2 пишет только
  mcp.servers.qlik-sense, v1 — mcp.qlik-sense. Ручной mcp.qlik не менять.
- Writer и config-lock синхронизировать с fleet-kit: общий .bb-config-lock,
  owner.json, ожидание, восстановление только старого замка мёртвого процесса
  на том же хосте (либо старого без owner), сверка содержимого перед rename.
- Восстановление stale lock обязательно сериализовать отдельным recovery guard.
  Две lstat перед rename не атомарны: второй recoverer может удалить новый замок.
  Сам recovery guard автоматически не восстанавливать — это вернёт ту же гонку.
- Смысл галочек в каталоге ожидает решения владельца. Не превращать их в
  ограничение доступа или избранное молчаливым выбором реализации.
