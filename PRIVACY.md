# Foxwright privacy policy

_Last updated: 2026-11-13 (0.7.0)_

Foxwright has no servers and collects nothing for its developer. There is no analytics, no telemetry and no remote logging.

**Why Firefox says Foxwright collects data.** The add-on's store page and install prompt list "Browsing activity", "Website activity" and "Website content". Mozilla counts data as collected whenever an extension passes it to another program, and Foxwright passes page content to the AI client you set up on your own computer. That is the only place it goes. The sections below say exactly what is passed and what is kept.

**What the extension handles.** When an AI agent that *you* connected calls a Foxwright tool, the extension reads the requested content of pages in the Foxwright tab group:

- the page outline and text
- screenshots
- form values (password fields are never included: they show only how many characters they hold)
- console messages and network request URLs of those tabs

It sends that content to the Foxwright helper program on your own computer (through Firefox native messaging). The helper passes it to the AI client you configured, such as Claude Code or Claude Desktop. That client may send it to its AI provider under that provider's own privacy terms. This is the add-on's sole purpose, and it only happens for sites you approved (or all sites, if you chose "Allow all sites").

**What is stored.**

- In Firefox's extension storage: your site-access choices (approved origins, the ask/allow-all setting) and the pause state.
- Also in Firefox's extension storage: which sites are approved for reading only, 1-hour approvals with their expiry time, and the "ask before sending, buying or deleting" setting.
- An activity log, in Firefox's extension storage on your computer (the last 500 entries). Each entry has a time, the site's origin (for example `https://example.com`, never the full address), the tab number, a short description of the action (the agent's own one-line summary, or Foxwright's description such as "Typed 12 characters") and the outcome. It never contains what was typed, form values, page content, passwords, file names or full URLs. It is never sent anywhere. You can export it, clear it, or turn it off on the Activity page; removing the add-on deletes it.
- In memory only: the last 1,000 console messages of each agent tab (kept in the tab) and its recent network request URLs (kept in the extension), so the agent can ask for them. They are gone when the tab closes or moves to another site, and requests made by embedded frames from sites you haven't approved are never shown to the agent.
- In memory only, in the extension: short descriptions of the agent's last few actions (shown in the toolbar popup and the in-page pill). Gone when Firefox restarts.
- In memory only, in the MCP server on your computer: the agent's last 20 screenshots, for 10 minutes, so it can attach one to a page with `upload_image` (after you confirm). Gone when the AI client closes.
- In `~/.foxwright/` on your computer: the helper and its local log file. The log records connection events, not page content. `~/.foxwright/browsers/` lists the Firefox profiles connected right now (a random ID, the name you gave each one in the popup, and the helper's process ID); each entry is removed when that Firefox closes.
- GIF recordings: only when the agent uses `gif_creator` and exports one. The GIF is saved to your Downloads folder (or `FOXWRIGHT_GIF_DIR`) and goes nowhere else.

**File uploads.** Files are read from your disk only when an agent asks to upload them, and only after you confirm the upload in a Foxwright window. With this version the file contents are not read at all until you have approved. The file is then given to the web page, as if you had picked it yourself, so the website receives it under its own privacy terms. Key and credential files are always refused.

**PDFs.** To read a PDF shown in Firefox's PDF viewer, Foxwright downloads that same PDF again from the extension (a GET request to the site you approved, with your cookies, usually served from Firefox's cache). Its text is extracted on your computer and only goes to the agent like other page text.

**The helper connection.** Traffic between the MCP server and the helper is encrypted and authenticated with a key in `~/.foxwright/auth-token`, so other users on the same computer can't read it or inject commands. On Windows the key file is protected by your user profile folder's permissions.

**`doctor`.** `foxwright doctor` reads your Firefox profiles' list of installed add-ons on your computer, only to see whether Foxwright is installed and enabled. Nothing is sent anywhere.

**Real-input mode.** If you start Firefox with remote debugging on, the Foxwright MCP server on your computer connects to Firefox's local WebDriver BiDi port (127.0.0.1) to send clicks and keystrokes. Nothing leaves your computer through this connection.

**Removing everything.** Remove the extension and run `npx foxwright-firefox uninstall`. That removes the helper, `~/.foxwright`, and the Foxwright entries it added to Claude Code and Claude Desktop.

Contact: will.ricchiuti@gmail.com, or an issue at https://github.com/william-ricchiuti/FoxWright/issues (for anything sensitive, use the private reporting described in SECURITY.md).
