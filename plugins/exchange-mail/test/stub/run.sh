#!/usr/bin/env bash
# Starts the EWS stub in docker on a free local port and prints its URL.
#   EWS_STUB_URL=$(test/stub/run.sh) npm run test:e2e; docker rm -f ews-stub-$USER
set -euo pipefail
here="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
name="ews-stub-${USER:-test}"
docker rm -f "$name" >/dev/null 2>&1 || true
docker run -d --rm --name "$name" --memory 256m --oom-score-adj=1000 -p 127.0.0.1::8080 -v "$here:/stub:ro" python:3.12-slim python3 -I /stub/ews_stub.py >/dev/null
for _ in $(seq 1 50); do
  port="$(docker port "$name" 8080 2>/dev/null | head -1 | sed 's/.*://')"
  if [ -n "$port" ] && curl -s -o /dev/null "http://127.0.0.1:$port/__state"; then
    echo "http://127.0.0.1:$port"
    exit 0
  fi
  sleep 0.2
done
echo "the stub did not start" >&2
docker logs "$name" >&2 || true
exit 1
