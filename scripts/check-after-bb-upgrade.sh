#!/usr/bin/env bash
# Сторож плагинов bb: не сломало ли их обновление bb.
#
#   scripts/check-after-bb-upgrade.sh
#
# Проверяет все плагины репозитория (индекс .bb/plugins.json) и все наши
# плагины, которые стоят в bb, откуда бы они ни были поставлены: из этого
# каталога, из git или из рабочего дерева агента. Чужие плагины, поставленные
# не из bb, тоже попадают в отчёт о статусе, но только предупреждением: чинить
# их не нам. Встроенные плагины bb сторож не смотрит.
#
# Опаснее всего плагины, которые встраиваются в интерфейс bb своим DOM:
# usage-meter, server-status, theme-toggle и sticker-note находят кнопку в
# футере сайдбара по data-testid хоста, context-compact — кольцо контекста по
# aria-label, app-branding и fleet-kit — логотип и заголовок страницы.
# Обновление bb может переименовать или убрать такой якорь — и плагин сломается
# молча: останется running, ошибок в логах не будет.
#
# Скрипт сравнивает версию запущенного bb с последней проверенной. Версия та
# же — выходит молча с кодом 0, чтобы его можно было дёргать хоть каждый день.
# Версия сменилась — проверяет четыре вещи и печатает отчёт:
#
#   1. якоря хоста ещё есть в собранном коде приложения;
#   2. селекторы плагинов собраны из тех id, под которыми их знает bb;
#   3. каждый плагин собирается — из того каталога, откуда его запускает bb;
#   4. каждый установленный плагин running, без degraded и сервисов в backoff.
#
# Ничего не чинит и не удаляет: только читает и собирает. Плагины, которые bb
# запускает не из этого репозитория (кэш git, чужое рабочее дерево), собираются
# во временной копии — их каталоги сторож не трогает. Код возврата 1 — что-то
# сломано, 2 — сам скрипт не смог отработать (нет bb, нет файлов).
# Версию в .bb/last-checked-version скрипт тоже не пишет: её записывает тот,
# кто разобрал отчёт и убедился, что всё в порядке.
set -uo pipefail

repo="$(cd -- "$(dirname -- "${BASH_SOURCE[0]}")/.." && pwd)"
runtime="${BB_APP_RUNTIME_JSON:-$HOME/.bb/bb-app-runtime.json}"
state="$repo/.bb/last-checked-version"
index="$repo/.bb/plugins.json"

# Плагины, у которых селектор кнопки собирается в app.tsx из PLUGIN_ID и
# ACTION_ID: для них раздел 2 сверяет эту пару с тем, как плагин зовёт bb.
selector_plugins=(usage-meter server-status theme-toggle)

# Плагины, которые лезут в DOM хоста контент-скриптом и чьи якоря проверяет
# раздел 1. Новый такой плагин без строки здесь сторож покажет вопросом.
anchored_plugins=(usage-meter server-status theme-toggle sticker-note context-compact app-branding fleet-kit)

# Контент-скрипты, которым якоря хоста не нужны: bug-report-button 0.1
# кладёт свою кнопку прямо в document.body, model-usage только крутит таймер
# обновления. Если такой плагин начнёт искать узлы bb — перенести его в
# anchored_plugins и дописать его якоря в раздел 1.
unanchored_plugins=(bug-report-button model-usage)

fail=0
note() { printf '%s\n' "$*"; }
ok()   { printf '  ок    %s\n' "$*"; }
bad()  { printf '  СБОЙ  %s\n' "$*"; fail=1; }
warn() { printf '  ?     %s\n' "$*"; }
skip() { printf '  —     %s\n' "$*"; }

die() {
  printf 'сторож: %s\n' "$*" >&2
  exit 2
}

tmp=""
cleanup() { if [ -n "$tmp" ]; then rm -rf -- "$tmp"; fi; }
trap cleanup EXIT

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
[ -r "$index" ] || die "не читается индекс плагинов $index"

tmp="$(mktemp -d)" || die "не создал временный каталог"

