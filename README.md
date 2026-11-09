# Kitsune 狐

[![CI](https://github.com/william-ricchiuti/Kitsune/actions/workflows/ci.yml/badge.svg)](https://github.com/william-ricchiuti/Kitsune/actions/workflows/ci.yml)

**Let Claude (or any MCP-capable AI agent) use your real Firefox**: your tabs, your logins, your extensions. It works the same way Claude in Chrome does in Chrome.

![A Claude Code agent buying a backpack on saucedemo.com through Kitsune: log in, add to cart, fill checkout details, finish](docs/demo.gif)

*A real Claude Code session with Kitsune, sped up 1.5×. The orange glow and "Kitsune is driving this tab" pill show which tab the agent is using. The striped address bar is from the test profile's remote-debugging mode.*

Kitsune is a Firefox extension plus a small helper program. The helper gives your AI client the same tools Claude in Chrome has (`read_page`, `find`, `computer`, `form_input`, `navigate`, …), so the agent already knows how to use them.

```
 Claude Code / Claude Desktop / any MCP client
        │  stdio (MCP)
        ▼
 kitsune mcp ──── Unix socket (~/.kitsune, owner-only) ───► kitsune helper
                                                               │ Firefox native messaging
 (optional) WebDriver BiDi on :9222 for real input             ▼
        └─────────────────────────────────────────────► Kitsune extension ──► your tabs
```

## Why this exists

Chrome extensions can call Chrome's DevTools protocol (`chrome.debugger`). That's how Claude in Chrome gets a page outline and real mouse and keyboard input. Firefox extensions have no equivalent API ([bug 1316741](https://bugzilla.mozilla.org/show_bug.cgi?id=1316741)). The other ways to connect an AI agent to Firefox each fall short somewhere. This is how they compare (re-checked November 2026), based on each project's own code and README:

| | Your real profile (logins, extensions)? | Page outline for the AI | Input that React/Vue/editors accept | Security |
|---|---|---|---|---|
| Playwright MCP (with Firefox) | no: uses its own browser profile (its "attach to your browser" extension is Chrome/Edge only) | full accessibility snapshot | real (Playwright) | local process |
| mozilla/firefox-devtools-mcp | only after restarting Firefox (or a second profile) with `--marionette --remote-debugging-port` | JS tree walk, roles from `role=` only | real (WebDriver) | debugging port open while in use |
| Blueprint MCP (Firefox) | yes | its store listing says the snapshot isn't available in Firefox | appends to `.value` (React ignores it) | local WebSocket |
| ClaudeCodeBrowser | yes | screenshots / raw DOM | basic DOM events | HTTP server on localhost; API key in the current code, none in the store version; polls twice a second |
| FoxMCP | yes | run-a-script only, no page outline | none (scripts only) | local WebSocket, no caller authentication |
| browser-control-mcp, FireMCP | yes | read-only (FireMCP can also open, close and group tabs) | none (by design) | shared secret, per-site consent |
| **Kitsune** | **yes** | full accessibility outline (roles, names, states, values, refs), iframes included | synthetic events tuned per framework; **real input automatically** when Firefox runs with remote debugging | owner-only socket, no open port; per-site approval in an extension-owned window |

If you don't need your own logged-in browser, Playwright MCP is a solid choice. Kitsune is for when the agent should work in the Firefox you already use.

How Kitsune fills the gaps:

- **Page outline without DevTools.** It uses Microsoft Playwright's accessibility-snapshot code, vendored under Apache-2.0. That code computes WAI-ARIA roles and accessible names in plain JavaScript inside the page. `read_page` returns YAML like `- textbox "Email" [ref=e7]: ada@example.com`, and every interactive element gets a ref you can click or fill.
- **Input that frameworks accept.**
  - Clicks send the full pointer/mouse sequence, move focus like a real click, and place the caret where you clicked.
  - Typing goes through `execCommand('insertText')`, so React, Vue, ProseMirror, Lexical and Slate all see normal input events.
  - Keys like Enter, Tab, Backspace and arrows get their *default actions* reproduced: form submission, focus moves, deletion, caret moves.
  - HTML5 drag-and-drop, file inputs, `<select>`, range and date inputs are handled specially.
- **Real (trusted) input when available.** If Firefox is running with `--remote-debugging-port`, Kitsune detects it and sends clicks, keys, wheel and drags through WebDriver BiDi. Pages then see `isTrusted: true` events, including inside cross-origin iframes. If a step can't be done that way, it falls back to synthetic events, and never runs the same action twice.

## Does it actually work?

Claude Code was given 17 everyday browser tasks and allowed to use only Kitsune's tools. Each result was then checked in the browser by an independent verifier, not taken from the agent's word. The tasks were logins, a full shop checkout, React forms, custom dropdowns, drag-and-drop, a JavaScript confirm dialog, drawing on a canvas, a rich-text editor, file upload, research across two tabs, a site's own search, looking facts up on Wikipedia, Hacker News and gov.uk, and a local three-step sign-up form with validation errors.

Results for the current code (November 2026, macOS, Firefox 158, Claude Opus 5.5), one run per task, with every site pre-approved:

| Input mode | Tasks completed | Median time | Median tool calls | Cost for all 17 |
|---|---|---|---|---|
| Synthetic (default) | **17/17** | 36 s | 7 | $4.05 |
| Trusted (remote debugging) | **17/17** | 31 s | 6 | $3.68 |

The same 17 tasks with other models and agents (default input mode, November 2026, same checks):

| Agent and model | Tasks completed | Median time | Median tool calls | Cost for all 17 |
|---|---|---|---|---|
| Codex CLI, GPT (`gpt-6-astra`) | **17/17** | 27 s | 7 | ChatGPT plan usage |
| OpenCode, DeepSeek v4-pro | **17/17** | 19 s | 6 | $0.09 |
| OpenCode, DeepSeek v4.1 flash (free) | **17/17** | 19 s | 6 | $0 |

So Kitsune's tools aren't tied to Claude: models that weren't trained on Claude in Chrome's tool names used them without changes. Each agent could reach the web only through Kitsune (shell, web fetch/search and built-in browsers off). DeepSeek v4-pro failed the rich-text task once in an earlier run, which is the kind of variance one run per task can hide. Reports: [GPT](docs/agent-eval-gpt.md), [DeepSeek v4-pro](docs/agent-eval-deepseek-v4-pro.md), [DeepSeek flash](docs/agent-eval-deepseek-flash.md). Run them with `node test/agent-eval.mjs --agent codex` or `--agent opencode --model provider/model`.

Version 0.3.0 scored 16/16 on the first 16 tasks with looser checks ($1.57 and $1.58; the model wasn't recorded then). The very first version scored 14/16. The agent's own transcripts drove the fixes: multi-step batching, text search within a page, a `form_input` that handles custom dropdowns, word selection on double-click, and more forgiving arguments. Full reports: [synthetic](docs/agent-eval-synthetic.md), [trusted](docs/agent-eval-trusted.md).

These numbers are a useful signal, not a guarantee: one run per task, demo sites rather than your logged-in accounts, and no permission prompts. The checks are strict (for example, the editor task checks that only "Kitsune" is bold, and the search task that the agent really used the site's search). The evaluation can also run with permission prompts on (`--ask`) and repeat tasks (`--repeat N`). Run it yourself with `node test/agent-eval.mjs`. It needs the `claude` CLI; the cost depends on the model (about $4 per run with Opus 5.5, which on a Claude subscription counts against its usage limits).

## Install

You need Firefox 152 or newer (153 ESR works) and Node.js 20 or newer.

> **Linux:** Ubuntu's default Firefox is a Snap, and Snap/Flatpak Firefox is sandboxed and may not be able to start the helper. If the toolbar fox keeps its `!` badge, install Firefox from [Mozilla's .deb repository or tarball](https://support.mozilla.org/kb/install-firefox-linux). Setup also registers the helper with Flatpak Firefox, LibreWolf, Waterfox and Floorp when it finds them.

1. **Install the helper** and register it with Firefox. Add `--claude-code` and/or `--claude-desktop` to also register the MCP server with those apps:
   ```sh
   npx kitsune-firefox setup --claude-code --claude-desktop
   ```
   Setup copies one self-contained file to `~/.kitsune/app/` (on Windows, `%USERPROFILE%\.kitsune\app\`) and registers it with Firefox. It then prints the exact MCP config for any other client.
2. **Install the extension.** It's in review on addons.mozilla.org (submitted 2026-11-08); the link goes here once it's approved. Until then, build it and load it yourself: see [Install from source](#before-the-store-listing-is-live-install-from-source) below. (The helper in step 1 is already on npm.) The fox in your toolbar loses its `!` badge once it finds the helper.
3. **Ask Claude to use it**, e.g. *"Use Kitsune to open my GitHub notifications and summarize them."*

Run `npx kitsune-firefox doctor` any time to check every link in the chain. `npx kitsune-firefox uninstall` removes the helper and the Claude Code / Claude Desktop entries again.

### Before the store listing is live: install from source

```sh
git clone https://github.com/william-ricchiuti/Kitsune.git && cd Kitsune
npm ci && npm ci --prefix host
npm run build                                  # extension → dist/store, helper → host/dist/kitsune.mjs
node host/dist/kitsune.mjs setup --claude-code # or --claude-desktop, or neither
```

Then load the extension: open `about:debugging#/runtime/this-firefox`, click **Load Temporary Add-on…** and pick `dist/store/manifest.json`. A temporary add-on is removed when Firefox restarts. To keep it installed, use [Firefox Developer Edition or Nightly](https://www.mozilla.org/firefox/developer/) with `xpinstall.signatures.required` set to `false` in `about:config`, and install `dist/zips/kitsune-store-*.zip` (made by `npm run package`) from `about:addons` → ⚙ → *Install Add-on From File*.

### Using it from Claude Code without `--claude-code`

```sh
# macOS / Linux
claude mcp add --scope user kitsune -- node ~/.kitsune/app/kitsune.mjs mcp
# Windows (PowerShell)
claude mcp add --scope user kitsune -- node "$env:USERPROFILE\.kitsune\app\kitsune.mjs" mcp
```

### Optional: real input (WebDriver BiDi)

Quit Firefox, then start it with remote debugging on:

```sh
# macOS
/Applications/Firefox.app/Contents/MacOS/firefox --remote-debugging-port=9222
# Linux
firefox --remote-debugging-port=9222
# Windows (PowerShell)
& "C:\Program Files\Mozilla Firefox\firefox.exe" --remote-debugging-port=9222
```

Kitsune picks it up automatically. `tabs_context_mcp` reports `Input mode: trusted`, and so does the toolbar popup.

**Before turning this on, know that:**

- Any program on your computer can then control Firefox through that port, with no password. Only use it on a machine you trust, and don't leave it on all the time.
- Kitsune sends keystrokes (which can include text you gave the agent for a form) to whatever answers on that port. It checks that the answer comes from Firefox, but another local program could still take the port first if Firefox isn't using it. To use a different port, start Firefox with `--remote-debugging-port=N` and set `KITSUNE_BIDI_PORT=N` for the MCP server.
- Firefox shows a striped address bar and a robot icon while it's on.
- Pages can tell the browser is being automated: Firefox sets `navigator.webdriver` to `true` whenever remote debugging is on. On your Mac, Google showed its "unusual traffic" check in this mode but not in the default mode. Kitsune deliberately doesn't hide this.
- At startup, Firefox applies a few "automation" preferences, such as turning off update checks. Set `remote.prefs.recommended` to `false` in `about:config` to stop that.

Without it, Kitsune works on most sites. The things that need real input are listed under [Limitations](#limitations).

## Safety model

- **Agent tabs only.** The agent can only use tabs in the orange **Kitsune** tab group. To share an existing tab, drag it into the group. Popups and new tabs opened from agent tabs join the group automatically.
- **You approve every site.** Before the agent opens, reads or touches a site you haven't approved, Kitsune shows you a small window owned by the extension, not by the web page. That means a page can't hide it, restyle it, or trick you into clicking it, and neither the page nor the AI can press its buttons. The choices are *Deny*, *Allow this session* and *Always allow*.
  - This covers embedded frames from other sites too: they stay hidden from the agent until you approve that site.
  - You can review and revoke sites in the toolbar popup, or switch to "Allow all sites" if you prefer.
- **Commands stay on the approved site.** Every command is tied to the site you approved. If the page has since navigated to another site, the content script refuses it.
- **File uploads need your OK each time.** Kitsune shows you the file names and sizes and waits for your confirmation. Key and credential files are always refused: `~/.ssh`, `.env`, `*.pem`, cloud CLI credentials, browser profiles (saved passwords and cookies), shell history, and Claude's own settings.
- **Passwords stay hidden.** Password fields appear to the agent as `(password, N characters)`, never their contents, even when Firefox has filled in a saved login.
- **The permission window can't be clicked by accident.** Its buttons only work after it has been on screen for a moment, so a window that pops up under your cursor mid-click can't catch that click. The default button is *Allow this session*, not *Always allow*. The page's title is shown, labelled as coming from the website.
- **Stopping the agent.** Any of these pauses it:
  - the toolbar popup
  - **Alt+Shift+K**
  - the in-page *Stop* pill

  Stopping interrupts work already in progress: open permission windows are denied, typing and drags stop at the next keystroke or step, and the agent is told you stopped it.

  While the agent is working, the tab group title changes to **Kitsune ● working** and the page gets an orange glow. The in-page pill and glow are only a convenience, because a hostile page could hide or imitate them. The toolbar and the keyboard shortcut are the controls the page can't touch.
- **See what the agent is doing.** The in-page pill shows the agent's description of its latest action ("Kitsune: Sends the reply to pat@example.com"), and the toolbar popup lists its recent actions: in quotes when they're the agent's own words, otherwise Kitsune's plain description ("Opened example.com", "Typed 12 characters"). The agent's words are a convenience, not a guarantee: a manipulated agent could describe an action wrongly.
- **No open ports.** The helper talks to AI clients through a Unix socket in `~/.kitsune` that only your user can open (directory mode 0700, socket 0600). On Windows it uses a named pipe with an unguessable name. Nothing listens on TCP unless you turn on real input yourself.
- **Prompt injection is still possible.** Web pages can contain text written to manipulate an AI. Kitsune's permission windows limit the damage, but review what your agent is about to do on sensitive sites.

## Tools

Kitsune's tools are compatible with Claude in Chrome's: same names, same arguments, including `action_summary`, `upload_image` and choosing between browsers. Kitsune adds `handle_dialog`, `visible_only` for `read_page`, and `query`/`offset` for `get_page_text`.

| Tool | What it does |
|---|---|
| `tabs_context_mcp` | List the agent's tabs (and create one). Also reports the input mode. |
| `tabs_create_mcp` / `tabs_close_mcp` | Open or close agent tabs. |
| `navigate` | Go to a URL, or `back` / `forward`. |
| `read_page` | Accessibility outline with refs. Open popups and dialogs are listed first. Options: `filter: "interactive"`, `visible_only` (just what's on screen), `depth`, `ref_id` (a subtree, or the inside of an iframe), `max_chars`. |
| `find` | Find elements by description ("search box", "add to cart button"). |
| `computer` | `screenshot`, `zoom`, `left_click`, `right_click`, `double_click`, `triple_click`, `hover`, `type`, `key`, `scroll`, `scroll_to`, `left_click_drag`, `wait`. Coordinates, or refs for clicks. `action_summary` describes the action for you (see Safety model). |
| `form_input` | Set text fields, selects, checkboxes, radios, date/range inputs and rich-text editors by ref. On custom dropdowns and autocompletes (MUI, react-select, Radix…) it opens the list, types, and clicks the matching option. |
| `get_page_text` | Readable text of the main content, 20k characters at a time (`offset` for more). With `query`, it returns only the passages about that topic. |
| `gif_creator` | Record the session as an animated GIF (`start_recording` → act → `stop_recording` → `export`, which saves to Downloads). Frames show click circles, drag arrows, each action's label, a progress bar and a small watermark; `options` turns these off and sets `quality`. With `coordinate`, export also drops the GIF onto the page (you confirm the upload). |
| `browser_batch` | Several of the above in one call, e.g. fill three fields and click Submit. Stops at the first error. |
| `file_upload` | Attach local files to a file input or drop zone. You confirm each upload. |
| `upload_image` | Attach a screenshot the agent just took (each screenshot result has an ID) to a file input or drop zone, e.g. for a bug report. You confirm each upload. |
| `list_connected_browsers` / `select_browser` / `switch_browser` | Work with several Firefox profiles at once (say, "Work" and "Personal"): list them, pick one by its ID, or let you pick by clicking Connect in a window that appears in each. Name each browser in its Kitsune toolbar popup. |
| `handle_dialog` | Choose how the next JavaScript `confirm()`/`prompt()` is answered. While the agent is working in a tab (and for a few seconds after), dialogs don't block the page: alerts are dismissed, confirms/prompts are cancelled, and the tool result reports what the page asked. When you use the tab yourself, the page's dialogs appear normally. |
| `read_console_messages` / `read_network_requests` | Console output and HTTP requests of an agent tab. |
| `resize_window` | Resize the browser window. |
| `javascript_tool` | Run JS in the page. **Full build only** (see below). |

### Two builds

- **Kitsune** (addons.mozilla.org): everything except `javascript_tool`. Mozilla's policy doesn't allow extensions to run code strings that come from outside the add-on.
- **Kitsune (Full)**: adds `javascript_tool`. Distribute it yourself (signed as "unlisted" on AMO, or unsigned in Firefox Developer Edition / Nightly). Pages with a strict Content-Security-Policy can still block it.

## Limitations

Without real input (remote debugging off):

- **Anti-bot checks.** Some sites only accept real (trusted) events: Cloudflare Turnstile, reCAPTCHA and some banking or social sites. Solve CAPTCHAs yourself.
- **Menus and dropdowns.** Firefox's own right-click menu and native `<select>` dropdowns can't be opened. Use `form_input` for selects. Custom page menus work.
- **Hover styles.** CSS `:hover` isn't triggered. JavaScript hover handlers are.
- **Clipboard.** Clipboard shortcuts (`ctrl+c/v`) mostly fail.

Also:

- **Several Firefox profiles.** Several can be connected at once. An agent uses the first one that connected unless it picks another (`select_browser`, `switch_browser`). Real input (WebDriver BiDi) only works in the Firefox that was started with remote debugging; in the others, Kitsune uses synthetic input.
- **Pages extensions can't touch.** Firefox blocks all extensions on `about:` pages, `addons.mozilla.org` and a few Mozilla account pages.
- **Firefox's JSON and PDF viewers.** Pages shown in these viewers can't be read or screenshotted by extensions. For JSON loaded with GET, `get_page_text` fetches it again; otherwise Kitsune explains the problem and suggests the `devtools.jsonview.enabled` pref.
- **Snap and Flatpak Firefox.** On Linux, the sandboxed Snap/Flatpak builds may not be able to start the helper (see [Install](#install)).
- **Console capture starts when Kitsune's hooks load.** Messages logged by scripts in the page's `<head>`, before that, can be missed; reload the page to capture them.
- **Windows** hasn't been tested as thoroughly as macOS and Linux (see [docs/MANUAL-CHECKS.md](docs/MANUAL-CHECKS.md)).
- **`find`** uses word matching, not a language model, so describe elements by their visible text or role.

## Development

```sh
npm ci && npm ci --prefix host
npm run build              # extension → dist/store and dist/full, helper/MCP → host/dist/kitsune.mjs
node test/build-fixtures.mjs

# End-to-end tests against a real Firefox. FIREFOX must point at the binary to test with.
export FIREFOX=/path/to/firefox
node test/e2e.mjs                           # 60 tests, synthetic input
KITSUNE_E2E_TRUSTED=1 node test/e2e.mjs     # same tests with WebDriver BiDi input
node test/e2e-safety.mjs                    # presses the real permission-window and popup buttons
node test/e2e-permissions.mjs               # approval timeouts, frame gating, uploads
node test/e2e-store.mjs                     # AMO build smoke test
node test/e2e-resilience.mjs                # concurrent clients, latency, helper crash, Firefox restart
node test/e2e-multi.mjs                     # two Firefox profiles: list, select, switch, takeover
node test/e2e-idle.mjs                      # still answers after the event page's idle timeout (75 s)
node test/bidi-connect.mjs                  # real-input client vs a fake one-session Firefox (no browser)
node test/bench-actions.mjs                 # latency of common tool calls
node test/realsites.mjs                     # 51 tasks on real websites (needs internet)
node test/agent-eval.mjs [--trusted|--ask]  # a real Claude Code agent does 17 tasks (needs the claude CLI; about $4 with Opus 5.5)
bash scripts/mac-test.sh [quick|agent]      # the main suites on macOS, against a throwaway copy of your Firefox
npx web-ext lint --source-dir dist/store
node scripts/version.mjs check              # the three version numbers agree
```

On Linux the tests don't touch your own Kitsune install: they set up the helper in a temporary home folder. On macOS they use your real `~/.kitsune`, so run `node host/dist/kitsune.mjs setup` again afterwards if you use a released version.

Results are in [docs/TESTING.md](docs/TESTING.md). What's planned next is in [docs/ROADMAP.md](docs/ROADMAP.md). The checks automation can't do are listed in [docs/MANUAL-CHECKS.md](docs/MANUAL-CHECKS.md). The tests use `web-ext run` with a temporary profile. They configure Kitsune through an enterprise policy (`policies.json` → `3rdparty.Extensions`), which administrators can also use to pre-approve sites (`allowed`, `mode`, `promptTimeoutSec`, `confirmUploads`).

Layout:

- `src/content/`: the content script (outline, input, overlay).
- `src/background/`: the extension's event page (native messaging, tab group, permissions, tools).
- `extension/`: manifest, popup and permission window.
- `host/src/`: helper, MCP server, BiDi client, setup.
- `vendor/playwright/`: the unmodified upstream files. The build-time patches (contenteditable roles, hidden password values, closed shadow roots) are documented in its README.

## Credits

The accessibility-snapshot engine is from [Playwright](https://github.com/microsoft/playwright) (Apache-2.0, © Microsoft). Kitsune is not affiliated with Anthropic or Mozilla. "Claude" is a trademark of Anthropic and "Firefox" is a trademark of the Mozilla Foundation.

License: Apache-2.0.
