# Tests

These tests run a real Firefox (via `web-ext run`, headless by default) with the Foxwright extension. They start the MCP server and drive it with an MCP client, against local fixture pages in `fixtures/`, served on two free local ports (`FOXWRIGHT_P1`, `FOXWRIGHT_P2`) that the harness picks.

| Script | What it covers |
|---|---|
| `e2e.mjs` | 57 scenarios: outline and find, forms, React, ProseMirror, iframes (including `about:blank`/`srcdoc` editors), closed shadow roots, password masking, dialogs, drag-and-drop, keys, console, network, tabs, parallel calls, GIFs. Set `FOXWRIGHT_E2E_TRUSTED=1` to run them all through WebDriver BiDi. |
| `e2e-safety.mjs` | Presses the real buttons in the permission window and the toolbar popup through the test's own WebDriver BiDi session: Deny, Allow this session, Always allow + revoke, Pause/Resume (also while typing and while a prompt is open), upload approval. |
| `e2e-permissions.mjs` | Approval timeouts, concurrent-call blocking, frame gating, upload confirmation, credential-file refusal. |
| `e2e-store.mjs` | The AMO build (no `javascript_tool`). |
| `e2e-resilience.mjs` | Two MCP clients at once, latency, helper crash, Firefox restart. |
| `e2e-multi.mjs` | Two Firefox profiles at once: list_connected_browsers, select_browser, switch_browser (the test clicks Connect), and the shared socket moving to the other browser when the first closes. |
| `e2e-gaps-*.mjs` | Seven suites written after the 0.6.0 store release: `hostile` (pages against the permission window), `stop` (the in-page pill and Alt+Shift+K, pressed for real), `trusted` (Stop and the pill in real-input mode), `boundary` (tabs outside the group, private windows, special URLs), `secrets` (uploads, password masking), `fuzz` (malformed arguments), `persistence` (approvals and pause across restarts). They run headful under Xvfb (`FOXWRIGHT_E2E_HEADFUL=1 xvfb-run -a node test/e2e-gaps-stop.mjs`), need `xdotool`, and need `a.test`, `sub.a.test`, `b.test`, `c.test` and `xn--pple-43d.test` pointing to 127.0.0.1 in `/etc/hosts`. Linux only so far. |
| `e2e-idle.mjs` | Still answers after the event page's idle timeout (takes about 75 s). |
| `rename-cleanup.mjs` | `setup` removes an install from before the Kitsune → Foxwright rename, without touching another program's files in `~/.kitsune`. Fake home folders; no browser needed. |
| `bidi-connect.mjs` | The real-input (WebDriver BiDi) client against a fake Firefox that allows one session: overlapping connection attempts share one session. No browser needed. |
| `bench-actions.mjs` | Median latency of common tool calls. |
| `realsites.mjs` | 51 tasks on real websites (needs internet access). |
| `agent-eval.mjs` + `agent-tasks.mjs` | A real Claude Code agent does 17 tasks; independent checks. Needs the `claude` CLI and costs about $4 per run with Opus 5.5 (less with a cheaper --model). Options: `--agent claude|codex|opencode` (other agents and models, e.g. `--agent opencode --model deepseek/deepseek-v4-pro`), `--trusted`, `--ask`, `--repeat N`, `--only REGEX`. |
| `measure-outline.mjs` | Outline sizes on real sites. |

Helpers: `harness.mjs` (fixture servers, Firefox, MCP client), `bidi-driver.mjs` (acts as the person at the computer), `build-fixtures.mjs` (bundles the React and ProseMirror fixtures).

Before running:

- Build with `npm run build` and `node test/build-fixtures.mjs`.
- Set `FIREFOX` to a Firefox 152+ binary (there's no default).
- On Linux the harness sets up the helper in a temporary home folder, so your own `~/.foxwright` and native-messaging registration aren't touched (set `FOXWRIGHT_E2E_ISOLATE=0` to use them instead). On macOS the tests use your real `~/.foxwright`; `scripts/mac-test.sh` handles this and uses a throwaway copy of Firefox.
- To see the browser, set `FOXWRIGHT_E2E_HEADFUL=1` (under Xvfb on a server).
- Behind a TLS-intercepting proxy (e.g. a CI sandbox), set `FOXWRIGHT_E2E_PROXY=host:port` and `FOXWRIGHT_E2E_PROXY_CA=/path/to/proxy-ca.crt` for the real-site suites.
