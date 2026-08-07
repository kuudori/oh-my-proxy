#!/bin/sh
# Assemble the Firefox build in dist/firefox (same code, MV2 manifest).
set -e
cd "$(dirname "$0")"

OUT=dist/firefox

rm -rf "$OUT"
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

echo "Firefox build created: $OUT"
echo "Load it in Firefox from $OUT/manifest.json"
