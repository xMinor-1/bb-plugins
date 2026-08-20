# scripts

Служебные скрипты репозитория.

| Скрипт | Что делает |
| --- | --- |
| `new-plugin.sh` | Создаёт новый плагин и регистрирует его в `.bb/plugins.json`. |
| `check-after-bb-upgrade.sh` | Сторож: проверяет, не сломало ли обновление bb плагины `usage-meter` и `server-status`. |

## Сторож `check-after-bb-upgrade.sh`

### Зачем

`usage-meter` и `server-status` рисуют свои индикаторы не в собственной панели, а
прямо в интерфейсе bb: контент-скрипт находит кнопку, которую рисует сам хост, и
кладёт внутрь неё своё кольцо. Держится это на якорях хоста:

| Якорь | Кто использует | Зачем |
| --- | --- | --- |
| `[data-testid="plugin-sidebar-footer-action-usage-meter-usage"]` | `usage-meter` | кнопка в футере сайдбара, в неё встают кольца |
| `[data-testid="plugin-sidebar-footer-action-server-status-status"]` | `server-status` | то же самое для кольца памяти |
| `[data-radix-popper-content-wrapper]` | `usage-meter` | обёртка тултипов хоста: попап отодвигается, чтобы не налезть на подсказку |

Первые два хост собирает шаблоном из id плагина и id действия, поэтому в
собранном коде приложения лежит не готовая строка, а сам шаблон — сторож
проверяет именно его форму.

Опасность в том, что поломка тихая. Если крупное обновление bb переименует или
уберёт якорь, плагины останутся `running`, в логах будет пусто, а кольца просто
исчезнут из интерфейса — и заметить это можно только глазами.

Якоря `[data-testid="app-layout-root"]` в этих двух плагинах нет: попапы живут в
`document.body`, а не внутри корня разметки, поэтому сторож его и не проверяет.

### Что проверяет

Сравнивает версию запущенного bb (`~/.bb/bb-app-runtime.json`, поле `version`) с
последней проверенной (`.bb/last-checked-version`).

- Версия та же — молча выходит с кодом `0`. Гонять можно хоть ежедневно.
- Файла с версией нет — считает, что версия сменилась, и проверяет.
- Версия сменилась — печатает отчёт по-русски и проверяет четыре вещи:
  1. якоря хоста ещё есть в собранном коде приложения (грепом по
     `<bb>/node_modules/bb-app/app/dist/assets/*.js`, путь берётся из
     `entryPath` того же `bb-app-runtime.json`);
  2. `PLUGIN_ID`/`ACTION_ID` в `app.tsx` совпадают с тем, как bb зовёт плагин
     (`package.json` → `name` без префикса `bb-plugin-`);
  3. оба плагина собираются (`bb plugin build`);
  4. оба стоят в `running`, без `degraded` и без упавших сервисов
     (`bb plugin list --json`).

Коды возврата: `0` — всё цело, `1` — что-то сломано, `2` — сторож не смог
отработать (не запущен bb, нет `node`, не нашёлся каталог бандлов).

Сторож только читает и собирает: ничего не удаляет, не переустанавливает, не
коммитит и не пишет `.bb/last-checked-version` — версию записывает тот, кто
разобрал отчёт.

### Запуск руками

```sh
cd "/home/coder/Work/3. projects/BB Plugins"
./scripts/check-after-bb-upgrade.sh; echo "код: $?"
```

Посмотреть полный отчёт на неизменившейся версии — подсунуть свой файл рантайма:

```sh
sed 's/"0.39.0"/"0.99.0"/' ~/.bb/bb-app-runtime.json > /tmp/rt.json
BB_APP_RUNTIME_JSON=/tmp/rt.json ./scripts/check-after-bb-upgrade.sh
```

Зафиксировать текущую версию как проверенную:

```sh
printf '%s\n' "$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' ~/.bb/bb-app-runtime.json)" \
  > .bb/last-checked-version
```

## Автоматизация: ежедневный сторож

Сторожа дёргает автоматизация bb — агент, который не просто зовёт скрипт, а сам
чинит плагины, если тот ругнулся.

```text
Проект:      proj_58ezp634x9 (BB Plugins)
Автоматизация: auto_jbumkothkqy — «Сторож плагинов после обновления bb»
Расписание:  15 9 * * * (Europe/Sofia), раз в сутки
Агент:       claude-code / claude-opus-5[1m], доступ full
Каталог:     /home/coder/Work/3. projects/BB Plugins
```

Что делает агент:

- версия bb не менялась — скрипт молчит, агент сразу заканчивает: ничего не
  собирает, не переустанавливает, не коммитит;
- версия сменилась, всё цело — записывает новую версию в
  `.bb/last-checked-version` и коммитит один этот файл с пушем, чтобы завтра
  проверка снова была бесплатной;
- версия сменилась, что-то отвалилось — ищет новый вид якоря в собранном коде
  приложения, правит `BUTTON_SELECTOR`/`HOST_TOOLTIP` в обоих плагинах,
  прогоняет `npx tsc --noEmit` и `bb plugin build`, переустанавливает
  (`bb plugin install path:… --plugin <имя> --yes`), проверяет `bb plugin list`
  и `bb plugin logs`, при необходимости обновляет самого сторожа, записывает
  версию и коммитит с пушем только свои файлы;
- починить не вышло — не коммитит ничего и пишет, что сломалось.

### Управление

```sh
P=proj_58ezp634x9
A=auto_jbumkothkqy

bb automation show   $A --project $P          # настройки, промпт, следующий запуск
bb automation run    $A --project $P          # прогнать прямо сейчас
bb automation runs   $A --project $P --limit 5             # история запусков
bb automation runs   $A --project $P --limit 1 --output <runId>   # что ответил агент
bb automation pause  $A --project $P          # приостановить
bb automation resume $A --project $P          # снова включить
bb automation update $A --project $P --cron "0 8 * * *" --timezone Europe/Sofia
```

Автоматизация живёт в проекте `BB Plugins` (`proj_58ezp634x9`), а не в
`proj_personal`: `bb automation create` этот id не принимает — `Project not
found`.
