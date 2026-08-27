#!/usr/bin/env bash
# Сторож плагинов, которые встраиваются в чужой интерфейс своим DOM.
#
#   scripts/check-after-bb-upgrade.sh
#
# usage-meter и server-status рисуют кольца внутри кнопки, которую рисует сам
# bb, и находят её по data-testid хоста. Обновление bb может переименовать или
# убрать этот якорь — тогда индикаторы молча пропадут: плагин останется
# running, ошибок в логах не будет, просто кольца больше не за что цеплять.
#
# Скрипт сравнивает версию запущенного bb с последней проверенной. Версия та
# же — выходит молча с кодом 0, чтобы его можно было дёргать хоть каждый день.
# Версия сменилась — проверяет три вещи и печатает отчёт:
#
#   1. якоря хоста ещё есть в собранном коде приложения;
#   2. оба плагина собираются;
#   3. оба стоят в статусе running, без degraded и без упавших сервисов.
#
# Ничего не чинит и не удаляет: только читает и собирает. Код возврата 1 —
# что-то сломано, 2 — сам скрипт не смог отработать (нет bb, нет файлов).
# Версию в .bb/last-checked-version скрипт тоже не пишет: её записывает тот,
# кто разобрал отчёт и убедился, что всё в порядке.
set -uo pipefail

repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
runtime="${BB_APP_RUNTIME_JSON:-$HOME/.bb/bb-app-runtime.json}"
state="$repo/.bb/last-checked-version"

# Плагины-подопечные. Для каждого из app.tsx достаётся своя пара id, из
# которой хост собирает data-testid кнопки в футере сайдбара.
plugins=(usage-meter server-status)

fail=0
note() { printf '%s\n' "$*"; }
ok()   { printf '  ок    %s\n' "$*"; }
bad()  { printf '  СБОЙ  %s\n' "$*"; fail=1; }

die() {
  printf 'сторож: %s\n' "$*" >&2
  exit 2
}

# --- версия bb --------------------------------------------------------------

[ -r "$runtime" ] || die "не читается $runtime — bb не запущен?"

version="$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$runtime" | head -n 1)"
[ -n "$version" ] || die "в $runtime нет поля version"

if [ -r "$state" ]; then
  checked="$(tr -d '[:space:]' < "$state")"
else
  # Файла нет — считаем, что версия сменилась: первый прогон обязан проверить.
  checked=""
fi

if [ -n "$checked" ] && [ "$checked" = "$version" ]; then
  exit 0
fi

# --- дальше только когда версия сменилась -----------------------------------

command -v bb >/dev/null 2>&1 || die "в PATH нет bb"
command -v node >/dev/null 2>&1 || die "в PATH нет node"

note "Проверка после смены версии bb"
note "  было:  ${checked:-<не проверялось ни разу>}"
note "  стало: $version"
note ""

# --- 1. якоря хоста в собранном коде приложения ------------------------------

# Каталог бандлов приложения берём от точки входа из bb-app-runtime.json:
# .../node_modules/.bin/bb-app -> .../node_modules/bb-app/app/dist/assets.
entry="$(sed -n 's/.*"entryPath"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$runtime" | head -n 1)"
assets=""
if [ -n "$entry" ]; then
  candidate="$(dirname -- "$(dirname -- "$entry")")/bb-app/app/dist/assets"
  [ -d "$candidate" ] && assets="$candidate"
fi
if [ -z "$assets" ] && [ -d /home/coder/opt/bb/node_modules/bb-app/app/dist/assets ]; then
  assets=/home/coder/opt/bb/node_modules/bb-app/app/dist/assets
fi
[ -n "$assets" ] || die "не нашёл каталог бандлов приложения (assets)"

note "Якоря хоста в $assets"

shopt -s nullglob
bundles=("$assets"/*.js)
shopt -u nullglob
if [ "${#bundles[@]}" -eq 0 ]; then
  bad "в каталоге нет ни одного *.js — проверять нечего"
else
  # 1a. Кнопка в футере сайдбара. Хост собирает testid шаблоном из pluginId и
  # id действия, поэтому в бандле лежит не готовая строка, а сам шаблон:
  # `plugin-sidebar-footer-action-${x.pluginId}-${x.id}`. Проверяем именно его
  # форму: уцелевший префикс с другим хвостом — это уже другой селектор.
  if grep -qE 'plugin-sidebar-footer-action-\$\{[A-Za-z0-9_$.]+\.pluginId\}-\$\{[A-Za-z0-9_$.]+\.id\}' "${bundles[@]}"; then
    ok 'plugin-sidebar-footer-action-<pluginId>-<actionId> — шаблон testid на месте'
  elif grep -qF 'plugin-sidebar-footer-action-' "${bundles[@]}"; then
    bad 'префикс plugin-sidebar-footer-action- есть, но testid собирается уже не из pluginId и id действия — селекторы плагинов надо переписать'
  else
    bad 'plugin-sidebar-footer-action-<pluginId>-<actionId> — якорь кнопки исчез из приложения'
  fi

  # 1b. Обёртка тултипов хоста: usage-meter по ней отодвигает свой попап,
  # чтобы тот не налезал на подсказку кнопки.
  if grep -qF 'data-radix-popper-content-wrapper' "${bundles[@]}"; then
    ok 'data-radix-popper-content-wrapper — обёртка тултипов хоста на месте (нужна usage-meter)'
  else
    bad 'data-radix-popper-content-wrapper — обёртки тултипов хоста больше нет: попап usage-meter будет налезать на подсказку'
  fi
fi
note ""

# --- 2. селекторы самих плагинов --------------------------------------------

# Константу плагин держит либо прямо в app.tsx, либо в общем модуле рядом
# (usage-meter с 0.2.3 берёт PLUGIN_ID из lib/limits.ts) — смотрим в оба места.
const_of() {
  local dir="$1" name="$2" value
  value="$(sed -n "s/^\(export \)\{0,1\}const $name = \"\([^\"]*\)\";.*/\2/p" "$dir/app.tsx" 2>/dev/null | head -n 1)"
  if [ -z "$value" ]; then
    value="$(grep -rhs --include='*.ts' --include='*.tsx' \
      --exclude-dir=node_modules --exclude-dir=dist -- "const $name = " "$dir" |
      sed -n "s/^\(export \)\{0,1\}const $name = \"\([^\"]*\)\";.*/\2/p" | head -n 1)"
  fi
  printf '%s' "$value"
}

