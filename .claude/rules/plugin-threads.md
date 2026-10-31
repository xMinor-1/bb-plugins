---
paths:
  - "plugins/**"
---

# Плагин запускает треды агентов

- `threads.spawn` с `environment: { type: "project-default" }` в проекте, где по
  умолчанию git worktree, делает полную копию репозитория на каждый тред. У
  sticker-note поручение со стикера в проекте Work дало копию всего ~/Work
  (31.10.2026). Треду без кода — личный проект bb (`projects.list({ includePersonal:
  true })`, `kind: "personal"`) и `{ type: "host", workspace: { type: "personal" } }`.
  Личное рабочее место bb разрешает только в личном проекте (иначе HTTP 400).
- `bb thread delete` не убирает окружение треда: worktree остаётся на диске до
  автоматического «retiring» (около часа) и ветка `bb/…` — в репозитории проекта.
  После тестовых тредов: `bb environment delete <env>` (без `--yes`), затем
  `git branch -D` ветки, если в ней нет своих коммитов (`git rev-list --count HEAD..<ветка>`).
- Плагинные инструменты агентов работают, только если их выбрать в
  `bb.agents.configure(() => ({ tools: [...], skills: [...] }))`; одной
  регистрации `registerTool` мало.
