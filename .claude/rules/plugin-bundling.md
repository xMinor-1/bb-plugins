---
paths:
  - "plugins/**"
---

# Сборка плагина: зелёный `bb plugin build` ещё не значит, что бандл загрузится

- Зависимость с UMD-входом (`main` → `lib/umd/...`, внутри `require("./impl/...")`)
  esbuild не разворачивает: сборка проходит, а при загрузке плагин падает с
  `Cannot find module './impl/...'`. Так было с `jsonc-parser` в fleet-kit (31.10.2026).
  Импортировать ESM-вход пакета напрямую: `jsonc-parser/lib/esm/main.js`.
- После `bb plugin build` проверять, что бандл грузится:
  `node -e "import('./dist/server.js').then(m => console.log(typeof m.default))"` → `function`.
- Установку из git проверять на отдельном bb (docker), не на рабочем: только там видно,
  что bb собирает плагин сам и с `npm install --omit=dev`.
