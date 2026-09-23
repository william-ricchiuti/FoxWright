# Changelog

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
