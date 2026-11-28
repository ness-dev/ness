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
#   mobile/assets/icon.png                      1024  Expo app icon (iOS)
#   mobile/assets/android-icon-foreground.png   1024  adaptive icon: the mark
#   mobile/assets/android-icon-background.png   1024  adaptive icon: plate colour
#   mobile/assets/android-icon-monochrome.png   1024  themed (Material You) icon
#   mobile/assets/splash-icon.png                     the mark, trimmed, for splash
#   mobile/assets/favicon.png                     48  Expo web
#
# Full-bleed outputs (maskable, apple-touch-icon, the mobile app icon): iOS
# and Android apply their own mask, so they get a square filled edge to edge
# instead of the padded rounded rect. The mobile app icon is also opaque —
# App Store icons may not have an alpha channel — and cropped to the plate. Android's adaptive icon is
# layered instead: the mark alone in front of a plate-coloured background
# (the mark sits well inside the 66% safe zone at the artwork's scale).
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

# The mark alone (no rounded plate), and a white copy of it for Android's
# monochrome layer.
MARK=$(mktemp -d)
sed '/<rect /d' "$SRC" > "$MARK/mark.svg"
sed -E 's/(<g [^>]*fill=")[^"]*"/\1#ffffff"/' "$MARK/mark.svg" > "$MARK/mark-white.svg"
trap 'rm -rf "$MARK"' EXIT

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

echo "mobile app icons"
# Cropped to the plate (rendered so the 832-unit plate spans 1024) rather
# than flattening the padding: iOS draws its own rounded mask, and this keeps
# the mark the same size relative to the icon shape as on the Mac app icon.
PLATE=$(sed -n 's/.*<rect[^>]*width="\([0-9]*\)".*/\1/p' "$SRC" | head -1)
rsvg-convert -w $((1024 * 1024 / PLATE)) -h $((1024 * 1024 / PLATE)) "$SRC" \
  | magick - -gravity center -crop 1024x1024+0+0 +repage -background "$BG" -flatten -alpha off mobile/assets/icon.png
echo "  mobile/assets/icon.png  1024x1024  plate, opaque"
rsvg-convert -w 1024 -h 1024 "$MARK/mark.svg" -o mobile/assets/android-icon-foreground.png
rsvg-convert -w 1024 -h 1024 "$MARK/mark-white.svg" -o mobile/assets/android-icon-monochrome.png
magick -size 1024x1024 "xc:$BG" mobile/assets/android-icon-background.png
rsvg-convert -w 1024 -h 1024 "$MARK/mark.svg" | magick - -trim +repage mobile/assets/splash-icon.png
png mobile/assets/favicon.png 48
echo "  mobile/assets/android-icon-{foreground,background,monochrome}.png, splash-icon.png"

echo "done"
