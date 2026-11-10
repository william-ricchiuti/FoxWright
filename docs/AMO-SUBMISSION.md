# Publishing Zenko on addons.mozilla.org

## Listed build (`dist/store`, id `kitsune@william-ricchiuti.com`)

1. `npm ci && npm run build && npx web-ext lint --source-dir dist/store` (expect 0 errors and 0 warnings).
2. `npm run package`. This produces `dist/zips/zenko-store-<version>.zip`.
3. `bash scripts/make-source-zip.sh`. This produces `dist/zips/zenko-source-<version>.zip` for the "source code" upload, because the content and background scripts are bundled with esbuild. The zip includes `BUILDING.txt` with exact steps and tool versions; rebuilding from it gives a byte-identical `dist/store` (checked 2026-09-23).
4. Submit on AMO under **On this site** and **Firefox desktop only**; answer **Yes** to "Do you need to submit source code?". Categories: *Web Development*, *Tabs*. Link the privacy policy (`PRIVACY.md`). For a later version: the add-on's page → *Upload New Version*, the store zip, then the source zip.

### Notes for the reviewer (paste into "Notes to Reviewer")

AMO limits this field to about 3,000 characters; the text below is about 2,450. For an update, start with one paragraph saying what changed in the add-on since the last reviewed version (check with `git diff --stat vOLD vNEW -- src extension vendor`), e.g. "New in 0.4.2: only content/content.js changed. ... No new permissions."

```
Zenko lets a user-installed local AI agent (e.g. Claude Code, via MCP) operate tabs in a dedicated "Zenko" tab group, like "Claude in Chrome" does on Chrome. Page content goes only through runtime.connectNative('zenko') to a helper the user installs themselves (npx zenko-firefox setup, source in host/). The add-on does nothing until that helper is installed and an agent connects.

Permissions:
- nativeMessaging: the only data channel, to the local helper.
- <all_urls> + scripting: inject the content script into agent tabs on demand, only after the user approves the site in an extension-owned popup window (prompt/prompt.html).
- tabs / tabGroups: keep agent tabs in their own group; the agent may only act on tabs in it.
- webNavigation: frame origins (per-frame permission checks), page-load detection, re-injecting the console recorder.
- webRequest: non-blocking; request URLs/status for agent tabs only (read_network_requests).
- storage: site approvals. alarms: reconnect to the helper.

No remote code: this listed build cannot run code strings. javascript_tool exists only in a separate, self-distributed build and is compiled out here.

Injected scripts (all packaged, only in agent tabs on approved sites, one frame at a time):
- content/content.js: page outline and input simulation.
- content/hooks.js (isolated world): console capture, and non-blocking alert/confirm/prompt while the agent works in the tab (exportFunction); real dialogs when the user uses the tab.
- content/page-hooks.js (MAIN world): only emulates pointer capture during Zenko's own gestures (Firefox rejects setPointerCapture for synthetic pointers).

Password values are never sent to the agent (shown as "(password, N characters)"). Vendored Playwright files (vendor/playwright, Apache-2.0, changes listed in NOTICE) compute accessibility roles/names. LICENSE, NOTICE and THIRD-PARTY-NOTICES.txt are included.

Build: scripts are bundled with esbuild. The source zip has BUILDING.txt with exact steps and tool versions; rebuilding gives a byte-identical add-on.

To test: npx zenko-firefox setup (or from the source zip: npm ci --prefix host && npm run build --prefix host && node host/dist/zenko.mjs setup), connect an MCP client (claude mcp add zenko -- node ~/.zenko/app/zenko.mjs mcp) and ask it to read a page. Zenko's permission window appears the first time the agent opens a site. test/e2e-safety.mjs covers the permission window and pause controls.
```

### Version notes ("release notes" shown to users)

Write them from the CHANGELOG section, in user terms, for the add-on only (not the helper). 0.4.2's:

```
- Keyboard shortcuts for moving around text now work when the agent uses them: Cmd+Left/Right (start/end of line), Alt or Ctrl+Left/Right (one word), Ctrl+Home/End and Cmd+Up/Down (start/end of the text), and the same with Shift to select. Before, they did nothing, so agents had trouble selecting a word to format it.
- Requires Firefox 152 or newer (153 ESR works).
- The free helper program (npx zenko-firefox setup) is now on npm; version 0.4.2 also fixes a case where real mouse and keyboard input could stay off for a whole session.
```

### Data-collection consent

The manifest declares `required: ["websiteContent", "websiteActivity", "browsingActivity"]`: page content, interactions and URLs of agent tabs are passed to the user's AI client. Password values are masked. If the reviewer asks for more specific categories (the agent can read whatever is on an approved page, e.g. `personalCommunications` in webmail), add them to `extension/manifest.json`; nothing else changes.

### Listing text

See [amo/LISTING.md](amo/LISTING.md) for the summary, description, categories and screenshot list.

## Full build (`dist/full`, id `kitsune-full@william-ricchiuti.com`)

It adds `javascript_tool`, which runs agent-supplied JavaScript in the page. AMO policy §4 forbids that for listed add-ons, and unlisted add-ons are subject to the same policies. So choose one of:

- Sign it as **unlisted** (`npx web-ext sign --channel=unlisted --source-dir dist/full --api-key … --api-secret …`), knowing it may still be rejected or blocked later; or
- Load it unsigned in **Firefox Developer Edition / Nightly** (`xpinstall.signatures.required = false`), or temporarily via `about:debugging`.

The store build covers everything else.

## npm package (`host/`)

```sh
cd host && npm ci && npm run build && npm publish --access public   # package name: zenko-firefox
```

Run it yourself in a terminal: the account's two-factor setting (`auth-and-writes`) shows a browser approval link for each publish. Run without a terminal (an agent, a script), it fails with `EOTP` instead.
