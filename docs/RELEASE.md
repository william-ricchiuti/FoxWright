# Releasing Kitsune

The code side is automated. What's left needs your accounts. `X.Y.Z` below is the new version.

## Every release

1. Make sure `main` is green in CI (GitHub → Actions).
2. Run the checks that CI can't:
   ```sh
   export FIREFOX=/path/to/firefox
   node test/agent-eval.mjs            # a real agent, about $4 of Claude usage with Opus 5.5; also --trusted, --ask
   bash scripts/mac-test.sh quick      # on the Mac
   ```
   and the items in [MANUAL-CHECKS.md](MANUAL-CHECKS.md) that the change touches.
3. Set the version and date:
   ```sh
   node scripts/version.mjs bump X.Y.Z   # package.json, host/package.json, extension/manifest.json, CHANGELOG
   npm install && npm install --prefix host   # refresh the lockfiles
   git commit -am "X.Y.Z" && git tag vX.Y.Z && git push && git push --tags
   ```
4. The tag starts `.github/workflows/release.yml`. It builds and lints everything, creates a GitHub release with `kitsune-store-X.Y.Z.zip`, `kitsune-full-X.Y.Z.zip` and `kitsune-source-X.Y.Z.zip` and the CHANGELOG section as notes, and, once the secrets below exist, also signs the full build and publishes to npm.
5. Submit the store build on addons.mozilla.org (below).

## One-time setup

### npm (about 5 minutes)

The npm package `kitsune-firefox` is the helper plus MCP server that `npx kitsune-firefox setup` runs.

- First publish by hand, from the repository folder:
  ```sh
  npm login
  npm run build --prefix host
  cd host && npm publish --access public
  ```
- Then, for automatic publishing, create an **automation** token at npmjs.com → Access Tokens and add it to the GitHub repo as the secret `NPM_TOKEN` (Settings → Secrets and variables → Actions).
- The name `kitsune-firefox` was free on 2026-09-23. If it's taken when you publish, change `name` in `host/package.json` and every `npx kitsune-firefox` in the README and docs.
- Check it worked on another machine, or after `npx clear-npx-cache`: `npx kitsune-firefox@latest doctor`.

### addons.mozilla.org

1. Make or sign in to a Firefox account at <https://addons.mozilla.org/developers/>.
2. For automatic signing of the full build, create API keys at <https://addons.mozilla.org/developers/addon/api/key/> and add them to GitHub as the secrets `AMO_JWT_ISSUER` and `AMO_JWT_SECRET`.

## Submitting the store build (each release)

1. From the GitHub release, download `kitsune-store-X.Y.Z.zip` and `kitsune-source-X.Y.Z.zip` (or build them yourself: `npm run package && bash scripts/make-source-zip.sh`).
2. On AMO: *Submit a New Add-on* (first time) or *Upload New Version*, choose **On this site** and **Firefox (desktop) only**, and upload the store zip.
3. When asked for source code, upload the source zip.
4. Paste the reviewer notes from [AMO-SUBMISSION.md](AMO-SUBMISSION.md), and (first time) the listing text and screenshots from [amo/LISTING.md](amo/LISTING.md).
5. First time only: AMO picks the add-on's address (`kitsune` is taken by another add-on). Put the real link into README step 2 of Install.
6. Expect a manual review, because of `nativeMessaging` + `<all_urls>`. That can take days to a few weeks.

The full build (with `javascript_tool`) is not listed on AMO; AMO-SUBMISSION.md explains why. The release workflow signs it as "unlisted" and attaches the `.xpi` to the GitHub release.

## Let people know (first release)

- **Where:**
  - Hacker News (Show HN)
  - r/firefox
  - r/ClaudeAI
  - MCP server lists: github.com/modelcontextprotocol/servers, mcpservers.org, glama.ai
  - X
- **Angle:** "Claude in Chrome, but for Firefox, with a real-agent benchmark" is concrete and checkable. Include the demo GIF and the agent-evaluation table.
- **MCP directories** usually want a one-line description, the install command (`npx kitsune-firefox setup`) and the repo link.
