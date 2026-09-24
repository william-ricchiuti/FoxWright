# Kitsune roadmap (post-0.3.0 review)

A full review of 0.3.0 (extension, helper, tests, docs) produced the list below. This file is the
source of truth for what's done and what's left: each item is marked when its change is committed,
so work can stop and resume at any point.

Status: `[x]` done · `[~]` partly done (see note) · `[ ]` not started

## 1. Fix before publishing

- [x] 1. Passwords shown to the AI (outline shows `input[type=password]` values; `describe()` falls back to `.value`) — masked in outline (build patch) and in click/type results; e2e test
- [x] 2. MCP server doesn't exit when the client closes stdin (orphan keeps the BiDi session) — exits on stdin end/close/SIGTERM and ends the BiDi session
- [x] 3. AMO source zip can't be rebuilt (omits `host/`) — zip includes host/ and BUILDING.txt; rebuild verified byte-identical
- [x] 4. License notices stripped from built files (Playwright Apache NOTICE, MIT deps in host bundle) — LICENSE, NOTICE, THIRD-PARTY-NOTICES.txt generated into dist/* and host/dist
- [x] 5. npm package lists bundled deps as runtime `dependencies` (~40 MB of unused installs) — all moved to devDependencies; package has 0 dependencies
- [x] 6. `about:blank` / `srcdoc` iframes can't be operated (origin check fails) — content script compares the inherited origin; click focuses the frame window; e2e tests for srcdoc and about:blank
- [x] 7. Content script + page hooks injected into every frame, including unapproved ones — frames injected one at a time, only when a tool reaches them
- [x] 8. Stop/Pause doesn't stop in-flight work; popup Pause doesn't notify the helper — Stop denies open prompts, cancels typing/drag loops, fails the running command; popup Pause uses the same path

## 2. Safety hardening

- [x] 9. Permission window: short click delay; "Allow this session" as default — buttons armed 800 ms after the window is focused/visible (or the pointer moves in it); Deny focused; "Allow this session" is the primary button
- [x] 10. Permission window shows the page's own title (and the wrong one for `navigate`) — title labelled as set by the website and truncated; not shown for navigate (it was the page being left)
- [x] 11. Pages can disable/forge page hooks (`__kitsuneConsoleHooked`, dialog answers) — console/dialog state moved to the isolated world (hooks.ts, exportFunction); MAIN world keeps only pointer capture; e2e tests with a hostile fixture
- [x] 12. Dialogs auto-answered even when the user is using the tab — auto-answer only while the agent works in the tab (+8 s, also across a navigation it caused); otherwise native dialogs
- [x] 13. `javascript_tool` not bound to the approved origin (full build) — runUserCode refuses if location.origin differs from the approved origin
- [x] 14. Trusted mode trusts anything on port 9222 (check browserName, document risk) — browserName checked; README explains the risk and `KITSUNE_BIDI_PORT`
- [x] 15. Secret-file denylist gaps (browser profiles, shell history, Claude config, case) — adds browser profiles, Claude config, shell history, /etc/shadow, Windows hives; case-insensitive
- [x] 16. `file_upload` reads before size check; accepts non-regular files — stat first: regular files only, size checked before reading
- [x] 17. Any group titled "Kitsune" is adopted — re-adopt by title only if the group is also orange

## 3. Speed and tokens

- [x] 18. Lower `read_page` default; shorter navigate summary; none for mid-batch steps — read_page default 20k chars; navigate summary capped at 1.5k; no summary for mid-batch steps
- [x] 19. Event-driven navigation waits instead of fixed polling — webNavigation events instead of polling; waits scaled to whether the action can navigate (see test/bench-actions.mjs: click 323→120 ms, type 347→46 ms, key 318→25 ms, link click 258→114 ms)
- [~] 20. Big pages: limits passed into the page, frames in parallel, `find` reuse — frames fetched in parallel for read_page and find; find returns the viewport in the same call. Not done: stopping the outline early inside the page (needs deeper changes to the vendored Playwright code)
- [x] 21. `describe()` reads whole-page innerText on every key press — uses textContent, skips body/html
- [x] 22. Alias parameters bloat tool schemas — aliases accepted but not advertised; `.int()` bounds dropped; tool listing 15.6k → 14.2k chars
- [x] 23. `browser_batch` skips per-tool argument parsing — every batch step goes through the same argument parsing as a direct call

## 4. Reliability

- [x] 24. Two agents collide on the same tab; no per-tab queue; raw "Invalid tab ID" errors — per-tab command queue in the extension and in the MCP server (trusted input bypasses the extension); "tab was closed" errors; a second connected client gets its own tab; e2e test
- [x] 25. Trusted-mode state lost after helper reconnect — client re-sends its state on reconnect; helper tracks it per client (also fixes #24-style multi-client flag)
- [x] 26. No version check between MCP server, helper and extension — helper reports its version; MCP warns once in tabs_context_mcp on minor mismatch
- [x] 27. Closed shadow roots invisible (`openOrClosedShadowRoot`) — build patch + input.ts; e2e test
- [x] 28. Timed-out commands keep running without telling the agent — timeout message tells the agent to check the page before retrying

## 5. Tests

- [~] 29. Safety features untested (pause/stop, allow/deny buttons, upload approve, origin binding, GIF filename) — new test/e2e-safety.mjs drives the permission window and popup through the test's own WebDriver BiDi session: Deny, Allow this session, Always allow + revoke, Pause/Resume, Pause during typing, Pause during a prompt, upload approval; GIF file-name test in e2e.mjs. Not covered: Alt+Shift+K and the in-page Stop pill (browser-chrome input), cross-site origin binding race
- [ ] 30. Agent eval easier than real use (auto-allow, full build, single run, loose verifiers)
- [x] 31. Tests touch the real install (`~/.kitsune`, `~/Downloads`, port 9222) — on Linux the harness sets up the dev build in a temporary HOME, picks a free debugging port and a temp GIF folder; `FIREFOX` must be set explicitly
- [~] 32. CI: Firefox 140/ESR, idle suite, Windows setup job, pack→install smoke, version check — Firefox matrix (latest + 140.0esr), safety + idle suites, `scripts/version.mjs check`, npm pack → install → setup/doctor/uninstall on Linux, Windows and macOS; weekly scheduled run. Not verified yet: the workflow has only run locally in parts

## 6. Install and cross-platform

- [ ] 33. Install-from-source path in README until npm/AMO are live
- [~] 34. Windows/Ubuntu instructions; Flatpak manifest location — setup also registers with Flatpak Firefox, LibreWolf, Waterfox and Floorp when present, and the Snap warning links Mozilla's install guide; README per-OS instructions still to do
- [x] 35. `uninstall` leaves Claude entries and `~/.kitsune` — also removes Claude Code / Desktop entries, extra browser manifests and ~/.kitsune

## 7. Docs, listing, project files

- [ ] 36. Outdated docs (test counts, TESTING.md title, RELEASE.md 0.2.0 and personal path, test/README)
- [ ] 37. AMO listing copy + screenshots in `docs/amo/`
- [ ] 38. PRIVACY.md gaps; data-collection declaration
- [ ] 39. SECURITY.md, CONTRIBUTING.md, issue templates, version-bump script, release workflow
- [ ] 40. Tone down claims (Claude in Chrome compatibility, comparison table, eval wording)

## Later / ideas

- Console capture from the very first script: needs a registered document_start content script (today capture starts when Kitsune's hooks land, usually after inline `<head>` scripts)
- Model-based `find`
- `javascript_tool` on strict-CSP sites via `userScripts`
- Download handling
- Element/region screenshots
- LibreWolf, Waterfox, Floorp support

## Work log

Newest last. One line per commit so an interrupted session can pick up where it stopped.

- 1–8 fixed, plus 21, 25, 26, 27, 28, part of 14; also: BiDi timers cleared, Windows pipe-id race (`wx`), `KITSUNE_SOCKET` chmod limited to ~/.kitsune, `<kitsune-ui>` decoy check (identity only), input-mode line only when it changes. e2e 53/53 both modes; permissions 5/5, store 2/2, resilience 5/5.
- 9–17 done (safety hardening). e2e 55/55 both modes; permissions 5/5; store 2/2.
- 18, 19, 22, 23 done; 20 partly. New `test/bench-actions.mjs`. e2e 55/55 both modes (synthetic 3 runs in a row); permissions 5/5, resilience 5/5, store 2/2. BiDi retry backoff 15 s → 5 s (Firefox may still be starting).
- 24, 29 (most), 31, 32, 35 done; 34 partly. Found and fixed while testing: permission-window buttons were clickable before its script ran (now disabled in the HTML); typing in a background tab ran at one character per second (timer throttling), now unthrottled. e2e 57/57, safety 7/7, resilience 5/5, idle ok.
