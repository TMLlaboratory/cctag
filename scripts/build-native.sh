#!/usr/bin/env bash
# cctag の3エントリポイント（standalone / hub / spoke）を bun でネイティブバイナリにビルドする。
#
# nixpkgs の bun は使わない: nix ICU にリンクした生成物は GC でライブラリが消えて起動不能になる
# （2026-07 に cctag-spoke で実際に発生）。公式配布の bun はシステムの
# /usr/lib/libicucore.A.dylib にリンクするため、生成バイナリは nix store に一切依存しない。
set -euo pipefail

REPO_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
DIST_DIR="$HOME/.local/share/cctag"
BIN_DIR="$HOME/.local/bin"
BUN_TMP="$(mktemp -d)"
trap 'rm -rf "$BUN_TMP"' EXIT

ARCH="$(uname -m)"
case "$ARCH" in
  arm64) BUN_ASSET="bun-darwin-aarch64.zip"; BUN_SUBDIR="bun-darwin-aarch64" ;;
  x86_64) BUN_ASSET="bun-darwin-x64.zip"; BUN_SUBDIR="bun-darwin-x64" ;;
  *) echo "unsupported arch: $ARCH" >&2; exit 1 ;;
esac

echo "==> Downloading official bun ($BUN_ASSET, ephemeral)"
curl -fsSL -o "$BUN_TMP/bun.zip" "https://github.com/oven-sh/bun/releases/latest/download/$BUN_ASSET"
unzip -oq "$BUN_TMP/bun.zip" -d "$BUN_TMP"
BUN="$BUN_TMP/$BUN_SUBDIR/bun"

cd "$REPO_DIR"
echo "==> Installing dependencies"
"$BUN" install

mkdir -p "$DIST_DIR" "$BIN_DIR"

build_target() {
  local name="$1" entry="$2"
  echo "==> Building $name from $entry"
  "$BUN" build --compile "$entry" --outfile "$DIST_DIR/$name"
  ln -sf "$DIST_DIR/$name" "$BIN_DIR/$name"
}

build_target cctag       src/index.ts
build_target cctag-hub   src/hub/index.ts
build_target cctag-spoke src/spoke/index.ts

echo "==> Verifying ICU linkage (should show /usr/lib, not /nix/store)"
for name in cctag cctag-hub cctag-spoke; do
  otool -L "$DIST_DIR/$name" | grep -i icu || true
done

echo "==> Done. Binaries:"
for name in cctag cctag-hub cctag-spoke; do
  echo "  $BIN_DIR/$name -> $DIST_DIR/$name"
done
