#!/bin/sh
# ttym-hook-nested.sh — sourced by the Claude Code hooks (not run on its own).
#
# `ttym_nested_claude` succeeds when the claude that fired the hook is running inside another claude:
# a `claude -p` a subagent started from a Bash tool, say. Such a child inherits the pane's
# TTYM_SESSION_ID, so without this check its SessionStart/Stop hooks would overwrite the pane's
# claudeSessionId with the child's and settle the parent's await. Only the outermost claude owns the pane.
#
# Walks up from the hook's parent; the first `claude` found is the one firing the hook, a second one above it means nested.
# A process counts as claude when its command's basename is `claude` or a versioned `claude-<digits…>`.

ttym_nested_claude() {
  _pid=$PPID
  _seen=0
  _n=0
  while [ -n "$_pid" ] && [ "$_pid" -gt 1 ] 2>/dev/null && [ "$_n" -lt 40 ]; do
    _cmd=$(ps -o command= -p "$_pid" 2>/dev/null) || break
    [ -z "$_cmd" ] && break
    _first=${_cmd%% *}
    case "${_first##*/}" in
      claude | claude-[0-9]*) _seen=$((_seen + 1)) ;;
    esac
    [ "$_seen" -ge 2 ] && return 0
    _pid=$(ps -o ppid= -p "$_pid" 2>/dev/null | tr -d ' ')
    _n=$((_n + 1))
  done
  return 1
}
