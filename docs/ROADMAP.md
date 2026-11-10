# Zenko roadmap (formerly Kitsune; post-0.3.0 review)

> Renamed from Kitsune to Zenko in 0.6.0 (section G). Earlier sections keep the old name as written at the time.

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
- [x] 30. Agent eval easier than real use (auto-allow, full build, single run, loose verifiers) — stricter checks (todos: exactly the right item completed; rich-editor: exact text with only "Kitsune" bold; two-tabs: both articles open, weights for both, red fox named heavier; docs-search: must have typed into the site search, not jumped to the URL); new local `signup-wizard` task (validation errors, 3 steps, code depends on every answer); `--ask` mode with a scripted user approving permission windows; `--repeat N` reports pass@1/pass@N; exit code 1 on failures. Partial run in the sandbox: signup-wizard, todos, rich-editor, two-tabs pass; docs-search now fails there because react.dev's search (Algolia) is blocked by the sandbox network, which the old check missed. A full run on a normal network is still to do
- [x] 31. Tests touch the real install (`~/.kitsune`, `~/Downloads`, port 9222) — on Linux the harness sets up the dev build in a temporary HOME, picks a free debugging port and a temp GIF folder; `FIREFOX` must be set explicitly
- [~] 32. CI: Firefox 140/ESR, idle suite, Windows setup job, pack→install smoke, version check — Firefox matrix (latest + 140.0esr), safety + idle suites, `scripts/version.mjs check`, npm pack → install → setup/doctor/uninstall on Linux, Windows and macOS; weekly scheduled run. Not verified yet: the workflow has only run locally in parts

## 6. Install and cross-platform

- [x] 33. Install-from-source path in README until npm/AMO are live — README "install from source" section (build, about:debugging, Developer Edition for a persistent install)
- [x] 34. Windows/Ubuntu instructions; Flatpak manifest location — setup also registers with Flatpak Firefox, LibreWolf, Waterfox and Floorp when present, and the Snap warning links Mozilla's install guide; README now has per-OS commands (Windows paths, PowerShell) and the Snap/Flatpak note at the top of Install
- [x] 35. `uninstall` leaves Claude entries and `~/.kitsune` — also removes Claude Code / Desktop entries, extra browser manifests and ~/.kitsune

## 7. Docs, listing, project files

