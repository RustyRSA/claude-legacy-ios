#!/usr/bin/env bash
# tools/pull-log.sh - fetches the app's debug log from the iPhone over SSH.
#
#   bash tools/pull-log.sh          saves phone-logs/debug-log-<time>.txt and prints its path
#
# The app writes Documents/debug-log.txt in its data folder each time it goes to
# the background (and on "Copy debug log"). The phone's address comes from
# ~/.claude-legacy-phone (set by tools/update.sh --phone). With the key in the
# Windows SSH agent, put Windows' ssh first:
#   PATH="/c/WINDOWS/System32/OpenSSH:$PATH" bash tools/pull-log.sh
set -euo pipefail
cd "$(dirname "${BASH_SOURCE[0]}")/.."
PHONE="$(cat "$HOME/.claude-legacy-phone" 2>/dev/null || true)"
[ -n "$PHONE" ] || { echo "No phone address saved. Run: bash tools/update.sh --phone root@<address>" >&2; exit 1; }
REMOTE="$(ssh -o BatchMode=yes -o ConnectTimeout=8 "$PHONE" 'ls -t /var/mobile/Containers/Data/Application/*/Documents/debug-log.txt 2>/dev/null | head -n 1')"
[ -n "$REMOTE" ] || { echo "No debug-log.txt on the phone yet: open the app, use it, then leave it (home screen)." >&2; exit 1; }
mkdir -p phone-logs
OUT="phone-logs/debug-log-$(date +%Y%m%d-%H%M%S).txt"
scp -q -o BatchMode=yes "$PHONE:$REMOTE" "$OUT"
echo "$OUT"