note "Селекторы плагинов"
for name in "${plugins[@]}"; do
  src="$repo/plugins/$name/app.tsx"
  if [ ! -r "$src" ]; then
    bad "$name — нет $src"
    continue
  fi
  plugin_id="$(const_of "$repo/plugins/$name" PLUGIN_ID)"
  action_id="$(const_of "$repo/plugins/$name" ACTION_ID)"
  if [ -z "$plugin_id" ] || [ -z "$action_id" ]; then
    bad "$name — нигде в исходниках не нашлись PLUGIN_ID/ACTION_ID, якорь не вычислить"
    continue
  fi
  # Константы могут быть на месте, а сам селектор — переписан. Проверяем, что
  # app.tsx по-прежнему собирает testid хоста именно из этой пары.
  if ! grep -qF 'plugin-sidebar-footer-action-${PLUGIN_ID}-${ACTION_ID}' "$src"; then
    bad "$name — BUTTON_SELECTOR в app.tsx собран уже не из PLUGIN_ID и ACTION_ID"
    continue
  fi
  # Плагин обязан звать себя так же, как его зовёт bb: иначе testid, который
  # он ищет, никогда не совпадёт с тем, что рисует хост. Идентификатор bb
  # берёт из package.json name, отбрасывая скоуп и префикс bb-plugin-.
  manifest_id="$(node -e '
    const p = require(process.argv[1]);
    const raw = String(p.name ?? "");
    process.stdout.write(raw.replace(/^@[^/]+\//, "").replace(/^bb-plugin-/, ""));
  ' "$repo/plugins/$name/package.json" 2>/dev/null)"
  if [ "$manifest_id" != "$plugin_id" ]; then
    bad "$name — PLUGIN_ID=\"$plugin_id\", а bb зовёт плагин \"$manifest_id\" (package.json name)"
    continue
  fi
  ok "$name — ищет [data-testid=\"plugin-sidebar-footer-action-$plugin_id-$action_id\"]"
done
note ""

# --- 3. сборка ---------------------------------------------------------------

note "Сборка"
for name in "${plugins[@]}"; do
  dir="$repo/plugins/$name"
  if [ ! -d "$dir" ]; then
    bad "$name — нет каталога $dir"
    continue
  fi
  if out="$(cd "$dir" && bb plugin build . 2>&1)"; then
    ok "$name — собирается"
  else
    bad "$name — bb plugin build упал:"
    printf '%s\n' "$out" | sed 's/^/        /'
  fi
done
note ""

# --- 4. статус установленных плагинов ---------------------------------------

note "Статус в bb"
if listing="$(bb plugin list --json 2>&1)"; then
  report="$(printf '%s' "$listing" | node -e '
    const fs = require("fs");
    const want = process.argv.slice(1);
    let data;
    try {
      data = JSON.parse(fs.readFileSync(0, "utf8"));
    } catch {
      console.log("bad\tне разобрал JSON от bb plugin list --json");
      process.exit(0);
    }
    for (const name of want) {
      const p = (data.plugins ?? []).find((x) => x.id === name);
      if (!p) {
        console.log(`bad\t${name} — не установлен в bb`);
        continue;
      }
      const problems = [];
      if (p.enabled === false) problems.push("выключен");
      if (p.status !== "running") problems.push(`статус ${p.status}`);
      if (p.statusDetail) problems.push(String(p.statusDetail));
      for (const s of p.services ?? []) {
        if (s.state !== "running") problems.push(`сервис ${s.name}: ${s.state}`);
      }
      const errors = p.handlerStats?.errorCount ?? 0;
      if (problems.length > 0) {
        console.log(`bad\t${name} — ${problems.join(", ")}`);
      } else if (errors > 0) {
        console.log(`warn\t${name} — running, но ${errors} ошибок в обработчиках (см. bb plugin logs ${name})`);
      } else {
        console.log(`ok\t${name} — running, сервисы живы`);
      }
    }
  ' "${plugins[@]}")"
  if [ -z "$report" ]; then
    bad "не разобрал вывод bb plugin list --json"
  else
    while IFS=$'\t' read -r kind text; do
      [ -n "$kind" ] || continue
      case "$kind" in
        ok)   ok "$text" ;;
        warn) printf '  ?     %s\n' "$text" ;;
        *)    bad "$text" ;;
      esac
    done <<< "$report"
  fi
else
  bad "bb plugin list --json не отработал:"
  printf '%s\n' "$listing" | sed 's/^/        /'
fi
note ""

# --- итог --------------------------------------------------------------------

if [ "$fail" -ne 0 ]; then
  note "ИТОГ: bb $version что-то сломал. Чинить селекторы и код плагинов, потом"
  note "      пересобрать, переустановить и записать $version в"
  note "      .bb/last-checked-version."
  exit 1
fi

note "ИТОГ: bb $version ничего не сломал, оба плагина целы."
note "      Записать версию: printf '%s\\n' \"$version\" > \"$state\""
exit 0
