#!/bin/bash
# Runs inside the e2e container after scenario.sh: the person's own agents and
# the build's skills. The confirmation window is a real zenity window on the
# container's virtual display (start.sh); xdotool presses its buttons the way a
# person would. Codex stands for the person's own agent: its requests go to a
# local capture server, so the check reads the instructions it was given.
# Prints one line per check; exits 1 when any check fails.
set -uo pipefail
cd "$HOME"
export DISPLAY=:99
failures=0
check() {
  local name=$1
  shift
  if "$@" >/dev/null 2>&1; then echo "ok   $name"; else echo "FAIL $name"; failures=$((failures + 1)); fi
}
manifest=$HOME/build/manifest.json
enabled_agents() { bb provider list --json 2>/dev/null | jq -r '.[].id' | sort | paste -sd' '; }
state() { bb fleet-kit status --json | jq -r '.ownAgents.on'; }
notices() { bb fleet-kit status --json | jq '.notices | length'; }
refusals() { bb fleet-kit status --json | jq -r '.ownAgents.refusals // 0'; }
# Start `own-agents on` and answer its window: yes (click Turn on), enter (press
# Enter, the default button) or no (Escape). Prints the CLI's answer.
turn_on() {
  local answer=$1 out=/tmp/own-agents-$RANDOM.txt window=""
  (bb fleet-kit own-agents on > "$out" 2>&1; echo "exit=$?" >> "$out") &
  for _ in $(seq 1 30); do
    window=$(xdotool search --name "Fleet Kit" 2>/dev/null | tail -1)
    [ -n "$window" ] && break
    sleep 1
  done
  if [ -z "$window" ]; then echo "no window"; wait; cat "$out"; return; fi
  echo "window: $(xdotool getwindowname "$window")"
  if [ "$answer" = yes ]; then
    eval "$(xdotool getwindowgeometry --shell "$window")"
    xdotool mousemove $((X + WIDTH - 50)) $((Y + HEIGHT - 25)) click 1
  elif [ "$answer" = enter ]; then
    xdotool windowfocus "$window" 2>/dev/null
    xdotool key --window "$window" Return 2>/dev/null
  else
    xdotool windowfocus "$window" 2>/dev/null
    xdotool key --window "$window" Escape 2>/dev/null
  fi
  wait
  cat "$out"
}
project=$(bb project list --json | jq -r '(if type == "array" then . else .projects end)[] | select(.name == "proj") | .id' | head -1)
spawn() { bb thread spawn --project "$project" --environment ~/proj "$@" --prompt "Reply with one word." --json | jq -r .id; }

# The build offers Codex as an own agent, a skill for the build's agents and one for own agents.
jq '.ownAgents = { providers: ["codex"], warning: "E2E: your agent reads the data of plugins through bb commands.", delegate: { provider: "acp-opencode", model: "corp/model-large" } }
  | .skills = [
      { id: "tools", name: "tools", description: "Use the build tools.", body: "TOOLS-BODY" },
      { id: "corp-agent", name: "corp-agent", description: "Hand a step to the build agent.", audience: "own", body: "CORP-BODY" } ]' \
  "$manifest" > "$manifest.tmp" && mv "$manifest.tmp" "$manifest"
bb fleet-kit sync >/dev/null 2>&1
check "the sync accepts ownAgents and skills" bash -c "bb fleet-kit status --json | jq -e '.lastSync.outcome != \"error\" and ([.lastSync.steps[] | select(.message | test(\"not known\"))] | length == 0)'"
check "own agents are off by default" test "$(state)" = false
bb provider enable codex >/dev/null 2>&1
bb fleet-kit sync >/dev/null 2>&1
check "codex turned on by hand while off is turned off again" test "$(enabled_agents)" = "acp-opencode"

echo "-- yes in the window"
turn_on yes | sed 's/^/   /'
check "Turn on in the window turns own agents on" test "$(state)" = true
notices_before=$(notices)
bb provider enable codex >/dev/null 2>&1
bb fleet-kit sync >/dev/null 2>&1
check "codex stays on after the sync" test "$(enabled_agents)" = "acp-opencode codex"
check "no new notice about codex" test "$(notices)" = "$notices_before"
bb provider enable claude-code >/dev/null 2>&1
bb fleet-kit sync >/dev/null 2>&1
check "an agent the build does not offer is still turned off" test "$(enabled_agents)" = "acp-opencode codex"

