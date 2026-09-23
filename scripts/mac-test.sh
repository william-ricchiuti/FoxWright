#!/bin/bash
# Runs Kitsune's full test suite on macOS against a *throwaway copy* of your Firefox,
# so your real Firefox (and its profile) is never modified.
#   bash scripts/mac-test.sh            # everything (~10 min)
#   bash scripts/mac-test.sh quick      # local suites only (~3 min)
#   bash scripts/mac-test.sh only NAME  # just the real-site tasks matching NAME, both input modes
set -u
cd "$(dirname "$0")/.."
LOG="test/results/mac-run.log"
mkdir -p test/results
exec > >(tee "$LOG") 2>&1

echo "== Kitsune macOS test run $(date)"
sw_vers 2>/dev/null | tr '\n' ' '; echo; uname -m
if ! command -v node >/dev/null; then echo "Node.js 20+ is required (e.g. brew install node)"; exit 1; fi
echo "node $(node --version) at $(command -v node)"
SRC_FF="/Applications/Firefox.app"
[ -d "$SRC_FF" ] || { echo "Firefox not found in /Applications"; exit 1; }
/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$SRC_FF/Contents/Info.plist" | sed 's/^/Firefox /'

WORK="$(mktemp -d /tmp/kitsune-test.XXXXXX)"
echo "== copying Firefox.app to $WORK (your installed Firefox is not touched)"
ditto "$SRC_FF" "$WORK/Firefox.app"
xattr -dr com.apple.quarantine "$WORK/Firefox.app" 2>/dev/null || true
export FIREFOX="$WORK/Firefox.app/Contents/MacOS/firefox"

echo "== installing and building"
npm install --no-audit --no-fund --silent || exit 1
(cd host && npm install --no-audit --no-fund --silent && npm run build --silent) || exit 1
node scripts/build.mjs && node test/build-fixtures.mjs || exit 1
node host/dist/kitsune.mjs setup | sed 's/\x1b\[[0-9;]*m//g'

run() { echo; echo "== $*"; "$@" 2>&1 | grep -v -E '^(Running web|Setting custom|  "|}|Use --verbose|Installed /|Automatic extension)'; }
if [ "${1:-}" = "only" ]; then
  run node test/realsites.mjs "${2:-.}"
  run env KITSUNE_E2E_TRUSTED=1 node test/realsites.mjs "${2:-.}"
  rm -rf "$WORK"; echo; echo "== done. Full log: $LOG"; exit 0
fi
run node test/e2e.mjs
run env KITSUNE_E2E_TRUSTED=1 node test/e2e.mjs
run node test/e2e-permissions.mjs
run node test/e2e-store.mjs
run node test/e2e-resilience.mjs
run node test/e2e-idle.mjs
if [ "${1:-}" != "quick" ]; then
  run node test/realsites.mjs
  run env KITSUNE_E2E_TRUSTED=1 node test/realsites.mjs
fi
echo; echo "== doctor"; node host/dist/kitsune.mjs doctor | sed 's/\x1b\[[0-9;]*m//g'
rm -rf "$WORK"
echo; echo "== done. Full log: $LOG"
