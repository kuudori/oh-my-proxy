#!/bin/sh
# Assemble the Firefox build in dist/firefox (same code, MV2 manifest).
set -e
cd "$(dirname "$0")"

VERSION=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' src/manifest.firefox.json | head -1)
[ -n "$VERSION" ] || { echo "could not read version from src/manifest.firefox.json" >&2; exit 1; }

OUT=dist/firefox
ZIP=oh-my-proxy-$VERSION-firefox.zip

rm -rf "$OUT" "$ZIP"
mkdir -p "$OUT"

# Ship everything in src/, then drop what Firefox does not use. The offscreen
# document and its worker are a Chrome MV3 workaround; Firefox fetches from the
# background page directly.
cp -R src/. "$OUT/"
rm -f "$OUT/manifest.json" "$OUT/platform-chrome.js" "$OUT/check-worker.js" \
      "$OUT/offscreen.html" "$OUT/offscreen.js"
mv "$OUT/manifest.firefox.json" "$OUT/manifest.json"

# Icon source art and macOS cruft are not part of the extension.
find "$OUT" -name '*.svg' -delete
find "$OUT" -name '.DS_Store' -delete

# manifest.json must sit at the zip root, so zip from inside the build dir.
(cd "$OUT" && zip -q -r -X "../../$ZIP" .)

echo "Firefox build created: $OUT"
echo "Load it unpacked from $OUT/manifest.json"
echo "Upload this to AMO: $ZIP"
