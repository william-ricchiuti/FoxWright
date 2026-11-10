#!/bin/sh
# Source archive for AMO review. Reviewers rebuild the add-on with the steps in BUILDING.txt
# (included in the zip). host/ is included because the root `npm run build` also builds it.
set -e
cd "$(dirname "$0")/.."
VERSION=$(node -p "require('./package.json').version")
mkdir -p dist/zips
OUT="dist/zips/zenko-source-$VERSION.zip"
rm -f dist/zips/zenko-source-*.zip  # also older versions, so the wrong one can't be uploaded
NODE_V=$(node -v)
NPM_V=$(npm -v)
cat > BUILDING.txt <<TXT
Building Zenko $VERSION from source
=====================================

Tested with Node $NODE_V and npm $NPM_V on Linux and macOS (any OS with Node 20+ works).

  npm ci
  npm ci --prefix host
  node scripts/build.mjs          # extension only -> dist/store (listed) and dist/full

The listed add-on is dist/store. Its background.js, content/content.js and
content/page-hooks.js are produced by esbuild from src/ and vendor/playwright/
(syntax-minified only: names and whitespace are kept readable). Everything else
in dist/store is copied as-is from extension/.

To also build the companion helper (npm package "zenko-firefox", not part of
the add-on): npm run build  -> host/dist/zenko.mjs
TXT
zip -r -q "$OUT" BUILDING.txt README.md PRIVACY.md LICENSE NOTICE package.json package-lock.json scripts src extension vendor docs \
  host/src host/build.mjs host/package.json host/package-lock.json host/LICENSE host/README.md \
  -x '*/node_modules/*' '*.DS_Store' 'docs/demo.gif'
rm -f BUILDING.txt
echo "wrote $OUT"