# Codex's requests go to a capture server: what bb gave it as instructions and tools.
mkdir -p ~/.codex ~/.fk-e2e/codex-requests
rm -f ~/.fk-e2e/codex-requests/*
cat > ~/.codex/config.toml <<'EOF'
model = "model-large"
model_provider = "capture"
[model_providers.capture]
name = "capture"
base_url = "http://127.0.0.1:4012/v1"
wire_api = "responses"
EOF
cat > /tmp/capture.mjs <<'EOF'
import { createServer } from "node:http";
import { writeFileSync } from "node:fs";
createServer((req, res) => {
  const chunks = [];
  req.on("data", (chunk) => chunks.push(chunk));
  req.on("end", () => {
    writeFileSync(`${process.env.HOME}/.fk-e2e/codex-requests/${Date.now()}.json`, Buffer.concat(chunks));
    res.writeHead(500);
    res.end("{}");
  });
}).listen(4012, "127.0.0.1");
EOF
pkill -f "[c]apture.mjs" || true
(nohup node /tmp/capture.mjs > /tmp/capture.log 2>&1 &)
sleep 1
codex_thread=$(spawn --provider codex)
for _ in $(seq 1 60); do [ -n "$(ls ~/.fk-e2e/codex-requests)" ] && break; sleep 1; done
sleep 2
request=$(ls ~/.fk-e2e/codex-requests | head -1)
codex_has() { grep -qF -- "$1" ~/.fk-e2e/codex-requests/"$request"; }
check "codex sent a request" test -n "$request"
check "codex is told about the skill for own agents" codex_has "- corp-agent: Hand a step to the build agent."
check "codex has the build_skill tool" codex_has "build_skill"
check "codex is not told about the skill for the build's agents" bash -c "! grep -qF -- '- tools: Use the build' ~/.fk-e2e/codex-requests/$request"
check "codex's instructions do not hold the skill's body" bash -c "! grep -qF CORP-BODY ~/.fk-e2e/codex-requests/$request"
bb thread stop "$codex_thread" >/dev/null 2>&1

# The build's agent on the fake gateway: its own skill, not the one for own agents.
before=$(ls ~/.fk-e2e/requests | wc -l)
opencode_thread=$(spawn --provider acp-opencode --model corp/model-large)
timeout 240 bb thread wait "$opencode_thread" >/dev/null 2>&1
latest=$(ls -t ~/.fk-e2e/requests | head -1)
opencode_has() { grep -qF -- "$1" ~/.fk-e2e/requests/"$latest"; }
check "the build's agent sent a request" test "$(ls ~/.fk-e2e/requests | wc -l)" -gt "$before"
check "the build's agent is told about its skill" opencode_has "- tools: Use the build tools."
check "the build's agent is not told about the skill for own agents" bash -c "! grep -qF corp-agent ~/.fk-e2e/requests/$latest"

echo "-- the build changes the warning"
jq '.ownAgents.warning = "E2E: your agent reads the data of plugins through bb commands, and more."' "$manifest" > "$manifest.tmp" && mv "$manifest.tmp" "$manifest"
bb fleet-kit sync >/dev/null 2>&1
check "a changed warning turns own agents off" test "$(state)" = false
check "codex is turned off after the warning changed" test "$(enabled_agents)" = "acp-opencode"
out=$(turn_on yes)
echo "$out" | sed 's/^/   /'
check "the new window shows the new warning and turns them on" bash -c "echo \"\$1\" | grep -q '^window:' && test \"\$(bb fleet-kit status --json | jq -r .ownAgents.on)\" = true" _ "$out"
bb provider enable codex >/dev/null 2>&1

echo "-- turn off"
notices_on=$(notices)
bb fleet-kit own-agents off >/dev/null 2>&1
sleep 8   # the sync that turning off starts
bb fleet-kit sync >/dev/null 2>&1
check "own agents are off" test "$(state)" = false
check "codex is turned off again" test "$(enabled_agents)" = "acp-opencode"
check "no 'turned on by hand' notice for codex" test "$(notices)" = "$notices_on"

echo "-- Enter in the window"
out=$(turn_on enter)
echo "$out" | sed 's/^/   /'
check "a window opened" bash -c "echo \"\$1\" | grep -q '^window:'" _ "$out"
check "Enter does not turn own agents on" test "$(state)" = false
check "Enter counts as a refusal" test "$(refusals)" = 1
echo "-- right after the refusal"
out=$(timeout 20 bb fleet-kit own-agents on 2>&1)
echo "$out" | sed 's/^/   /'
check "no window for 10 minutes after a refusal" bash -c "echo \"\$1\" | grep -q 'try again in 10 minutes' && ! xdotool search --name 'Fleet Kit'" _ "$out"
check "still off" test "$(state)" = false
check "the status says when the next window may open" bash -c "bb fleet-kit status --json | jq -e '.ownAgents.retryAt | type == \"string\"'"

for id in $(bb thread list --json 2>/dev/null | jq -r '(if type == "array" then . else .threads end)[].id'); do bb thread archive "$id" >/dev/null 2>&1; done
echo "$failures failed"
[ "$failures" -eq 0 ]
