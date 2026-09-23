# Kitsune 狐

**Let Claude (or any MCP-capable AI agent) use your real Firefox**: your tabs, your logins, your extensions. It works the same way Claude in Chrome does in Chrome.

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

Chrome extensions can call Chrome's DevTools protocol (`chrome.debugger`). That's how Claude in Chrome gets a page outline and real mouse and keyboard input. Firefox extensions have no equivalent API ([bug 1316741](https://bugzilla.mozilla.org/show_bug.cgi?id=1316741)). The existing Firefox bridges each fall short somewhere:

| | Page outline for the AI | Input that React/Vue/editors accept | Security |
|---|---|---|---|
| Blueprint MCP (Firefox) | its own docs say the snapshot is broken in Firefox | appends to `.value` (React ignores it) | local WebSocket |
| ClaudeCodeBrowser | screenshots / raw DOM | basic DOM events | HTTP server on localhost, no auth; polls twice a second |
| browser-control-mcp | read-only | none (by design) | good (shared secret, per-site consent) |
| mozilla/firefox-devtools-mcp | JS tree walk, roles from `role=` only | real (WebDriver) | needs Firefox started in remote-debugging mode |
| **Kitsune** | full accessibility outline (roles, names, states, values, refs), iframes included | synthetic events tuned per framework; **real input automatically** when Firefox runs with remote debugging | owner-only socket, no open port; per-site approval in an extension-owned window |

How Kitsune fills the gaps:

- **Page outline without DevTools.** It uses Microsoft Playwright's accessibility-snapshot code, vendored under Apache-2.0. That code computes WAI-ARIA roles and accessible names in plain JavaScript inside the page. `read_page` returns YAML like `- textbox "Email" [ref=e7]: ada@example.com`, and every interactive element gets a ref you can click or fill.
- **Input that frameworks accept.**
  - Clicks send the full pointer/mouse sequence, move focus like a real click, and place the caret where you clicked.
  - Typing goes through `execCommand('insertText')`, so React, Vue, ProseMirror, Lexical and Slate all see normal input events.
  - Keys like Enter, Tab, Backspace and arrows get their *default actions* reproduced: form submission, focus moves, deletion, caret moves.
  - HTML5 drag-and-drop, file inputs, `<select>`, range and date inputs are handled specially.
- **Real (trusted) input when available.** If Firefox is running with `--remote-debugging-port`, Kitsune detects it and sends clicks, keys, wheel and drags through WebDriver BiDi. Pages then see `isTrusted: true` events, including inside cross-origin iframes. If a step can't be done that way, it falls back to synthetic events, and never runs the same action twice.

## Install

You need Firefox 140 or newer and Node.js 20 or newer.

1. **Install the helper** and register it with Firefox. Add `--claude-code` and/or `--claude-desktop` to also register the MCP server with those apps:
   ```sh
   npx kitsune-firefox setup --claude-code --claude-desktop
   ```
   Setup copies one self-contained file to `~/.kitsune/app/` and writes Firefox's native-messaging manifest. It then prints the exact MCP config for any other client.
2. **Install the extension.** Get it from [addons.mozilla.org](https://addons.mozilla.org/firefox/addon/kitsune/) (once it's published), or from the `.xpi` in Releases. The fox in your toolbar loses its `!` badge once it finds the helper.
3. **Ask Claude to use it**, e.g. *"Use Kitsune to open my GitHub notifications and summarize them."*

Run `npx kitsune-firefox doctor` any time to check every link in the chain.

### Using it from Claude Code without `--claude-code`

```sh
claude mcp add --scope user kitsune -- node ~/.kitsune/app/kitsune.mjs mcp
```

### Optional: real input (WebDriver BiDi)

Start Firefox with remote debugging on:

```sh
# macOS
/Applications/Firefox.app/Contents/MacOS/firefox --remote-debugging-port=9222
# Linux / Windows
firefox --remote-debugging-port=9222
```

Kitsune picks it up automatically. `tabs_context_mcp` reports `Input mode: trusted`, and so does the toolbar popup.

**Before turning this on, know that:**

- Any program on your computer can then control Firefox through that port, with no password. Only use it on a machine you trust, and don't leave it on all the time.
- Firefox shows a striped address bar and a robot icon while it's on.
- At startup, Firefox applies a few "automation" preferences, such as turning off update checks. Set `remote.prefs.recommended` to `false` in `about:config` to stop that.

Without it, Kitsune works on most sites. The things that need real input are listed under [Limitations](#limitations).

## Safety model

- **Agent tabs only.** The agent can only use tabs in the orange **Kitsune** tab group. To share an existing tab, drag it into the group. Popups and new tabs opened from agent tabs join the group automatically.
- **You approve every site.** Before the agent opens, reads or touches a site you haven't approved, Kitsune shows you a small window owned by the extension, not by the web page. That means a page can't hide it, restyle it, or trick you into clicking it, and neither the page nor the AI can press its buttons. The choices are *Deny*, *Allow this session* and *Always allow*.
  - This covers embedded frames from other sites too: they stay hidden from the agent until you approve that site.
  - You can review and revoke sites in the toolbar popup, or switch to "Allow all sites" if you prefer.
- **Commands stay on the approved site.** Every command is tied to the site you approved. If the page has since navigated to another site, the content script refuses it.
- **File uploads need your OK each time.** Kitsune shows you the file names and sizes and waits for your confirmation. Key and credential files (`~/.ssh`, `.env`, `*.pem`, cloud CLI credentials…) are always refused.
- **Stopping the agent.** Any of these pauses it:
  - the toolbar popup
  - **Alt+Shift+K**
  - the in-page *Stop* pill

  While the agent is working, the tab group title changes to **Kitsune ● working** and the page gets an orange glow. The in-page pill and glow are only a convenience, because a hostile page could hide or imitate them. The toolbar and the keyboard shortcut are the controls the page can't touch.
- **No open ports.** The helper talks to AI clients through a Unix socket in `~/.kitsune` that only your user can open (directory mode 0700, socket 0600). On Windows it uses a named pipe with an unguessable name. Nothing listens on TCP unless you turn on real input yourself.
- **Prompt injection is still possible.** Web pages can contain text written to manipulate an AI. Kitsune's permission windows limit the damage, but review what your agent is about to do on sensitive sites.

## Tools

The names and arguments match Claude in Chrome.

| Tool | What it does |
|---|---|
| `tabs_context_mcp` | List the agent's tabs (and create one). Also reports the input mode. |
| `tabs_create_mcp` / `tabs_close_mcp` | Open or close agent tabs. |
| `navigate` | Go to a URL, or `back` / `forward`. |
| `read_page` | Accessibility outline with refs. Open popups and dialogs are listed first. Options: `filter: "interactive"`, `visible_only` (just what's on screen), `depth`, `ref_id` (a subtree, or the inside of an iframe), `max_chars`. |
| `find` | Find elements by description ("search box", "add to cart button"). |
| `computer` | `screenshot`, `zoom`, `left_click`, `right_click`, `double_click`, `triple_click`, `hover`, `type`, `key`, `scroll`, `scroll_to`, `left_click_drag`, `wait`. Coordinates, or refs for clicks. |
| `form_input` | Set text fields, selects, checkboxes, radios, date/range inputs and rich-text editors by ref. |
| `get_page_text` | Readable text of the main content. |
| `file_upload` | Attach local files to a file input or drop zone. You confirm each upload. |
| `handle_dialog` | Choose how the next JavaScript `confirm()`/`prompt()` is answered. Dialogs never block the page: by default alerts are dismissed and confirms/prompts are cancelled, and the tool result reports what the page asked. |
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

- **One Firefox profile.** Only one Firefox profile can be connected at a time.
- **Pages extensions can't touch.** Firefox blocks all extensions on `about:` pages, `addons.mozilla.org` and a few Mozilla account pages.
- **Firefox's JSON and PDF viewers.** Pages shown in these viewers can't be read or screenshotted by extensions. For JSON loaded with GET, `get_page_text` fetches it again; otherwise Kitsune explains the problem and suggests the `devtools.jsonview.enabled` pref.
- **Snap and Flatpak Firefox.** On Linux, the sandboxed Snap/Flatpak builds may not be able to start the helper. The Mozilla `.deb` or tarball build works.
- **`find`** uses word matching, not a language model, so describe elements by their visible text or role.

## Development

```sh
npm install && (cd host && npm install)
npm run build              # extension → dist/store and dist/full
(cd host && npm run build) # helper/MCP → host/dist/kitsune.mjs
node host/dist/kitsune.mjs setup

# End-to-end tests against a real Firefox (set FIREFOX=/path/to/firefox)
node test/e2e.mjs                           # 43 tests, synthetic input
KITSUNE_E2E_TRUSTED=1 node test/e2e.mjs     # same tests with WebDriver BiDi input
node test/e2e-permissions.mjs               # approval windows, frame gating, uploads
node test/e2e-store.mjs                     # AMO build smoke test
node test/e2e-resilience.mjs                # concurrent clients, latency, helper crash, Firefox restart
node test/realsites.mjs                     # 51 tasks on real websites (needs internet)
npx web-ext lint --source-dir dist/store
```

Results are in [docs/TESTING.md](docs/TESTING.md). The tests use `web-ext run` with a temporary profile. They configure Kitsune through an enterprise policy (`policies.json` → `3rdparty.Extensions`), which administrators can also use to pre-approve sites (`allowed`, `mode`, `promptTimeoutSec`, `confirmUploads`).

Layout:

- `src/content/`: the content script (outline, input, overlay).
- `src/background/`: the extension's event page (native messaging, tab group, permissions, tools).
- `extension/`: manifest, popup and permission window.
- `host/src/`: helper, MCP server, BiDi client, setup.
- `vendor/playwright/`: the unmodified upstream files. One build-time patch is documented in its README.

## Credits

The accessibility-snapshot engine is from [Playwright](https://github.com/microsoft/playwright) (Apache-2.0, © Microsoft). Kitsune is not affiliated with Anthropic or Mozilla. "Claude" is a trademark of Anthropic and "Firefox" is a trademark of the Mozilla Foundation.

License: Apache-2.0.
