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
