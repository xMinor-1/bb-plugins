#!/bin/bash
# Builds the throwaway bb image, starts it with hard resource limits and
# prepares it (see inside-setup.sh): OpenCode on the fake gateway, a project,
# the plugin installed from this working copy. Never point these checks at
# your own bb: the plugin stops and re-sends turns on the bb it runs in.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
name=${MODEL_FALLBACK_E2E_CONTAINER:-model-fallback-e2e}

docker build -t model-fallback-e2e "$@" "$here"
docker rm -f "$name" >/dev/null 2>&1 || true
docker run -d --name "$name" \
  --memory 2g --memory-swap 2g --cpus 2 --pids-limit 2048 \
  --oom-score-adj 1000 --security-opt no-new-privileges \
  -p 127.0.0.1::38886 \
  model-fallback-e2e >/dev/null

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
tar --exclude=model-fallback/node_modules --exclude=model-fallback/dist --exclude=model-fallback/e2e \
  -czf "$tmp/src.tgz" -C "$here/../.." model-fallback
docker cp "$tmp/src.tgz" "$name:/tmp/src.tgz"
for file in fake-models.mjs inside-setup.sh scenario.sh; do docker cp "$here/$file" "$name:/tmp/$file"; done

"$here/x.sh" 'for i in $(seq 1 90); do curl -sf -o /dev/null http://127.0.0.1:38886/ && exit 0; sleep 2; done; echo "bb did not start" >&2; exit 1'
"$here/x.sh" 'bash /tmp/inside-setup.sh'
echo "Ready. Run the checks with: $here/x.sh 'bash /tmp/scenario.sh'"
echo "bb in a browser: http://$(docker port "$name" 38886)"