listing="$tmp/plugin-list.json"
bb plugin list --json > "$listing" 2> "$tmp/plugin-list.err" \
  || die "bb plugin list --json не отработал: $(head -c 300 "$tmp/plugin-list.err")"

# Наш репозиторий на GitHub — по нему узнаём наши плагины, поставленные из git.
remote="$(git -C "$repo" remote get-url origin 2>/dev/null \
  | sed -E 's#^git@github\.com:#github.com/#; s#^https?://##; s#\.git$##')"

# Опись: что в индексе и что стоит в bb. Строка на плагин:
#   имя  чей  стоит  включён  каталог  откуда
# чей: ours — наш (в индексе, из нашего git или по пути), foreign — чужой.
# Встроенные плагины bb в опись не попадают.
inventory="$tmp/inventory.tsv"
node -e '
  const fs = require("fs");
  const [listFile, indexFile, remote] = process.argv.slice(1);
  let list;
  try {
    list = JSON.parse(fs.readFileSync(listFile, "utf8"));
  } catch {
    process.stderr.write("не разобрал JSON от bb plugin list --json\n");
    process.exit(3);
  }
  const indexed = (JSON.parse(fs.readFileSync(indexFile, "utf8")).plugins ?? []).map((p) => p.name);
  const installed = new Map();
  for (const p of list.plugins ?? []) {
    const source = String(p.source ?? "");
    if (source.startsWith("builtin:")) continue;
    installed.set(p.id, p);
  }
  const ours = (id, source) =>
    indexed.includes(id) || source.startsWith("path:") || (remote !== "" && source.includes(remote));
  const where = (p) => {
    const source = String(p.source ?? "");
    if (source.startsWith("git:")) {
      const ref = source.match(/\.git@(.+)$/);
      return ref ? `git ${ref[1]}` : "git";
    }
    if (source.startsWith("npm:")) return `npm ${source.slice(4)}`;
    return String(p.rootDir ?? "");
  };
  const row = (id, p) => {
    const source = String(p?.source ?? "");
    return [
      id,
      ours(id, source) ? "ours" : "foreign",
      p ? "1" : "0",
      p && p.enabled === false ? "0" : "1",
      p ? String(p.rootDir ?? "") : "",
      p ? where(p) : "",
    ].join("\t");
  };
  for (const id of indexed) console.log(row(id, installed.get(id)));
  for (const id of [...installed.keys()].sort()) {
    if (!indexed.includes(id)) console.log(row(id, installed.get(id)));
  }
' "$listing" "$index" "$remote" > "$inventory" || die "не собрал опись плагинов"

declare -A kind_of installed_of enabled_of root_of where_of
names=()
while IFS=$'\t' read -r name kind inst enabled root where; do
  [ -n "$name" ] || continue
  names+=("$name")
  kind_of[$name]="$kind"
  installed_of[$name]="$inst"
  enabled_of[$name]="$enabled"
  root_of[$name]="$root"
  where_of[$name]="$where"
done < "$inventory"

# Каталог исходников плагина: откуда его запускает bb, а если он не стоит —
# копия в репозитории.
src_of() {
  local name="$1"
  if [ -n "${root_of[$name]}" ]; then
    printf '%s' "${root_of[$name]}"
  else
    printf '%s' "$repo/plugins/$name"
  fi
}

note "Проверка после смены версии bb"
note "  было:  ${checked:-<не проверялось ни разу>}"
note "  стало: $version"
note ""

# --- 1. якоря хоста в собранном коде приложения ------------------------------

# Каталог бандлов приложения берём от точки входа из bb-app-runtime.json.
# Точка входа бывает двух видов:
#   npm-установка:     .../node_modules/.bin/bb-app
#   обновление из bb:  ~/.bb/app-versions/<версия>/node_modules/bb-app/dist/bb-app.js
# В обоих случаях бандлы лежат в .../node_modules/bb-app/app/dist/assets.
entry="$(sed -n 's/.*"entryPath"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' "$runtime" | head -n 1)"
assets=""
if [ -n "$entry" ]; then
  up2="$(dirname -- "$(dirname -- "$entry")")"
  for candidate in "$up2/bb-app/app/dist/assets" "$up2/app/dist/assets"; do
    if [ -d "$candidate" ]; then
      assets="$candidate"
      break
    fi
  done
