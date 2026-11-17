# Connecting your AI app to Foxwright

Foxwright's helper is also an MCP server. Your AI app starts it with two things:

- **NODE**: the full path of Node.js, for example `/opt/homebrew/bin/node` (Mac with Homebrew), `/usr/local/bin/node` (Mac installer) or `C:\Program Files\nodejs\node.exe` (Windows).
- **APP**: the helper that setup installed: `~/.foxwright/app/foxwright.mjs` written out in full, for example `/Users/you/.foxwright/app/foxwright.mjs` or `C:\Users\you\.foxwright\app\foxwright.mjs`.

**Easiest:** run `npx foxwright-firefox setup`. At the end it prints every line below with your own NODE and APP filled in, ready to copy. Use full paths, not `~` or `node` alone: apps started from the Dock or Start menu often don't see the same PATH as your terminal.

After changing the settings, restart the app, then ask it: *"Use Foxwright to open https://example.com and tell me the main heading."* Firefox asks you to approve example.com first.

## Claude Code

```sh
npx foxwright-firefox setup --claude-code
```

or by hand:

```sh
claude mcp add --scope user foxwright -- NODE APP mcp
```

Start a new Claude Code session. `/mcp` should list `foxwright`.

## Claude Desktop

```sh
npx foxwright-firefox setup --claude-desktop
```

Then quit Claude Desktop completely (on a Mac: Claude menu › Quit Claude; on Windows: right-click its icon next to the clock › Quit) and open it again. Closing the window isn't enough.

By hand: in Claude Desktop open **Settings › Developer › Edit Config**. That opens `claude_desktop_config.json`:

- macOS: `~/Library/Application Support/Claude/claude_desktop_config.json`
- Windows: `%APPDATA%\Claude\claude_desktop_config.json`
- Linux: `~/.config/Claude/claude_desktop_config.json`

Add Foxwright inside `"mcpServers"` (keep any servers already there):

```json
{
  "mcpServers": {
    "foxwright": { "command": "NODE", "args": ["APP", "mcp"] }
  }
}
```

On Windows, write each backslash twice inside JSON: `"C:\\Program Files\\nodejs\\node.exe"`. Setup's printout already does this.

## Cursor

Add the same `"mcpServers"` entry as Claude Desktop to `~/.cursor/mcp.json` (all projects) or `.cursor/mcp.json` in one project:

```json
{
  "mcpServers": {
    "foxwright": { "command": "NODE", "args": ["APP", "mcp"] }
  }
}
```

## Codex (OpenAI)

```sh
codex mcp add foxwright -- NODE APP mcp
```

or add to `~/.codex/config.toml`:

```toml
[mcp_servers.foxwright]
command = "NODE"
args = ["APP", "mcp"]
```

In TOML on Windows, use single quotes so backslashes stay as they are: `command = 'C:\Program Files\nodejs\node.exe'`.

## Gemini CLI

```sh
gemini mcp add --scope user foxwright NODE APP mcp
```

Without `--scope user` it's added to the current project only. The entry lands under `"mcpServers"` in `~/.gemini/settings.json`, in the same format as Claude Desktop's.

## VS Code (GitHub Copilot agent mode)

macOS and Linux:

```sh
code --add-mcp '{"name":"foxwright","type":"stdio","command":"NODE","args":["APP","mcp"]}'
```

Or add it to a workspace's `.vscode/mcp.json`. Note that VS Code uses `"servers"`, not `"mcpServers"`:

```json
{
  "servers": {
    "foxwright": { "type": "stdio", "command": "NODE", "args": ["APP", "mcp"] }
  }
}
```

## Windsurf (Devin Desktop)

Add the `"mcpServers"` entry shown for Claude Desktop to `~/.codeium/windsurf/mcp_config.json` (Windows: `%USERPROFILE%\.codeium\windsurf\mcp_config.json`), then reload Windsurf's MCP servers.

## Zed

In Zed's `settings.json`, Foxwright goes under `"context_servers"`:

```json
{
  "context_servers": {
    "foxwright": { "command": "NODE", "args": ["APP", "mcp"], "env": {} }
  }
}
```

## Any other MCP app

Foxwright is a local **stdio** MCP server: command `NODE`, arguments `APP mcp`, no environment variables needed. Most apps take the `"mcpServers"` entry shown for Claude Desktop.

## Checking and removing

- `npx foxwright-firefox doctor` checks the helper, Firefox and the extension, and says what to fix.
- `npx foxwright-firefox uninstall` removes the helper and the Claude Code and Claude Desktop entries. Remove the `foxwright` entry from the other apps above by hand.

## Where these formats come from

Checked against each app's own documentation on 2026-11-16: [Claude Desktop](https://modelcontextprotocol.io/docs/develop/connect-local-servers), [Cursor](https://cursor.com/docs/context/mcp), [Codex](https://learn.chatgpt.com/docs/extend/mcp?surface=cli), [Gemini CLI](https://geminicli.com/docs/tools/mcp-server/), [VS Code](https://code.visualstudio.com/docs/agents/reference/mcp-configuration), [Zed](https://zed.dev/docs/ai/mcp). Windsurf's documentation now redirects to Devin's and doesn't show the file format on the page; the path above comes from [Devin's Windsurf plugin page](https://docs.devin.ai/windsurf/plugins/cascade/mcp) and wasn't tried in the app. None of these apps were run against Foxwright for this page except Claude Code and Codex (see the [evaluation reports](evaluations/0.8.0/README.md)).
