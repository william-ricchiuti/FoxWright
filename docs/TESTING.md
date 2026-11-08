# Test report: Kitsune

_Latest run: the 2026-11-08 fixes (unreleased). Linux (Docker, headless) with Firefox 152.0, the oldest supported, and 159.0, the latest; macOS 27 with Firefox 158.0.1; Node 22. Earlier sections are marked with the version they were measured on._

Every test drives Kitsune the way an AI client does: an MCP client calls the tools, and nothing else touches the browser. Each suite ran in both input modes:

- **synthetic**: the extension alone.
- **trusted**: Firefox started with `--remote-debugging-port`, so input goes through WebDriver BiDi.

## Summary (latest)

| Suite | Synthetic | Trusted |
|---|---|---|
| `e2e.mjs`: local fixtures (forms, React, ProseMirror, iframes incl. `about:blank`/`srcdoc` editors and slow-loading nested frames, closed shadow roots, password masking, dialogs, drag-and-drop, keys, console, network, tabs, parallel calls) | **58/58** (152, 159, Mac 158) | **58/58** (152, 159, Mac 158) |
| `e2e-safety.mjs`: the real permission-window and popup buttons (Deny, Allow this session, Always allow + revoke, Pause/Resume, Pause mid-typing and mid-prompt, upload approval) | **7/7** (152, 159, Mac 158) | n/a |
| `e2e-permissions.mjs`: approval timeouts, frame gating, uploads | 5/5 | n/a |
| `e2e-resilience.mjs`: concurrency, latency, crash/restart recovery | 5/5 | n/a |
| `e2e-store.mjs`: the addons.mozilla.org build | 2/2 | n/a |
| `e2e-idle.mjs`: works after the event page's idle timeout | pass (Mac) | n/a |
| `realsites.mjs`: 51 tasks on 25 real websites (Mac, home network) | **51/51** | **50/51** (react.dev search) |
| `web-ext lint` (store and full builds) | 0 errors, 0 warnings | n/a |

Firefox 140–151 are no longer supported: they give Manifest V3 extensions neither `tabs.captureTab` nor a usable `captureVisibleTab`, so screenshots, zoom and GIF recording fail (53/58). 152 is the first version that passes; 153 ESR passes too.

### Speed (`test/bench-actions.mjs`, local fixture, median of 15)

| Call | 0.3.0 | Now |
|---|---|---|
| click a button (no page load) | 323 ms | 120 ms |
| type 10 characters | 347 ms | 46 ms |
| press Tab | 318 ms | 25 ms |
| click a link that loads a page | 258 ms | 114 ms |
| `read_page` / `find` / screenshot | 26 / 24 / 55 ms | about the same |

The gain comes from waiting on Firefox's navigation events, only as long as the action could start a page load, instead of fixed sleeps. Typing in a tab that isn't in front no longer runs at one character per second.

The 2 real-site failures in each mode come from the test sandbox's network, not from Kitsune:

- **react.dev search**: the Algolia search API is unreachable from the sandbox (`curl` fails too). Kitsune opened the search dialog and typed the query; the dialog showed "No results".
- **DuckDuckGo**: it served a blank page to the sandbox's data-center IP in 3 of 4 runs. It passed in the one run where the page loaded.

## Real-agent evaluation (Claude Code, 0.2.0 → 0.3.0)

`test/agent-eval.mjs` runs `claude -p` with only Kitsune's tools enabled. Everything else is blocked: WebFetch, Bash, file tools and Claude in Chrome. After each task, an independent verifier checks the result through Kitsune's own tools: the page state, the tabs that are open and the answer.

| Run | Passed | Median time | Median tool calls | Cost (16 tasks) | What changed before the run |
|---|---|---|---|---|---|
| v1 | 14/16 | 20 s | 9 | $2.57 | none (first run) |
| v2 | 14/16 | 15 s | 6 | $2.11 | default tab; `find` aliases; clamped numbers; `get_page_text` paging and `query`; `browser_batch`; on-screen summary after navigate |
| v3 | 15/16 | 18 s | 7 | $2.25 | accepts stringified arguments; `browser_batch` allowed in the harness |
| v4 | **16/16** | 20 s | 7 | $1.46 | `form_input` handles custom comboboxes; word selection on double-click; `key` alias |
| final, synthetic | **16/16** | 17 s | 7 | $1.57 | summary after navigating clicks; no navigation wait after non-navigating clicks |
| final, trusted | **16/16** | 15 s | 7 | $1.58 | same |

