#!/bin/sh
# ttym-claude-stop-hook.sh — Claude Code turn-end hook
#
# Installed for Stop, StopFailure and SessionEnd. Only Stop means the agent
# answered; the other two mean it will not, and reporting them is what keeps a
# waiting interaction from blocking until its timeout.
#
# Speaks HTTP to the server that owns this session (TTYM_PORT, stamped into
# every session env) instead of shelling out to `ttym` — a hook must not care
# which CLI build happens to be on PATH. One production CLI once answered a
# dev server with "api v1 vs v2", exited 1, and poisoned every turn.
#
# Always exits 0: this hook is a side effect, not a gate. stderr is left
# alone so the next failure is visible instead of silent.

[ -z "$TTYM_SESSION_ID" ] && exit 0

BASE="http://127.0.0.1:${TTYM_PORT:-7690}"
EVENT="${1:-Stop}"

HOOK_PAYLOAD=$(cat)
CLAUDE_SESSION=$(printf '%s' "$HOOK_PAYLOAD" | jq -r '.session_id // empty' 2>/dev/null)

# Agent runtime state: the turn is over; remember which claude session it was.
# What is still alive after this turn — Claude Code (2.1.269+) lists it in the
# Stop payload: background tasks (bash, agents, monitors, workflows) and the
# session-scoped crons (CronCreate, ScheduleWakeup, /loop) that will wake it
# later. Forwarded as claudeInFlight so the server knows the pane is not idle
# even though the turn is closed and nothing moves on screen. Older versions
# send neither key: then claudeInFlight is null and the server falls back to
# the process tree. Trimmed: ten entries, short descriptions.
IN_FLIGHT=$(printf '%s' "$HOOK_PAYLOAD" | jq -c '
  if (has("background_tasks") or has("session_crons")) then
    { tasks: ((.background_tasks // []) | map({type, status, description: ((.description // .command // "") | .[0:80])}) | .[0:10]),
      crons: ((.session_crons // []) | map({schedule, recurring: (.recurring // false), prompt: ((.prompt // "") | .[0:80])}) | .[0:10]),
      at: (now | floor) }
  else null end' 2>/dev/null)
[ -z "$IN_FLIGHT" ] && IN_FLIGHT=null
if [ -n "$CLAUDE_SESSION" ]; then
  AGENT_PATCH="{\"claudeActive\":false,\"claudeSessionId\":null,\"claudeLastSessionId\":\"$CLAUDE_SESSION\",\"claudeInFlight\":$IN_FLIGHT}"
else
  AGENT_PATCH="{\"claudeActive\":false,\"claudeSessionId\":null,\"claudeInFlight\":$IN_FLIGHT}"
fi
curl -s -m 5 -X POST "$BASE/api/internal/sessions/$TTYM_SESSION_ID/agent" \
  -H 'content-type: application/json' -d "$AGENT_PATCH" >/dev/null

# Settle whatever interaction is in flight for this session.
curl -s -m 5 -X POST "$BASE/api/internal/sessions/$TTYM_SESSION_ID/stop" \
  -H 'content-type: application/json' -d "{\"event\":\"$EVENT\"}" >/dev/null

# Legacy signal, still written so a v2 CLI polling meta.stopSeq keeps working
# during a rollback. Remove once no v2 client remains.
CURRENT_SEQ=$(curl -s -m 5 "$BASE/api/sessions/$TTYM_SESSION_ID/meta" | jq -r '.seq // 0' 2>/dev/null)
curl -s -m 5 -X POST "$BASE/api/internal/sessions/$TTYM_SESSION_ID/agent" \
  -H 'content-type: application/json' \
  -d "{\"stopSeq\":${CURRENT_SEQ:-0},\"stopAt\":$(date +%s)}" >/dev/null

exit 0
