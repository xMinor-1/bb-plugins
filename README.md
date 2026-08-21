# BB Plugins

Плагины для [bb](https://getbb.app) — по одному на директорию в `plugins/`.
Каждый ставится отдельно, скачивать весь репозиторий не нужно.

| Плагин | Что делает | Статус |
| --- | --- | --- |
| [theme-toggle](plugins/theme-toggle) | Кнопка темы в футере сайдбара: клик — следующая палитра, наведение с задержкой, удержание или правый клик — меню выбора палитры и режима светлая / тёмная / как в системе | В каталоге bb, релиз `theme-toggle/v0.2.1` |
| [server-status](plugins/server-status) | Состояние сервера в футере сайдбара: кольцо расхода оперативной памяти вокруг иконки (жёлтое с 80%, красное выше 90%), по клику — окно со сводкой: процессор, память, подкачка, диск, средняя нагрузка, время без перезагрузки, ОС и ядро | Релиз `server-status/v0.1.0`; заявка в каталог bb — [PR #89](https://github.com/get-bb/marketplace/pull/89) |
| [usage-meter](plugins/usage-meter) | Расход лимитов подписки Claude в футере сайдбара: два кольца вокруг иконки — внешнее пятичасовая сессия, внутреннее недельный лимит (жёлтое с 60%, красное выше 85%), лимит по модели с 60% зажигает точку в углу кнопки, по наведению или клику — попап со всеми окнами, временем сброса, планом и почтой аккаунта. Плюс страница «Usage»: та же сводка расхода, что у расширения Claude Code для VS Code (та же формула взвешенной стоимости, те же пороги и формулировки, сутки или неделя), а рядом то, чего в расширении нет, — прогоны workflow и фоновые раны /go, скиллы с весом инструкций, расход по проектам, моделям и тредам bb | Релиз `usage-meter/v0.2.1`; заявка в каталог bb — [PR #94](https://github.com/get-bb/marketplace/pull/94) |
| [file-manager](plugins/file-manager) | Файловый менеджер на весь экран, пункт «File Manager» в сайдбаре: дерево с раскрытием папок на месте, загрузка перетаскиванием кусками с докачкой после обрыва (проверено на 5 ГБ), скачивание потоком, перемещение, копирование, переименование, удаление, распаковка архивов; доступ ограничен домашней папкой пользователя, под которым работает bb | Релиз `file-manager/v0.3.0`; заявка в каталог bb — [PR #90](https://github.com/get-bb/marketplace/pull/90) |

## Установка

```sh
bb plugin install git:https://github.com/xMinor-1/bb-plugins.git@^0.2.0 --plugin theme-toggle --tag-prefix theme-toggle/
bb plugin install git:https://github.com/xMinor-1/bb-plugins.git@^0.3.0 --plugin file-manager --tag-prefix file-manager/
bb plugin install git:https://github.com/xMinor-1/bb-plugins.git@^0.1.0 --plugin server-status --tag-prefix server-status/
bb plugin install git:https://github.com/xMinor-1/bb-plugins.git@^0.2.0 --plugin usage-meter --tag-prefix usage-meter/
```

Каждая форма ставит последний релиз по тегу `<плагин>/vX.Y.Z` и видит
обновления через `bb plugin outdated`. Форма `@main` вместо диапазона берёт
текущее состояние ветки — так ставится то, что ещё не выпущено релизом.

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
