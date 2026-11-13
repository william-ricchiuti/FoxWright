# Contributing to Foxwright

Thanks for helping. Bug reports with a site and steps to reproduce are the most useful thing you can send; the issue templates ask for what's needed.

## Setup

```sh
npm ci && npm ci --prefix host
npm run build                  # extension → dist/store + dist/full, helper → host/dist/foxwright.mjs
node test/build-fixtures.mjs   # React and ProseMirror test pages
```

Load `dist/full/manifest.json` from `about:debugging#/runtime/this-firefox` and run `node host/dist/foxwright.mjs setup` to try it by hand.

## Where things are

- `src/content/`: content scripts: page outline (`snapshot.ts`), input (`input.ts`), text (`text.ts`), overlay, console/dialog hooks (`hooks.ts`, isolated world) and pointer-capture emulation (`page-hooks.ts`, page world).
- `src/background/`: the event page: native messaging, tab group, permissions, the tools.
- `extension/`: manifest, toolbar popup, permission window.
- `host/src/`: the helper, the MCP server (`mcp.js`), WebDriver BiDi input (`bidi.js`), setup/doctor.
- `vendor/playwright/`: unmodified upstream files; build-time patches are in `scripts/build.mjs` and listed in `vendor/playwright/README.md` and `NOTICE`.
- `test/`: see `test/README.md`.

## Before opening a pull request

```sh
export FIREFOX=/path/to/firefox          # Firefox 152 or newer
node test/e2e.mjs && FOXWRIGHT_E2E_TRUSTED=1 node test/e2e.mjs
node test/e2e-safety.mjs && node test/e2e-permissions.mjs && node test/e2e-store.mjs
npx web-ext lint --source-dir dist/store
```

- Add a test for new behavior. Fixtures go in `test/fixtures/` and must not load anything from the internet.
- Anything that changes what the agent can reach (permissions, frames, uploads, dialogs, tabs) needs a test in `test/e2e-safety.mjs` or `test/e2e-permissions.mjs`, and a line in the README's safety model if users should know.
- Tool results are read by a model: keep them short and plain, and say what to do next when something fails.
- Keep the store build free of anything that runs code strings (AMO policy); full-build-only code goes behind `__FOXWRIGHT_FULL__`.
- Add a line to the "Unreleased" section of `CHANGELOG.md`.

## Releasing

See [docs/RELEASE.md](docs/RELEASE.md). `node scripts/version.mjs bump X.Y.Z` sets the version everywhere.
