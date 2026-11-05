#!/usr/bin/env bash
# Runs the tests for the app's JavaScript (Node 18 or newer). The first run
# installs jsdom into tests/node_modules (git-ignored).
#
#   bash tests/run.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")"
[ -d node_modules/jsdom ] || npm install --no-audit --no-fund --silent
REPO="$(cd .. && pwd)"
TESTS="$PWD"
for t in test-voice-patches.js test-loader.js; do
  node "$t" "$REPO" | tail -n 1
done
for t in test-dom.js test-tweaks2.js test-patch.js test-chrome.js; do
  node "$t" "$REPO" "$TESTS" 2>/dev/null | tail -n 1
done
echo "Bracket balance (Objective-C):"
node balance.js "$REPO"/ClaudeLegacy/*.m
