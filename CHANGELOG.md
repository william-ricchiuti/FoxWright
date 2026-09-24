# Changelog

## Unreleased

Work from the 0.3.0 review; `docs/ROADMAP.md` tracks every item.

**Security and privacy**
- Password values are never shown to the agent: the outline says `(password, N characters)`, and click/type results leave them out.
- Kitsune's scripts go only into the frames a tool actually reaches (after that frame's site is approved), not into every ad, payment or login iframe on the page.
- Stop/Pause now interrupts work in progress: open permission windows are denied, typing and drags stop at the next step, and the running command reports that the user stopped it. The popup's Pause does the same as the shortcut and the in-page Stop.
- Trusted mode only sends input to a WebDriver BiDi endpoint that identifies as Firefox.
- A page can no longer make its own elements look like Kitsune's UI to be skipped.

**Fixes**
- Editors inside `about:blank` and `srcdoc` iframes (TinyMCE, CKEditor 4, many webmail composers) can be read, clicked and typed into.
- Web components with closed shadow roots appear in the outline and can be clicked.
- The MCP server exits when the AI client closes it, releasing Firefox's single WebDriver BiDi session.
- Trusted mode survives an extension reload or Firefox restart, and a second MCP client no longer switches it off for the first.
- A command that times out says the action may still have happened.
- `npx kitsune-firefox` warns once if the MCP server, helper and extension versions don't match.
- Windows: the helper and MCP server can no longer pick different pipe names on first run.

**Packaging**
- The npm package has no runtime dependencies (everything is bundled), so `npx` downloads one package instead of ~96.
- Built add-ons and the npm bundle include LICENSE, NOTICE and THIRD-PARTY-NOTICES.txt (Playwright's Apache-2.0 notice and the MIT/ISC notices of bundled packages).
- The AMO source zip now includes `host/` and a BUILDING.txt; rebuilding from it gives a byte-identical add-on.

**Speed and tokens**
- Key presses and typing no longer read the text of the whole page to describe the focused element.
- `tabs_context_mcp` mentions the input mode only when it's new to the session.

## 0.3.0 (2026-09-23)

- New `gif_creator` tool records an agent session as an animated GIF, with clicks marked. `export` saves it to Downloads, or to `KITSUNE_GIF_DIR`. Only a file name is accepted, never a path, so an agent can't overwrite other files.
- GitHub Actions CI runs the build, lint and the end-to-end suites (both input modes) against the latest Firefox.
- `docs/MANUAL-CHECKS.md` lists the checks automation can't do: Windows, logged-in sites and safety.
- The repository moved to github.com/william-ricchiuti/Kitsune.

## 0.2.0 (2026-09-23)

Tuned with a real agent: Claude Code completed 16/16 everyday browser tasks with Kitsune in both input modes (docs/agent-eval-*.md). The first run scored 14/16 at $2.57; the same suite now costs about $1.57.

- New `browser_batch` tool: several steps in one call.
- `get_page_text` returns pages of 20k characters, and `query` returns only the relevant passages.
- `form_input` works on custom comboboxes (MUI, react-select, Radix, Headless UI): it opens them, types, and clicks the matching option.
- Double-click selects a word, and triple-click a paragraph.
- After `navigate`, and after clicks that load a new page, the result lists what's clickable on screen, so the agent doesn't need an extra `read_page`.
- More forgiving arguments:
  - `tabId` is optional and defaults to the last tab.
  - `find` also accepts `text` and `description` in place of `query`.
  - `key` is accepted as an alias for `text`.
  - Numbers sent as strings and arrays sent as JSON strings are accepted.
  - Out-of-range numbers are clamped rather than rejected.
- Clearer JavaScript error messages. The waiting-for-navigation check is skipped after clicks that can't start a page load.
- New tools for testing and releasing: `test/agent-eval.mjs` (a real-agent evaluation), `scripts/mac-test.sh agent`, and a demo GIF.

## 0.1.0 (2026-09-23)

First release.

- Firefox MV3 extension + native helper + MCP server.
- Tools compatible with Claude in Chrome: `tabs_context_mcp`, `tabs_create_mcp`, `tabs_close_mcp`, `navigate`, `read_page`, `find`, `computer`, `form_input`, `get_page_text`, `read_console_messages`, `read_network_requests`, `resize_window`, `file_upload`, plus `javascript_tool` in the full build.
- Accessibility outline via vendored Playwright aria-snapshot; same-origin and cross-origin iframes stitched in.
- Synthetic input tuned for React/Vue/rich-text editors; automatic trusted input through WebDriver BiDi when Firefox runs with `--remote-debugging-port`.
- Safety: agent tab group, per-site approval in an extension-owned window, per-frame approval, upload confirmation + credential-file denylist, Alt+Shift+K pause, owner-only local socket.

### Hardening from real-site testing (same day)

- JavaScript dialogs no longer freeze agent tabs; new `handle_dialog` tool.
- Typing yields between keystrokes (fixes Lexical and other async editors).
- Pointer-capture emulation for canvas apps (Excalidraw etc.).
- `read_page`: open popups listed first, custom combobox values shown, `visible_only` option.
- Drags and `find` coordinates work inside iframes; slider clicks jump to position.
- Clear messages for Firefox error pages and the JSON/PDF viewers; GET JSON is re-fetched.
- Better `find` ranking; navigation detection after clicks/Enter.
- New suites: real sites (51 tasks), resilience/load. See docs/TESTING.md.