fi
# Запасной путь — npm-установка в ~/opt/bb, но только той же версии, что
# запущена: после обновления из bb там остаётся старый бандл, и проверка по
# нему ничего не говорит о работающем приложении.
fallback=/home/coder/opt/bb/node_modules/bb-app
if [ -z "$assets" ] && [ -d "$fallback/app/dist/assets" ] \
  && grep -qF "\"version\": \"$version\"" "$fallback/package.json" 2>/dev/null; then
  assets="$fallback/app/dist/assets"
fi
[ -n "$assets" ] || die "не нашёл каталог бандлов запущенного bb $version (assets)"

note "Якоря хоста в $assets"

shopt -s nullglob
bundles=("$assets"/*.js)
logos=("$assets"/bb-logo-*)
shopt -u nullglob
page="$(dirname -- "$assets")/index.html"

# anchor <F|E> <шаблон> <ок-текст> <сбой-текст> — один якорь в бандлах.
anchor() {
  if grep -q"$1" -- "$2" "${bundles[@]}"; then ok "$3"; else bad "$4"; fi
}

if [ "${#bundles[@]}" -eq 0 ]; then
  bad "в каталоге нет ни одного *.js — проверять нечего"
else
  # 1a. Кнопка в футере сайдбара. Хост собирает testid шаблоном из pluginId и
  # id действия, поэтому в бандле лежит не готовая строка, а сам шаблон:
  # `plugin-sidebar-footer-action-${x.pluginId}-${x.id}`. Проверяем именно его
  # форму: уцелевший префикс с другим хвостом — это уже другой селектор.
  if grep -qE 'plugin-sidebar-footer-action-\$\{[A-Za-z0-9_$.]+\.pluginId\}-\$\{[A-Za-z0-9_$.]+\.id\}' "${bundles[@]}"; then
    ok 'plugin-sidebar-footer-action-<pluginId>-<actionId> — шаблон testid на месте (usage-meter, server-status, theme-toggle, sticker-note)'
  elif grep -qF 'plugin-sidebar-footer-action-' "${bundles[@]}"; then
    bad 'префикс plugin-sidebar-footer-action- есть, но testid собирается уже не из pluginId и id действия — селекторы плагинов надо переписать'
  else
    bad 'plugin-sidebar-footer-action-<pluginId>-<actionId> — якорь кнопки исчез из приложения'
  fi

  # 1b. Тот же футер, вид «пункт» вместо «действия»: sticker-note ищет кнопку
  # по обоим testid, потому что bb рисует слот то так, то так.
  anchor E 'plugin-sidebar-footer-item-\$\{[A-Za-z0-9_$.]+\.pluginId\}-\$\{[A-Za-z0-9_$.]+\.id\}' \
    'plugin-sidebar-footer-item-<pluginId>-<id> — шаблон testid пункта футера на месте (sticker-note)' \
    'plugin-sidebar-footer-item-<pluginId>-<id> — шаблона testid пункта футера больше нет: sticker-note может потерять счётчик на кнопке'

  # 1c. Обёртка тултипов хоста: usage-meter по ней отодвигает свой попап,
  # чтобы тот не налезал на подсказку кнопки.
  anchor F 'data-radix-popper-content-wrapper' \
    'data-radix-popper-content-wrapper — обёртка тултипов хоста на месте (usage-meter)' \
    'data-radix-popper-content-wrapper — обёртки тултипов хоста больше нет: попап usage-meter будет налезать на подсказку'

  # 1d. Значок плагина маской: theme-toggle находит в своей кнопке этот span и
  # перекрашивает его в квадрат «день/ночь». Есть он, только пока bb рисует
  # кнопку из branding.icon, поэтому имя иконки в регистрации — вне словаря bb
  # (с 0.46 встроенное имя побеждает брендинг, и тогда span не появляется).
  anchor F 'data-plugin-icon-asset' \
    'data-plugin-icon-asset — значок плагина маской на месте (theme-toggle)' \
    'data-plugin-icon-asset — bb больше не рисует значок плагина маской: theme-toggle останется с запасной иконкой'

  # 1e. Кольцо контекста: context-compact ищет его как
  # button[aria-label^="Context window"] и вешает на него свою карточку.
  anchor F 'Context window ${' \
    'кольцо контекста с подписью «Context window …» на месте (context-compact)' \
    'подпись кольца контекста «Context window …» пропала: context-compact не найдёт кольцо, карточка сжатия не появится'

  # 1f. Панель треда: по ней context-compact узнаёт, к какому треду относится
  # кольцо, когда окно разделено на несколько тредов.
  anchor F 'data-thread-window' \
    'data-thread-window — панель треда на месте (context-compact)' \
    'data-thread-window — атрибута панели треда больше нет: context-compact в разделённом окне сожмёт не тот тред'
fi

# 1g. Логотип и заголовок страницы: app-branding и fleet-kit подменяют
# картинку img[src*="/assets/bb-logo-"], заголовок «bb» и значки вкладки.
if [ "${#logos[@]}" -gt 0 ]; then
  ok 'assets/bb-logo-* — логотип bb на месте (app-branding, fleet-kit)'
else
  bad 'assets/bb-logo-* — файла логотипа bb больше нет: app-branding и fleet-kit не подменят логотип'
fi
if grep -qF '<title>bb</title>' "$page" 2>/dev/null && grep -qE 'rel="(icon|apple-touch-icon)"' "$page" 2>/dev/null; then
  ok 'index.html — заголовок «bb» и значки вкладки на месте (app-branding, fleet-kit)'
else
  bad "index.html — нет заголовка «bb» или значков вкладки в $page: app-branding и fleet-kit не переименуют вкладку"
fi

# 1h. Контент-скрипт без описанных якорей: плагин лезет в DOM хоста, а
# сторож не знает, за что он держится, — значит, и поломку не заметит.
for name in "${names[@]}"; do
  [ "${kind_of[$name]}" = ours ] || continue
  dir="$(src_of "$name")"
  [ -d "$dir" ] || continue
  if grep -rqs --include='*.ts' --include='*.tsx' --exclude-dir=node_modules \
    --exclude-dir=dist --exclude-dir=test -- 'contentScripts.register' "$dir"; then
    case " ${anchored_plugins[*]} ${unanchored_plugins[*]} " in
      *" $name "*) ;;
      *) warn "$name — контент-скрипт лезет в DOM хоста, а его якорей сторож не знает: дописать их в раздел 1 и в anchored_plugins" ;;
    esac
  fi
done

# Каталог в plugins/ без строки в индексе: bb plugin install --plugin его не
# найдёт, и сторож о нём бы не узнал.
for dir in "$repo"/plugins/*/; do
  name="$(basename -- "$dir")"
  [ -n "${kind_of[$name]+x}" ] || warn "plugins/$name — нет в .bb/plugins.json, сторож его не проверяет"
done
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
for name in "${selector_plugins[@]}"; do
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

# build_in <имя> <каталог сборки> <каталог плагина> <пометка>
build_in() {
  local name="$1" dir="$2" home="$3" label="$4" out
  if out="$(cd "$dir" && bb plugin build . 2>&1)"; then
    ok "$name — собирается$label"
  else
    bad "$name — bb plugin build упал$label:"
    # esbuild печатает каждую ошибку с рамкой кода; хватает итоговых строк.
    if grep -q 'ERROR:' <<< "$out"; then
      grep 'ERROR:' <<< "$out" | head -n 10 | sed 's/^/        /'
    else
      printf '%s\n' "$out" | tail -n 10 | sed 's/^/        /'
    fi
    if grep -q 'Could not resolve' <<< "$out"; then
      note "        похоже, не поставлены зависимости: npm install в $home"
    fi
  fi
}

note "Сборка"
for name in "${names[@]}"; do
  [ "${kind_of[$name]}" = ours ] || continue
  if [ "${installed_of[$name]}" = 1 ] && [ "${enabled_of[$name]}" = 0 ]; then
    skip "$name — выключен в bb, не собираю"
    continue
  fi
  dir="$(src_of "$name")"
  if [ ! -d "$dir" ]; then
    bad "$name — нет каталога $dir"
    continue
  fi
  if [ "${installed_of[$name]}" = 0 ] && [ ! -d "$dir/node_modules" ]; then
    skip "$name — не стоит в bb и без node_modules, собирать нечем"
    continue
  fi
  if [ "$dir" = "$repo/plugins/$name" ]; then
    build_in "$name" "$dir" "$dir" ""
    continue
  fi
  # Чужой каталог — кэш git bb или рабочее дерево агента: собираем копию
  # исходников, а зависимости берём ссылкой на его же node_modules.
  copy="$tmp/build/$name"
  mkdir -p "$copy"
  if ! tar -C "$dir" --exclude=./node_modules --exclude=./dist -cf - . | tar -C "$copy" -xf -; then
    bad "$name — не скопировал исходники из $dir"
    continue
  fi
  [ -d "$dir/node_modules" ] && ln -s "$dir/node_modules" "$copy/node_modules"
  build_in "$name" "$copy" "$dir" " (копия установленной, ${where_of[$name]})"
done
note ""

# --- 4. статус установленных плагинов ---------------------------------------

note "Статус в bb"
report="$(node -e '
  const fs = require("fs");
  const [listFile, inventoryFile, repo] = process.argv.slice(1);
  const list = JSON.parse(fs.readFileSync(listFile, "utf8"));
  const byId = new Map((list.plugins ?? []).map((p) => [p.id, p]));
  for (const line of fs.readFileSync(inventoryFile, "utf8").split("\n")) {
    if (!line) continue;
    const [name, kind, installed, , root, where] = line.split("\t");
    const foreign = kind === "foreign";
    // Откуда стоит — пишем, только если не из этого репозитория.
    const tag = foreign ? `чужой, ${where}` : root === `${repo}/plugins/${name}` ? "" : where;
    const suffix = tag ? ` (${tag})` : "";
    if (installed !== "1") {
      console.log(`skip\t${name} — не стоит в bb`);
      continue;
    }
    const p = byId.get(name);
    if (p.enabled === false) {
      console.log(`skip\t${name} — выключен в bb, не проверяю${suffix}`);
      continue;
    }
    const problems = [];
    if (p.status !== "running") problems.push(`статус ${p.status}`);
    if (p.statusDetail) problems.push(String(p.statusDetail).split("\n").join("; "));
    // Сервис бывает running, stopped или backoff. stopped — норма для разового
    // сервиса, который сделал своё и вышел (configure у voice-ink); упал и
    // перезапускается — это backoff.
    for (const s of p.services ?? []) {
      if (s.state !== "running" && s.state !== "stopped") problems.push(`сервис ${s.name}: ${s.state}`);
    }
    const errors = p.handlerStats?.errorCount ?? 0;
    if (problems.length > 0) {
      console.log(`${foreign ? "warn" : "bad"}\t${name} — ${problems.join(", ")}${suffix}`);
    } else if (errors > 0) {
      console.log(`warn\t${name} — running, но ошибок в обработчиках: ${errors} (bb plugin logs ${name})${suffix}`);
    } else {
      console.log(`ok\t${name} — running, сервисы живы${suffix}`);
    }
  }
' "$listing" "$inventory" "$repo")"
if [ -z "$report" ]; then
  bad "не разобрал вывод bb plugin list --json"
else
  while IFS=$'\t' read -r kind text; do
    [ -n "$kind" ] || continue
    case "$kind" in
      ok)   ok "$text" ;;
      warn) warn "$text" ;;
      skip) skip "$text" ;;
      *)    bad "$text" ;;
    esac
  done <<< "$report"
fi
note ""

# --- итог --------------------------------------------------------------------

if [ "$fail" -ne 0 ]; then
  note "ИТОГ: bb $version — есть сбои (строки «СБОЙ» выше). Починить, пересобрать,"
  note "      переустановить и только потом записать $version в"
  note "      .bb/last-checked-version."
  exit 1
fi

note "ИТОГ: bb $version ничего не сломал, все наши плагины целы."
note "      Записать версию: printf '%s\\n' \"$version\" > \"$state\""
exit 0
