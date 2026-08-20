# BB Plugins

Плагины для [bb](https://getbb.app) — по одному на директорию в `plugins/`.
Каждый ставится отдельно, скачивать весь репозиторий не нужно.

| Плагин | Что делает | Статус |
| --- | --- | --- |
| [theme-toggle](plugins/theme-toggle) | Кнопка темы в футере сайдбара: клик — следующая палитра, наведение с задержкой, удержание или правый клик — меню выбора палитры и режима светлая / тёмная / как в системе | Работает, релиз `theme-toggle/v0.2.1`; заявка в каталог bb — [PR #74](https://github.com/get-bb/marketplace/pull/74) |
| [file-manager](plugins/file-manager) | Панель для файлов на сервере bb: дерево, загрузка и скачивание больших файлов потоком | Спецификация готова, реализация не начата |

## Установка

```sh
bb plugin install git:https://github.com/xMinor-1/bb-plugins.git@^0.2.0 --plugin theme-toggle --tag-prefix theme-toggle/
bb plugin install git:https://github.com/xMinor-1/bb-plugins.git@main --plugin file-manager
```

Первая форма ставит последний релиз по тегу `theme-toggle/vX.Y.Z` и видит
обновления через `bb plugin outdated`; `@main` берёт текущее состояние ветки.

`--plugin <имя>` берёт запись из `.bb/plugins.json`. Равнозначная форма — через путь:
`--subdirectory plugins/theme-toggle`.

Локально, из клона репозитория:

```sh
bb plugin install path:. --plugin theme-toggle
```

## Релизы

Каждый плагин версионируется отдельно тегом `<плагин>/vX.Y.Z`:

```sh
git tag -a theme-toggle/v0.3.0 -m "Release theme-toggle v0.3.0"
git push origin theme-toggle/v0.3.0
```

Версия в теге должна совпадать с `version` в `package.json` плагина. Тег не
переносят и не переписывают — на каждый релиз новый. Пока диапазон в записи
каталога (`^0.2.0`) покрывает новую версию, обновлять запись в каталоге не
нужно: bb сам увидит релиз. Для версий `0.x` смена второй цифры выходит за
диапазон — тогда запись в каталоге правится отдельным PR. Смена источника, названия, иконки или описания —
новый PR в каталог.

## Новый плагин

```sh
scripts/new-plugin.sh <имя> [--app]
```

Создаёт `plugins/<имя>` и регистрирует его в `.bb/plugins.json`. Остальные шаги —
в [CLAUDE.md](CLAUDE.md).

## Разработка

```sh
cd plugins/theme-toggle
npm install
npx tsc --noEmit        # проверка типов
bb plugin build .       # сборка dist/ (server.js, app.js, app.css + meta)
bb plugin dev .         # пересборка и перезагрузка на каждое сохранение
```

Требования: bb >= 0.39, `@get-bb/plugin-sdk` >= 0.4.8, Node 24.

`dist/` и `node_modules/` не версионируются — bb собирает плагин при установке
из git сам.

## Лицензия

MIT — см. [LICENSE](LICENSE).
