# Releasing Kitsune

Most of this is done already. What's left needs your accounts. In order:

## 1. GitHub (about 5 minutes)

1. Create an empty public repo at <https://github.com/new> named `kitsune`, under `william-ricchiuti`. Don't add a README, license or .gitignore; the project already has them.
2. From `~/Desktop/Projects/kitsune`:
   ```sh
   git remote add origin https://github.com/william-ricchiuti/kitsune.git
   git push -u origin main
   ```
   If your branch is called `master`, first run `git branch -m main`.
3. On the repo page, fill in:
   - **Description:** "Let Claude and other AI agents drive your real Firefox (MCP). The Firefox answer to Claude in Chrome."
   - **Topics:** `firefox`, `mcp`, `claude`, `browser-automation`, `webextension`, `ai-agents`
4. Create a release: `git tag v0.2.0 && git push --tags`. On GitHub, open **Releases → Draft a new release**, pick the tag, and attach `dist/zips/kitsune-full-0.2.0.zip` (renamed `.xpi` once it's signed; see step 3). Paste the 0.2.0 section of `CHANGELOG.md` as the notes.

## 2. npm (about 5 minutes)

The package is the helper plus MCP server that `npx kitsune-firefox setup` runs.

```sh
cd host
npm login                  # one time
npm run build
npm publish --access public
```

The name `kitsune-firefox` was free on 2026-09-23. If it's taken by the time you publish, change `name` in `host/package.json` and every `npx kitsune-firefox` in the README and docs.

Check it worked on another machine, or after `npx clear-npx-cache`: `npx kitsune-firefox@latest doctor`.

## 3. addons.mozilla.org

1. Make or sign in to a Firefox account at <https://addons.mozilla.org/developers/>.
2. Build the files:
   ```sh
   npm run package                   # → dist/zips/kitsune-store-0.2.0.zip (and full)
   bash scripts/make-source-zip.sh   # → dist/zips/kitsune-source-0.2.0.zip
   ```
3. **Listed store build:**
   - Go to *Submit a New Add-on → On this site*, upload `kitsune-store-0.2.0.zip` and choose **Firefox (desktop) only**.
   - When asked about source code, upload `kitsune-source-0.2.0.zip`.
   - Paste the reviewer notes from `docs/AMO-SUBMISSION.md`.
   - Set the privacy policy to the text of `PRIVACY.md`, or link it on GitHub.
   - Screenshots: `test/results/permission-window.png`, `activity-glow.png` and the popup. Frames from `docs/demo.gif` also work.
   - Expect a manual review, because of `nativeMessaging` + `<all_urls>`. That can take days to a few weeks.
4. **Full build (optional, self-distributed):**
   - Create API keys at <https://addons.mozilla.org/developers/addon/api/key/>, then:
     ```sh
     npx web-ext sign --channel=unlisted --source-dir dist/full --api-key $AMO_JWT_ISSUER --api-secret $AMO_JWT_SECRET
     ```
   - Attach the signed `.xpi` to the GitHub release.
   - `docs/AMO-SUBMISSION.md` explains why this build carries some policy risk.

## 4. Let people know

- **Post:** a short write-up with the demo GIF and the agent-evaluation table. Places where Firefox + AI-agent users are:
  - Hacker News (Show HN)
  - r/firefox
  - r/ClaudeAI
  - the MCP servers lists: github.com/modelcontextprotocol/servers, mcpservers.org, glama.ai
  - X
- **Angle:** "Claude in Chrome, but for Firefox, with a real-agent benchmark" is concrete and checkable.
- **MCP directories** usually want a one-line description, the install command (`npx kitsune-firefox setup`) and the repo link.

## 5. Before each later release

```sh
npm run build && node host/dist/kitsune.mjs setup
node test/e2e.mjs && KITSUNE_E2E_TRUSTED=1 node test/e2e.mjs
node test/e2e-permissions.mjs && node test/e2e-store.mjs && node test/e2e-resilience.mjs
node test/agent-eval.mjs          # about $1.50 of Claude usage
npx web-ext lint --source-dir dist/store
```

Bump `version` in `package.json`, `host/package.json` and `extension/manifest.json` together, and add a `CHANGELOG.md` entry.
