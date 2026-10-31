#!/usr/bin/env bash
# Starts a local Qlik Core engine for the end-to-end tests and prints its address.
# The 2021 image's licence has expired, so the engine runs with a faked date
# (libfaketime from Debian buster, glibc 2.28 like the image).
set -euo pipefail
NAME=bb-qlik-sense-test-engine
LIB_DIR="$HOME/.cache/bb-qlik-sense-test"
LIB="$LIB_DIR/libfaketimeMT.so.1"

if [ ! -f "$LIB" ]; then
  mkdir -p "$LIB_DIR"
  TMP=$(mktemp -d)
  curl -sfL --max-time 60 -o "$TMP/f.deb" http://archive.debian.org/debian/pool/main/f/faketime/libfaketime_0.9.7-3_amd64.deb
  dpkg-deb -x "$TMP/f.deb" "$TMP/x"
  cp "$TMP/x/usr/lib/x86_64-linux-gnu/faketime/libfaketimeMT.so.1" "$LIB"
  rm -r "$TMP"
fi

if ! docker ps --format '{{.Names}}' | grep -qx "$NAME"; then
  docker rm -f "$NAME" >/dev/null 2>&1 || true
  docker run -d --name "$NAME" --memory 1g --oom-score-adj=1000 -p 127.0.0.1::9076 \
    -v "$LIB:/faketime/libfaketimeMT.so.1:ro" -e LD_PRELOAD=/faketime/libfaketimeMT.so.1 \
    -e 'FAKETIME=@2021-10-01 12:00:00' -e DONT_FAKE_MONOTONIC=1 \
    qlikcore/engine:12.1126.0 -S AcceptEULA=yes >/dev/null
  sleep 3
fi
echo "ws://$(docker port "$NAME" 9076 | head -1)"
