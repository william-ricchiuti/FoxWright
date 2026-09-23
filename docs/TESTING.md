# Test report: Kitsune 0.1.0

_Run on 2026-09-23 with Firefox 156.0.1 (Linux, headless and Xvfb) and Node 22._

Every test drives Kitsune the way an AI client does: an MCP client calls the tools, and nothing else touches the browser. Each suite ran in both input modes:

- **synthetic**: the extension alone.
- **trusted**: Firefox started with `--remote-debugging-port`, so input goes through WebDriver BiDi.

## Summary

| Suite | Synthetic | Trusted |
|---|---|---|
| `e2e.mjs`: local fixtures (forms, React, ProseMirror, iframes, drag-and-drop, keys, console, network, tabs) | **43/43** | **43/43** |
| `realsites.mjs`: 51 tasks on 25 real websites | **49/51** | **49/51** |
| `e2e-permissions.mjs`: approval windows, frame gating, uploads | 5/5 | n/a |
| `e2e-resilience.mjs`: concurrency, latency, crash/restart recovery | 5/5 | n/a |
| `e2e-store.mjs`: the addons.mozilla.org build | 2/2 | n/a |
| `e2e-idle.mjs`: works after the event page's idle timeout | pass | n/a |
| `web-ext lint` (store and full builds) | 0 errors (1 ignorable Android warning) | n/a |

The 2 real-site failures in each mode come from the test sandbox's network, not from Kitsune:

- **react.dev search**: the Algolia search API is unreachable from the sandbox (`curl` fails too). Kitsune opened the search dialog and typed the query; the dialog showed "No results".
- **DuckDuckGo**: it served a blank page to the sandbox's data-center IP in 3 of 4 runs. It passed in the one run where the page loaded.

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

## Performance (local page, 15 rounds)

| Tool | p50 | p95 |
|---|---|---|
| `read_page` (interactive) | 25 ms | 113 ms |
| `find` | 29 ms | 67 ms |
| `computer` click | 315 ms | 336 ms |
| `computer` screenshot | 33 ms | 106 ms |

Click latency includes about 300 ms spent watching for a navigation the click might start.

### Outline size on real sites

| Page | Interactive only | Visible only | Full (default 50k cap) |
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

- **Other platforms.** macOS and Windows haven't been tested. The code paths are written, and the native-messaging locations and named pipe follow Mozilla's docs.
- **Snap/Flatpak Firefox.**
- **Logged-in sites.** Gmail, Google Docs and banking all need an account.
- **Strong anti-bot pages.** Cloudflare Turnstile and reCAPTCHA were unreachable from the sandbox. Trusted mode is expected to fare much better there than synthetic mode.
- **A real Claude agent session.** Everything was driven by scripted MCP calls, not by Claude deciding what to do.
