// foxwright CLI entry point (bundled to dist/foxwright.mjs).
import { runHost } from './host.js';

const [cmd, ...rest] = process.argv.slice(2);

// Firefox launches the helper with: <manifest path> <extension id>. Our launcher adds "host".
const launchedByFirefox = cmd && (cmd.endsWith('.json') || cmd.includes('@'));

async function main() {
  if (cmd === '--version' || cmd === '-v' || cmd === 'version') {
    console.log(typeof __FOXWRIGHT_VERSION__ !== 'undefined' ? __FOXWRIGHT_VERSION__ : '0.0.0');
    return;
  }
  if (cmd === 'host' || launchedByFirefox) {
    runHost();
    return;
  }
  if (cmd === 'mcp') {
    const { runMcp } = await import('./mcp.js');
    await runMcp();
    return;
  }
  if (cmd === 'setup') {
    const { setup } = await import('./setup.js');
    await setup(rest);
    return;
  }
  if (cmd === 'doctor') {
    const { doctor } = await import('./setup.js');
    await doctor();
    return;
  }
  if (cmd === 'uninstall') {
    const { uninstall } = await import('./setup.js');
    await uninstall();
    return;
  }
  console.log(`foxwright: let AI agents drive your real Firefox.

Usage:
  foxwright setup [--claude-code] [--claude-desktop] [--all]
                      Install the helper Firefox talks to, and optionally register
                      the MCP server with Claude Code / Claude Desktop.
  foxwright doctor      Check the installation and the live connection to Firefox, and
                      say what to do about each problem. Prints the installed
                      helper's version as well as this command's.
  foxwright mcp         Run the MCP server on stdio (what your AI client launches).
  foxwright uninstall   Remove the helper.
  foxwright --version   Print this command's version (\`doctor\` also shows the installed helper's).
`);
  process.exit(cmd && cmd !== 'help' && cmd !== '--help' ? 1 : 0);
}

main().catch((e) => {
  console.error(e?.stack || e);
  process.exit(1);
});
