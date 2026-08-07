#!/bin/sh
# ttym-codex-stop-hook.sh — Codex turn-end hook (codex_hooks v0.114+)
#
# Same contract as the Claude stop hook: HTTP to the owning server via
# TTYM_PORT, no CLI dependency, always exit 0, stderr left visible.

[ -z "$TTYM_SESSION_ID" ] && exit 0

BASE="http://127.0.0.1:${TTYM_PORT:-7690}"

HOOK_PAYLOAD=$(cat)
CODEX_SESSION=$(printf '%s' "$HOOK_PAYLOAD" | jq -r '.session_id // empty' 2>/dev/null)

if [ -n "$CODEX_SESSION" ]; then
  AGENT_PATCH="{\"codexActive\":false,\"codexSessionId\":null,\"codexLastSessionId\":\"$CODEX_SESSION\"}"
else
  AGENT_PATCH='{"codexActive":false,"codexSessionId":null}'
fi
curl -s -m 5 -X POST "$BASE/api/internal/sessions/$TTYM_SESSION_ID/agent" \
  -H 'content-type: application/json' -d "$AGENT_PATCH" >/dev/null

curl -s -m 5 -X POST "$BASE/api/internal/sessions/$TTYM_SESSION_ID/stop" \
  -H 'content-type: application/json' -d '{"event":"Stop"}' >/dev/null

CURRENT_SEQ=$(curl -s -m 5 "$BASE/api/sessions/$TTYM_SESSION_ID/meta" | jq -r '.seq // 0' 2>/dev/null)
curl -s -m 5 -X POST "$BASE/api/internal/sessions/$TTYM_SESSION_ID/agent" \
  -H 'content-type: application/json' \
  -d "{\"stopSeq\":${CURRENT_SEQ:-0},\"stopAt\":$(date +%s)}" >/dev/null

exit 0
