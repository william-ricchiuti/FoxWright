# Kitsune privacy policy

_Last updated: 2026-09-23_

Kitsune has no servers and collects nothing for its developer. There is no analytics, no telemetry and no remote logging.

**What the extension handles.** When an AI agent that *you* connected calls a Kitsune tool, the extension reads the requested content of pages in the Kitsune tab group:

- the page outline and text
- screenshots
- form values
- console messages and network request URLs of those tabs

It sends that content to the Kitsune helper program on your own computer (through Firefox native messaging). The helper passes it to the AI client you configured, such as Claude Code or Claude Desktop. That client may send it to its AI provider under that provider's own privacy terms. This is the add-on's sole purpose, and it only happens for sites you approved (or all sites, if you chose "Allow all sites").

**What is stored.**

- In Firefox's extension storage: your site-access choices (approved origins, the ask/allow-all setting) and the pause state.
- In `~/.kitsune/` on your computer: the helper and its local log file. The log records connection events, not page content.

**File uploads.** Files are read from your disk only when an agent asks to upload them, and only after you confirm the upload in a Kitsune window.

**Removing everything.** Remove the extension, run `npx kitsune-firefox uninstall`, and delete `~/.kitsune`.

Contact: will.ricchiuti@gmail.com
