#!/bin/sh
# Source archive for AMO review (reviewers rebuild with: npm ci && npm run build).
set -e
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
mkdir -p dist/zips
OUT="dist/zips/kitsune-source-$VERSION.zip"
rm -f "$OUT"
zip -r -q "$OUT" README.md PRIVACY.md LICENSE NOTICE package.json package-lock.json scripts src extension vendor docs \
  -x '*/node_modules/*' '*.DS_Store'
echo "wrote $OUT"
