# Tests

These tests run a real Firefox (via `web-ext run`, headless by default) with the Kitsune extension. They start the MCP server and drive it with an MCP client, against local fixture pages in `fixtures/` served on ports 8765 and 8766.

| Script | What it covers |
|---|---|
| `e2e.mjs` | 43 scenarios: outline and find, forms, React, ProseMirror, iframes, drag-and-drop, keys, console, network, tabs. Set `KITSUNE_E2E_TRUSTED=1` to run them all through WebDriver BiDi. |
| `e2e-permissions.mjs` | Approval windows, concurrent-call blocking, frame gating, upload confirmation, credential-file refusal. |
| `e2e-store.mjs` | The AMO build (no `javascript_tool`). |
| `e2e-idle.mjs` | Still answers after the event page's idle timeout. |
| `e2e-realsites.mjs` | A few real websites (needs internet access; not run by default). |

Before running:

- Build first with `npm run build`, then `node host/dist/kitsune.mjs setup`.
- Point `FIREFOX` at a Firefox 140+ binary.
- Fixture bundles (React, ProseMirror) are built with esbuild: `node test/build-fixtures.mjs`.
- To see the browser, set `KITSUNE_E2E_HEADFUL=1` (under Xvfb on a server).