What the transcripts showed, and what fixed each problem:

- **Wrong argument names.** The agent sent `description` where `find` expects `query`, and `key` where `computer` expects `text`. It also passed numbers as strings, arrays as JSON strings, and `scroll_amount: 30`. All of these are now accepted.
- **Missing `tabId`.** The agent sometimes left it out. It now defaults to the last tab used.
- **Oversized page text.** `get_page_text` on Wikipedia returned more than Claude Code accepts inline, so Claude Code saved it to a file the agent couldn't open. Page text now comes 20k characters at a time, and `query` returns only the relevant passages.
- **Custom dropdowns.** On the MUI autocomplete the agent flailed for 27–40 tool calls. `form_input` on a custom combobox now types and clicks the matching option: 9 calls.
- **Word selection.** Selecting a word to make it bold failed, because synthetic double-clicks don't select text. Double-click now selects a word and triple-click a paragraph.
- **Unhelpful JavaScript errors.** `javascript_tool` returned a stack trace without the actual message. It now includes the message.

The per-task reports are in `docs/agent-eval-synthetic.md` and `docs/agent-eval-trusted.md`.

**Since 0.3.0** the checks are stricter and there's a 17th, local task (`signup-wizard`: validation errors, three steps, a code that depends on every answer). A partial run in the sandbox passed `signup-wizard`, `todos`, `rich-editor` and `two-tabs` under the new checks. `docs-search` now fails in the sandbox, correctly: react.dev's search (Algolia) is blocked there, and the new check requires the agent to have actually used the search. A full run on a normal network (`node test/agent-eval.mjs`, and `--trusted`, `--ask`) is still to do.

## macOS run (0.2.0, your MacBook Pro)

macOS 26.5.1 on Apple Silicon, Firefox 155.0.1 (a throwaway copy made by `scripts/mac-test.sh`), Node 22.22.3.

| Suite | Synthetic | Trusted |
|---|---|---|
| `e2e.mjs` (43 tests at the time) | 43/43 | 43/43 |
| `realsites.mjs` | 50/51 | 50/51 |
| permissions / store / resilience / idle | 5/5 · 2/2 · 5/5 · pass | n/a |

- **DuckDuckGo** passed on the Mac, which confirms its sandbox failure was the network.
- **Google showed its bot check only in trusted mode** on a home connection. The cause is that Firefox sets `navigator.webdriver = true` while remote debugging is on. The README now documents this trade-off.
- **react.dev failed in both modes.** The test pressed Enter in the search popup instead of clicking a result, the way an agent reading the page would. The scenario has been rewritten to click the result; re-check it with `bash scripts/mac-test.sh only react.dev`.

## Real-site tasks (all passing)

| Site | Tasks |
|---|---|
| the-internet.herokuapp.com (20) | login, checkboxes, native select, **HTML5 drag-and-drop**, CSS hover (trusted mode only), key presses, **alert / confirm / prompt dialogs**, nested frames, dynamic loading, shadow DOM, slider, new window, file upload, add/remove elements, infinite scroll, sortable table, modal, 3,600-ref page outline in under 0.5 s |
| demoqa.com (6) | React text form, styled radios, double/right/dynamic click, react-select, autocomplete, full practice form |
| saucedemo.com | login → add to cart → checkout → order complete |
| TodoMVC (React) | add 3 todos, complete one, filter |
| selenium.dev web form | text, password, textarea, select, checkbox, range → submit |
| Wikipedia, Hacker News, gov.uk, YouTube, Amazon, Reddit, BBC | search / navigate / read, cookie-consent dismissal |
| Google | search (Google showed its bot check to the data-center IP; Kitsune reported it) |
| **Rich editors** | Lexical, Slate, Quill (inside an iframe), ProseMirror, CodeMirror 6, **Monaco** |
| **Widgets** | MUI Autocomplete, Radix Select, jQuery UI sortable (in an iframe), Excalidraw (draws a 200×150 rectangle on the canvas) |
| httpbin | classic form POST (the JSON result is explained clearly), GET JSON re-fetched |

## Bugs found by real-site testing, and fixed

1. **Alerts froze the tab.** A JavaScript `alert()` blocked the page's JavaScript, and Kitsune with it, for 30 s. Kitsune now replaces the blocking dialogs in agent tabs:
   - `alert` is dismissed, and `confirm`/`prompt` are cancelled.
   - The tool result tells the agent what the page asked.
   - The new `handle_dialog` tool lets the agent accept the next dialog.
