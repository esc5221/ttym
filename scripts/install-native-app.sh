#!/bin/bash
set -euo pipefail

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
APP_NAME="ttym-native.app"
BUILD_APP="$ROOT/packages/desktop/src-tauri/target/release/bundle/macos/$APP_NAME"

if [ ! -d "$BUILD_APP" ]; then
  echo "release app bundle not found: $BUILD_APP"
  echo "run: pnpm run desktop:release"
  exit 1
fi

DEST_ROOT="/Applications"
if [ ! -w "$DEST_ROOT" ]; then
  DEST_ROOT="$HOME/Applications"
  mkdir -p "$DEST_ROOT"
fi

DEST_APP="$DEST_ROOT/$APP_NAME"

if [ -L "$DEST_APP" ] || [ -d "$DEST_APP" ]; then
  rm -rf "$DEST_APP"
fi

ln -s "$BUILD_APP" "$DEST_APP"

echo "installed: $DEST_APP -> $BUILD_APP"
