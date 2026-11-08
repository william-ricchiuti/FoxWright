# Publishing Kitsune on addons.mozilla.org

## Listed build (`dist/store`, id `kitsune@william-ricchiuti.com`)

1. `npm ci && npm run build && npx web-ext lint --source-dir dist/store` (expect 0 errors and 0 warnings).
2. `npm run package`. This produces `dist/zips/kitsune-store-<version>.zip`.
3. `bash scripts/make-source-zip.sh`. This produces `dist/zips/kitsune-source-<version>.zip` for the "source code" upload, because the content and background scripts are bundled with esbuild. The zip includes `BUILDING.txt` with exact steps and tool versions; rebuilding from it gives a byte-identical `dist/store` (checked 2026-09-23).
4. Submit on AMO under **On this site** and **Firefox desktop only**; answer **Yes** to "Do you need to submit source code?". Categories: *Web Development*, *Tabs*. Link the privacy policy (`PRIVACY.md`).

### Notes for the reviewer (paste into "Notes to Reviewer")

> Kitsune lets a user-installed local AI agent (for example Claude Code, over the Model Context Protocol) operate tabs in a dedicated "Kitsune" tab group, the same way "Claude in Chrome" does on Chrome. Page content is sent only through `runtime.connectNative('kitsune')` to a helper program the user installs themselves (`npx kitsune-firefox setup`, source in `host/`). The add-on does nothing until that helper is installed and an agent connects.
>
> Permissions:
> - `nativeMessaging`: the only data channel, to the local helper.
> - `<all_urls>` + `scripting`: inject the content script into agent tabs on demand, and only after the user approves the site in an extension-owned popup window (`prompt/prompt.html`).
> - `tabs` / `tabGroups`: keep agent tabs in their own group. The agent may only act on tabs in that group.
> - `webNavigation`: frame origins (per-frame permission checks), knowing when a page the agent opened has loaded, and re-injecting the console recorder on navigation.
> - `webRequest`: non-blocking; records request URLs/status for agent tabs only (`read_network_requests`).
> - `storage`: site approvals. `alarms`: reconnect to the helper if it wasn't running.
>
> No remote code: this listed build contains no way to run code strings. The `javascript_tool` exists only in a separate, self-distributed build and is compiled out here.
>
> Scripts injected into pages (all packaged, all only in agent tabs on sites the user approved, one frame at a time):
> - `content/content.js`: the page outline and input simulation.
> - `content/hooks.js` (isolated world): records console output for `read_console_messages`, and while the agent is working in the tab replaces blocking alert/confirm/prompt with non-blocking versions, using `exportFunction`, so the page never freezes under automation. Its state stays in the isolated world, out of the page's reach; when the user is using the tab themselves, the page's real dialogs are shown.
> - `content/page-hooks.js` (MAIN world): only emulates pointer capture during Kitsune-generated gestures (Firefox rejects `setPointerCapture` for synthetic pointers).
>
> Password field values are never sent to the agent (shown as "(password, N characters)"). The vendored Playwright files (`vendor/playwright`, Apache-2.0, modifications listed in `NOTICE`) compute accessibility roles/names. `LICENSE`, `NOTICE` and `THIRD-PARTY-NOTICES.txt` are included in the add-on.
>
> To test: install the helper with `npx kitsune-firefox setup` (or from the source zip: `npm ci --prefix host && npm run build --prefix host && node host/dist/kitsune.mjs setup`), then connect an MCP client, e.g. `claude mcp add kitsune -- node ~/.kitsune/app/kitsune.mjs mcp`, and ask it to read a page. The first time the agent opens a site, Kitsune's permission window appears. The end-to-end tests in `test/` show every tool working (`test/e2e-safety.mjs` covers the permission window and the pause controls).

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
cd host && npm ci && npm run build && npm publish   # package name: kitsune-firefox
```
