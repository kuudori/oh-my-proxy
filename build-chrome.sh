#!/bin/sh
# Assemble the Chrome build in dist/chrome and zip it for the Web Store.
set -e
cd "$(dirname "$0")"

VERSION=$(sed -n 's/.*"version"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' src/manifest.json | head -1)
[ -n "$VERSION" ] || { echo "could not read version from src/manifest.json" >&2; exit 1; }

OUT=dist/chrome
ZIP=oh-my-proxy-$VERSION-chrome.zip

rm -rf "$OUT" "$ZIP"
mkdir -p "$OUT"

# Ship everything in src/, then drop what Chrome does not use. Excluding is
# safer than listing: a new source file ships by default instead of being
# silently left out.
cp -R src/. "$OUT/"
rm -f "$OUT/manifest.firefox.json" "$OUT/platform-firefox.js"
cp LICENSE "$OUT/"

# Icon source art and macOS cruft are not part of the extension.
find "$OUT" -name '*.svg' -delete
find "$OUT" -name '.DS_Store' -delete

# manifest.json must sit at the zip root, so zip from inside the build dir.
(cd "$OUT" && zip -q -r -X "../../$ZIP" .)

echo "Chrome build created: $OUT"
echo "Upload this to the Web Store: $ZIP"
