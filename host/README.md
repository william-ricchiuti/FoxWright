# zenko-firefox

This package is the helper and MCP server for **[Zenko](https://github.com/william-ricchiuti/Zenko)**. Zenko lets Claude, or any MCP client, operate your real Firefox through the Zenko extension.

```sh
npx zenko-firefox setup --claude-code --claude-desktop   # install + register
npx zenko-firefox doctor                                  # check the connection
```

- `setup`: copies a single self-contained file to `~/.zenko/app/`, registers the native-messaging host with Firefox, and optionally adds the MCP server to Claude Code / Claude Desktop.
- `mcp`: runs the MCP server on stdio. Your AI client starts this.
- `doctor` / `uninstall`: check the installation, or remove the helper.

Requires Node.js 20+ and Firefox 140+ with the Zenko extension installed. See the main README for the tools, the safety model and the optional trusted-input mode.
