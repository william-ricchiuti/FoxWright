# Kitsune roadmap (post-0.3.0 review)

A full review of 0.3.0 (extension, helper, tests, docs) produced the list below. This file is the
source of truth for what's done and what's left: each item is marked when its change is committed,
so work can stop and resume at any point.

Status: `[x]` done · `[~]` partly done (see note) · `[ ]` not started

## 1. Fix before publishing

- [ ] 1. Passwords shown to the AI (outline shows `input[type=password]` values; `describe()` falls back to `.value`)
- [ ] 2. MCP server doesn't exit when the client closes stdin (orphan keeps the BiDi session)
- [ ] 3. AMO source zip can't be rebuilt (omits `host/`)
- [ ] 4. License notices stripped from built files (Playwright Apache NOTICE, MIT deps in host bundle)
- [ ] 5. npm package lists bundled deps as runtime `dependencies` (~40 MB of unused installs)
- [ ] 6. `about:blank` / `srcdoc` iframes can't be operated (origin check fails)
- [ ] 7. Content script + page hooks injected into every frame, including unapproved ones
- [ ] 8. Stop/Pause doesn't stop in-flight work; popup Pause doesn't notify the helper

## 2. Safety hardening

- [ ] 9. Permission window: short click delay; "Allow this session" as default
- [ ] 10. Permission window shows the page's own title (and the wrong one for `navigate`)
- [ ] 11. Pages can disable/forge page hooks (`__kitsuneConsoleHooked`, dialog answers)
- [ ] 12. Dialogs auto-answered even when the user is using the tab
- [ ] 13. `javascript_tool` not bound to the approved origin (full build)
- [ ] 14. Trusted mode trusts anything on port 9222 (check browserName, document risk)
- [ ] 15. Secret-file denylist gaps (browser profiles, shell history, Claude config, case)
- [ ] 16. `file_upload` reads before size check; accepts non-regular files
- [ ] 17. Any group titled "Kitsune" is adopted

## 3. Speed and tokens

- [ ] 18. Lower `read_page` default; shorter navigate summary; none for mid-batch steps
- [ ] 19. Event-driven navigation waits instead of fixed polling
- [ ] 20. Big pages: limits passed into the page, frames in parallel, `find` reuse
- [ ] 21. `describe()` reads whole-page innerText on every key press
- [ ] 22. Alias parameters bloat tool schemas
- [ ] 23. `browser_batch` skips per-tool argument parsing

## 4. Reliability

- [ ] 24. Two agents collide on the same tab; no per-tab queue; raw "Invalid tab ID" errors
- [ ] 25. Trusted-mode state lost after helper reconnect
- [ ] 26. No version check between MCP server, helper and extension
- [ ] 27. Closed shadow roots invisible (`openOrClosedShadowRoot`)
- [ ] 28. Timed-out commands keep running without telling the agent

## 5. Tests

- [ ] 29. Safety features untested (pause/stop, allow/deny buttons, upload approve, origin binding, GIF filename)
- [ ] 30. Agent eval easier than real use (auto-allow, full build, single run, loose verifiers)
- [ ] 31. Tests touch the real install (`~/.kitsune`, `~/Downloads`, port 9222)
- [ ] 32. CI: Firefox 140/ESR, idle suite, Windows setup job, pack→install smoke, version check

## 6. Install and cross-platform

- [ ] 33. Install-from-source path in README until npm/AMO are live
- [ ] 34. Windows/Ubuntu instructions; Flatpak manifest location
- [ ] 35. `uninstall` leaves Claude entries and `~/.kitsune`

## 7. Docs, listing, project files

- [ ] 36. Outdated docs (test counts, TESTING.md title, RELEASE.md 0.2.0 and personal path, test/README)
- [ ] 37. AMO listing copy + screenshots in `docs/amo/`
- [ ] 38. PRIVACY.md gaps; data-collection declaration
- [ ] 39. SECURITY.md, CONTRIBUTING.md, issue templates, version-bump script, release workflow
- [ ] 40. Tone down claims (Claude in Chrome compatibility, comparison table, eval wording)

## Later / ideas

- Model-based `find`
- `javascript_tool` on strict-CSP sites via `userScripts`
- Download handling
- Element/region screenshots
- LibreWolf, Waterfox, Floorp support

## Work log

Newest last. One line per commit so an interrupted session can pick up where it stopped.
