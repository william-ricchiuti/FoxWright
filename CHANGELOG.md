# Changelog

## Unreleased

Work from the 0.3.0 review; `docs/ROADMAP.md` tracks every item.

**Security and privacy**
- Password values are never shown to the agent: the outline says `(password, N characters)`, and click/type results leave them out.
- Kitsune's scripts go only into the frames a tool actually reaches (after that frame's site is approved), not into every ad, payment or login iframe on the page.
- Stop/Pause now interrupts work in progress: open permission windows are denied, typing and drags stop at the next step, and the running command reports that the user stopped it. The popup's Pause does the same as the shortcut and the in-page Stop.
- Trusted mode only sends input to a WebDriver BiDi endpoint that identifies as Firefox.
- A page can no longer make its own elements look like Kitsune's UI to be skipped.
- The permission window's buttons only work after it has been on screen for a moment, and are disabled in its HTML until then (clickjacking guard). *Allow this session* is now the default button, and the page title is labelled as coming from the website.
- Console capture and dialog handling moved out of the page's reach (Firefox's isolated content-script world): pages can no longer switch them off or forge the dialog reports Kitsune gives the agent.
- Dialogs are only auto-answered while the agent is working in the tab. When you use the tab yourself, the page's dialogs appear normally.
- `javascript_tool` (full build) refuses to run if the tab navigated to another site since it was approved.
- `file_upload` also refuses browser profiles (saved logins, cookies), shell history, Claude's settings and system password files, matches paths case-insensitively, and checks size and file type before reading.
- A tab group is only re-adopted after a restart if it has Kitsune's title and orange color.

**Fixes**
- Typing in a tab that isn't in front ran at about one character per second (Firefox throttles timers in background tabs). It now runs at full speed.
- Commands for the same tab run one at a time, so parallel tool calls or two agents can't interleave their typing. A second AI client gets its own tab instead of sharing the first one's, and a tab closed mid-command gives a clear message.
- The toolbar popup also works when opened in a tab.
- Editors inside `about:blank` and `srcdoc` iframes (TinyMCE, CKEditor 4, many webmail composers) can be read, clicked and typed into.
- Web components with closed shadow roots appear in the outline and can be clicked.
- The MCP server exits when the AI client closes it, releasing Firefox's single WebDriver BiDi session.
- Trusted mode survives an extension reload or Firefox restart, and a second MCP client no longer switches it off for the first.
- A command that times out says the action may still have happened.
- `npx kitsune-firefox` warns once if the MCP server, helper and extension versions don't match.
- Windows: the helper and MCP server can no longer pick different pipe names on first run.

**Packaging**
- `kitsune-firefox uninstall` also removes the Claude Code and Claude Desktop entries and `~/.kitsune`. `setup` also registers with Flatpak Firefox, LibreWolf, Waterfox and Floorp when they're installed. New `kitsune-firefox --version`.
- `scripts/version.mjs` checks and bumps the version in all three places.

**Docs and project**
- README: install from source until the store listing and npm package are live, per-OS commands, a fairer comparison table (now including Playwright MCP), and plainer wording about the agent evaluation.
- New SECURITY.md (private reporting), CONTRIBUTING.md, issue and pull-request templates, AMO listing text and screenshots (`docs/amo/`, made by `npm run screenshots`), and a release workflow that builds the zips, creates the GitHub release and, once secrets are set, signs the full build and publishes to npm.
- PRIVACY.md covers GIF recordings, file uploads, in-tab buffers and the real-input connection.
- `docs/ROADMAP.md` tracks the review items.

**Tests**
- New `test/e2e-safety.mjs` presses the real buttons in the permission window and the toolbar popup (Deny, Allow this session, Always allow and revoke, Pause and Resume, including Pause while typing and while a permission window is open, and upload approval).
- On Linux, tests no longer touch your own Kitsune install: they set up the helper in a temporary home folder and use a free debugging port and a temporary GIF folder.
- The agent evaluation checks results more strictly (e.g. that exactly the right to-do is completed, that only "Kitsune" is bold, that the agent really used the site's search), adds a local multi-step sign-up task with validation errors, and can run with permission prompts on (`--ask`, answered by a scripted user) and repeat tasks (`--repeat N`, pass@1 and pass@N).
- CI tests the oldest supported Firefox (140 ESR) as well as the latest, runs the safety and idle suites, and installs the packed npm package on Linux, Windows and macOS.
- The npm package has no runtime dependencies (everything is bundled), so `npx` downloads one package instead of ~96.
- Built add-ons and the npm bundle include LICENSE, NOTICE and THIRD-PARTY-NOTICES.txt (Playwright's Apache-2.0 notice and the MIT/ISC notices of bundled packages).
- The AMO source zip now includes `host/` and a BUILDING.txt; rebuilding from it gives a byte-identical add-on.

**Speed and tokens**
- Actions wait on Firefox's navigation events instead of fixed sleeps, and only as long as the action could start a page load. On the local fixtures (`test/bench-actions.mjs`, medians): clicking a button 323 → 120 ms, typing 10 characters 347 → 46 ms, a key press 318 → 25 ms, clicking a link that loads a page 258 → 114 ms.
- `navigate` and clicks that load a page return once the new page's HTML is parsed, plus at most 1 s for the full load, instead of waiting for every image and tracker.
- `read_page` returns 20k characters by default (was 50k); the "on screen now" list after a navigation is capped at 1.5k, and inside `browser_batch` only the last step gets one.
- `read_page` and `find` reach into iframes in parallel.
- The tool list the AI receives with every request is ~10% smaller: alternative argument names are still accepted but no longer advertised.
- `browser_batch` steps get the same forgiving argument parsing as direct calls.
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
