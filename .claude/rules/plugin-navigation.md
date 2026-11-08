---
paths:
  - "plugins/**"
---

# Переход на страницу другого плагина

- `useBbNavigate().toPluginPanel` ведёт только на панели своего плагина, `openUrl`
  открывает браузер. Страницу чужого плагина (`/plugins/<id>/<панель>`) внутри bb
  открывать так, как это делают ссылки самого bb (react-router):
  `history.pushState({ usr: null, key, idx: prev.idx + 1 }, "", path)` и затем
  `dispatchEvent(new PopStateEvent("popstate"))`. Готовая функция — `openBbPage` в
  `plugins/fleet-kit/src/app/setup-page.tsx`, проверена в docker на bb 0.48.1:
  открывает страницу почты, «Назад» возвращает (fleet-kit 0.3.0, 31.10.2026).
- Путь, который пришёл от другого плагина, проверять регуляркой
  `^/plugins/[a-z0-9][a-z0-9-]*(/[A-Za-z0-9._~-]+)*$`: никаких внешних адресов и `..`.
