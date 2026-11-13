# Manual checks

These are the things automated tests can't cover: other operating systems, your own logged-in accounts, and real people. Each takes a few minutes. Note anything odd in a GitHub issue.

Before starting, install the extension (`dist/full` via `about:debugging` → *Load Temporary Add-on*, or the signed `.xpi`), run `npx foxwright-firefox setup --claude-code`, and open Claude Code.

## Windows (10/11)

1. `npx foxwright-firefox setup` prints `✓ Registered with Firefox … (+ registry HKCU\Software\Mozilla\NativeMessagingHosts\foxwright)`.
2. `npx foxwright-firefox doctor` shows no ✗ while Firefox is running with the extension. The toolbar fox has no `!` badge.
3. Ask Claude: *"Use Foxwright to open example.com and read me the heading."* A Foxwright permission window appears; approve it.
4. **Named pipe.** `%USERPROFILE%\.foxwright\pipe-id` exists, and a second Windows user account can't connect. Optional; needs two accounts.
5. **Real clicks.** Start Firefox with `"C:\Program Files\Mozilla Firefox\firefox.exe" --remote-debugging-port=9222`. `tabs_context_mcp` says `Input mode: trusted`.

## Linux distributions

- **Mozilla's .deb or tarball Firefox:** same steps as Windows 1–3.
- **Snap or Flatpak Firefox:** check whether the helper starts at all (setup also writes the Flatpak manifest location). If it doesn't, the README's warning is right; note the distro and Firefox version.
- **LibreWolf / Waterfox / Floorp:** setup registers the helper with them when they're installed. Check the toolbar fox loses its `!` badge.

## Sites you're logged into (your real profile)

Use your normal Firefox profile, and approve each site when asked. Say "stop" or press **Alt+Shift+K** if anything looks wrong.

| Task to give Claude | What to watch for |
|---|---|
| "Summarize my 5 newest unread emails in Gmail" | It reads without sending anything. Gmail's heavy DOM stays under `read_page` limits (try `visible_only`). |
| "In Google Docs, add a line at the end of <doc> saying 'Checked by Foxwright'" | Google Docs uses a canvas and a hidden text target. Expect synthetic typing to fail and trusted mode to work. |
| "Draft (don't send) a reply to the newest GitHub notification" | Typing into GitHub's markdown editor; clicking stops before Submit. |
| "Add 'oat milk' to my shopping list in <todo app>" | Whatever to-do app you use. |
| "Find the cheapest nonstop flight NOLA→NYC next Friday on Google Flights" | Heavy React UI with date pickers and dropdowns. |
| A site with a Cloudflare or reCAPTCHA check | Claude should stop and ask you to solve it, not keep clicking. |

## Safety checks worth repeating before each release

`test/e2e-safety.mjs` now covers the permission-window buttons, revoking a site, Pause/Resume from the popup (also mid-typing and with a prompt open) and upload approval automatically. These still need a person:

- [ ] **Unapproved sites.** A new site shows the Foxwright window, and its buttons only respond after a moment. *Deny* makes the tool call fail, and Claude says so.
- [ ] **Stop controls.** Pressing *Stop* in the page pill or **Alt+Shift+K** makes every later call fail with "paused". Pressing it while Claude is typing a long text stops the typing.
- [ ] **Dialogs when you use the tab.** In an agent tab, click something that shows a JavaScript confirm yourself, a minute after the agent last acted: the real dialog appears.
- [ ] **Tabs outside the group.** A tab you drag *out* of the orange group can't be used. One you drag *in* can.
- [ ] **Uploads.** `file_upload` of a normal file asks you first. `~/.ssh/id_ed25519` is refused without asking.
- [ ] **Hostile pages.** A page can't change what the permission window says or press its buttons. A page that covers the in-page pill doesn't stop Alt+Shift+K from working.
