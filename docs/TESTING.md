# Test report: Foxwright

_Latest run: 0.8.1 platform round (main at 0.8.0 plus test changes), 2026-11-16: Linux (Docker, arm64) with Firefox 152.0, 153.7.0esr, 160.0, 161.0b2 and Nightly 162.0a1 (2026-11-16 build), Node 20, 22 and 24; macOS 27 with Firefox 160.0. Older sections are marked with the version they were measured on._

Every test drives Foxwright the way an AI client does: an MCP client calls the tools, and nothing else touches the browser. Each suite ran in both input modes:

- **synthetic**: the extension alone.
- **trusted**: Firefox started with `--remote-debugging-port`, so input goes through WebDriver BiDi.

## 0.8.1 platform round (2026-11-16)

### Firefox versions (Linux, Docker, Node 22)

Every cell passed; a failed suite was rerun up to twice. Two needed one rerun, both while other suites ran in the same container: `gaps-persistence` on 160 ("Allow this session" seemed to survive a Firefox restart once) and `gaps-fuzz` on 152 (a 2000-key repeat kept `read_page` waiting over 30 s).

| Suite | 152.0 | 153.7.0esr | 160.0 | 161.0b2 | Nightly 162 |
|---|---|---|---|---|---|
| `e2e.mjs` synthetic / trusted | 79/79 · 79/79 | 79/79 · 79/79 | 79/79 · 79/79 | 79/79 · 79/79 | 79/79 · 79/79 |
| `e2e.mjs` on the store build, synthetic / trusted | 79/79 · 79/79 | 79/79 · 79/79 | 79/79 · 79/79 | 79/79 · 79/79 | 79/79 · 79/79 |
| `e2e-safety` / `e2e-permissions` | 9/9 · 5/5 | 9/9 · 5/5 | 9/9 · 5/5 | 9/9 · 5/5 | 9/9 · 5/5 |
| `e2e-permission-modes` / `e2e-onboarding` | 14 · 12 | 14 · 12 | 14 · 12 | 14 · 12 | 14 · 12 |
| `e2e-storebuild` synthetic / trusted (4 not testable) / `e2e-store` | 17 · 13 · 2/2 | 17 · 13 · 2/2 | 17 · 13 · 2/2 | 17 · 13 · 2/2 | 17 · 13 · 2/2 |
| `e2e-resilience` / `e2e-multi` | 5/5 · 6/6 | 5/5 · 6/6 | 5/5 · 6/6 | 5/5 · 6/6 | 5/5 · 6/6 |
| `e2e-idle` | n/a | n/a | pass | n/a | n/a |
| gap suites (boundary 10, fuzz 6, hostile 17, persistence 4, secrets 7 + 1 known limit, stop 11, trusted 10) | pass | pass | pass | pass | pass |
| `realsites.mjs` synthetic / trusted | n/a | n/a | 52/52 · 52/52 | 52/52 · 52/52 | n/a |

### macOS 27 (Apple Silicon, Firefox 160.0 copy, `scripts/mac-test.sh` with a separate HOME)

| Suite | Synthetic | Trusted |
|---|---|---|
| `e2e.mjs` | 79/79 | 79/79 (on a rerun; see below) |
| `e2e-safety` / `e2e-permissions` / `e2e-store` | 9/9 · 5/5 (rerun) · 2/2 | n/a |
| `e2e-storebuild` / `e2e-smoke` | 17 · 6/6 | 13 (4 not testable) · 6/6 |
| `e2e-resilience` / `e2e-multi` / `e2e-idle` | 5/5 · 6/6 · pass | n/a |
| `realsites.mjs` (home network) | 52/52 | 52/52 (on a rerun) |

In the first full run, the trusted `e2e.mjs`, `e2e-permissions` and the trusted `realsites.mjs` lost the test Firefox partway ("extension disconnected" in the helper log, no crash report); each passed in full when rerun on its own. The cause wasn't found; other test runs shared the machine at the time. `e2e-permission-modes` needs the `.test` host names in `/etc/hosts` (now skipped with a note when they don't resolve). Firefox Developer Edition 161 couldn't be tested: a copy with the harness's `policies.json` added is killed at launch (its code signature), and macOS write-protects a copy once it has run.

