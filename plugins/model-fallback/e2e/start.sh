#!/bin/bash
# Keep a headless bb and the fake model gateway running on loopback inside the container.
set -u
mkdir -p "$HOME/projects" "$HOME/logs"
(while true; do node /tmp/fake-models.mjs 4010 >> "$HOME/logs/gateway.log" 2>&1; sleep 1; done) &
while true; do
  NODE_ENV=production bb-app --server-bind-host 0.0.0.0 --server-port 38886 --host-daemon-port 38887
  echo "bb-app exited ($?), restarting in 3 s" >&2
  sleep 3
done
