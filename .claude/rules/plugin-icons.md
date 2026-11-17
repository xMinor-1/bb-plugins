---
paths:
  - "plugins/**"
---

# Иконки плагина: только имена из набора bb

- `Icon name`, `icon` в `navPanel` и `bb.branding.icon` принимают имена из набора bb,
  а не из lucide. Неизвестное имя не даёт ошибки: bb молча рисует запасную молнию.
  Так в fleet-kit 31.10.2026 почти все иконки панели стали одинаковыми
  (`PackageCheck`, `KeyRound`, `ShieldCheck`, `ListChecks`, `RefreshCw`, `Loader2`).
- Список имён — `ICON_NAMES` в бандле приложения bb: базовые `Object.keys(Is)` и
  расширенные — строка через точку `var ys=`…`` в `bb-app/app/dist/assets/index-*.js`.
  На bb 0.48 есть, например: `Lock`, `SecurityCheck`, `PackageReceive`,
  `ArrowReloadHorizontal`, `Loading`, `ListTodo`, `AlertTriangle`, `CircleX`, `Bot`.
- Своя картинка — `./icon.svg` в `bb.branding.icon`.
- Просят иконку по имени — сначала сверить со списком. `ChartPie` в bb 0.48 нет (есть только
  `ChartColumn`): для qlik-sense 0.1.1 круговая диаграмма нарисована своей `./icon.svg` и компонентом.
- Проверять глазами на снимке панели: тест и сборка неверное имя не ловят.
- Цветной значок (градиенты, несколько цветов) `bb.branding.icon` не даст: это маска
  `currentColor`. Для навигации и кнопки в футере — React-компонент через
  `app.experimental_icons.register({ name, component })` и это имя в `navPanel.icon`
  и `experimental_sidebarFooter.register({ icon })`. id градиентов — через `useId()`,
  иначе два экземпляра значка делят одни `<defs>` (sticker-note 0.1.0, 31.10.2026).

## Данные значков Hugeicons — копией в плагине

- `@hugeicons/core-free-icons` в `dependencies` не держать: bb ставит плагин из git через
  `npm install --omit=dev` и распаковывает весь пакет (16–24 тыс. файлов) ради сотни значков.
  Значки — в `components/ui/hugeicons.ts`, их пишет `scripts/vendor-hugeicons.mjs`
  (порядок — в шапке файла). doc-review 0.8.2, voice-ink 0.11.1, file-manager 0.11.1
  (17.11.2026): установка с 26,9/25,2/17,4 тыс. файлов до 2,6/1,1/1,1 тыс.
- `npx shadcn add @bb/icon` вернёт импорт из пакета и перезапишет `icon.tsx`: после него —
  снова генератор. Тест `hugeicons.test.ts` плагина падает на импорте пакета.
- Версию пакета брать из lock-файла плагина: между 4.2.3 и 4.3.x пять значков
  нарисованы иначе (`Copy01Icon`, `Idea01Icon`, `Mic02Icon`, `UserIcon`, `UserAdd01Icon`).
