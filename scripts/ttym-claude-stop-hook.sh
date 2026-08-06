#!/bin/sh
# ttym-claude-stop-hook.sh — Claude Code turn-end hook
#
# Installed for Stop, StopFailure and SessionEnd. Only Stop means the agent
# answered; the other two mean it will not, and reporting them is what keeps a
# waiting interaction from blocking until its timeout.
#
# The event name is passed as $1 by the installer. It defaults to Stop so an
# older settings.json entry keeps working.

[ -z "$TTYM_SESSION_ID" ] && exit 0

EVENT="${1:-Stop}"

HOOK_PAYLOAD=$(cat)
CLAUDE_SESSION=$(printf '%s' "$HOOK_PAYLOAD" | jq -r .session_id 2>/dev/null)

if [ -n "$CLAUDE_SESSION" ] && [ "$CLAUDE_SESSION" != "null" ]; then
  ttym meta "$TTYM_SESSION_ID" --clear-claude-session "$CLAUDE_SESSION" >/dev/null 2>&1
else
  ttym meta "$TTYM_SESSION_ID" --clear-claude-session >/dev/null 2>&1
fi

# Settle whatever interaction is in flight for this session. The server owns
# that state now, so nothing here writes to session meta — a user key can no
# longer stall an await the way meta.seq / meta.stopSeq could.
ttym hook report-stop "$TTYM_SESSION_ID" --event "$EVENT" >/dev/null 2>&1

# Legacy signal, still written so a v2 CLI polling meta.stopSeq keeps working
# during a rollback. Remove once no v2 client remains.
CURRENT_SEQ=$(ttym meta "$TTYM_SESSION_ID" 2>/dev/null | jq -r '.seq // "0"')
ttym meta "$TTYM_SESSION_ID" --set stopSeq="$CURRENT_SEQ" --set stopAt="$(date +%s)" >/dev/null 2>&1
