# Tests

These tests run a real Firefox (via `web-ext run`, headless by default) with the Foxwright extension. They start the MCP server and drive it with an MCP client, against local fixture pages in `fixtures/`, served on two free local ports (`FOXWRIGHT_P1`, `FOXWRIGHT_P2`) that the harness picks.

| Script | What it covers |
|---|---|
| `e2e.mjs` | 60 scenarios: outline and find, forms, React, ProseMirror, iframes (including `about:blank`/`srcdoc` editors), closed shadow roots, password masking, dialogs, drag-and-drop, keys, console, network, tabs, parallel calls, GIFs. Set `FOXWRIGHT_E2E_TRUSTED=1` to run them all through WebDriver BiDi. |
| `e2e-safety.mjs` | Presses the real buttons in the permission window and the toolbar popup through the test's own WebDriver BiDi session: Deny, Allow this session, Always allow + revoke, Pause/Resume (also while typing and while a prompt is open), upload approval. |
| `e2e-permissions.mjs` | Approval timeouts, concurrent-call blocking, frame gating, upload confirmation, credential-file refusal. |
| `e2e-store.mjs` | Smoke test of the AMO build (no `javascript_tool`). |
| `e2e-storebuild.mjs` | The core flows on the store build, with page state read through `pageEval` instead of `javascript_tool`: outline/find, forms, React, clicks, typing, keys, drag-and-drop, dialogs, iframes, tabs, and (synthetic mode) screenshot masking of an unapproved frame, permission window Allow/Deny, Pause. Runs in both input modes; `FOXWRIGHT_E2E_BUILD=dist/amo` runs it against the signed AMO XPI (see `fetch-amo-xpi.mjs`). |
| `e2e-smoke.mjs` | Six-step smoke test (tabs, navigate, read_page, click, type, screenshot) plus `doctor` while Firefox is connected. What CI runs on Windows. |
| `e2e-resilience.mjs` | Two MCP clients at once, latency, helper crash, Firefox restart. |
| `e2e-multi.mjs` | Two Firefox profiles at once: list_connected_browsers, select_browser, switch_browser (the test clicks Connect), and the shared socket moving to the other browser when the first closes. |
| `e2e-gaps-*.mjs` | Seven suites written after the 0.6.0 store release: `hostile` (pages against the permission window), `stop` (the in-page pill and Alt+Shift+K, pressed for real), `trusted` (Stop and the pill in real-input mode), `boundary` (tabs outside the group, private windows, special URLs), `secrets` (uploads, password masking), `fuzz` (malformed arguments), `persistence` (approvals and pause across restarts). They run headful under Xvfb, need `xdotool`, and need `a.test`, `sub.a.test`, `b.test`, `c.test` and `xn--pple-43d.test` pointing to 127.0.0.1 in `/etc/hosts`. Linux only so far. `npm run test:gaps` runs all seven (under `xvfb-run` when there is no display). |
| `e2e-idle.mjs` | Still answers after the event page's idle timeout (takes about 75 s). |
| `rename-cleanup.mjs` | `setup` removes an install from before the Kitsune → Foxwright rename, without touching another program's files in `~/.kitsune`. Fake home folders; no browser needed. |
| `bidi-connect.mjs` | The real-input (WebDriver BiDi) client against a fake Firefox that allows one session: overlapping connection attempts share one session. No browser needed. |
| `sandbox-probe.mjs` | Records what happens with a Snap or Flatpak Firefox (does Firefox start the helper, the exact errors). CI runs it, non-blocking. |
| `bench-actions.mjs` | Median latency of common tool calls. |
| `realsites.mjs` | 51 tasks on real websites (needs internet access). |
| `agent-eval.mjs` + `agent-tasks.mjs` | A real Claude Code agent does 17 tasks; independent checks. Needs the `claude` CLI and costs about $4 per run with Opus 5.5 (less with a cheaper --model). Options: `--agent claude|codex|opencode` (other agents and models, e.g. `--agent opencode --model deepseek/deepseek-v4-pro`), `--trusted`, `--ask`, `--repeat N`, `--only REGEX`. |
| `measure-outline.mjs` | Outline sizes on real sites. |

