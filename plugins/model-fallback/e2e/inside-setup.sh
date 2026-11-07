#!/bin/bash
# Inside the container: OpenCode talks to the fake gateway, a git project for
# threads, and the plugin installed from the copied working tree.
set -euo pipefail
cd "$HOME"

mkdir -p .config/opencode
cat > .config/opencode/opencode.json <<'JSON'
{
  "providers": {
    "corp": {
      "name": "Corp (fake)",
      "package": "@opencode/ai/providers/openai-compatible",
      "settings": { "baseURL": "http://127.0.0.1:4010/v1", "apiKey": "fake" },
      "models": { "ok": { "name": "Ok" }, "limited": { "name": "Limited" }, "slow": { "name": "Slow" } }
    }
  },
  "enabled_providers": ["corp"],
  "model": "corp/slow",
  "update": "disable"
}
JSON

mkdir -p projects/demo && cd projects/demo
if [ ! -d .git ]; then
  git init -q && git config user.email e2e@example.com && git config user.name e2e
  echo "# demo" > README.md && git add README.md && git commit -qm init
fi
cd "$HOME"
bb project list --json | jq -e '.[] | select(.name == "demo")' >/dev/null 2>&1 \
  || bb project create --name demo --root "$HOME/projects/demo" >/dev/null

rm -rf model-fallback && tar -xzf /tmp/src.tgz
(cd model-fallback && npm install --omit=dev --no-fund --no-audit >/dev/null)
bb plugin install path:"$HOME/model-fallback" --yes >/dev/null
bb plugin config model-fallback set allowedModels "acp-opencode corp/*" >/dev/null
bb plugin config model-fallback set graceSeconds 5 >/dev/null
bb plugin config model-fallback set silenceMinutes 0.25 >/dev/null
bb plugin list 2>&1 | grep -i fallback || true
echo "setup done"
