# Kitsune privacy policy

_Last updated: 2026-09-23 (post-0.3.0)_

Kitsune has no servers and collects nothing for its developer. There is no analytics, no telemetry and no remote logging.

**What the extension handles.** When an AI agent that *you* connected calls a Kitsune tool, the extension reads the requested content of pages in the Kitsune tab group:

- the page outline and text
- screenshots
- form values (password fields are never included: they show only how many characters they hold)
- console messages and network request URLs of those tabs

It sends that content to the Kitsune helper program on your own computer (through Firefox native messaging). The helper passes it to the AI client you configured, such as Claude Code or Claude Desktop. That client may send it to its AI provider under that provider's own privacy terms. This is the add-on's sole purpose, and it only happens for sites you approved (or all sites, if you chose "Allow all sites").

**What is stored.**

- In Firefox's extension storage: your site-access choices (approved origins, the ask/allow-all setting) and the pause state.
- In memory only, inside each agent tab: the last 1,000 console messages and the tab's recent network request URLs, so the agent can ask for them. They are gone when the tab closes or navigates to another site.
- In `~/.kitsune/` on your computer: the helper and its local log file. The log records connection events, not page content.
- GIF recordings: only when the agent uses `gif_creator` and exports one. The GIF is saved to your Downloads folder (or `KITSUNE_GIF_DIR`) and goes nowhere else.

**File uploads.** Files are read from your disk only when an agent asks to upload them, and only after you confirm the upload in a Kitsune window. The file is then given to the web page, as if you had picked it yourself, so the website receives it under its own privacy terms. Key and credential files are always refused.

**Real-input mode.** If you start Firefox with remote debugging on, the Kitsune MCP server on your computer connects to Firefox's local WebDriver BiDi port (127.0.0.1) to send clicks and keystrokes. Nothing leaves your computer through this connection.

**Removing everything.** Remove the extension and run `npx kitsune-firefox uninstall`. That removes the helper, `~/.kitsune`, and the Kitsune entries it added to Claude Code and Claude Desktop.

Contact: will.ricchiuti@gmail.com, or an issue at https://github.com/william-ricchiuti/Kitsune/issues (for anything sensitive, use the private reporting described in SECURITY.md).
