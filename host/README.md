# foxwright-firefox

This package is the helper and MCP server for **[Foxwright](https://github.com/william-ricchiuti/FoxWright)**. Foxwright lets Claude, or any MCP app, operate your real Firefox through the [Foxwright extension](https://addons.mozilla.org/firefox/addon/foxwright/), with your approval for each site.

```sh
npx foxwright-firefox setup --claude-desktop   # install, and connect Claude Desktop
npx foxwright-firefox setup --claude-code      # install, and connect Claude Code
npx foxwright-firefox setup                    # install; prints settings for Cursor, Codex, VS Code, Gemini CLI, Windsurf, Zed
npx foxwright-firefox doctor                   # check every link and say what to fix
npx foxwright-firefox uninstall                # remove the helper and the Claude entries
```

- `setup`: copies a single self-contained file to `~/.foxwright/app/`, registers the native-messaging host with Firefox, and optionally adds the MCP server to Claude Code / Claude Desktop. Settings for other apps: [docs/CLIENTS.md](https://github.com/william-ricchiuti/FoxWright/blob/main/docs/CLIENTS.md).
- `mcp`: runs the MCP server on stdio. Your AI app starts this.
- `doctor` / `uninstall`: check the installation, or remove the helper.

Requires Node.js 20+ and Firefox 152+ with the Foxwright extension installed. On Windows, run it in Command Prompt (or type `npx.cmd` in PowerShell). On Ubuntu, the built-in Snap Firefox usually can't start the helper; use Mozilla's .deb or tarball Firefox. See the main README for the tools, the safety model and the optional trusted-input mode.
