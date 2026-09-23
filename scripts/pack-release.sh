#!/bin/bash
# GitHub Release tarball for one platform — what install.sh downloads.
#   scripts/pack-release.sh <platform> [holder] [outdir]
#   → <outdir>/ttym-<platform>.tar.gz + .sha256
#
# Same layout as the repo and the npm package: the server reads the web app
# from dist/../packages/web/dist and `ttym agent install` points hooks at
# dist/../scripts/*.sh. install.json marks the folder as a release install, so
# `ttym upgrade` knows to fetch the next tarball instead of building.
# Asset names carry no version: releases/latest/download/<asset> then always
# resolves, and install.sh needs no GitHub API call.
set -eo pipefail
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
PLATFORM="${1:?usage: pack-release.sh <platform> [holder] [outdir]}"
DIST="${TTYM_DIST:-$ROOT/dist}"
HOLDER="${2:-$DIST/ttym-holder}"
OUT="${3:-$ROOT/release-staging}"
VERSION=$(node -p "require('$ROOT/package.json').version")

[ -f "$DIST/ttym" ] && [ -f "$DIST/ttym-server.js" ] || { echo "no $DIST build — run scripts/build.sh"; exit 1; }
[ -f "$ROOT/packages/web/dist/index.html" ] || { echo "no packages/web/dist — run scripts/build.sh"; exit 1; }
[ -f "$HOLDER" ] || { echo "no holder at $HOLDER"; exit 1; }

stage="$OUT/stage-$PLATFORM"
rm -rf "$stage"; mkdir -p "$stage/dist" "$stage/packages/web" "$stage/scripts"
cp "$DIST/ttym" "$DIST/ttym-server.js" "$DIST/package.json" "$stage/dist/"
cp "$HOLDER" "$stage/dist/ttym-holder"
cp -R "$ROOT/packages/web/dist" "$stage/packages/web/dist"
cp "$ROOT"/scripts/ttym-*-hook.sh "$ROOT/scripts/ttym-shell-integration.zsh" "$stage/scripts/"
chmod 755 "$stage/dist/ttym" "$stage/dist/ttym-holder" "$stage/scripts/"*.sh
printf '{ "kind": "release", "repo": "esc5221/ttym", "version": "%s", "platform": "%s" }\n' "$VERSION" "$PLATFORM" > "$stage/install.json"

asset="ttym-$PLATFORM.tar.gz"
COPYFILE_DISABLE=1 tar -czf "$OUT/$asset" -C "$stage" .
(cd "$OUT" && if command -v sha256sum >/dev/null; then sha256sum "$asset"; else shasum -a 256 "$asset"; fi > "$asset.sha256")
rm -rf "$stage"
echo "packed: $OUT/$asset (v$VERSION)"
