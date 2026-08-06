#!/bin/bash
# Dev server profile — keeps everything out of the production ~/.ttym.
#
# Production (do not touch):  port 7690, ~/.ttym, /Users/lullu/study/ttym/dist
# Dev (this file):            port 7691, ~/.ttym-dev, this worktree's dist
#
# Usage:
#   source scripts/dev-env.sh      then run ./dist/ttym <cmd>
#   ./scripts/dev-env.sh start     one-shot: start the dev server
#   ./scripts/dev-env.sh stop
#   ./scripts/dev-env.sh status

ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"

export TTYM_HOME="$HOME/.ttym-dev"
export TTYM_RUNTIME_DIR="$TTYM_HOME/run"
export PORT=7691
export TTYM_HOLDER_BIN="$ROOT/dist/ttym-holder"

mkdir -p "$TTYM_RUNTIME_DIR"

# Guard: refuse to run if anything still points at the production home.
case "$TTYM_HOME" in
  "$HOME/.ttym") echo "REFUSING: TTYM_HOME points at production" >&2; return 1 2>/dev/null || exit 1 ;;
esac

if [ "${BASH_SOURCE[0]}" = "$0" ]; then
  # Executed, not sourced — act as a thin wrapper around the dev CLI.
  exec "$ROOT/dist/ttym" "$@"
fi

echo "dev env loaded — port $PORT, home $TTYM_HOME, holder $TTYM_HOLDER_BIN"
