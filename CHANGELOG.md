# Changelog

## 0.7.1 (2026-11-13)

**Fix: the helper works with the 0.6 extension again.** Until Firefox updates the add-on to 0.7, the store's extension is still the Zenko 0.6 one, which asks Firefox for a helper named "zenko". The 0.7.0 helper only answered to "foxwright", so a new install didn't connect, and running `npx foxwright-firefox setup` on a working Zenko install disconnected it. `setup` now registers the helper under both names. `uninstall` removes both.
- `gif_creator` works with a 0.6 extension again (0.7.0 asked it for a check it doesn't have).

## 0.7.0 (2026-11-13)

**Zenko is now Foxwright.** "Zenko" turned out to be shared with a crypto token, a storage project and several other "Zen" browser tools, so the project couldn't be found by its name. What changes for you:

- The helper is now `npx foxwright-firefox setup`. Running it removes the old Zenko (and Kitsune) helper, its `~/.zenko` folder and its Claude Code / Claude Desktop entries, and installs the new one in `~/.foxwright`. Do this once after the extension updates; until then the toolbar fox shows `!`.
- The tab group is titled "Foxwright". An existing orange "Zenko" group is adopted and renamed.
- Environment variables are now `FOXWRIGHT_*` (were `ZENKO_*`), and the MCP server entry is named `foxwright`.
- The add-on's ID is unchanged, so the extension updates in place and keeps your approved sites.

This release also contains the fixes below, which were prepared as 0.6.1 and not published separately.

## 0.6.1 (2026-11-13, released as part of 0.7.0)

Fixes from a round of testing after the store listing went live. Most are in the Stop button and the per-site approval, the two things Zenko promises.

**Stop and pause**
- Stop now interrupts real (WebDriver BiDi) typing and key repeats within a few keystrokes. Before, a long text kept arriving after Stop and the agent was told it had succeeded.
- A command that was waiting behind another one on the same tab no longer runs after Stop.
- Paused stays paused across a Firefox restart or an extension update, until you resume it.
- The in-page Stop pill no longer catches clicks after it has faded out. A click on the page there used to do nothing and pause Zenko. When the agent's own real click is aimed under the visible pill, the pill moves to the top edge first.

**Site approval**
- Screenshots, zooms and GIF frames grey out embedded frames from sites you haven't approved, as `read_page` already left them out. The result names those sites.
- `read_network_requests` no longer returns requests recorded on another site: the log is cleared whenever the tab's top-level site changes, including back/forward. Requests from unapproved embedded frames are left out.
- `navigate` back/forward asks before staying on a site you haven't approved. An extension can't see where history leads, so Zenko goes, steps straight back out if the site isn't approved, asks, and goes again only if you allow. The page does load for a moment first.
- A tab dragged out of the Zenko group loses access at once (it stayed readable for about half a second).
- `tabs_context_mcp` shows only the site for a tab on an unapproved site, not its full address and title.
- `gif_creator` refuses tabs outside the group.
- A click that lands on an unapproved site no longer opens a permission window by itself; the window appears when the agent next acts there.
- The permission window strips text-direction and zero-width characters from the page title it shows.
- The `upload_image` window says which site the screenshot was taken on.

**Secrets**
- A password field stays masked after the page's "Show password" button turns it into a text field.
- More files are refused for upload without asking: `.pgpass`, `.vault-token`, `.my.cnf`, `.s3cfg`, `.boto`, rclone, Terraform and Cargo credentials, keyrings, 1Password CLI and Thunderbird folders, renamed SSH keys (`id_rsa_old`), hard links to files in those folders, and anything under `/proc` or `/sys`.

**Reliability**
- `navigate` waits as long as the permission window stays open. It used to give up after 60 seconds while the window stayed up for 120, so a late Allow navigated after the agent had been told it failed.
- `navigate` says so when the page didn't leave, which usually means a "Leave page?" dialog that only you can answer.
- In real-input mode, `type` says when no text field had focus instead of reporting that it typed into a button.
- `read_console_messages` refuses patterns that could take minutes to evaluate, such as `(a+)+`, which froze the extension.
- Reinstalling without restarting Firefox works: the helper exits when `uninstall` removes its socket, and the extension starts a fresh one after `setup`.
- The helper no longer uses a full CPU core when its socket path is longer than the system allows; it gives up and logs why.
- The MCP server releases Firefox's remote-control session when its terminal is closed (SIGHUP). If a force-quit server left the session held, the status line now says a Firefox restart frees it.

**Docs**
- The README, the npm README and `setup` link the store listing. The npm README said Firefox 140+; the minimum is 152.

**Tests**
- Seven new suites, `test/e2e-gaps-*.mjs`: hostile pages against the permission window, the Stop pill and the Alt+Shift+K shortcut pressed for real, the tab-group boundary, uploads and secrets, argument fuzzing, approvals across restarts. They need `a.test`, `sub.a.test`, `b.test`, `c.test` and `xn--pple-43d.test` pointing to 127.0.0.1, and `xdotool` under Xvfb; see `test/README.md`.

**Known limits**
- A page whose login form submits with GET puts the password in a URL, which `read_network_requests` shows.
- An endless loop in `javascript_tool` (Full build) blocks that tab until it is closed.

## 0.6.0 (2026-11-10)

**Kitsune is now Zenko** (善狐, "good fox"). Another, unrelated Firefox MCP project is also called Kitsune (github.com/junyeong-nero/kitsune), and it even uses the same `~/.kitsune` folder and Claude Code name.
- npm package `zenko-firefox` (was `kitsune-firefox`), command `npx zenko-firefox setup`. The MCP server registers as `zenko`, so tools are `mcp__zenko__*`.
- Files in `~/.zenko`, Firefox native-messaging name `zenko`, settings `ZENKO_*` (were `~/.kitsune`, `kitsune`, `KITSUNE_*`). The tab group is titled Zenko.
- `setup` (and `uninstall`) remove an old Kitsune install, but only what is provably this project's: the `kitsune.json` registration if it names this extension, the Claude entries if they run this helper, and this helper's files in `~/.kitsune` (the folder too only if nothing else is in it). `uninstall` used to delete all of `~/.kitsune`, which would also have removed the other project's files. New `test/rename-cleanup.mjs`.
- The extension's id is unchanged, so its settings and site approvals carry over, and an open Kitsune tab group is reused.

## 0.5.0 (2026-11-08)

Features from Claude in Chrome's public tool definitions (interface only; no code was copied).

**New**
- **Action summaries.** `computer` and `form_input` take `action_summary`, a few words on what the action does. The in-page pill shows it ("Kitsune: Sends the reply to pat@example.com") and the toolbar popup lists the agent's recent actions, quoting its own words and describing the rest ("Opened example.com", "Typed 12 characters"). Summaries are cleaned to one line without control or text-direction characters.
- **Several Firefox profiles at once.** `list_connected_browsers`, `select_browser` and `switch_browser` (a "Use this Firefox?" window appears in every connected browser; the one where you click Connect is used). Name each browser in its toolbar popup. The first browser to connect is the default, and the next one takes over when it closes; the agent is told when that happens. Before, a second profile got "Only one can be connected at a time".
- **`upload_image`.** Screenshot results carry an ID; `upload_image` attaches that screenshot to a file input or drop zone, after you confirm it like any upload.
- **GIF export options.** `gif_creator` export draws each action's label, drag arrows, a progress bar and a small watermark as well as click circles (now also for clicks by ref), with `options` to turn each off and `quality` 1–30. `coordinate` drops the finished GIF onto the page. The overlays are drawn by the extension with real fonts; an older extension falls back to click circles.
- The agent is told to close the tabs it opened when it's done.

**Tests**
- `test/e2e-multi.mjs` (two Firefoxes), new safety tests for `upload_image` and the popup's action list, and a GIF options test.

## 0.4.2 (2026-11-08)

**Fixes**
- Cmd/Alt/Ctrl + arrow keys, and Ctrl+Home/End, did nothing in the default (synthetic) input mode: the caret stayed where it was. They now work as on a real keyboard, in text fields, text areas and rich-text editors: Cmd+Left/Right to the start/end of the line, Alt or Ctrl+Left/Right by a word, Cmd+Up/Down and Ctrl+Home/End to the start/end of the text, and with Shift they extend the selection. Agents use these to select a word before formatting it (found in DeepSeek's transcripts from the cross-model evaluation). New e2e test with 20 cases; real-input mode was already fine.

## 0.4.1 (2026-11-08)

**Fixes**
- Real input (WebDriver BiDi) could stay off for a whole session. When the AI client's first call came while Kitsune was still connecting at startup, two connections raced for Firefox's single session; one was refused and the other was stranded. Connection attempts are now shared. New `test/bidi-connect.mjs` checks this against a fake Firefox, and CI runs it.

**Dependencies**
- The npm package bundles MCP SDK 1.32.2 (was 1.30.1), zod 4.6.7 (was 4.6.5; fixes a memory-exhaustion advisory when validating oversized input) and fast-uri 3.1.9. The SDK's advisories cover tasks, OAuth, bearer auth and HTTP transports, which Kitsune doesn't use (it runs the server over stdio only). `npm audit` for the package reports 0 vulnerabilities.
- Test and build tools: web-ext 10.8.0 (fixes shell-quote) and updated lockfile entries (undici, node-forge, hono). The extension itself is unchanged apart from its version number.

## 0.4.0 (2026-11-08)

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
- Links that open in a new tab get the same checks as `navigate` (http(s) only, approved sites).
- `doctor` says when the debugging port is already in use by a running Kitsune MCP server, instead of reporting real input as off.

- `read_page` waits (up to 3 s) for frames that are still loading their page, instead of showing them empty. Pages built from nested frames came back blank when read right after `navigate`.
- When real input is expected but can't start, `tabs_context_mcp` says why, and names the port actually in use.

**Packaging**
- Firefox 152 or newer is required (was 140). Firefox 140–151 give Manifest V3 extensions no way to screenshot a tab, so `screenshot`, `zoom` and `gif_creator` failed there. The current ESR, 153, works.
- `kitsune-firefox uninstall` also removes the Claude Code and Claude Desktop entries and `~/.kitsune`. `setup` also registers with Flatpak Firefox, LibreWolf, Waterfox and Floorp when they're installed. New `kitsune-firefox --version`.
- `scripts/version.mjs` checks and bumps the version in all three places.

**Docs and project**
- README: install from source until the store listing and npm package are live, per-OS commands, a fairer comparison table (now including Playwright MCP), and plainer wording about the agent evaluation.
- New SECURITY.md (private reporting), CONTRIBUTING.md, issue and pull-request templates, AMO listing text and screenshots (`docs/amo/`, made by `npm run screenshots`), and a release workflow that builds the zips, creates the GitHub release and, once secrets are set, signs the full build and publishes to npm.
- PRIVACY.md covers GIF recordings, file uploads, in-tab buffers and the real-input connection.
- `docs/ROADMAP.md` tracks the review items.

**Tests**
- The safety suite and the agent evaluation's scripted user work on Firefox 159, which replaced the `-remote-allow-system-access` flag with the `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS` environment variable.
- CI uses the Node 24 versions of GitHub's actions (v7); `scripts/version.mjs check` also compares the versions in both lockfiles.
- New `test/e2e-safety.mjs` presses the real buttons in the permission window and the toolbar popup (Deny, Allow this session, Always allow and revoke, Pause and Resume, including Pause while typing and while a permission window is open, and upload approval).
- On Linux, tests no longer touch your own Kitsune install: they set up the helper in a temporary home folder and use a free debugging port and a temporary GIF folder.
- The agent evaluation checks results more strictly (e.g. that exactly the right to-do is completed, that only "Kitsune" is bold, that the agent really used the site's search), adds a local multi-step sign-up task with validation errors, and can run with permission prompts on (`--ask`, answered by a scripted user) and repeat tasks (`--repeat N`, pass@1 and pass@N).
- CI tests the oldest supported Firefox (152) as well as the latest, runs the safety and idle suites, and installs the packed npm package on Linux, Windows and macOS.
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
