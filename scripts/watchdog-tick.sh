#!/usr/bin/env bash
# Ежедневный тик сторожа — дешёвая часть, без агента.
#
#   scripts/watchdog-tick.sh
#
# Это тело автоматизации «Сторож плагинов после обновления bb». Раньше она
# каждый день поднимала агентскую сессию, которая почти всегда отвечала
# «версия bb не менялась». Теперь по расписанию бежит только этот bash:
# он дёргает check-after-bb-upgrade.sh, и пока версия bb та же, выходит молча
# с кодом 0 — агент не запускается вовсе.
#
# Агентский тред спавнится только когда сторож заговорил: версия сменилась
# (есть отчёт) или что-то сломалось (ненулевой код). Инструкция для агента
# лежит в scripts/watchdog-agent-prompt.md, отчёт сторожа подклеивается к ней,
# чтобы агент видел ту же картину, что и тик.
set -uo pipefail

# Путь к репозиторию задан явно: автоматизация запускает не этот файл, а его
# снапшот в ~/.bb/plugins/automations/scripts/, и вычислять корень от
# BASH_SOURCE там бессмысленно. Правка этого файла доезжает до автоматизации
# только через bb automation update --script-file (см. заголовок).
repo="${WATCHDOG_REPO:-/home/coder/Work/3. projects/BB Plugins}"
prompt_file="$repo/scripts/watchdog-agent-prompt.md"

[ -d "$repo" ] || {
  printf 'сторож: нет каталога репозитория %s\n' "$repo" >&2
  exit 2
}

project="${WATCHDOG_PROJECT:-proj_58ezp634x9}"
provider="${WATCHDOG_PROVIDER:-claude-code}"
model="${WATCHDOG_MODEL:-claude-opus-5[1m]}"

report="$("$repo/scripts/check-after-bb-upgrade.sh" 2>&1)"
code=$?

# Тихий день: версия bb та же, сторож ничего не сказал.
if [ "$code" -eq 0 ] && [ -z "${report//[[:space:]]/}" ]; then
  exit 0
fi

printf '%s\n' "$report"
printf 'сторож: код возврата %s — поднимаю агента\n' "$code"

[ -r "$prompt_file" ] || {
  printf 'сторож: не читается %s — агента звать нечем\n' "$prompt_file" >&2
  exit 2
}

prompt="$(cat "$prompt_file")

---

ОТЧЁТ СТОРОЖА (код возврата $code), уже собранный автоматикой:

$report"

# WATCHDOG_DRY_RUN=1 — проверить ветку «версия сменилась», не поднимая агента.
if [ -n "${WATCHDOG_DRY_RUN:-}" ]; then
  printf 'сторож: dry-run, агент не запущен. Промпт %s символов\n' "${#prompt}"
  exit 0
fi

bb thread spawn \
  --project "$project" \
  --environment "$repo" \
  --provider "$provider" \
  --model "$model" \
  --permission-mode full \
  --title "Сторож плагинов: bb обновился" \
  --prompt "$prompt"
