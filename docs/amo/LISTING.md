# addons.mozilla.org listing

Copy these into the AMO developer hub when submitting the listed ("store") build.

## Name

Zenko

## Summary (250 characters max)

Let Claude and other AI agents you run use your real Firefox: read pages, click, type and fill forms in their own tab group. You approve each site. Needs the free Zenko helper (npx zenko-firefox setup).

## Description

Zenko connects an AI agent that you run on your own computer, such as Claude Code or Claude Desktop, to Firefox. The agent gets the same browser tools it uses with Claude in Chrome, so it can open pages, read them, click, type, fill in forms and take screenshots, in the Firefox you already use.

**You stay in control**

- The agent only works in tabs in its own orange "Zenko" tab group. Your other tabs are off-limits.
- Before it opens or reads a site for the first time, Zenko asks you in its own window: Deny, Allow this session, or Always allow. Pages and the agent can't press these buttons.
- Password fields are never shown to the agent.
- Pause it any time from the toolbar button, with Alt+Shift+K, or with the Stop button on the page. Pausing stops work already in progress too.
- File uploads need your confirmation every time, and key or credential files are always refused.

**How it works**

Zenko has two parts: this extension, and a small helper program you install once with `npx zenko-firefox setup` (it needs Node.js). The helper is also the MCP server your AI client talks to. Page content only goes from the extension to that helper on your computer and on to the AI client you connected. Zenko itself has no servers and collects nothing.

Optional: start Firefox with `--remote-debugging-port=9222` and Zenko sends real mouse and keyboard input, which some sites require.

Source code, documentation and test results: https://github.com/william-ricchiuti/Zenko

## Categories

- Web Development
- Tabs

(AMO's current list; it has no "Developer Tools". Used for the 0.4.0 submission.)

## Tags

ai, automation, mcp, claude, accessibility, developer-tools

## Support

- Support site: https://github.com/william-ricchiuti/Zenko/issues
- Support email: will.ricchiuti@gmail.com
- Privacy policy: paste the text of `PRIVACY.md` (or link https://github.com/william-ricchiuti/Zenko/blob/main/PRIVACY.md)

## Screenshots (1280×800)

Generated from the real UI by `node scripts/amo-screenshots.mjs`:

1. `screenshot-1-agent-working.png`: "The agent fills in a form; the orange glow and Stop button show which tab it's using."
2. `screenshot-2-permission-window.png`: "You approve every site in a window the page and the agent can't touch."
3. `screenshot-3-popup.png`: "Pause the agent, review and revoke sites, see the input mode."

## License

Apache License 2.0
