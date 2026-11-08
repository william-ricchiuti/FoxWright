# Tests

These tests run a real Firefox (via `web-ext run`, headless by default) with the Kitsune extension. They start the MCP server and drive it with an MCP client, against local fixture pages in `fixtures/`, served on two free local ports (`KITSUNE_P1`, `KITSUNE_P2`) that the harness picks.

| Script | What it covers |
|---|---|
| `e2e.mjs` | 57 scenarios: outline and find, forms, React, ProseMirror, iframes (including `about:blank`/`srcdoc` editors), closed shadow roots, password masking, dialogs, drag-and-drop, keys, console, network, tabs, parallel calls, GIFs. Set `KITSUNE_E2E_TRUSTED=1` to run them all through WebDriver BiDi. |
| `e2e-safety.mjs` | Presses the real buttons in the permission window and the toolbar popup through the test's own WebDriver BiDi session: Deny, Allow this session, Always allow + revoke, Pause/Resume (also while typing and while a prompt is open), upload approval. |
| `e2e-permissions.mjs` | Approval timeouts, concurrent-call blocking, frame gating, upload confirmation, credential-file refusal. |
| `e2e-store.mjs` | The AMO build (no `javascript_tool`). |
| `e2e-resilience.mjs` | Two MCP clients at once, latency, helper crash, Firefox restart. |
| `e2e-idle.mjs` | Still answers after the event page's idle timeout (takes about 75 s). |
| `bidi-connect.mjs` | The real-input (WebDriver BiDi) client against a fake Firefox that allows one session: overlapping connection attempts share one session. No browser needed. |
| `bench-actions.mjs` | Median latency of common tool calls. |
| `realsites.mjs` | 51 tasks on real websites (needs internet access). |
| `agent-eval.mjs` + `agent-tasks.mjs` | A real Claude Code agent does 17 tasks; independent checks. Needs the `claude` CLI and costs about $4 per run with Opus 5.5 (less with a cheaper --model). Options: `--trusted`, `--ask`, `--repeat N`, `--only REGEX`. |
| `measure-outline.mjs` | Outline sizes on real sites. |

Helpers: `harness.mjs` (fixture servers, Firefox, MCP client), `bidi-driver.mjs` (acts as the person at the computer), `build-fixtures.mjs` (bundles the React and ProseMirror fixtures).

Before running:

- Build with `npm run build` and `node test/build-fixtures.mjs`.
- Set `FIREFOX` to a Firefox 152+ binary (there's no default).
- On Linux the harness sets up the helper in a temporary home folder, so your own `~/.kitsune` and native-messaging registration aren't touched (set `KITSUNE_E2E_ISOLATE=0` to use them instead). On macOS the tests use your real `~/.kitsune`; `scripts/mac-test.sh` handles this and uses a throwaway copy of Firefox.
- To see the browser, set `KITSUNE_E2E_HEADFUL=1` (under Xvfb on a server).
- Behind a TLS-intercepting proxy (e.g. a CI sandbox), set `KITSUNE_E2E_PROXY=host:port` and `KITSUNE_E2E_PROXY_CA=/path/to/proxy-ca.crt` for the real-site suites.
