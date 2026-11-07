#!/bin/bash
# The checks, inside the container. Each case spawns an OpenCode thread on a
# misbehaving fake model and waits for the plugin to move it to `corp/ok`.
set -uo pipefail
cd "$HOME"
fail=0
check() { if eval "$2"; then echo "ok   $1"; else echo "FAIL $1"; fail=1; fi; }
wait_for() { local i; for i in $(seq 1 "$2"); do eval "$1" && return 0; sleep 2; done; return 1; }
proj=$(bb project list --json | jq -r '.[] | select(.name == "demo") | .id')
for old in $(bb thread list --json | jq -r '.[].id'); do bb thread stop "$old" >/dev/null 2>&1; bb thread archive "$old" >/dev/null 2>&1; done

view() {
  printf '{"threadId":"%s"}' "$1" > /tmp/view-in.json
  bb plugin rpc call model-fallback thread_view --input-file /tmp/view-in.json 2>/dev/null
}
events() { bb thread log "$1" --json --all 2>/dev/null; }
# Models of the thread's turns in order, e.g. "corp/slow corp/ok".
turn_models() { events "$1" | jq -r '[.[] | select(.type == "client/turn/requested") | .data.execution.model] | join(" ")'; }
plugin_turns() { events "$1" | jq '[.[] | select(.type == "client/turn/requested" and .data.originPluginId == "model-fallback")] | length'; }
sent_count() { view "$1" | jq -r '.state.sent | length'; }
active_pair() { view "$1" | jq -r '(.state.active.current.id // "") + " " + (.state.active.original.id // "")'; }
answered_ok() { events "$1" | jq -e '[.[] | select(.type == "item/completed" and .data.item.type == "agentMessage") | .data.item.text] | any(test("Pong from ok"))' >/dev/null; }
spawn() {
  bb thread spawn --project "$proj" --environment "$HOME/projects/demo" --provider acp-opencode --model "$1" --prompt "$2" --json | jq -r '.id // .thread.id'
}

echo "== hang: corp/slow never answers"
bb plugin config model-fallback set ladders "acp-opencode corp/slow > corp/ok" >/dev/null
t1=$(spawn corp/slow "Say hi")
echo "thread $t1"
check "countdown appears while the model is silent" "wait_for '[ \"\$(view $t1 | jq -r .state.pending.to.id)\" = corp/ok ]' 45"
check "the hung turn is stopped and continued on corp/ok" "wait_for '[ \"\$(plugin_turns $t1)\" = 1 ]' 30"
check "the new model answers" "wait_for 'answered_ok $t1' 30"
check "turns went slow then ok" "[ \"\$(turn_models $t1)\" = 'corp/slow corp/ok' ]"
check "the thread is marked as on its fallback" "[ \"\$(active_pair $t1)\" = 'corp/ok corp/slow' ]"
check "the continuation is recorded for its timeline label" "wait_for '[ \"\$(sent_count $t1)\" = 1 ]' 15"

echo "== cancel: the person keeps waiting"
t2=$(spawn corp/slow "Say hi again")
echo "thread $t2"
check "countdown appears" "wait_for '[ \"\$(view $t2 | jq -r .state.pending.to.id)\" = corp/ok ]' 45"
printf '{"threadId":"%s"}' "$t2" > /tmp/cancel-in.json
bb plugin rpc call model-fallback thread_cancel --input-file /tmp/cancel-in.json >/dev/null
sleep 25
check "no switch after Cancel" "[ \"\$(plugin_turns $t2)\" = 0 ]"
check "the cancelled switch stays offered" "[ \"\$(view $t2 | jq -r .state.pending.dueAt)\" = null ]"
bb plugin rpc call model-fallback thread_switch_now --input-file /tmp/cancel-in.json >/dev/null
check "Switch now still moves it" "wait_for 'answered_ok $t2' 30"
bb plugin rpc call model-fallback thread_return --input-file /tmp/cancel-in.json >/dev/null
check "Return clears the fallback" "[ \"\$(view $t2 | jq -r .state.active)\" = null ]"

echo "== rate limit: corp/limited answers 429"
bb plugin config model-fallback set ladders "acp-opencode corp/limited > corp/ok" >/dev/null
t3=$(spawn corp/limited "Say hi once more")
echo "thread $t3"
check "the thread ends up answered on corp/ok" "wait_for 'answered_ok $t3' 75"
# OpenCode retries a 429 itself and keeps the turn open: the plugin sees silence, not a failed turn.
echo "   how the 429 surfaced: $(view $t3 | jq -c '[.state.log[] | {kind, reason: .reason.kind}]')"
echo "   turns: $(turn_models $t3)"

echo "== outside the ladder: nothing happens"
t4=$(spawn corp/slow "Stay")
bb plugin config model-fallback set ladders "acp-opencode corp/limited > corp/ok" >/dev/null
sleep 40
check "no switch for a model on no ladder" "[ \"\$(plugin_turns $t4)\" = 0 ]"
bb thread stop "$t4" >/dev/null 2>&1 || true

[ "$fail" = 0 ] && echo "ALL OK" || echo "SOME CHECKS FAILED"
exit "$fail"
