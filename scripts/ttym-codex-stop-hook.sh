#!/bin/sh
# ttym-codex-stop-hook.sh — Codex CLI Stop hook
# Clears the active Codex mapping and signals completion for await.

[ -z "$TTYM_SESSION_ID" ] && exit 0

HOOK_PAYLOAD=$(cat)
CODEX_SESSION=$(printf '%s' "$HOOK_PAYLOAD" | jq -r .session_id 2>/dev/null)

if [ -n "$CODEX_SESSION" ] && [ "$CODEX_SESSION" != "null" ]; then
  ttym meta "$TTYM_SESSION_ID" --clear-codex-session "$CODEX_SESSION" >/dev/null 2>&1
else
  ttym meta "$TTYM_SESSION_ID" --clear-codex-session >/dev/null 2>&1
fi

# Signal completion: copy current request seq to stopSeq so callers can detect response end
CURRENT_SEQ=$(ttym meta "$TTYM_SESSION_ID" 2>/dev/null | jq -r '.seq // "0"')
ttym meta "$TTYM_SESSION_ID" --set stopSeq="$CURRENT_SEQ" --set stopAt="$(date +%s)" >/dev/null 2>&1
