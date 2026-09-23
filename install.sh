#!/bin/sh
# ttym installer: downloads the prebuilt tarball for this machine from GitHub
# Releases, checks its sha256, and installs it into one fixed folder.
#
#   curl -fsSL https://raw.githubusercontent.com/esc5221/ttym/master/install.sh | sh
#
# The folder never moves, because `ttym service install` writes the server path
# into the launchd plist / systemd unit and `ttym agent install` writes the hook
# paths into the agents' settings. `ttym upgrade` later swaps the whole folder by
# rename, so both keep pointing at the right files.
#
# Environment:
#   TTYM_VERSION      tag to install (default: the latest release), e.g. v0.3.0
#   TTYM_INSTALL_DIR  install folder (default: ~/.local/share/ttym)
#   TTYM_BIN_DIR      where the `ttym` link goes (default: ~/.local/bin)
#   TTYM_TARBALL      install this local tarball instead of downloading (testing)
#
# POSIX sh on purpose: `curl … | sh` runs dash on Debian/Ubuntu.
set -eu

REPO="esc5221/ttym"
ROOT="${TTYM_INSTALL_DIR:-$HOME/.local/share/ttym}"
BIN_DIR="${TTYM_BIN_DIR:-$HOME/.local/bin}"

say() { printf '%s\n' "$*"; }
die() { printf 'ttym install: %s\n' "$*" >&2; exit 1; }

# ── platform
case "$(uname -s)" in
  Darwin) os=darwin ;;
  Linux) os=linux ;;
  *) die "unsupported OS $(uname -s) (macOS and Linux only)" ;;
esac
case "$(uname -m)" in
  arm64 | aarch64) arch=arm64 ;;
  x86_64 | amd64) arch=x64 ;;
  *) die "unsupported CPU $(uname -m) (arm64 and x86_64 only)" ;;
esac
platform="$os-$arch"

# ── Node ≥ 20 runs the CLI and the server
command -v node >/dev/null 2>&1 || die "Node.js 20 or newer is required (https://nodejs.org). Install it, then run this again."
node_major=$(node -p 'process.versions.node.split(".")[0]')
[ "$node_major" -ge 20 ] || die "Node.js 20 or newer is required; found $(node -v)"

command -v tar >/dev/null 2>&1 || die "tar is required"
sha256() {
  if command -v sha256sum >/dev/null 2>&1; then sha256sum "$1" | cut -d' ' -f1
  elif command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | cut -d' ' -f1
  else die "sha256sum or shasum is required"; fi
}

tmp=$(mktemp -d)
trap 'rm -rf "$tmp"' EXIT INT TERM

# ── fetch + verify
asset="ttym-$platform.tar.gz"
if [ -n "${TTYM_TARBALL:-}" ]; then
  [ -f "$TTYM_TARBALL" ] || die "no such file: $TTYM_TARBALL"
  cp "$TTYM_TARBALL" "$tmp/$asset"
  say "installing from $TTYM_TARBALL"
else
  command -v curl >/dev/null 2>&1 || die "curl is required"
  if [ -n "${TTYM_VERSION:-}" ]; then base="https://github.com/$REPO/releases/download/$TTYM_VERSION"
  else base="https://github.com/$REPO/releases/latest/download"; fi
  say "downloading $asset …"
  curl -fsSL -o "$tmp/$asset" "$base/$asset" || die "download failed: $base/$asset"
  curl -fsSL -o "$tmp/$asset.sha256" "$base/$asset.sha256" || die "download failed: $base/$asset.sha256"
  want=$(cut -d' ' -f1 <"$tmp/$asset.sha256")
  got=$(sha256 "$tmp/$asset")
  [ "$want" = "$got" ] || die "checksum mismatch for $asset (expected $want, got $got)"
  say "checksum ok"
fi

# ── unpack next to the target, then swap by rename
if [ -e "$ROOT" ] && [ ! -f "$ROOT/install.json" ]; then
  die "$ROOT exists and was not made by this installer; move it away or set TTYM_INSTALL_DIR"
fi
mkdir -p "$(dirname "$ROOT")"
next="$ROOT.next"
rm -rf "$next"
mkdir -p "$next"
tar -xzf "$tmp/$asset" -C "$next"
[ -f "$next/dist/ttym-server.js" ] && [ -x "$next/dist/ttym-holder" ] || { rm -rf "$next"; die "$asset is missing files"; }
if [ -e "$ROOT" ]; then
  rm -rf "$ROOT.prev"
  mv "$ROOT" "$ROOT.prev"
fi
mv "$next" "$ROOT"
version=$(node -p "require('$ROOT/install.json').version")

# ── the command
mkdir -p "$BIN_DIR"
link="$BIN_DIR/ttym"
if [ -L "$link" ]; then
  old=$(readlink "$link")
  [ "$old" = "$ROOT/dist/ttym" ] || say "replacing $link (was → $old)"
  rm -f "$link"
elif [ -e "$link" ]; then
  die "$link exists and is not a link; remove it and run this again"
fi
ln -s "$ROOT/dist/ttym" "$link"

say ""
say "ttym $version installed → $ROOT"
case ":$PATH:" in
  *":$BIN_DIR:"*) ;;
  *)
    shell_rc="~/.profile"
    case "${SHELL:-}" in */zsh) shell_rc="~/.zshrc" ;; */bash) shell_rc="~/.bashrc" ;; esac
    say ""
    say "$BIN_DIR is not on your PATH. Add it:"
    say "  echo 'export PATH=\"$BIN_DIR:\$PATH\"' >> $shell_rc && export PATH=\"$BIN_DIR:\$PATH\""
    ;;
esac
say ""
say "next:"
say "  ttym service install         # keep the server running: starts at login, restarts on crash"
say "  ttym agent install claude    # hooks for Claude Code (codex works too)"
say "  ttym                         # open a workspace; the browser view is http://localhost:7690"
if [ -e "$ROOT.prev" ]; then
  say ""
  say "an earlier install was replaced; restart the server to run the new one: ttym restart (sessions survive)"
fi
