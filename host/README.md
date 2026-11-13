# foxwright-firefox

This package is the helper and MCP server for **[Foxwright](https://github.com/william-ricchiuti/FoxWright)**. Foxwright lets Claude, or any MCP client, operate your real Firefox through the Foxwright extension.

```sh
npx foxwright-firefox setup --claude-code --claude-desktop   # install + register
npx foxwright-firefox doctor                                  # check the connection
```

- `setup`: copies a single self-contained file to `~/.foxwright/app/`, registers the native-messaging host with Firefox, and optionally adds the MCP server to Claude Code / Claude Desktop.
- `mcp`: runs the MCP server on stdio. Your AI client starts this.
- `doctor` / `uninstall`: check the installation, or remove the helper.

Requires Node.js 20+ and Firefox 152+ with the [Foxwright extension](https://addons.mozilla.org/firefox/addon/foxwright/) installed. See the main README for the tools, the safety model and the optional trusted-input mode.
