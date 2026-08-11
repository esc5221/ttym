#!/bin/sh
# ttym-claude-activity-hook.sh — Claude Code UserPromptSubmit hook
#
# Every turn starts here. Without this event, claudeActive was set once at
# SessionStart and cleared by the first Stop — every later turn ran with the
# flag down, so the server's liveness stamp (agentActiveAt) never refreshed
# and the tab dot only ever pulsed for a session's first turn.
#
# Same contract as the other hooks: HTTP to the owning server via TTYM_PORT,
# no CLI dependency, always exit 0.

[ -z "$TTYM_SESSION_ID" ] && exit 0

BASE="http://127.0.0.1:${TTYM_PORT:-7690}"

curl -s -m 5 -X POST "$BASE/api/internal/sessions/$TTYM_SESSION_ID/agent" \
  -H 'content-type: application/json' \
  -d '{"claudeActive":true}' >/dev/null

exit 0