Helpers: `harness.mjs` (fixture servers, Firefox, MCP client, `pageEval`, suite watchdog), `gap-lib.mjs` (test runner with known limits, extra fixture server, "person at the computer" helpers), `bidi-driver.mjs` (acts as the person at the computer), `ws-shim.mjs` (WebSocket on Node 20 too), `run-suites.mjs` (runs several suites, prints a pass/fail table), `fetch-amo-xpi.mjs` (downloads and unpacks the signed AMO XPI when it matches `package.json`'s version), `build-fixtures.mjs` (bundles the React and ProseMirror fixtures).

## Before running

- Build with `npm run build` and `node test/build-fixtures.mjs`.
- Set `FIREFOX` to a Firefox 152+ binary (there's no default). The harness writes a `policies.json` next to it (the extension's test policy, plus `DisableAppUpdate` so the test Firefox never updates itself mid-run), so use a copy of Firefox, not your installed one.
- On Linux the harness sets up the helper in a temporary home folder, so your own `~/.foxwright` and native-messaging registration aren't touched (set `FOXWRIGHT_E2E_ISOLATE=0` to use them instead). On macOS and Windows the tests use your real home folder; on a Mac see below.
- To see the browser, set `FOXWRIGHT_E2E_HEADFUL=1` (under Xvfb on a server).
- Behind a TLS-intercepting proxy (e.g. a CI sandbox), set `FOXWRIGHT_E2E_PROXY=host:port` and `FOXWRIGHT_E2E_PROXY_CA=/path/to/proxy-ca.crt` for the real-site suites.
- Node 20 and 22 both work (`ws-shim.mjs` supplies WebSocket on Node 20).

## Harness options (environment)

| Variable | Effect |
|---|---|
| `FOXWRIGHT_E2E_BUILD=store\|full\|<folder>` | Which extension build a suite runs against when it doesn't pick one itself (default `full`). A folder is an unpacked extension, e.g. `dist/amo` from `fetch-amo-xpi.mjs`. |
| `FOXWRIGHT_E2E_TRUSTED=1` | Trusted (WebDriver BiDi) input. The harness waits until Firefox's BiDi endpoint opens sessions promptly before the first test (`FOXWRIGHT_E2E_TRUSTED_WAIT_SEC`, default 90) and, if the MCP server's first connection still lost a race with a busy Firefox, waits for it to switch to trusted input instead of letting the run test synthetic input; it fails with a clear message if trusted input never comes up. |
| `FOXWRIGHT_E2E_SUITE_TIMEOUT_MIN` | Give up on a whole suite after this many minutes (default 25), printing the current test, the last tool call and whether it was answered, and the tail of the helper log, and exit with code 124. Also written to `test/results/<suite>-timeout.txt`. |
| `FOXWRIGHT_E2E_PAGE_EVAL=bidi\|beacon` | Force how `pageEval` reads page state (see below). |

### Reading page state without `javascript_tool` (`pageEval`)

The store build has no `javascript_tool`, so checks that read the page through it can't run there. The harness offers:

- `h.pageEvalText(tabId, code)`: runs `code` in the tab's top document and returns the result formatted exactly like `javascript_tool`'s text (same REPL semantics, JSON for values).
- `h.pageEval(tabId, code)`: the same, parsed.
- `h.js(tabId, code)`: `javascript_tool` on the full build, `pageEvalText` on the store build (or when `FOXWRIGHT_E2E_PAGE_EVAL` is set). A drop-in for the suites' `js()` helpers.

Two routes, picked automatically: with `testDriver: true` (or `pageEval: 'bidi'`) through a WebDriver BiDi session of the test's own (`script.evaluate` in the tab's browsing context; if the suite opened that session itself, pass it with `h.useDriver(driver)`, since Firefox allows only one); in trusted mode, where the MCP server holds that one session, and for the store build, through a probe script the fixture servers add to every page they serve (it connects back to the fixture server over a WebSocket and runs what the test sends). The tab is matched by its URL, so two tabs showing the same URL need distinct query strings.

Converting `e2e.mjs` to run on the store build is one line: replace the body of its `js()` helper with `return h.js(tabId, code);`. Run with `FOXWRIGHT_E2E_BUILD=store`. `e2e-safety.mjs` needs `h.useDriver(driver)` after it connects its driver and its one `javascript_tool` call replaced by `h.js(tabId, ...)`.

### Known limits (gap suites)

`gap-lib.mjs` has a `KNOWN_LIMITS` list: tests that fail today for an accepted reason. They print `~ ... (known limit: ...)` and don't fail the suite, but only while they fail with the expected message; any other failure is a real one, and a known limit that starts passing fails the suite so its entry gets deleted.

## Running several suites

```
npm run test:gaps                                      # the seven gap suites, headful (xvfb-run on Linux without a display)
npm run test:storebuild                                # store build, synthetic then trusted input
node test/run-suites.mjs e2e-safety e2e-multi          # any suites; a pass/fail table at the end, exit 1 if any failed
```

Each suite's output is also written to `test/results/<suite>.log`.

## Testing on your own Mac

`bash scripts/mac-test.sh` copies Firefox.app to a temporary folder (your Firefox is never modified), builds, runs the suites and ends with a pass/fail table (non-zero exit if any suite failed). The tests use your real home folder on macOS, so by default they share `~/.foxwright` (socket, browser registry) with your own Foxwright install.

To keep a run's socket and registry apart from your install:

```
HOME=/private/tmp/fwt bash scripts/mac-test.sh quick
```

Why this works, and its limits:

- Firefox ignores `HOME` when it looks for the native-messaging manifest (it uses your real `~/Library/Application Support/Mozilla/NativeMessagingHosts`), so it starts your **installed** helper. That helper, however, follows `HOME`, so its socket, registry and log go to `/private/tmp/fwt/.foxwright`, and the test's MCP server looks there too.
- So it is only valid while the installed helper is the same version as the build under test. If you changed the helper (`host/src`), install it first (`node host/dist/foxwright.mjs setup` with your real HOME) or test on Linux, where the harness isolates fully.
- Keep the path short: a Unix socket path is limited to 104 bytes on macOS, and the helper's per-browser socket lives at `<HOME>/.foxwright/browsers/<pid>.sock`.
- Never run the browser suites against your installed Firefox or while you depend on your real install; on Linux, prefer a container.

## CI

`.github/workflows/ci.yml`: Linux with Firefox latest and 152.0 runs everything above that needs no internet, including the gap suites (hosts entries, Xvfb, xdotool) and the store-build suite in both modes; a Node 20 job; and non-blocking jobs for the signed AMO XPI (skipped with a message when AMO's version differs from `package.json`), a Windows smoke test (`e2e-smoke.mjs` after `setup`, plus the full `e2e.mjs` as information), macOS (`e2e`, `e2e-safety`, `e2e-storebuild`), and the Snap/Flatpak sandbox probes.
