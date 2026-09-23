# Changelog

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
