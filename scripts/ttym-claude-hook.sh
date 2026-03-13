#!/bin/sh
# ttym-claude-hook.sh — Claude Code SessionStart hook
# Maps Claude Code session to the ttym session it's running inside.
#
# Install (add to ~/.claude/settings.json):
#
#   {
#     "hooks": {
#       "SessionStart": [
#         {
#           "hooks": [
#             {
#               "type": "command",
#               "command": "/path/to/ttym-claude-hook.sh"
#             }
#           ]
#         }
#       ]
#     }
#   }
#
# Or inline:
#
#   "command": "[ -n \"$TTYM_SESSION_ID\" ] && jq -r .session_id | xargs -I{} ttym meta $TTYM_SESSION_ID --claude-session {}"
#
# How it works:
#   1. Holder sets TTYM_SESSION_ID in child shell environment
#   2. Claude Code fires SessionStart hook, piping { session_id, cwd, ... } to stdin
#   3. This script extracts session_id and source and stores them as ttym session meta

[ -z "$TTYM_SESSION_ID" ] && exit 0

HOOK_PAYLOAD=$(cat)
CLAUDE_SESSION=$(printf '%s' "$HOOK_PAYLOAD" | jq -r .session_id 2>/dev/null)
[ -z "$CLAUDE_SESSION" ] && exit 0
CLAUDE_SOURCE=$(printf '%s' "$HOOK_PAYLOAD" | jq -r '.source // "startup"' 2>/dev/null)

ttym meta "$TTYM_SESSION_ID" --claude-source "$CLAUDE_SOURCE" --claude-session "$CLAUDE_SESSION" >/dev/null 2>&1
