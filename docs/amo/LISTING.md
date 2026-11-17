# addons.mozilla.org listing

Copy these into the AMO developer hub when submitting the listed ("store") build. Updated for 0.8.1. AMO's description field takes a limited set of HTML/Markdown; the bold headings and lists below paste as they are.

## Name

Foxwright

## Summary (250 characters max)

Let Claude, Codex, Cursor or another AI app on your computer use your real Firefox: read pages, click, type and fill in forms in its own tab group. You approve each site. Needs the free helper (npx foxwright-firefox setup).

## Description

Foxwright connects an AI app that runs on your own computer (Claude Desktop, Claude Code, Codex, Cursor, VS Code, Gemini CLI, Windsurf, Zed or any other MCP app) to the Firefox you already use, with your logins and extensions. The agent gets the same browser tools it has with Claude in Chrome: open pages, read them, click, type, fill in forms and take screenshots.

**Getting started (about five minutes)**

1. Install Foxwright. A setup page opens.
2. Pick your AI app on that page and run the one command it shows (`npx foxwright-firefox setup`, needs Node.js 20 or newer). The page switches to "Connected" by itself.
3. Restart your AI app and ask it to "use Foxwright to open example.com".

**You stay in control**

- The agent only works in its own orange "Foxwright" tab group. Your other tabs are off-limits.
- Before it opens or reads a site for the first time, Foxwright asks you in its own window: Deny, Allow this session, Allow for 1 hour, or Always allow. Tick "Read only" to let it look but not click or type. Web pages and the agent can't press these buttons.
- Optional: ask before every form submission and every button like Send, Pay or Delete.
- Stop it at any time with the Stop button on the page, the toolbar button, or Alt+Shift+K. Stopping interrupts work in progress.
- See what it did: the page shows the agent's description of each action, and the Activity page lists its actions and your answers. The log stays on your computer and never contains what was typed.
- Password fields are never shown to the agent. File uploads need your OK every time, and key or credential files are always refused.

**How it works**

Foxwright has two parts: this extension, and a small helper program you install once with `npx foxwright-firefox setup`. The helper is also the MCP server your AI app talks to. Page content only goes from the extension to that helper on your computer and on to the AI app you connected. Foxwright itself has no servers and collects nothing.

On Linux, Ubuntu's built-in Firefox is a Snap; Snap and Flatpak Firefox usually can't start the helper. Use Firefox from Mozilla's .deb repository or tarball.

**About the permissions and data notice on this page**

Firefox lists "Browsing activity", "Website activity" and "Website content" as data collection because Foxwright passes what's on a page (its text, screenshots, addresses and the agent's clicks) to another program: the AI app you set up on your own computer. That is the whole point of the add-on, so Mozilla requires it to be declared. None of it goes to Foxwright's developer or to any Foxwright server, because there isn't one. What your AI app does with it is covered by that app's own privacy terms.

- "Access your data for all websites" lets the agent work on whichever site you approve. Foxwright still asks you about each site first, and you can turn this permission off for a site, or entirely, in Firefox's add-on settings.
- "Exchange messages with programs other than Firefox" is how the extension talks to the helper on your computer.
- "Access browser tabs" and "Access browser activity during navigation" let Foxwright keep the agent in its own tab group and know when a page has finished loading.

Several Firefox profiles can be connected at once: name each one in the toolbar popup, and the agent can pick one or ask you to choose.

Optional: start Firefox with `--remote-debugging-port=9222` and Foxwright sends real mouse and keyboard input, which some sites require. Read the trade-offs in the documentation first.

Foxwright was called Zenko until version 0.7.0, and Kitsune before 0.6.0.

Source code, documentation and test results: https://github.com/william-ricchiuti/FoxWright

## Release notes for 0.8.1 ("Version notes", shown to users)

Paste into the version's release notes. Written for people using the add-on.

```
Easier first setup:
- The setup page asks which AI app you use (Claude Desktop, Claude Code, or another app such as Cursor, Codex, VS Code, Gemini CLI, Windsurf or Zed) and shows the matching command, with step-by-step instructions for macOS, Windows and Linux.
- It explains what to do when the terminal can't find Node.js, when Windows PowerShell blocks npx, and when Ubuntu's Snap Firefox can't start the helper.
- The helper's setup now prints ready-to-paste settings for Codex, Gemini CLI, VS Code, Cursor, Windsurf and Zed.

Clearer permission window:
- Buttons in a tidy two-by-two layout: Deny next to Allow this session, then Allow for 1 hour and Always allow. It says that "this session" lasts until you quit Firefox, and that Read only means the agent can look but not click or type.
- Better contrast in dark mode for the site name, the Deny button and warnings.

Toolbar popup and Activity page:
- When the helper isn't connected, "Setup help" is the main button and the command no longer runs off the edge.
- Approved sites show the kind of approval (always, this session, until a time, read only) on their own line instead of cutting it off.
- The shortcut shows as Option+Shift+K on a Mac.
- The Activity page shows a readable label for every answer, including "Allow for 1 hour".

Fixes:
- The agent's new tabs now work when another Firefox window, or a private window, is in front, and tabs in Firefox containers are no longer invisible to the agent.
- A malicious PDF can no longer freeze Foxwright; very large pages are handled without slowing it down.
- The Activity log keeps less: never addresses, typed text or file names, even if the agent writes them in its own summary.
- "Ask before sending, buying or deleting" catches more ways of sending, such as Ctrl/Cmd+Enter and Enter in chat boxes.
- If your AI app or the helper is out of date, the toolbar popup tells you exactly what to do.

Version 0.8.0 (the previous release) added the setup page, read-only and one-hour approvals, an optional confirmation before sending, buying or deleting, and the on-device Activity log. After updating from 0.7 or older, run: npx foxwright-firefox@latest setup, then restart Firefox and your AI app.
```

## Categories

- Web Development
- Tabs

(AMO's current list; it has no "Developer Tools". Used for the 0.4.0 submission.)

## Tags

ai, automation, mcp, claude, accessibility, developer-tools

## Support

- Support site: https://github.com/william-ricchiuti/FoxWright/issues
- Support email: will.ricchiuti@gmail.com
- Privacy policy: paste the text of `PRIVACY.md` (or link https://github.com/william-ricchiuti/FoxWright/blob/main/PRIVACY.md)

## Screenshots (1280×800)

Generated from the real UI by `node scripts/amo-screenshots.mjs`:

1. `screenshot-1-agent-working.png`: "The agent fills in a form; the orange glow and Stop button show which tab it's using."
2. `screenshot-2-permission-window.png`: "You approve every site in a window the page and the agent can't touch."
3. `screenshot-3-popup.png`: "See what the agent did, pause it, review and revoke sites."

## License

Apache License 2.0
