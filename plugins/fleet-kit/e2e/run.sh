#!/bin/bash
# Builds the throwaway bb image, starts it with hard resource limits, and
# prepares the fixture build inside (see inside-setup.sh). Never point these
# checks at your own bb: Fleet Kit installs and removes plugins on whatever bb
# it runs in.
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
name=${FLEET_KIT_E2E_CONTAINER:-fleet-kit-e2e}

docker build -t fleet-kit-e2e "$@" "$here"
docker rm -f "$name" >/dev/null 2>&1 || true
docker run -d --name "$name" \
  --memory 2g --memory-swap 2g --cpus 2 --pids-limit 2048 \
  --oom-score-adj 1000 --security-opt no-new-privileges \
  fleet-kit-e2e >/dev/null

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT
tar --exclude=fleet-kit/node_modules --exclude=fleet-kit/dist --exclude=fleet-kit/e2e \
  -czf "$tmp/fleet-kit-src.tgz" -C "$here/../.." fleet-kit
docker cp "$tmp/fleet-kit-src.tgz" "$name:/tmp/fleet-kit-src.tgz"
docker cp "$here/fake-gateway.mjs" "$name:/tmp/fake-gateway.mjs"
docker cp "$here/inside-setup.sh" "$name:/tmp/inside-setup.sh"

"$here/x.sh" 'for i in $(seq 1 60); do curl -sf -o /dev/null http://127.0.0.1:38886/ && exit 0; sleep 2; done; echo "bb did not start" >&2; exit 1'
"$here/x.sh" 'bash /tmp/inside-setup.sh'
echo "Ready. Run commands inside with: $here/x.sh '<command>'"
