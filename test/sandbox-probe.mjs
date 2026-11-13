// Records what happens when a sandboxed Firefox (Snap, Flatpak) runs Foxwright: does Firefox start
// the helper through native messaging, does the helper's socket appear, can an MCP client use it?
// It prints the exact errors so the README's warning about these packages can be precise.
//
//   node host/dist/foxwright.mjs setup                     (real HOME: meant for a throwaway CI runner)
//   FIREFOX=/snap/bin/firefox node test/sandbox-probe.mjs snap
//   FIREFOX=/path/to/flatpak-wrapper node test/sandbox-probe.mjs flatpak
//
// Exit 0 if the helper connected and a tool call worked, 1 otherwise. Findings also go to
// test/results/sandbox-<label>.txt. Policies are not written here (Snap's install is read-only);
// put them in /etc/firefox/policies/policies.json beforehand if the run should skip site prompts.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import webExt from 'web-ext';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const label = process.argv[2] || 'sandbox';
const firefox = process.env.FIREFOX;
const fw = path.join(os.homedir(), '.foxwright');
const sock = path.join(fw, 'foxwright.sock');
const findings = [];
const note = (s) => {
  findings.push(s);
  console.log(s);
};
const sleep = ms => new Promise(r => setTimeout(r, ms));
const run = (cmd, args) => {
  try {
    return execFileSync(cmd, args, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], timeout: 30000 });
  } catch (e) {
    return `${e.stdout || ''}${e.stderr || ''}(exit ${e.status ?? e.signal ?? e.code})`;
  }
};
const strip = s => String(s).replace(/\x1b\[[0-9;]*m/g, '');

note(`== Foxwright sandbox probe: ${label}`);
note(`Firefox: ${firefox} -> ${run(firefox, ['--version']).trim()}`);
for (const dir of [path.join(os.homedir(), '.mozilla', 'native-messaging-hosts'), path.join(os.homedir(), '.var', 'app', 'org.mozilla.firefox', '.mozilla', 'native-messaging-hosts'), path.join(os.homedir(), 'snap', 'firefox', 'common', '.mozilla', 'native-messaging-hosts')])
  note(`native-messaging manifest in ${dir}: ${fs.existsSync(path.join(dir, 'foxwright.json')) ? 'yes' : 'no'}`);

fs.rmSync(sock, { force: true });
let logStart = 0;
try {
  logStart = fs.statSync(path.join(fw, 'helper.log')).size;
} catch { /* no log yet */ }

// A strictly confined Firefox can't read a profile in the host's /tmp: keep web-ext's temporary
// profile somewhere the package can see.
const tmp = label === 'snap' ? path.join(os.homedir(), 'snap', 'firefox', 'common', 'tmp') : label === 'flatpak' ? path.join(os.homedir(), '.var', 'app', 'org.mozilla.firefox', 'tmp') : os.tmpdir();
fs.mkdirSync(tmp, { recursive: true });
process.env.TMPDIR = tmp;

let runner = null;
let ok = false;
try {
  runner = await webExt.cmd.run({
    sourceDir: path.join(root, 'dist', 'full'), firefox, args: ['--headless'], noReload: true, noInput: true, browserConsole: false,
    pref: { 'browser.shell.checkDefaultBrowser': false, 'app.update.disabledForTesting': true },
  }, { shouldExitProgram: false });
  note('web-ext: Firefox started and the extension was installed as a temporary add-on');
} catch (e) {
  note(`web-ext could not start Firefox with the extension: ${e.message}`);
}

if (runner) {
  const t0 = Date.now();
  let up = false;
  while (Date.now() - t0 < 60000 && !up) {
    up = await new Promise((resolve) => {
      const s = net.connect(sock);
      s.once('connect', () => { s.destroy(); resolve(true); });
      s.once('error', () => resolve(false));
    });
    if (!up)
      await sleep(1000);
  }
  note(up ? `helper socket appeared after ${Math.round((Date.now() - t0) / 1000)} s: ${sock}` : `helper socket never appeared within 60 s (${sock})`);
  if (up) {
    const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'host/dist/foxwright.mjs'), 'mcp'], stderr: 'inherit' });
    const client = new Client({ name: 'foxwright-sandbox-probe', version: '0' });
    try {
      await client.connect(transport);
      const r = await client.callTool({ name: 'tabs_context_mcp', arguments: { createIfEmpty: true } });
      const text = (r.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
      ok = !r.isError;
      note(`tabs_context_mcp: ${r.isError ? 'ERROR ' : ''}${text.split('\n')[0]}`);
    } catch (e) {
      note(`MCP client failed: ${e.message}`);
    }
    await client.close().catch(() => {});
  }
}

note('\n-- helper.log (this run)');
try {
  note(fs.readFileSync(path.join(fw, 'helper.log'), 'utf8').slice(logStart).trim() || '(empty: Firefox never started the helper)');
} catch (e) {
  note(`(no helper.log: ${e.code}) -> Firefox never started the helper`);
}
note('\n-- foxwright doctor');
note(strip(run(process.execPath, [path.join(root, 'host/dist/foxwright.mjs'), 'doctor'])).trim());
if (process.platform === 'linux') {
  note('\n-- AppArmor / portal denials in the kernel log (last 20 lines mentioning firefox/foxwright/node)');
  const k = run('sh', ['-c', 'journalctl -k --no-pager -n 400 2>/dev/null || dmesg 2>/dev/null']);
  note(k.split('\n').filter(l => /firefox|foxwright|node|apparmor="DENIED"/i.test(l)).slice(-20).join('\n') || '(nothing)');
}
note(`\nRESULT (${label}): ${ok ? 'Foxwright works' : 'Foxwright does NOT work'} with this Firefox package`);

try {
  await Promise.race([runner?.exit(), sleep(15000)]);
} catch { /* ignore */ }
fs.mkdirSync(path.join(root, 'test/results'), { recursive: true });
fs.writeFileSync(path.join(root, 'test/results', `sandbox-${label}.txt`), findings.join('\n') + '\n');
process.exit(ok ? 0 : 1);
