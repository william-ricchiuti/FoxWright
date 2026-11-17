// Windows only: a second local user must not be able to use or spy on the first user's Foxwright.
// Needs an administrator (it creates a throwaway local account) and the Secondary Logon service;
// meant for the CI runner, not a personal machine.
//
//   FIREFOX=... node test/e2e-windows-users.mjs
//
// 1. The first user runs Foxwright normally (Firefox + helper on its named pipe).
// 2. A second user (test/windows-intruder.mjs probe) tries to read the key and the pipe name, finds
//    the pipe by listing \\.\pipe\, and talks to it without the key: it must learn nothing and get
//    no tool to run.
// 3. With the first user's Firefox closed, the second user creates a pipe with the same name and
//    pretends to be the helper (squat). The first user's MCP server must refuse it before sending
//    anything but its handshake line.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import crypto from 'node:crypto';
import { execFileSync, spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { start } from './harness.mjs';
import { runner, expect, tabIdOf } from './gap-lib.mjs';
import { HelperClient } from '../host/src/client.js';

if (process.platform !== 'win32') {
  console.log('e2e-windows-users: Windows only, skipped.');
  process.exit(0);
}
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { test, finish } = runner('e2e-windows-users');
const sleep = (ms) => new Promise(r => setTimeout(r, ms));
const PUBLIC = 'C:\\Users\\Public\\foxwright-users-test';
fs.mkdirSync(PUBLIC, { recursive: true });
// The intruder script and a copy of node it can read (the runner's tool cache may not be).
const intruder = path.join(PUBLIC, 'windows-intruder.mjs');
fs.copyFileSync(path.join(root, 'test', 'windows-intruder.mjs'), intruder);
const nodeExe = path.join(PUBLIC, 'node.exe');
fs.copyFileSync(process.execPath, nodeExe);
execFileSync('icacls', [PUBLIC, '/grant', 'Users:(OI)(CI)M'], { stdio: 'ignore' });

const USER = 'fwprobe';
// At most 14 characters: for longer ones `net user` stops to ask whether to continue.
const PASS = `Fw!${crypto.randomBytes(6).toString('base64url')}9a`;
const ps = (script) => execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' });
try {
  execFileSync('net', ['user', USER, '/delete'], { stdio: 'ignore' });
} catch { /* not there */ }
try {
  execFileSync('net', ['user', USER, PASS, '/add'], { encoding: 'utf8', input: 'N\n' });
} catch (e) {
  throw new Error(`Could not create the test account: ${(e.stdout || '') + (e.stderr || '') || e.message}`);
}
try {
  ps('Start-Service seclogon');
} catch { /* already running */ }

/** Run the intruder as the second user; wait for it unless `background`. */
function asIntruder(args, { background = false } = {}) {
  const quoted = args.map(a => `'${String(a).replace(/'/g, "''")}'`).join(',');
  const script = `$p = ConvertTo-SecureString '${PASS}' -AsPlainText -Force; $c = New-Object System.Management.Automation.PSCredential('${os.hostname()}\\${USER}', $p); `
    + `$proc = Start-Process -FilePath '${nodeExe}' -ArgumentList @('${intruder}',${quoted}) -Credential $c -LoadUserProfile -WorkingDirectory '${PUBLIC}' -RedirectStandardError '${PUBLIC}\\err.txt' -PassThru${background ? '' : ' -Wait'}; `
    + `Write-Output $proc.Id`;
  if (background)
    return spawn('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { stdio: 'ignore' });
  return ps(script);
}
const readJson = (f) => JSON.parse(fs.readFileSync(f, 'utf8'));

const h = await start();
const ownerDir = path.join(os.homedir(), '.foxwright');
const pipe = h.sock;
console.log(`Foxwright two-user test (owner ${os.userInfo().username}, intruder ${USER}, pipe ${pipe.replace(/[a-f0-9]{32}/, '<id>')})`);
const tabId = tabIdOf((await h.call('tabs_context_mcp', { createIfEmpty: true })).text);

await test('the second user cannot read the key or the pipe name', async () => {
  const out = path.join(PUBLIC, 'probe.json');
  fs.rmSync(out, { force: true });
  asIntruder(['probe', ownerDir, out]);
  const r = readJson(out);
  console.log(`      (${JSON.stringify({ readKey: r.results.readKey, readPipeId: r.results.readPipeId, listDir: r.results.listDir?.ok, pipes: r.results.pipesSeen?.length })})`);
  expect(r.user && r.user.toLowerCase() === USER, `the probe ran as ${r.user}, not ${USER}`);
  expect(!r.results.readKey.ok, `the second user read the key file (${r.results.readKey.bytes} bytes)`);
  expect(!r.results.readPipeId.ok, 'the second user read the pipe name file');
  globalThis.probe = r;
});

await test('talking to the pipe without the key gets nothing and runs nothing', async () => {
  const r = globalThis.probe;
  expect(r, 'no probe result');
  for (const t of r.results.talks || []) {
    for (const [how, x] of [['plain request', t.plain], ['made-up key', t.fake]]) {
      const lines = x.received.split('\n').filter(Boolean).map(l => {
        try {
          return JSON.parse(l);
        } catch {
          return { raw: l.slice(0, 80) };
        }
      });
      // Allowed: the challenge, a refusal, and the "update your MCP server" error an old-style
      // request gets (it carries the helper's version, nothing about the browser or tabs).
      const refusal = (m) => (m.type === 'response' || m.type === 'status') && m.error && !('result' in m) && !m.extension && !m.browser;
      const leaked = lines.filter(m => !['auth-challenge', 'auth-failed', 'error'].includes(m.type) && !refusal(m) && !('raw' in m));
      console.log(`      (${t.name.replace(/[a-f0-9]{32}/, '<id>')}, ${how}: connected ${x.connected}, got ${lines.map(m => m.type || 'raw').join(',') || 'nothing'})`);
      expect(!leaked.length, `${how} got an answer beyond the handshake: ${JSON.stringify(leaked).slice(0, 200)}`);
      expect(!/tabId|Foxwright tab group|browserId/.test(x.received), `${how} saw browser data: ${x.received.slice(0, 200)}`);
    }
  }
  // The owner's Foxwright still works after the attempts.
  const ok = await h.call('tabs_context_mcp', {});
  expect(!ok.isError && ok.text.includes(`tabId ${tabId}`), 'the owner lost Foxwright after the intruder: ' + ok.text.slice(0, 200));
});

await test('a pipe squatted by the second user is refused before any tool data is sent', async () => {
  await h.stopFirefoxOnly(); // the helper exits and its pipe disappears
  await sleep(1500);
  const out = path.join(PUBLIC, 'squat.json');
  fs.rmSync(out, { force: true });
  asIntruder(['squat', pipe, '25', out], { background: true });
  for (let i = 0; i < 40 && !(fs.existsSync(out) && readJson(out).results.listening); i++)
    await sleep(250);
  const squat0 = fs.existsSync(out) ? readJson(out) : null;
  expect(squat0?.results.listening, `the squatter could not create the pipe (${squat0?.results.listenError || 'no output'}); nothing to test`);
  const c = new HelperClient({ path: pipe });
  let err = null;
  try {
    await c.call('tabs_context_mcp', { secret: 'TOOL-ARGS-MUST-NOT-LEAK' }, 8000);
  } catch (e) {
    err = String(e?.message || e);
  } finally {
    c.close();
  }
  await sleep(1000);
  const r = readJson(out);
  const sent = (r.results.received || []).map(x => x.data).join('\n');
  console.log(`      (client error: ${err?.slice(0, 120)}; the squatter received ${sent.length} bytes)`);
  expect(err, 'the MCP client accepted the squatted pipe');
  expect(!sent.includes('TOOL-ARGS-MUST-NOT-LEAK') && !sent.includes('tabs_context_mcp'), 'tool data reached the squatter: ' + sent.slice(0, 200));
  for (const line of sent.split('\n').filter(Boolean)) {
    const m = JSON.parse(line);
    expect(m.type === 'auth', `the client sent something besides its handshake line: ${line.slice(0, 120)}`);
  }
});

try {
  execFileSync('net', ['user', USER, '/delete'], { stdio: 'ignore' });
} catch { /* ignore */ }
await h.stop().catch(() => {});
process.exit(finish());