2. **Rich editors lost keystrokes.** Lexical dropped every character after the first, because Kitsune typed a whole string within one browser task while the editor updates asynchronously. Kitsune now yields to the page between keystrokes. Lexical, Slate, Quill, CodeMirror and ProseMirror all pass.
3. **Canvas apps crashed on synthetic pointers.** Excalidraw and similar apps call `setPointerCapture`, which Firefox rejects for synthetic pointers ("Invalid pointer id"), aborting the drawing. Kitsune now emulates pointer capture during its own gestures.
4. **Popups were cut off.** Menus, listboxes and dialogs rendered at the end of `<body>` (Radix, MUI, DocSearch) were truncated from long outlines. `read_page` now lists open popups first.
5. **Custom selects hid their value.** A combobox labelled "Food" didn't show its chosen value. The outline now shows it (`combobox "Food": Banana`).
6. **Drags inside iframes did nothing.** `find` also gave no coordinates for elements in frames. Both are fixed.
7. **Slider clicks didn't move the thumb.** Clicking a range input now moves it to the click position, like a real click.
8. **`find` put whole tables and containers ahead of the actual element.** It now ranks exact name matches first and down-weights containers and long text blocks.
9. **Firefox error and viewer pages were confusing.** They produced "Missing host permission". Kitsune now says what's going on: network error, certificate warning, the JSON viewer or the PDF viewer.
10. **Navigations weren't always reported.** Some page navigations start a moment after a click or Enter, and Kitsune now watches for them before reporting.
11. **`read_page` was huge on long pages.** Wikipedia's full outline is about 500 KB. The new `visible_only` option returns just what's on screen: 14.7 KB instead of 512 KB on Wikipedia's Red fox article.

## Performance (0.2.0, local page, 15 rounds)

| Tool | p50 | p95 |
|---|---|---|
| `read_page` (interactive) | 25 ms | 113 ms |
| `find` | 29 ms | 67 ms |
| `computer` click | 315 ms | 336 ms |
| `computer` screenshot | 33 ms | 106 ms |

Click latency includes about 300 ms spent watching for a navigation the click might start.

### Outline size on real sites

| Page | Interactive only | Visible only | Full (0.2.0's 50k cap; now 20k) |
|---|---|---|---|
| Wikipedia article | 191k | **14.7k** | 50k (truncated from 513k) |
| Amazon home | 18.5k | 14.1k | 43k |
| Reddit subreddit | 20k | 10k | 36k |
| BBC News | 18k | 6k | 46k |
| YouTube home | 3.6k | 3.4k | 5.5k |

(characters; roughly 4 characters per token)

## Resilience

- Two MCP clients (e.g. Claude Code and Claude Desktop) worked at the same time on different tabs, including 5 parallel calls.
- **Helper killed.** When the helper was killed with `SIGKILL`, Firefox restarted it and calls succeeded again within about 2 s.
- **Firefox restarted.** While Firefox was quit, the MCP server returned a clear "Firefox … is not running" error. Once Firefox was back, it reconnected on its own.

## Not covered yet

- **Windows.** The code paths (named pipe, registry, `.bat` launcher) are written and CI now installs the npm package on Windows, but the extension hasn't been driven on Windows. [MANUAL-CHECKS.md](MANUAL-CHECKS.md) has the checklist.
- **Snap/Flatpak Firefox.**
- **Logged-in sites.** Gmail, Google Docs and banking all need an account; see MANUAL-CHECKS.md.
- **Strong anti-bot pages.** Cloudflare Turnstile and reCAPTCHA were unreachable from the sandbox. Trusted mode is expected to fare much better there than synthetic mode.
- **The Alt+Shift+K shortcut and the in-page Stop pill.** The safety suite pauses through the toolbar popup, which uses the same code path; the shortcut and pill need a person (MANUAL-CHECKS.md).
- **CI on GitHub after these fixes.** Locally the CI suites pass on Linux (ARM, Docker) with Firefox 152 and 159. GitHub's x86_64 runners failed trusted mode from Firefox 158 on, which couldn't be reproduced here (an x86_64 container detected trusted mode fine); the first test now prints why if it happens again.
- **react.dev search** (trusted mode, Mac): the search popup showed no `useState` result. It also failed in the 0.2.0 Mac run.
- **A full agent evaluation after the post-0.3.0 changes** (see above).
