#!/bin/bash
# Keep a headless bb running on loopback inside the container.
set -u
mkdir -p "$HOME/projects"
# A virtual display: Fleet Kit's confirmation window (zenity) opens there, and e2e/own-agents.sh presses its buttons.
if command -v Xvfb >/dev/null; then
  Xvfb :99 -screen 0 1280x800x24 -nolisten tcp >/tmp/xvfb.log 2>&1 &
  export DISPLAY=:99
fi
while true; do
  NODE_ENV=production bb-app --server-bind-host 127.0.0.1 --server-port 38886 --host-daemon-port 38887
  echo "bb-app exited ($?), restarting in 3 s" >&2
  sleep 3
done
