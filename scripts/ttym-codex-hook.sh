#!/bin/sh
# ttym-codex-hook.sh — Codex CLI SessionStart hook (codex_hooks v0.114+)
# Maps a Codex session to the ttym session it runs inside.
#
# Same contract as the Claude and Codex stop hooks: HTTP to the owning server
# via TTYM_PORT, no CLI dependency, always exit 0.
#
# Why a script instead of the inline command this replaces:
#
#   [ -z "$TTYM_SESSION_ID" ] && exit 0; jq -r .session_id \
#     | xargs -I{} ttym meta $TTYM_SESSION_ID --codex-session {}
#
# `ttym meta` prints the session's metadata to stdout, and Codex reads a
# SessionStart hook's stdout as its own JSON. Valid JSON, wrong schema —
# Codex answered "hook returned invalid session start JSON output" on every
# start inside a ttym pane. Nothing here writes to stdout.

[ -z "$TTYM_SESSION_ID" ] && exit 0

BASE="http://127.0.0.1:${TTYM_PORT:-7690}"

HOOK_PAYLOAD=$(cat)
CODEX_SESSION=$(printf '%s' "$HOOK_PAYLOAD" | jq -r '.session_id // empty' 2>/dev/null)
[ -z "$CODEX_SESSION" ] && exit 0

curl -s -m 5 -X POST "$BASE/api/internal/sessions/$TTYM_SESSION_ID/agent" \
  -H 'content-type: application/json' \
  -d "{\"codexSessionId\":\"$CODEX_SESSION\",\"codexActive\":true}" >/dev/null

exit 0
