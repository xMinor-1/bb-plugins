#!/bin/bash
# Runs inside the e2e container after scenario.sh: the build's branding. The
# fixture build installs theme-toggle; here the branding takes its place the
# way it takes App Branding's: dropped from plugins, named in replaces.
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
installed() { bb plugin list --json 2>/dev/null | jq -e --arg id "$1" '(.plugins // .) | any(.id == $id)'; }
branding() { curl -sf http://127.0.0.1:38886/api/v1/plugins/fleet-kit/http/branding; }

check "theme-toggle is installed before" installed theme-toggle
check "no branding before the build has one" bash -c "curl -sf http://127.0.0.1:38886/api/v1/plugins/fleet-kit/http/branding | jq -e '.appName == \"\" and .logoSvg == \"\"'"

logo='<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 10 10"><rect width="10" height="10" fill="#0a0"/></svg>'
jq --arg logo "$logo" '.plugins |= map(select(.id != "theme-toggle")) | .branding = { appName: "E2E build", logoSvg: $logo, replaces: ["theme-toggle"] }' \
  "$manifest" > "$manifest.tmp" && mv "$manifest.tmp" "$manifest"
bb fleet-kit sync >/dev/null 2>&1
check "the first sync with the branding keeps the replaced plugin" installed theme-toggle
bb fleet-kit sync >/dev/null 2>&1
echo "branding: $(branding | jq -c '{appName, logo: (.logoSvg | length)}')"
check "the page gets the build's name" bash -c "curl -sf http://127.0.0.1:38886/api/v1/plugins/fleet-kit/http/branding | jq -e '.appName == \"E2E build\"'"
check "the page gets the build's logo" bash -c "curl -sf http://127.0.0.1:38886/api/v1/plugins/fleet-kit/http/branding | jq -e '.logoSvg | startswith(\"<svg\")'"
check "the replaced plugin is removed" bash -c "! bb plugin list --json | jq -e '(.plugins // .) | any(.id == \"theme-toggle\")'"
check "the sync has no errors" bash -c "bb fleet-kit status --json | jq -e '.lastSync.outcome != \"error\"'"

jq 'del(.branding)' "$manifest" > "$manifest.tmp" && mv "$manifest.tmp" "$manifest"
bb fleet-kit sync >/dev/null 2>&1
check "a build without branding gives the page none" bash -c "curl -sf http://127.0.0.1:38886/api/v1/plugins/fleet-kit/http/branding | jq -e '.appName == \"\"'"

echo "$failures failed"
[ "$failures" -eq 0 ]
