#!/bin/bash
# Run a branch as its own ttym — beside production, never on top of it.
#
#   prod   launchd · port 7690 · ~/.ttym      · the tree named in its plist
#   dev    this tree · port 7692 · ~/.ttym-dev · this tree's dist/ and packages/web/dist
#
# The server bundle finds the web app relative to itself (../packages/web/dist),
# so building inside a worktree gives dev its own UI without any code change.
# Building inside the prod tree would overwrite the web dist the live server
# reads from disk — so this script refuses to run there.
#
#   git worktree add .worktrees/<branch> <branch>      (.worktrees/ is gitignored)
#   cd .worktrees/<branch> && scripts/dev.sh up      build everything, start (self-daemonised)
#   scripts/dev.sh web                              rebuild the web app only — reload the browser
#   scripts/dev.sh restart                          server/holder changed
#   scripts/dev.sh down | status | logs
#   scripts/dev.sh <ttym args…>                     any other ttym command against dev
#
# Hooks (Claude Code SessionStart/Stop) are global in ~/.claude/settings.json and
# point at prod's scripts/. A dev session still reports to the dev server —
# the holder stamps TTYM_PORT into the session env and the hook uses it — but
# a *changed* hook script is not exercised until `ttym agent install` is run
# from the dev tree, which changes it for prod too. Keep hook scripts
# backward compatible when that happens.
set -eo pipefail

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
export TTYM_HOME="${TTYM_DEV_HOME:-$HOME/.ttym-dev}"
export PORT="${TTYM_DEV_PORT:-7692}"
export TTYM_HOLDER_BIN="$ROOT/dist/ttym-holder"
TTYM="$ROOT/dist/ttym"

# ── guards ────────────────────────────────────────────────────────────────
case "$TTYM_HOME" in
  "$HOME/.ttym"|"$HOME/.ttym/") echo "refusing: TTYM_HOME is production ($TTYM_HOME)" >&2; exit 1 ;;
esac
PLIST="$HOME/Library/LaunchAgents/com.lullu.ttym-server.plist"
if [ -f "$PLIST" ]; then
  PROD_JS="$(plutil -extract ProgramArguments.1 raw -o - "$PLIST" 2>/dev/null || true)"
  PROD_ROOT="$(cd "$(dirname "${PROD_JS:-/nonexistent}")/.." 2>/dev/null && pwd || true)"
  if [ -n "$PROD_ROOT" ] && [ "$PROD_ROOT" = "$ROOT" ]; then
    echo "refusing: $ROOT is the production tree (launchd runs $PROD_JS)." >&2
    echo "  git worktree add .worktrees/<branch> <branch>  and run this from there." >&2
    exit 1
  fi
fi
mkdir -p "$TTYM_HOME/run"

# ── helpers ───────────────────────────────────────────────────────────────
listening() { lsof -nP -iTCP:"$PORT" -sTCP:LISTEN -t 2>/dev/null | head -1; }
wait_port_free() {
  # The old server holds the port ~7-10s while it persists its checkpoint.
  for _ in $(seq 1 40); do [ -z "$(listening)" ] && return 0; sleep 0.5; done
  echo "port $PORT still held by pid $(listening)" >&2; return 1
}
wait_up() {
  for _ in $(seq 1 40); do
    curl -s -m 1 "http://127.0.0.1:$PORT/api/version" >/dev/null 2>&1 && return 0
    sleep 0.5
  done
  echo "server did not answer on $PORT — see $TTYM_HOME/ttym.log" >&2; return 1
}
build_all() { (cd "$ROOT" && scripts/build.sh); }
build_web() { (cd "$ROOT" && pnpm --dir packages/web build 2>&1 | tail -1); }
start() { "$TTYM" start --port "$PORT"; wait_up; }
stop() { [ -n "$(listening)" ] && "$TTYM" stop || true; wait_port_free; }

# ── commands ──────────────────────────────────────────────────────────────
case "${1:-}" in
  up)       build_all; stop; start; echo "dev up → http://localhost:$PORT  (home $TTYM_HOME, tree $ROOT)" ;;
  web)      build_web; echo "web rebuilt — reload the browser" ;;
  restart)  build_all; stop; start; echo "dev restarted on $PORT" ;;
  down)     stop; echo "dev down" ;;
  status)
    pid="$(listening)"
    if [ -n "$pid" ]; then
      js="$(ps -o command= -p "$pid" | awk '{print $2}')"
      echo "dev: pid $pid on $PORT, bundle $js, home $TTYM_HOME"
      [ "$(cd "$(dirname "$js")/.." && pwd)" = "$ROOT" ] || echo "  ! that bundle is not from this tree ($ROOT)"
    else echo "dev: not running (port $PORT free)"; fi ;;
  logs)     tail -n "${2:-40}" -f "$TTYM_HOME/ttym.log" ;;
  ""|-h|--help) sed -n '2,25p' "$0" ;;
  *)        exec "$TTYM" "$@" ;;
esac
