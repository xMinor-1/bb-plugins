# BB Plugins

Плагины для [bb](https://getbb.app) — по одному на директорию в `plugins/`.
Каждый ставится отдельно, скачивать весь репозиторий не нужно.

| Плагин | Что делает | Статус |
| --- | --- | --- |
| [theme-toggle](plugins/theme-toggle) | Кнопка темы в футере сайдбара: клик — следующая палитра, удержание или правый клик — меню выбора палитры и режима светлая / тёмная / как в системе | Работает |
| [file-manager](plugins/file-manager) | Панель для файлов на сервере bb: дерево, загрузка и скачивание больших файлов потоком | Спецификация готова, реализация не начата |

## Установка

```sh
bb plugin install git:https://github.com/xMinor-1/bb-plugins.git@main --plugin theme-toggle
bb plugin install git:https://github.com/xMinor-1/bb-plugins.git@main --plugin file-manager
```

`--plugin <имя>` берёт запись из `.bb/plugins.json`. Равнозначная форма — через путь:
`--subdirectory plugins/theme-toggle`.

Локально, из клона репозитория:

```sh
bb plugin install path:. --plugin theme-toggle
```

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
