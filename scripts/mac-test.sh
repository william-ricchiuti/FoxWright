#!/bin/bash
# Runs Foxwright's full test suite on macOS against a *throwaway copy* of your Firefox,
# so your real Firefox (and its profile) is never modified.
#   bash scripts/mac-test.sh            # everything (~10 min)
#   bash scripts/mac-test.sh quick      # local suites only (~3 min)
#   bash scripts/mac-test.sh only NAME  # just the real-site tasks matching NAME, both input modes
#   bash scripts/mac-test.sh agent [trusted]  # real Claude Code agent completes 17 tasks (uses your Claude usage, ~$4 with Opus 5.5)
# Ends with a pass/fail table and exits non-zero if any suite failed.
# To keep the run's socket and registry away from your own install, see test/README.md
# ("Testing on your own Mac"): HOME=/private/tmp/<short> bash scripts/mac-test.sh
set -u -o pipefail
cd "$(dirname "$0")/.."
LOG="test/results/mac-run.log"
mkdir -p test/results
exec > >(tee "$LOG") 2>&1

echo "== Foxwright macOS test run $(date)"
sw_vers 2>/dev/null | tr '\n' ' '; echo; uname -m
if ! command -v node >/dev/null; then echo "Node.js 20+ is required (e.g. brew install node)"; exit 1; fi
echo "node $(node --version) at $(command -v node)"
echo "HOME=$HOME"
SRC_FF="/Applications/Firefox.app"
[ -d "$SRC_FF" ] || { echo "Firefox not found in /Applications"; exit 1; }
/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$SRC_FF/Contents/Info.plist" | sed 's/^/Firefox /'

WORK="$(mktemp -d /tmp/foxwright-test.XXXXXX)"
echo "== copying Firefox.app to $WORK (your installed Firefox is not touched)"
ditto "$SRC_FF" "$WORK/Firefox.app"
xattr -dr com.apple.quarantine "$WORK/Firefox.app" 2>/dev/null || true
export FIREFOX="$WORK/Firefox.app/Contents/MacOS/firefox"

echo "== installing and building"
npm install --no-audit --no-fund --silent || exit 1
(cd host && npm install --no-audit --no-fund --silent && npm run build --silent) || exit 1
node scripts/build.mjs && node test/build-fixtures.mjs || exit 1
node host/dist/foxwright.mjs setup | sed 's/\x1b\[[0-9;]*m//g'

RESULTS=()
FAILED=0
# Run one suite, keep its real exit code (not grep's), and record it for the summary.
run() {
  echo; echo "== $*"
  local t0=$SECONDS
  "$@" 2>&1 | grep -v -E '^(Running web|Setting custom|  "|}|Use --verbose|Installed /|Automatic extension)'
  local rc=${PIPESTATUS[0]}
  local status="PASS"
  if [ "$rc" != 0 ]; then status="FAIL($rc)"; FAILED=$((FAILED + 1)); fi
  RESULTS+=("$(printf '%-9s %5ss  %s' "$status" $((SECONDS - t0)) "$*")")
  return 0
}
finish() {
  rm -rf "$WORK"
  echo; echo "== Summary"
  for r in "${RESULTS[@]}"; do echo "  $r"; done
  echo; echo "== done: $((${#RESULTS[@]} - FAILED))/${#RESULTS[@]} passed. Full log: $LOG"
  [ "$FAILED" = 0 ]
  exit $?
}

if [ "${1:-}" = "agent" ]; then
  command -v claude >/dev/null || { echo "The Claude Code CLI (claude) is required for the agent evaluation."; exit 1; }
  if [ "${2:-}" = "trusted" ]; then run node test/agent-eval.mjs --trusted; else run node test/agent-eval.mjs; fi
  echo "Report in test/results/agent-eval-*.md"
  finish
fi
if [ "${1:-}" = "only" ]; then
  run node test/realsites.mjs "${2:-.}"
  run env FOXWRIGHT_E2E_TRUSTED=1 node test/realsites.mjs "${2:-.}"
  finish
fi
run node test/e2e.mjs
run env FOXWRIGHT_E2E_TRUSTED=1 node test/e2e.mjs
run node test/e2e-safety.mjs
run node test/e2e-permissions.mjs
run node test/e2e-store.mjs
run node test/e2e-storebuild.mjs
run node test/e2e-resilience.mjs
run node test/e2e-multi.mjs
run node test/e2e-idle.mjs
if [ "${1:-}" != "quick" ]; then
  run node test/realsites.mjs
  run env FOXWRIGHT_E2E_TRUSTED=1 node test/realsites.mjs
fi
echo; echo "== doctor"; node host/dist/foxwright.mjs doctor | sed 's/\x1b\[[0-9;]*m//g'
finish