### Node versions (Firefox 160)

Node 20.20.2 and 24.22.3 (helper and MCP server both on that Node): `e2e.mjs` 79/79 in both modes, and `e2e-safety`, `e2e-permissions`, `e2e-permission-modes`, `e2e-onboarding`, `e2e-storebuild`, `e2e-resilience`, `e2e-multi`, `e2e-smoke` all pass. Node 22 is the matrix above.

### Setups real people have (Firefox 160, Linux)

`FOXWRIGHT_E2E_PREFS` and `FOXWRIGHT_E2E_POLICIES` (see test/README.md) run any suite under these. "probe" is a 12-step check: read_page, screenshot, click by `find` coordinate and by ref, hover, typing ASCII symbols and non-ASCII text, select-all/Backspace/Tab, the zoom action, scroll and click.

| Setup | Result |
|---|---|
| `privacy.resistFingerprinting` | `e2e.mjs` 79/79 both modes, `e2e-safety` 9/9, probe 12/12 |
| Strict Enhanced Tracking Protection (strict category prefs, `cookieBehavior` 5, fingerprinting protection) | `e2e.mjs` 79/79 both modes, `e2e-permission-modes` 14/14 |
| German and Japanese UI (Mozilla language packs, `intl.locale.requested`; checked `Services.locale.appLocalesAsBCP47`) | `e2e.mjs` 79/79 both modes, `e2e-safety` 9/9, `e2e-permission-modes` 14/14, probe 12/12. The permission window stays in English (the extension isn't localized). |
| Page zoom 67 % and 130 % (Ctrl+-/Ctrl+= under Xvfb), both modes | probe 13/13 |
| Page zoom 50 %, 150 %, 200 %; `devicePixelRatio` 0.5, 1.5, 2 | Screenshots, coordinates and the zoom action are right: every on-screen target was hit. The failures were elements below the shrunken viewport (`find` marks them "(off-screen)"); with DPR 2 in a window big enough, the probe passes 12/12. |
| Windows 500x400 (headful) and 3840x2160 | Same: everything on screen works; the large window passes 12/12 in both modes. |
| Container tabs (`privacy.userContext.enabled`) and private windows with the extension allowed there | Two bugs, below. Reading, clicking, screenshots and navigation inside a container tab work, and navigation stays in the container. Private tabs stay invisible. |
| Keyboard layouts (de, fr, jp) | Not verified: the Xvfb in the test image accepts `setxkbmap`/`xmodmap` but keeps the US keymap, so those runs only repeat the US layout. |
| Two Firefox profiles at once | `e2e-multi` 6/6 on every version above. |

### Bugs found in this round (not fixed here)

- **New agent tabs fail when another window is in front.** With the Foxwright group in one normal window and the person in a second normal window, `tabs_create_mcp` fails with "An unexpected error occurred"; with a private window in front (extension allowed there) it fails with "Cannot move non-private tabs to private window". Same on 152, 153 ESR, 160, 161 beta and Nightly. `createAgentTab` (src/background/tabs.js) opens the tab in the last-focused normal window and then moves it into the group with `tabs.group({ groupId })`, which Firefox refuses across windows.
- **Container tabs in the group aren't listed.** A Multi-Account-Containers style tab dragged into the group works by its ID, but `tabs_context_mcp` doesn't list it: `browser.tabs.query({})` leaves container tabs out (seen from an extension page too), and `groupTabs()` relies on it.

### Speed (`test/bench-actions.mjs`, Firefox 160, Linux arm64 Docker, median of 15)

| Call | 0.5.0 (Mac, synthetic) | 0.8.x synthetic | 0.8.x trusted |
|---|---|---|---|
| click a button (no page load) | 120 ms | 107 ms | 120 ms |
| type 10 characters | 46 ms | 33 ms | 115 ms |
| press Tab | 25 ms | 5 ms | 114 ms |
| click a link that loads a page | 114 ms | 29 ms | 41 ms |
| navigate (local page) | n/a | 75 ms | 67 ms |
| `read_page` / `find` / screenshot | 26 / 24 / 55 ms | 12 / 11 / 12 ms | 9 / 8 / 12 ms |

Measured with nothing else running in the container (an earlier run next to other suites was up to 1.5x slower). The earlier column is the 0.5.0 Mac run below, so machines differ. In trusted mode each typed character and key goes through WebDriver BiDi, which costs about 110 ms per call regardless of length.

## Summary (0.5.0, 2026-11-08)

| Suite | Synthetic | Trusted |
|---|---|---|
| `e2e.mjs`: local fixtures (forms, React, ProseMirror, iframes incl. `about:blank`/`srcdoc` editors and slow-loading nested frames, Cmd/Alt/Ctrl+arrow caret keys, closed shadow roots, password masking, dialogs, drag-and-drop, keys, console, network, tabs, parallel calls) | **60/60** (Mac 158; 59/59 on Linux 152 and 159 for 0.4.2) | **60/60** |
| `e2e-safety.mjs`: the real permission-window and popup buttons (Deny, Allow this session, Always allow + revoke, Pause/Resume, Pause mid-typing and mid-prompt, upload approval), upload_image approval, the popup's list of agent actions | **9/9** | n/a |
| `e2e-permissions.mjs`: approval timeouts, frame gating, uploads | 5/5 | n/a |
| `e2e-resilience.mjs`: concurrency, latency, crash/restart recovery | 5/5 | n/a |
| `e2e-multi.mjs`: two Firefox profiles at once (list, select, switch with a click on Connect, takeover when one closes) | **5/5** | n/a |
| `e2e-store.mjs`: the addons.mozilla.org build | 2/2 | n/a |
| `e2e-idle.mjs`: works after the event page's idle timeout | pass (Mac) | n/a |
| `realsites.mjs`: 51 tasks on 25 real websites (Mac, home network) | **50/51** (react.dev search) | 49/51 (react.dev search; Amazon showed a CAPTCHA in trusted mode) |
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

The 2 real-site failures in each mode come from the test sandbox's network, not from Foxwright:

- **react.dev search**: the Algolia search API is unreachable from the sandbox (`curl` fails too). Foxwright opened the search dialog and typed the query; the dialog showed "No results".
- **DuckDuckGo**: it served a blank page to the sandbox's data-center IP in 3 of 4 runs. It passed in the one run where the page loaded.

## Real-agent evaluation (Claude Code, 0.2.0 → now)

`test/agent-eval.mjs` runs `claude -p` with only Foxwright's tools enabled. Everything else is blocked: WebFetch, Bash, file tools and Claude in Chrome. After each task, an independent verifier checks the result through Foxwright's own tools: the page state, the tabs that are open and the answer.

| Run | Passed | Median time | Median tool calls | Cost (16 tasks) | What changed before the run |
|---|---|---|---|---|---|
| v1 | 14/16 | 20 s | 9 | $2.57 | none (first run) |
| v2 | 14/16 | 15 s | 6 | $2.11 | default tab; `find` aliases; clamped numbers; `get_page_text` paging and `query`; `browser_batch`; on-screen summary after navigate |
| v3 | 15/16 | 18 s | 7 | $2.25 | accepts stringified arguments; `browser_batch` allowed in the harness |
| v4 | **16/16** | 20 s | 7 | $1.46 | `form_input` handles custom comboboxes; word selection on double-click; `key` alias |
| final, synthetic | **16/16** | 17 s | 7 | $1.57 | summary after navigating clicks; no navigation wait after non-navigating clicks |
| final, trusted | **16/16** | 15 s | 7 | $1.58 | same |
| 2026-11-08, synthetic (17 tasks) | **17/17** | 36 s | 7 | $4.05 | the post-0.3.0 review, the Firefox 152 fixes, stricter checks, `signup-wizard`; macOS, Firefox 158.0.1, Claude Opus 5.5 |
| 2026-11-08, trusted (17 tasks) | **17/17** | 31 s | 6 | $3.68 | same |

What the transcripts showed, and what fixed each problem:

- **Wrong argument names.** The agent sent `description` where `find` expects `query`, and `key` where `computer` expects `text`. It also passed numbers as strings, arrays as JSON strings, and `scroll_amount: 30`. All of these are now accepted.
- **Missing `tabId`.** The agent sometimes left it out. It now defaults to the last tab used.
- **Oversized page text.** `get_page_text` on Wikipedia returned more than Claude Code accepts inline, so Claude Code saved it to a file the agent couldn't open. Page text now comes 20k characters at a time, and `query` returns only the relevant passages.
- **Custom dropdowns.** On the MUI autocomplete the agent flailed for 27–40 tool calls. `form_input` on a custom combobox now types and clicks the matching option: 9 calls.
- **Word selection.** Selecting a word to make it bold failed, because synthetic double-clicks don't select text. Double-click now selects a word and triple-click a paragraph.
- **Unhelpful JavaScript errors.** `javascript_tool` returned a stack trace without the actual message. It now includes the message.

The per-task reports are in `docs/agent-eval-synthetic.md` and `docs/agent-eval-trusted.md`.

### Other models (2026-11-08)

`--agent codex` runs the tasks with OpenAI's Codex CLI and `--agent opencode` with OpenCode (any provider). Both were locked down so Foxwright was their only way to the web. That was checked first by asking each to fetch example.com without Foxwright: Codex had no shell, browser, computer use, apps or web search (its code-mode JavaScript has no `fetch`, `XMLHttpRequest`, `WebSocket` or `require`), and OpenCode ran with a temporary config denying bash, edit, webfetch, websearch, task and skill. Your own `config.toml` / `opencode.json` aren't loaded or changed.

| Agent and model | Passed | Median time | Median tool calls | Tool errors | Tokens | Cost |
|---|---|---|---|---|---|---|
| Claude Code, Opus 5.5 (synthetic / trusted) | 17/17 · 17/17 | 36 s · 31 s | 7 · 6 | 0 · 0 | 4.5M · 4.3M | $4.05 · $3.68 |
| Codex CLI, `gpt-6-astra` | 17/17 | 27 s | 7 | 0 | 2.5M | ChatGPT plan |
| OpenCode, DeepSeek v4-pro | 17/17 (16/17 in an earlier run) | 19 s | 6 | 2 | 1.4M | $0.09 |
| OpenCode, DeepSeek v4.1 flash (free) | 17/17 | 19 s | 6 | 2 | 1.4M | $0 |

What the transcripts showed:

- **A loose check.** The Quill playground now runs its editor in a cross-origin frame, so the `rich-editor` check's page script couldn't read it and fell back to "the words appear somewhere", never checking the bold. DeepSeek v4-pro's first run passed that way while its editor showed an empty `strong` (bold toggled with nothing selected). The fallback now reads the editor paragraph from the outline and requires exactly "Foxwright" bold, then "was here." (`quillOutlineOk` in `test/agent-tasks.mjs`). Claude's and GPT's transcripts show the correct result, and a rerun of that task with the fixed check passed for all four models.
- **A Foxwright bug: Cmd/Alt/Ctrl+arrow do nothing in synthetic mode.** DeepSeek pressed `cmd+left` to get to the start of the line before selecting "Foxwright". In synthetic mode `cmd+left`, `alt+left` and `ctrl+left` leave the caret where it was, in contenteditable and text inputs alike (`Home` works). Confirmed with a direct test on `basic.html`. Trusted mode isn't affected (Firefox handles the keys). Fixed in 0.4.2.
- **javascript_tool used only to look.** Both DeepSeek models called `javascript_tool` (full build) on the canvas and editor tasks, but only to measure the canvas or list iframes; the drawing and the bold were done with clicks and keys.
- **Codex needs its approval switch.** Headless Codex refuses MCP tool calls unless the server is pre-approved (`default_tools_approval_mode="approve"`); Foxwright's own permission windows are unaffected.


**Since 0.3.0** the checks are stricter and there's a 17th, local task (`signup-wizard`: validation errors, three steps, a code that depends on every answer). The full run on 2026-11-08 passed all 17 in both modes. The cost per run went from about $1.57 to about $4 with similar token counts; that run used Claude Opus 5.5, and the earlier runs didn't record their model, so the difference is probably the model's price. Not yet run: `--ask` (permission prompts answered by a scripted user) and `--repeat`.

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
| Google | search (Google showed its bot check to the data-center IP; Foxwright reported it) |
| **Rich editors** | Lexical, Slate, Quill (inside an iframe), ProseMirror, CodeMirror 6, **Monaco** |
| **Widgets** | MUI Autocomplete, Radix Select, jQuery UI sortable (in an iframe), Excalidraw (draws a 200×150 rectangle on the canvas) |
| httpbin | classic form POST (the JSON result is explained clearly), GET JSON re-fetched |

## Bugs found by real-site testing, and fixed

1. **Alerts froze the tab.** A JavaScript `alert()` blocked the page's JavaScript, and Foxwright with it, for 30 s. Foxwright now replaces the blocking dialogs in agent tabs:
   - `alert` is dismissed, and `confirm`/`prompt` are cancelled.
   - The tool result tells the agent what the page asked.
   - The new `handle_dialog` tool lets the agent accept the next dialog.
2. **Rich editors lost keystrokes.** Lexical dropped every character after the first, because Foxwright typed a whole string within one browser task while the editor updates asynchronously. Foxwright now yields to the page between keystrokes. Lexical, Slate, Quill, CodeMirror and ProseMirror all pass.
3. **Canvas apps crashed on synthetic pointers.** Excalidraw and similar apps call `setPointerCapture`, which Firefox rejects for synthetic pointers ("Invalid pointer id"), aborting the drawing. Foxwright now emulates pointer capture during its own gestures.
4. **Popups were cut off.** Menus, listboxes and dialogs rendered at the end of `<body>` (Radix, MUI, DocSearch) were truncated from long outlines. `read_page` now lists open popups first.
5. **Custom selects hid their value.** A combobox labelled "Food" didn't show its chosen value. The outline now shows it (`combobox "Food": Banana`).
6. **Drags inside iframes did nothing.** `find` also gave no coordinates for elements in frames. Both are fixed.
7. **Slider clicks didn't move the thumb.** Clicking a range input now moves it to the click position, like a real click.
8. **`find` put whole tables and containers ahead of the actual element.** It now ranks exact name matches first and down-weights containers and long text blocks.
9. **Firefox error and viewer pages were confusing.** They produced "Missing host permission". Foxwright now says what's going on: network error, certificate warning, the JSON viewer or the PDF viewer.
10. **Navigations weren't always reported.** Some page navigations start a moment after a click or Enter, and Foxwright now watches for them before reporting.
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

- **Windows.** CI runs `e2e-smoke` and `e2e.mjs` in both input modes and the store build (non-blocking jobs); results aren't in this report. Not tried: the key-file ACL against another local user. [MANUAL-CHECKS.md](MANUAL-CHECKS.md) has the checklist.
- **Keyboard layouts other than US** (see above), and Firefox Developer Edition on macOS.
- **Snap/Flatpak Firefox.**
- **Logged-in sites.** Gmail, Google Docs and banking all need an account; see MANUAL-CHECKS.md.
- **Strong anti-bot pages.** Cloudflare Turnstile and reCAPTCHA were unreachable from the sandbox. Trusted mode is expected to fare much better there than synthetic mode.
- **The Alt+Shift+K shortcut and the in-page Stop pill.** The safety suite pauses through the toolbar popup, which uses the same code path; the shortcut and pill need a person (MANUAL-CHECKS.md).
- **CI on GitHub after these fixes.** Locally the CI suites pass on Linux (ARM, Docker) with Firefox 152 and 159. GitHub's x86_64 runners failed trusted mode from Firefox 158 on, which couldn't be reproduced here (an x86_64 container detected trusted mode fine); the first test now prints why if it happens again.
- **react.dev search** (trusted mode, Mac): the search popup showed no `useState` result. It also failed in the 0.2.0 Mac run.
