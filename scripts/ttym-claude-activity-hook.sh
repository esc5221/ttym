#!/bin/sh
# ttym-claude-activity-hook.sh — Claude Code activity hook
#
# Installed for UserPromptSubmit, PostToolUse, PostToolUseFailure, PermissionRequest,
# Notification and SubagentStop. The event name comes from the payload, so one
# entry without arguments serves them all.
#
# Every turn starts at UserPromptSubmit. Without it, claudeActive was set once at
# SessionStart and cleared by the first Stop — every later turn ran with the
# flag down. The tool events keep a long turn's liveness stamp fresh (a turn
# past fifteen minutes read as idle), PermissionRequest says a prompt is up
# (bypassPermissions panes included), and the server decides what each means.
#
# Same contract as the other hooks: HTTP to the owning server via TTYM_PORT,
# no CLI dependency, prints nothing (PermissionRequest reads stdout as a
# decision), always exit 0.

[ -z "$TTYM_SESSION_ID" ] && exit 0

# A claude started inside another claude (claude -p from a Bash tool) is not this pane's agent.
_LIB="$(dirname "$0")/ttym-hook-nested.sh"
if [ -r "$_LIB" ]; then
  . "$_LIB"
  if ttym_nested_claude; then cat >/dev/null; exit 0; fi
fi

BASE="http://127.0.0.1:${TTYM_PORT:-7690}"

HOOK_PAYLOAD=$(cat)
BODY=$(printf '%s' "$HOOK_PAYLOAD" | jq -c '{event: (.hook_event_name // "UserPromptSubmit"), agentId: (.agent_id // null), tool: (.tool_name // null), notificationType: (.notification_type // null), message: ((.message // "") | .[0:200])}' 2>/dev/null)
[ -z "$BODY" ] && BODY='{"event":"UserPromptSubmit"}'

CODE=$(curl -s -m 5 -o /dev/null -w '%{http_code}' -X POST "$BASE/api/internal/sessions/$TTYM_SESSION_ID/hook" \
  -H 'content-type: application/json' -d "$BODY")

# A server from before /hook knew one message: "active".
if [ "$CODE" = "404" ]; then
  case "$BODY" in
    *'"event":"UserPromptSubmit"'* | *'"event":"PostToolUse"'*)
      curl -s -m 5 -X POST "$BASE/api/internal/sessions/$TTYM_SESSION_ID/agent" \
        -H 'content-type: application/json' -d '{"claudeActive":true}' >/dev/null ;;
  esac
fi

exit 0
