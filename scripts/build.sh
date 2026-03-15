#!/bin/bash
set -e

ROOT="$(cd "$(dirname "$0")/.." && pwd)"
DIST="$ROOT/dist"

echo "=== ttym build ==="

# Clean
rm -rf "$DIST"
mkdir -p "$DIST"

# 1. Rust holder
echo "[1/3] Building holder (Rust)..."
cd "$ROOT/holder"
cargo build --release 2>&1 | tail -1
cp target/release/ttym-holder "$DIST/"
# macOS: cp invalidates ad-hoc code signature; re-sign so forkpty works
if [ "$(uname)" = "Darwin" ]; then
  codesign -f -s - "$DIST/ttym-holder" 2>/dev/null
fi
echo "      $(du -h "$DIST/ttym-holder" | cut -f1) ttym-holder"

# 2. Server bundle
echo "[2/3] Bundling server (esbuild)..."
cd "$ROOT"
npx esbuild server/src/index.ts \
  --bundle \
  --platform=node \
  --format=esm \
  --target=node20 \
  --external:better-sqlite3 \
  --outfile="$DIST/ttym-server.js" \
  --banner:js='import { createRequire } from "module"; const require = createRequire(import.meta.url); const __filename = decodeURIComponent(new URL(import.meta.url).pathname); const __dirname = decodeURIComponent(new URL(".", import.meta.url).pathname).replace(/\/$/, "");' \
  2>&1 | tail -1
echo "      $(du -h "$DIST/ttym-server.js" | cut -f1) ttym-server.js"

# 3. CLI + package.json
echo "[3/3] Copying CLI..."
cp "$ROOT/bin/ttym" "$DIST/ttym"
chmod +x "$DIST/ttym"
echo '{"type":"module"}' > "$DIST/package.json"

echo ""
echo "=== Build complete ==="
echo ""
ls -lh "$DIST/"
echo ""
echo "Usage:"
echo "  ./dist/ttym start          # Start server"
echo "  ./dist/ttym status         # Show status"
echo "  ./dist/ttym stop           # Stop server"