- [x] 36. Outdated docs (test counts, TESTING.md title, RELEASE.md 0.2.0 and personal path, test/README) — TESTING.md retitled and updated (57/57, speed table, what's still not covered), test/README rewritten, RELEASE.md uses X.Y.Z and no personal path, old e2e-realsites.mjs deleted, README dev section and counts updated
- [x] 37. AMO listing copy + screenshots in `docs/amo/` — docs/amo/LISTING.md (summary, description, categories, support, screenshot captions) and three 1280×800 screenshots made from the real UI by scripts/amo-screenshots.mjs
- [x] 38. PRIVACY.md gaps; data-collection declaration — PRIVACY.md covers GIFs, uploads going to the site, in-tab console/network buffers, trusted-mode local connection, GitHub/SECURITY contact; AMO notes explain the data-collection choice
- [x] 39. SECURITY.md, CONTRIBUTING.md, issue templates, version-bump script, release workflow — SECURITY.md, CONTRIBUTING.md, bug + site-compatibility issue templates, PR template, scripts/version.mjs (check/bump), release workflow (build, GitHub release with zips, optional unlisted signing and npm publish via secrets)
- [x] 40. Tone down claims (Claude in Chrome compatibility, comparison table, eval wording) — Claude in Chrome wording now "compatible with the core tools" with the differences listed; comparison table adds Playwright MCP and a "your real profile?" column, dated September 2026; eval section says one run each, demo sites, no prompts

## Later / ideas

- Console capture from the very first script: needs a registered document_start content script (today capture starts when Kitsune's hooks land, usually after inline `<head>` scripts)
- Model-based `find`
- `javascript_tool` on strict-CSP sites via `userScripts`
- Download handling
- Element/region screenshots
- LibreWolf, Waterfox, Floorp support
- Say what's selected after a key press that changes the selection (agents select text blind with shift+arrows today)

## Work log

Newest last. One line per commit so an interrupted session can pick up where it stopped.

- 1–8 fixed, plus 21, 25, 26, 27, 28, part of 14; also: BiDi timers cleared, Windows pipe-id race (`wx`), `KITSUNE_SOCKET` chmod limited to ~/.kitsune, `<kitsune-ui>` decoy check (identity only), input-mode line only when it changes. e2e 53/53 both modes; permissions 5/5, store 2/2, resilience 5/5.
- 9–17 done (safety hardening). e2e 55/55 both modes; permissions 5/5; store 2/2.
- 18, 19, 22, 23 done; 20 partly. New `test/bench-actions.mjs`. e2e 55/55 both modes (synthetic 3 runs in a row); permissions 5/5, resilience 5/5, store 2/2. BiDi retry backoff 15 s → 5 s (Firefox may still be starting).
- 24, 29 (most), 31, 32, 35 done; 34 partly. Found and fixed while testing: permission-window buttons were clickable before its script ran (now disabled in the HTML); typing in a background tab ran at one character per second (timer throttling), now unthrottled. e2e 57/57, safety 7/7, resilience 5/5, idle ok.
- 30 done: agent-eval verifiers tightened, --ask/--repeat, signup-wizard task; test/bidi-driver.mjs shared by e2e-safety and agent-eval.
- 33, 34, 36–40 done (docs, listing, screenshots, project files, release workflow).
- Final check of this round: e2e 57/57 both modes, safety 7/7, permissions 5/5, store 2/2, resilience 5/5, real sites 49/51 synthetic (the same two sandbox-network failures as before: DuckDuckGo, react.dev search), lint 0 errors. Also: links that open a new tab get the same URL and permission checks as navigate; doctor says when the debugging port is busy with another Kitsune session.
- 2026-11-08 fresh-eyes review, then option 1 (fix and ship), code part: see "Fix round" at the end. e2e 58/58 both modes on Linux Firefox 152 and 159 and Mac 158.0.1; safety 7/7; real sites 51/51 synthetic, 50/51 trusted (Mac).

## Next steps (need you or a normal network)

1. ~~Push to GitHub and check that CI passes~~ (done 2026-11-08, PR #1). The release workflow hasn't run yet.
2. ~~Run the full agent evaluation~~ (done 2026-11-08: 17/17 in both modes).
3. ~~Publish to npm~~ (0.4.0, 2026-11-08). Submit to AMO: docs/RELEASE.md.
4. The manual checks in docs/MANUAL-CHECKS.md, especially Windows.

## Fresh-eyes review (2026-11-08)

Six weeks after the last commit, nothing published yet. Each finding says how it was checked.
No code was changed in this review.

### A. Broken or out of date

1. **CI has failed on every run since 0.3.0.** `gh run list`: 8 runs from 2026-09-24 to 2026-11-03,
   all failed; the last green run is the 0.3.0 commit (2026-09-24). Three separate causes:
   - **Firefox 140 ESR (the manifest's minimum): 52/57.** Screenshot, zoom, a batch with a
     screenshot and both GIF tests fail with `browser.tabs.captureTab is not a function`
     (`src/background/tools.js:38`). It has failed the same way in every run since the ESR job was
     added. Cause unknown: MDN's compatibility data (`node_modules/@mdn/browser-compat-data`) says
     `captureTab` exists since Firefox 59. Either fix it (for example fall back to
     `captureVisibleTab`) or raise `strict_min_version` and the README's "Firefox 140 or newer".
   - **Trusted mode on Linux, Firefox 158 and 159: 55/57.** "tabs_context_mcp creates the Kitsune
     group" and "anti-bot button" fail, meaning real input was never detected. It passed on 157.0.1
     (run of 2026-10-12) and first failed on 158.0 (2026-10-19), still on the Ubuntu 24.04 image, so
     the switch to Ubuntu 26.04 isn't the cause. **On this Mac, Firefox 158.0.1, trusted mode passes
     57/57**, so it's Linux/headless-specific or fixed in 158.0.1. Not yet diagnosed.
   - **Will break next: Firefox 159 removed `--remote-allow-system-access`** (MDN "Firefox 159 for
     developers": replaced by the env var `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1`). `test/harness.mjs:153`
     passes that flag for the safety suite and the agent eval's scripted user. CI never got that far
     (it stops at the trusted step); this Mac is still on 158.0.1, so it passed here.
2. **Mac run today** (`bash scripts/mac-test.sh`, Firefox 158.0.1, Node 22.22.3, log in
   `test/results/mac-run.log`): e2e 57/57 both modes, safety 7/7, permissions 5/5, store 2/2,
   resilience 5/5, idle ok. Real sites **49/51 synthetic, 48/51 trusted**:
   - **New: the-internet "nested frames" fails in both modes.** The outline shows the inner frames
     empty (`iframe [ref=f1e2]` with nothing under it). It passed in the 2026-09-23 run (Linux,
     Firefox 156). Possibly item 7 (frames injected only when a tool reaches them) not reaching
     frames inside frames, or a Firefox 158 change. Not diagnosed.
   - **New: CSS `:hover` caption fails in trusted mode** (it's the one hover test that only trusted
     mode is supposed to pass).
   - react.dev search still fails in both modes, as in the 0.2.0 Mac run.
   - `doctor` at the end reports "Firefox is not running", which is expected (the test Firefox had
     already closed).
3. **The README's AMO link points at someone else's add-on.** The slug `kitsune` is taken ("Kitsune
   art", v2.0, 5 users, last updated 2023; AMO API `/api/v5/addons/addon/kitsune/`). AMO will assign
   a different slug; update README step 2 once it's known. The npm name `kitsune-firefox` is still
   free (`npm view` → E404).
4. **The GitHub repo is private** (`gh repo view` → `PRIVATE`). The README's CI badge, clone command,
   Releases link, `homepage_url` in the manifest and the SECURITY.md contact all need it public
   before npm or AMO.
5. **A commit this branch didn't have:** `origin/main` has `5b384a0 ci: remove weekly scheduled run`
   (2026-11-02), so item 32's "weekly scheduled run" is no longer true.
6. **Smaller:**
   - The root `package-lock.json` still says version 0.1.0. `mac-test.sh`'s `npm install` rewrote it
     to 0.3.0; that change was reverted. `scripts/version.mjs check` doesn't cover it.
   - CI warns that `actions/checkout@v4`, `setup-node@v4` and `upload-artifact@v4` run on deprecated
     Node 20.
   - `web-ext lint` warns that `data_collection_permissions` needs Firefox for Android 142. That
     doesn't matter for a desktop-only add-on.
   - On this Mac the helper launcher (`~/.kitsune/kitsune-host`) runs
     a Node binary inside another tool's private folder, because `setup` saves the absolute path of whatever
     `node` it was run with (`~/.local/bin/node` links there). If that folder moves, Firefox can't
     start the helper.

### B. The other tools, re-checked

Sources: each project's current README or code, the npm registry, the AMO API and Bugzilla's REST API.

| Project | What changed since September |
|---|---|
| Playwright MCP | v0.0.84 (2026-10-31). Uses its own profile, persistent by default; its `--extension` mode (attach to your browser) is Chrome/Edge only. Table row stays, wording: "its own profile". |
| mozilla/firefox-devtools-mcp | Now `@mozilla/firefox-devtools-mcp` 0.10.7 (2026-10-28). `--connect-existing` attaches to a Firefox that's already running, but only one started with `--marionette --remote-debugging-port`; its README says the flags are ignored if that profile is already open, so you restart Firefox or use a second profile. Outline unchanged (DOM walk, `role` attribute only); input real (BiDi). |
| Blueprint MCP (Firefox) | AMO v1.9.22 (2026-08-10), **124** daily users (not ~106). No release since. Its store description still says the snapshot isn't available in Firefox; typing still appends to `.value`. Row stays. |
| ClaudeCodeBrowser | Repo v1.4.0 added an API key for HTTP and WebSocket, plus allow/block lists and a read-only mode. AMO still ships 1.0.0 (no auth, 3,239 users). Still polls every 500 ms. Row: "API key (repo); AMO build has none". |
| browser-control-mcp | v1.5.2, unchanged. |
| FireMCP (fork of browser-control-mcp, new) | v2.2.0 (2026-10-23). Reads tabs, history, bookmarks (search only). It never clicks or types, but it *can* open, close, reorder and group tabs. |
| **FoxMCP (new to the table; repo since 2025-09)** | AMO 1.7.0, 74 users; updated 2026-11-07. Real profile, WebSocket on :8765 with no local caller authentication (its SECURITY.md). Page interaction is "run a script" only. **It already writes bookmarks**: create, create folder, move, rename/update and delete (`extension/background.js` ~line 1600–1645, delete runs immediately with no confirmation; `bookmarks` is a required permission). |
| fxmcp (new, 2026-10-25) | Real profile, token-protected WebSocket, clicks/typing in a content script; no bookmarks; 0 stars. |
| Mozilla | "AI Window" is now **Smart Window** (beta, US/Canada, English). It drafts form answers from tabs you pick and watches pages, but doesn't submit forms; no MCP or way for an outside agent to drive it (blog.mozilla.org, 2026-10-27). |
| Anthropic | Claude in Chrome is still Chrome-only (support.claude.com "Getting started with Claude in Chrome"). No Firefox announcement found. |
| Bug 1316741 | Still NEW, P3/S3, last changed 2025-03-11; last substantive comment (2019): DevTools has "no plans to enable this API". Related bug 1840132 (`browser.debugger` via BiDi) untouched since 2023. |

What this means: nobody else has an accessibility outline, real input or per-site approval on the
user's own Firefox profile, so Kitsune's position is unchanged. Two corrections to the plan: the idea
that no Firefox tool can change bookmarks is wrong (FoxMCP can), and demand looks small (the biggest
comparable Firefox listings have 74–124 daily users; ClaudeCodeBrowser's 3,239 is the exception).
Not checked: glama.ai and mcpservers.org listings directly, and the "claude-for-firefox" community
port (NetVar1337).

### C. Bookmark tools: what it would take

- Firefox supports `optional_permissions: ["bookmarks"]`, so the install prompt stays the same. A
  permission can only be requested from a user click. Kitsune already has an extension-owned window,
  so the first bookmark call would open it with an "Allow bookmarks" button.
- AMO's data-collection declaration would need `bookmarksInfo` added as an optional category.
- To keep the tool list small (it's sent with every request, 14.2k characters now), use one
  `bookmarks` tool with an `action` (`tree`, `search`, `create`, `create_folder`, `move`, `rename`,
  `delete`) rather than seven tools.
- Safety: deleting asks in the extension-owned window and lists what will go (folders show their
  count). Kitsune saves a JSON copy of the deleted subtree first, because the extension API has no
  undo. `tree` output needs a size cap and a depth/folder option (large bookmark sets run to tens of
  thousands of URLs). Reading bookmarks shows the AI every saved URL, which is one more reason to keep
  the permission optional.
- What sets it apart from FoxMCP: it asks before deleting, the permission is optional, and it comes
  with the rest of Kitsune's page tools.
- Effort: about 1.5–2.5 days with e2e tests, plus a second AMO review if it ships after the first
  listing.

### D. Options

1. **Fix CI and ship what exists.** Fix the three CI failures (A1), nested frames (A2), the
   `-remote-allow-system-access` switch, the repo visibility, the comparison table and README link,
   then the paid agent eval, npm publish and AMO submission. *Tradeoff:* no new features; AMO review
   (days to weeks) starts soonest. *Effort:* 1–2 days of fixes, then the release steps in RELEASE.md.
2. **Option 1, then bookmarks as 0.5 after the first AMO approval.** *Tradeoff:* the first review
   covers a smaller add-on, and bookmarks then need their own review; the first version doesn't have
   the one feature that's new. *Effort:* option 1, plus about 2 days later.
3. **Bookmarks before the first release.** *Tradeoff:* launches with something FoxMCP doesn't do
   safely. But it delays a release that has already waited six weeks, and it adds a permission and a
   data category to the first, slowest review. *Effort:* about 3–4 days before submitting.
4. **Ship (option 1), then a "Later / ideas" item instead of bookmarks.** Download handling is the
   one people are most likely to hit (tasks that end in "download the invoice"). Element screenshots
   are cheap because `zoom` already crops. *Tradeoff:* these widen what agents can finish, rather than
   adding a new area; none of them is unique. *Effort:* about 1–2 days each.
5. **Minimal release: GitHub + npm + a self-hosted signed `.xpi`, no AMO listing yet.** The release
   workflow already signs the full build as unlisted. *Tradeoff:* usable within a day of fixing CI,
   with no review wait. But there's no store discovery or one-click install, and updates need an
   `update_url` (not set up). *Effort:* option 1's fixes, minus the AMO steps.

**Recommendation: option 2.** CI is red for real reasons, including a Firefox 159 break the Mac
hasn't hit yet, and that blocks every option. Shipping what exists starts the slow AMO review now.
Bookmarks are a reasonable second release, but no longer a "nobody else can do this" feature.

### E. Fix round (option 1, 2026-11-08)

William chose option 1. Code and docs changes are done and tested locally; nothing is committed or pushed.

- [x] **Nested frames came back empty** when read right after `navigate` (A2). Cause, from debug output: the
  inner frames were still on their initial `about:blank`, according to both the content script and
  `webNavigation.getFrame`; `navigate` returns once the top page is parsed. Fix: `read_page` waits up to 3 s
  for a frame whose element has a real `src` (`src/background/tools.js` stitchFrames, `loads` flag from
  `src/content/snapshot.ts`), retrying snapshot errors while the frame swaps documents. New e2e test with
  slow-loading nested frames (`test/fixtures/frameset*.html`, `?delay=` in the test server): fails without
  the fix, passes with it.
- [x] **Firefox 159 removed `-remote-allow-system-access`** (A1). Reproduced on Firefox 159: the safety suite
  couldn't open Kitsune's pages ("not allowed in this context"). `test/harness.mjs` now also sets
  `MOZ_REMOTE_ALLOW_SYSTEM_ACCESS=1`. Safety 7/7 on 152, 158 and 159.
- [x] **Firefox 140 ESR screenshots** (A1). Reproduced in Linux (Firefox 140 doesn't run on macOS 27: it hangs
  with sandbox errors). On 140, MV3 extensions get no `tabs.captureTab`; `captureVisibleTab` is listed but
  empty, and with `activeTab` added it says "Missing activeTab permission", which only a user click grants. So
  there's no fix inside the extension. Tested 141, 145, 149, 150, 151: same failure; **152 and 153 ESR pass
  58/58**. Minimum raised to **Firefox 152** (manifest, README, setup message, CONTRIBUTING, test/README, CI
  matrix `[latest, "152.0"]`). Mozilla's product-details feed lists 153.6.0esr as the current ESR; 140 ESR is
  no longer listed.
- [x] **Trusted mode on GitHub's Linux runners** (A1). Passed in the PR's CI on Firefox 159.0.1. Before that, not reproduced: it passes in ARM Linux (152, 158, 159),
  in an x86_64 container (159, emulated), back-to-back after the synthetic suite, and on the Mac (158.0.1,
  159). The CI artifact shows the helper never connected ("Input mode: synthetic"). The first e2e test now
  checks the debugging port and says whether it accepts connections, and `tabs_context_mcp` reports the
  connection error when something answers on the port but real input can't start (it also names the port in
  use instead of always 9222). The next CI run will say which.
- [x] **CSS hover in trusted mode** (A2): same timing as the frames (images still loading after `navigate`).
  The test now looks again and retries once, like an agent would. 20/20 trusted twice.
- [x] Root `package-lock.json` version refreshed; `scripts/version.mjs check` now compares both lockfiles too.
- [x] GitHub Actions `checkout`, `setup-node`, `upload-artifact` v4 → v7 (Node 24).
- [x] README: comparison table re-checked (Playwright wording, devtools-mcp restart requirement, Blueprint's
  store listing, ClaudeCodeBrowser's API key, FoxMCP added, FireMCP added beside browser-control-mcp after
  checking its README: shared secret, per-site consent); AMO link removed until AMO assigns the address
  (RELEASE.md step added); 58 tests. CHANGELOG and TESTING.md updated.
- [x] Committed, PR #1: CI green on every job (Firefox 152 and 159.0.1, trusted 58/58 on GitHub's runners too,
  so the earlier runner failure was gone by 159.0.1; cause still unknown). Merged; repo made public (by William).
- [x] Agent eval, both modes (macOS, Firefox 158.0.1, Claude Opus 5.5): **17/17 synthetic** (median 36 s, 7 calls,
  $4.05) and **17/17 trusted** (31 s, 6 calls, $3.68). Reports in docs/agent-eval-*.md.
- [x] Released 0.4.0: PR #2 (CI green), tag `v0.4.0`, release workflow created the GitHub release with the store,
  full and source zips. No signed `.xpi` yet: the repo has no `AMO_JWT_*` secrets.
- [x] npm: `kitsune-firefox@0.4.0` published by William from a terminal (npm's browser approval; an unattended
  publish gets `EOTP` because the account's 2FA mode is `auth-and-writes`). `npx kitsune-firefox@latest
  --version` from an empty cache prints 0.4.0.
- [x] AMO submission (2026-11-08, listed, desktop only, with the source zip). Waiting for Mozilla's review.
- [x] Public repo: description, topics, npm link; private vulnerability reporting (SECURITY.md links to it), secret
  scanning + push protection, Dependabot security updates; merged branches deleted, auto-delete on.
- [x] 0.4.1: the intermittent CI trusted-mode failure was a real race (the startup BiDi probe and the first tool
  call both called `session.new`; the diagnostic added in the fix round printed "Maximum number of active sessions").
  Fixed in `host/src/bidi.js` with a shared connection attempt; `test/bidi-connect.mjs` reproduces it (fails before,
  passes after). MCP SDK 1.32.2, zod 4.6.7, web-ext 10.8.0; Dependabot and `npm audit` for the package clean.
- [x] Cross-model agent eval (`--agent codex|opencode`): GPT via Codex 17/17, DeepSeek v4-pro 17/17 ($0.09; 16/17 in
  an earlier run), DeepSeek v4.1 flash (free) 17/17. Fixed the `rich-editor` check, which skipped the bold test when
  the editor is in a cross-origin frame. Details in TESTING.md, "Other models".
- [x] **Bug: Cmd/Alt/Ctrl+arrow keys do nothing in synthetic mode** (fixed in 0.4.2: `modifiedCaretKey` in input.ts, e2e test with 20 cases) (`src/content/input.ts` key defaults ignore the
  modifier; `cmd+left` should go to the line start, `alt/ctrl+left` one word, `cmd+up` / `ctrl+home` to the start).
  Found from DeepSeek's transcripts; confirmed on `basic.html` in contenteditable and text inputs.
- [x] 0.4.2 released (PR #10): GitHub release, npm (`npx kitsune-firefox@latest --version` prints 0.4.2), and
  uploaded to AMO as a new version (William, 2026-11-08) with the source zip. AMO review of 0.4.0/0.4.2 pending;
  AMO emails the developer account's address with the result.
### F. Claude in Chrome parity (0.5.0, 2026-11-08)

From comparing Claude in Chrome's public tool definitions with Kitsune's (no reverse engineering: its code isn't used or copied).

- [x] Action summaries: `action_summary` on computer/form_input, shown in the pill and the popup's action list (cleaned; the agent's words, not a guarantee). e2e-safety test.
- [x] GIF export options, labels, drag arrows, progress bar, watermark, drop onto the page; drawn by the extension (`_annotate_frame`), click circles for ref clicks too. e2e test; frames checked by eye.
- [x] `upload_image` with screenshot IDs (memory only, 20 / 10 minutes), through the upload confirmation. e2e-safety test.
- [x] Several Firefox profiles: per-helper sockets and registry in ~/.kitsune/browsers, `list_connected_browsers` / `select_browser` / `switch_browser`, browser names in the popup, takeover note. test/e2e-multi.mjs. Trusted input can't reach another Firefox: tabs are found by a token set through the selected browser's extension.
- [x] Tool guidance: close the tabs you opened.
- Found along the way: on macOS the test harness uses the installed helper (`~/.kitsune/app`), so helper changes need `node host/dist/kitsune.mjs setup` (mac-test.sh does it) before a local run.

### G. Rename to Zenko (0.6.0, 2026-11-10)

- [x] Found an unrelated project with the same name and goal (github.com/junyeong-nero/kitsune, Python, public since 2026-10-16, 40 stars) and two more competitors the earlier check missed (Foxhand, FoxPilot, both on AMO). Added all three to the README comparison.
- [x] Name chosen by William from a checked shortlist: Zenko (善狐). Free on npm as `zenko-firefox`, on PyPI and as an AMO slug; no Firefox/MCP/agent projects named Zenko. Rejected: foxtail (npm/PyPI taken; padenot/foxtail is a Claude Code tool for Mozilla developers), Foxhand / FoxPilot / foxpaw (competitors), Reynard (a Gecko browser for iOS).
- [x] Everything renamed except the extension ids (AMO listing), the agent-eval task text, past CHANGELOG entries and old eval reports.
- [x] The other Kitsune also uses `~/.kitsune` and the Claude name `kitsune`: cleanup of the old install removes only provably-ours files; `uninstall` no longer deletes a whole folder that could hold another program's data. test/rename-cleanup.mjs.
- [ ] William: rename the GitHub repo to Zenko, publish `zenko-firefox` and deprecate `kitsune-firefox`, change the AMO listing's name and address.

- [ ] When AMO approves: put the listing's address into README step 2 (and the repo's website link).

Not changed: the helper launcher's Node path on this Mac (A6), react.dev search (also failed in 0.2.0).
