#!/bin/sh
# Assemble the Firefox build in dist/firefox (same code, MV2 manifest).
set -e
cd "$(dirname "$0")"
rm -rf dist/firefox
mkdir -p dist/firefox
cp -R shared.js routing.js check-fetch.js platform-firefox.js theme.css background.js popup options icons dist/firefox/
cp manifest.firefox.json dist/firefox/manifest.json
echo "Firefox build created: dist/firefox"
echo "Load it in Firefox from dist/firefox/manifest.json"
