#!/usr/bin/env bash
# Создаёт новый плагин bb внутри этого репозитория и регистрирует его
# в .bb/plugins.json, чтобы он сразу ставился отдельной командой.
#
#   scripts/new-plugin.sh <имя> [--app] [--host]
#
# Флаги после имени передаются в `bb plugin new` как есть (--app добавляет
# фронтенд-точку входа, --host — хост-демон).
set -euo pipefail

name="${1:-}"
if [ -z "$name" ]; then
  echo "использование: scripts/new-plugin.sh <имя> [--app] [--host]" >&2
  exit 1
fi
shift

case "$name" in
  *[!a-z0-9-]* | -* | *- )
    echo "имя плагина: строчные латинские буквы, цифры и дефис (например tab-groups)" >&2
    exit 1 ;;
esac

root="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
target="$root/plugins/$name"

if [ -e "$target" ]; then
  echo "плагин уже есть: $target" >&2
  exit 1
fi

tmp="$(mktemp -d)"
trap 'rm -rf "$tmp"' EXIT
( cd "$tmp" && bb plugin new "$name" "$@" >/dev/null )
mv "$tmp/bb-plugin-$name" "$target"

python3 - "$root" "$name" <<'PY'
import json, sys, pathlib

root, name = sys.argv[1], sys.argv[2]
path = pathlib.Path(root, ".bb", "plugins.json")
manifest = json.loads(path.read_text(encoding="utf-8"))
entries = manifest.setdefault("plugins", [])
if not any(entry.get("name") == name for entry in entries):
    entries.append({"name": name, "source": f"./plugins/{name}"})
    entries.sort(key=lambda entry: entry["name"])
    path.write_text(
        json.dumps(manifest, indent=2, ensure_ascii=False) + "\n", encoding="utf-8"
    )
    print(f"зарегистрирован в .bb/plugins.json: {name}")
else:
    print(f"уже был в .bb/plugins.json: {name}")
PY

cat <<EOF

Создан: plugins/$name

Дальше:
  cd "$root/plugins/$name"
  npm install
  # заполнить bb.name / bb.description / bb.branding.icon в package.json
  bb plugin dev .          # сборка и перезагрузка на каждое сохранение

Поставить в bb из репозитория:
  bb plugin install path:"$root" --plugin $name --yes

Перед коммитом: строка про плагин в таблицу README.md и свой README.md рядом с кодом.
EOF
