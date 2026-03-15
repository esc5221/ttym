#!/bin/sh
# ttym-claude-stop-hook.sh — Claude Code Stop hook
# Clears the active Claude mapping for the ttym session while retaining the
# last seen Claude session ID for debugging and resume diagnostics.

[ -z "$TTYM_SESSION_ID" ] && exit 0

HOOK_PAYLOAD=$(cat)
CLAUDE_SESSION=$(printf '%s' "$HOOK_PAYLOAD" | jq -r .session_id 2>/dev/null)

if [ -n "$CLAUDE_SESSION" ] && [ "$CLAUDE_SESSION" != "null" ]; then
  ttym meta "$TTYM_SESSION_ID" --clear-claude-session "$CLAUDE_SESSION" >/dev/null 2>&1
else
  ttym meta "$TTYM_SESSION_ID" --clear-claude-session >/dev/null 2>&1
fi

# Signal completion: copy current request seq to stopSeq so callers can detect response end
CURRENT_SEQ=$(ttym meta "$TTYM_SESSION_ID" 2>/dev/null | jq -r '.seq // "0"')
ttym meta "$TTYM_SESSION_ID" --set stopSeq="$CURRENT_SEQ" --set stopAt="$(date +%s)" >/dev/null 2>&1
