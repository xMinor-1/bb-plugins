#!/bin/bash
# Keep a headless bb running on loopback inside the container.
set -u
mkdir -p "$HOME/projects"
while true; do
  NODE_ENV=production bb-app --server-bind-host 127.0.0.1 --server-port 38886 --host-daemon-port 38887
  echo "bb-app exited ($?), restarting in 3 s" >&2
  sleep 3
done
