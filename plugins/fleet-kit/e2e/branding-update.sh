#!/bin/bash
# Moving a build's logo from the App Branding plugin to Fleet Kit, on a machine
# that still runs a Fleet Kit without branding. Start the container from that
# release, then run this instead of scenario.sh:
#   FLEET_KIT_BASE_REF=<commit of the older release> e2e/run.sh
#   e2e/x.sh 'bash /tmp/branding-update.sh'
# The page must have a logo at every step: App Branding's until Fleet Kit's.
# Prints one line per check; exits 1 when any check fails.
set -uo pipefail
cd "$HOME"
failures=0
check() {
  local name=$1
  shift
  if "$@" >/dev/null 2>&1; then echo "ok   $name"; else echo "FAIL $name"; failures=$((failures + 1)); fi
}
manifest=$HOME/build/manifest.json
plugins() { bb plugin list --json 2>/dev/null | jq -c '(.plugins // .)[]'; }
version_of() { plugins | jq -r --arg id "$1" 'select(.id == $id) | .version'; }
installed() { test -n "$(version_of "$1")"; }
branding() { curl -sf http://127.0.0.1:38886/api/v1/plugins/fleet-kit/http/branding; }
logo='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#0a0"/></svg>'
source='git:/home/tester/fleet.git@semver:fleet-kit/:>=0.2.0 <1.0.0'

# The build as it was: Fleet Kit on a range like the real one, App Branding with the logo.
jq --arg source "$source" --arg logo "$logo" '
  (.plugins[] | select(.id == "fleet-kit") | .source) = $source
  | .plugins += [{ id: "app-branding", source: "git:https://github.com/xMinor-1/bb-plugins.git@semver:app-branding/:^0.1.0", plugin: "app-branding", status: "required", config: { appName: "E2E build", logoSvg: $logo } }]' \
  "$manifest" > "$manifest.tmp" && mv "$manifest.tmp" "$manifest"
bb plugin install "$source" --plugin fleet-kit --yes >/dev/null
old=$(version_of fleet-kit)
echo "installed fleet-kit $old"
bb plugin config fleet-kit set allowDevSources true >/dev/null
bb plugin config fleet-kit set manifestUrl "file://$manifest" >/dev/null
bb fleet-kit sync >/dev/null 2>&1
bb fleet-kit secret set gateway-key --value-stdin < ~/.fk-e2e/expected-key >/dev/null
bb fleet-kit sync >/dev/null 2>&1
check "App Branding installed with the logo" bash -c "bb plugin config app-branding --json 2>/dev/null | grep -qF '<svg'"
check "fleet-kit $old has no branding route" bash -c "! curl -sf http://127.0.0.1:38886/api/v1/plugins/fleet-kit/http/branding"

# The new build: App Branding out of plugins, named in branding.replaces, not in removePlugins.
jq --arg logo "$logo" '.plugins |= map(select(.id != "app-branding")) | .branding = { appName: "E2E build", logoSvg: $logo, replaces: ["app-branding"] }' \
  "$manifest" > "$manifest.tmp" && mv "$manifest.tmp" "$manifest"
bb fleet-kit sync >/dev/null 2>&1
check "fleet-kit $old warns about branding and applies the rest" bash -c "bb fleet-kit status --json | jq -e '.lastSync.outcome != \"error\" and ([.lastSync.steps[] | select(.message | test(\"^branding: not known\"))] | length == 1)'"
check "fleet-kit $old keeps App Branding" installed app-branding

# The release with branding reaches the machine by itself.
target=$(bash /tmp/release-current.sh)
echo "released fleet-kit $target"
bb fleet-kit sync >/dev/null 2>&1
now=""
for _ in $(seq 1 60); do
  now=$(version_of fleet-kit)
  [ "$now" = "$target" ] && break
  sleep 5
done
check "fleet-kit $old updated itself to $target" test "$now" = "$target"
for _ in $(seq 1 24); do branding >/dev/null 2>&1 && break; sleep 5; done
check "App Branding is still there right after the update" installed app-branding
bb fleet-kit sync >/dev/null 2>&1
check "fleet-kit $target serves the build's logo" bash -c "curl -sf http://127.0.0.1:38886/api/v1/plugins/fleet-kit/http/branding | jq -e '.appName == \"E2E build\" and (.logoSvg | startswith(\"<svg\"))'"
bb fleet-kit sync >/dev/null 2>&1
check "the next sync removes App Branding" bash -c "! bb plugin list --json | jq -e '(.plugins // .) | any(.id == \"app-branding\")'"
check "the logo is still served" bash -c "curl -sf http://127.0.0.1:38886/api/v1/plugins/fleet-kit/http/branding | jq -e '.appName == \"E2E build\"'"
check "the last sync has no errors" bash -c "bb fleet-kit status --json | jq -e '.lastSync.outcome != \"error\"'"

echo "$failures failed"
[ "$failures" -eq 0 ]
