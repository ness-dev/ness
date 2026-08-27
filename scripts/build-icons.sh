#!/usr/bin/env bash
#
# Regenerate every raster icon in the repo from resources/icon.svg.
#
#   bash scripts/build-icons.sh
#
# Outputs:
#   resources/icon.png           1024  electron-builder source (mac/win/linux)
#   resources/icon-original.png  512   the pre-resize original kept alongside it
#   resources/icon.icns                macOS bundle icon, built via iconutil
#   site/public/icon.png         512   site favicon + PWA icon
#   site/public/apple-touch-icon.png 180
#   src/web-client/public/icon.png              1024  web client favicon + manifest "any"
#   src/web-client/public/icon-maskable.png     1024  manifest "maskable"
#   src/web-client/public/apple-touch-icon.png  1024  iOS Home Screen
#
# The last two are full-bleed: iOS and Android both apply their own mask, so
# they get a square filled edge to edge instead of the padded rounded rect.
#
# Requires rsvg-convert (brew install librsvg), magick (brew install imagemagick)
# and iconutil (macOS built-in).
# This script does NOT touch electron-builder config — it only rewrites the
# files that config already points at.
set -euo pipefail

cd "$(dirname "$0")/.."
SRC=resources/icon.svg

for bin in rsvg-convert iconutil magick; do
  command -v "$bin" >/dev/null || { echo "missing $bin" >&2; exit 1; }
done

# Flattening onto the same colour the rounded rect is filled with is what makes
# the corners disappear, so read it from the artwork rather than restating it.
BG=$(sed -n 's/.*<rect[^>]*fill="\([^"]*\)".*/\1/p' "$SRC" | head -1)

png() { rsvg-convert -w "$2" -h "$2" "$SRC" -o "$1"; echo "  $1  ${2}x${2}"; }
png_fullbleed() {
  rsvg-convert -w "$2" -h "$2" "$SRC" | magick - -background "$BG" -flatten "$1"
  echo "  $1  ${2}x${2}  full-bleed"
}

echo "app icons"
png resources/icon.png 1024
png resources/icon-original.png 512

echo "icns"
ICONSET=$(mktemp -d)/icon.iconset
mkdir -p "$ICONSET"
for s in 16 32 128 256 512; do
  png "$ICONSET/icon_${s}x${s}.png" $s
  png "$ICONSET/icon_${s}x${s}@2x.png" $((s * 2))
done
iconutil -c icns "$ICONSET" -o resources/icon.icns
rm -rf "$(dirname "$ICONSET")"
echo "  resources/icon.icns"

echo "site icons"
png site/public/icon.png 512
png site/public/apple-touch-icon.png 180

echo "web client icons"
png src/web-client/public/icon.png 1024
png_fullbleed src/web-client/public/icon-maskable.png 1024
png_fullbleed src/web-client/public/apple-touch-icon.png 1024

echo "done"
