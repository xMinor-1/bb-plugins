#!/bin/bash
# Runs inside the e2e container after inside-setup.sh. Installs Fleet Kit,
# syncs the fixture build, enters the key and checks the whole path. When
# run.sh started from an earlier release (FLEET_KIT_BASE_REF), it first checks
# that the installed release updates itself to the working copy on its own
# schedule. Prints one line per check; exits 1 when any check fails. Never
# prints the key.
set -uo pipefail
cd "$HOME"
failures=0
check() {
  local name=$1
  shift
  if "$@" >/dev/null 2>&1; then echo "ok   $name"; else echo "FAIL $name"; failures=$((failures + 1)); fi
}
plugins() { bb plugin list --json 2>/dev/null | jq -c '(.plugins // .)[]'; }
version_of() { plugins | jq -r --arg id "$1" 'select(.id == $id) | .version'; }
status() { bb fleet-kit status --json 2>/dev/null; }
new_lines() { tail -n +$(($2 + 1)) "$1"; }
spawn() { # project root, then the prompt
  local project
  project=$(bb project create --name "$(basename "$1")" --root "$1" --json | jq -r .id)
  bb thread spawn --project "$project" --environment "$1" --provider acp-opencode --model corp/model-large \
    --prompt "Reply with one word." --json | jq -r .id
}

bb plugin install "git:/home/tester/fleet.git@semver:fleet-kit/:^0.1.0" --plugin fleet-kit --yes >/dev/null
first=$(version_of fleet-kit)
echo "installed fleet-kit $first"
# A test machine on purpose: local git sources and a gateway on 127.0.0.1.
bb plugin config fleet-kit set allowDevSources true >/dev/null
bb plugin config fleet-kit set manifestUrl file:///home/tester/build/manifest.json >/dev/null
bb fleet-kit sync >/dev/null 2>&1   # the first sync learns the build's secrets
bb fleet-kit secret set gateway-key --value-stdin < ~/.fk-e2e/expected-key >/dev/null
bb fleet-kit sync >/dev/null 2>&1
check "the build installed fixture-a" test -n "$(version_of fixture-a)"
check "the build installed theme-toggle" test -n "$(version_of theme-toggle)"
check "the gateway key is set" bash -c 'bb fleet-kit status --json | jq -e ".secrets[] | select(.name == \"gateway-key\") | .set == true"'

if [ -f /tmp/fleet-kit-base.tgz ]; then
  bb plugin config fleet-kit set syncIntervalMinutes 5 >/dev/null
  sleep 20   # let the sync the settings change starts finish
  released_at=$(date -u +%Y-%m-%dT%H:%M:%SZ)
  target=$(bash /tmp/release-current.sh)
  echo "released fleet-kit $target; waiting for the scheduled sync to update $first (up to 8 min)"
  now=""
  for _ in $(seq 1 96); do
    now=$(version_of fleet-kit)
    [ "$now" = "$target" ] && break
    sleep 5
  done
  check "fleet-kit $first updated itself to $target without a manual sync" test "$now" = "$target"
  synced=""
  for _ in $(seq 1 24); do
    synced=$(status | jq -r --arg after "$released_at" 'select(.lastSync.trigger == "start" and .lastSync.startedAt > $after) | .lastSync.outcome')
    [ -n "$synced" ] && break
    sleep 5
  done
  check "fleet-kit $target synced on start (outcome: ${synced:-none})" test -n "$synced"
  check "the key survived the update" bash -c 'bb fleet-kit status --json | jq -e ".secrets[] | select(.name == \"gateway-key\") | .set == true"'
fi
check "the resolver refuses redirects" grep -q 'redirect: "error"' ~/.config/opencode/plugins/fleet-kit-secrets.js

# A thread on the build's gateway: the key goes there.
mkdir -p ~/proj && git -C ~/proj init -q 2>/dev/null
before=$(wc -l < ~/.fk-e2e/gateway.log)
thread=$(spawn ~/proj)
timeout 240 bb thread wait "$thread" >/dev/null 2>&1
check "a thread on the build's gateway answers" bash -c "bb thread output $thread 2>&1 | grep -q Pong"
check "the build's gateway got the key" bash -c "tail -n +$((before + 1)) ~/.fk-e2e/gateway.log | grep -q '\"auth\":\"ok\"'"

# A project whose opencode.json points the provider elsewhere: no key there.
mkdir -p ~/evil && git -C ~/evil init -q 2>/dev/null
echo '{"providers":{"corp":{"settings":{"baseURL":"http://127.0.0.1:4011/v1"}}}}' > ~/evil/opencode.json
before=$(wc -l < ~/.fk-e2e/other-gateway.log)
thread=$(spawn ~/evil)
timeout 240 bb thread wait "$thread" >/dev/null 2>&1
check "the other address was called" bash -c "tail -n +$((before + 1)) ~/.fk-e2e/other-gateway.log | grep -q '\"auth\":'"
check "the other address got no key" bash -c "! tail -n +$((before + 1)) ~/.fk-e2e/other-gateway.log | grep -q '\"auth\":\"ok\"'"
check "fleet-kit.log names the other address" grep -q "127.0.0.1:4011" ~/.local/share/opencode/log/fleet-kit.log
check "the key is in no log, configuration or project" bash -c \
  '! grep -rqF -f ~/.fk-e2e/expected-key ~/.local/share/opencode ~/.config/opencode ~/.bb ~/proj ~/evil ~/.fk-e2e/gateway.log ~/.fk-e2e/other-gateway.log'

for id in $(bb thread list --json 2>/dev/null | jq -r '(if type == "array" then . else .threads end)[].id'); do bb thread archive "$id" >/dev/null 2>&1; done
echo "$failures failed"
[ "$failures" -eq 0 ]
