#!/bin/sh
# ttym-claude-hook.sh — Claude Code SessionStart hook
# Maps a Claude Code session to the ttym session it runs inside.
#
# Speaks HTTP to the owning server via TTYM_PORT (stamped into every session
# env) — no dependency on whichever `ttym` CLI is on PATH, and no way for a
# CLI/server version skew to fail the hook. Always exits 0.
#
# Flow:
#   1. holder sets TTYM_SESSION_ID (+ TTYM_PORT) in the session env
#   2. Claude Code fires SessionStart, piping { session_id, source, ... }
#   3. this script records them as server-owned runtime meta

[ -z "$TTYM_SESSION_ID" ] && exit 0

BASE="http://127.0.0.1:${TTYM_PORT:-7690}"

HOOK_PAYLOAD=$(cat)
CLAUDE_SESSION=$(printf '%s' "$HOOK_PAYLOAD" | jq -r '.session_id // empty' 2>/dev/null)
[ -z "$CLAUDE_SESSION" ] && exit 0
CLAUDE_SOURCE=$(printf '%s' "$HOOK_PAYLOAD" | jq -r '.source // "startup"' 2>/dev/null)

curl -s -m 5 -X POST "$BASE/api/internal/sessions/$TTYM_SESSION_ID/agent" \
  -H 'content-type: application/json' \
  -d "{\"claudeSessionId\":\"$CLAUDE_SESSION\",\"claudeActive\":true,\"claudeSource\":\"$CLAUDE_SOURCE\"}" >/dev/null

exit 0
