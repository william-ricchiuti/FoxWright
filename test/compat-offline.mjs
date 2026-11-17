// Version compatibility without a browser: the real helper and MCP server of this build against a
// fake extension that says it is older, the same, or newer; and an MCP server from before 0.8
// knocking on the helper. No Firefox, no network; safe anywhere (needs `npm run build`).
//
//   node test/compat-offline.mjs
//
// The cells with real published extensions and helpers are in test/e2e-compat.mjs.
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(root, 'host', 'package.json'));
const { Client } = await import(req.resolve('@modelcontextprotocol/sdk/client/index.js'));
const { StdioClientTransport } = await import(req.resolve('@modelcontextprotocol/sdk/client/stdio.js'));
const C = await import(path.join(root, 'host/src/compat.js'));
const X = await import(path.join(root, 'src/background/compat.js'));
const CLI = path.join(root, 'host/dist/foxwright.mjs');
if (!fs.existsSync(CLI)) {
  console.error('Build first: npm run build');
  process.exit(2);
}
const MINE = spawnSync(process.execPath, [CLI, '--version'], { encoding: 'utf8' }).stdout.trim();
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-compat-'));
const sock = path.join(home, 'foxwright.sock');
const env = { ...process.env, FOXWRIGHT_HOME: home, FOXWRIGHT_TRUSTED: '0', FOXWRIGHT_BIDI_PORT: '1' };
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failed = 0, passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${String(e?.message || e).split('\n').join('\n      ')}`);
  }
}
const expect = (c, m) => { if (!c) throw new Error(m); };

/** The real helper with a fake extension of `version` on its stdio. requests: what the extension was asked. */
async function startHelper(version, answer) {
  const p = spawn(process.execPath, [CLI, 'host'], { env, stdio: ['pipe', 'pipe', 'inherit'] });
  const requests = [], other = [];
  const write = (obj) => {
    const body = Buffer.from(JSON.stringify(obj));
    const h = Buffer.alloc(4);
    h.writeUInt32LE(body.length);
    p.stdin.write(Buffer.concat([h, body]));
  };
  let buf = Buffer.alloc(0);
  p.stdout.on('data', async (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
      const msg = JSON.parse(buf.subarray(4, 4 + buf.readUInt32LE(0)).toString());
      buf = buf.subarray(4 + buf.readUInt32LE(0));
      if (msg.type !== 'request') {
        other.push(msg);
        continue;
      }
      requests.push(msg);
      try {
        write({ type: 'response', id: msg.id, result: await answer(msg.tool, msg.args) });
      } catch (e) {
        write({ type: 'response', id: msg.id, error: e.message });
      }
    }
  });
  write({ type: 'hello', version, full: false, browserId: 'abcdefabcdef', name: 'Test' });
  fs.rmSync(sock, { force: true });
  for (let i = 0; i < 100 && !fs.existsSync(sock); i++)
    await sleep(50);
  return { requests, other, stop: async () => { p.kill(); await new Promise(r => p.once('exit', r)); fs.rmSync(sock, { force: true }); } };
}

const text = (t) => ({ content: [{ type: 'text', text: t }] });
// What an extension from before 0.8 does: it ignores options it doesn't know.
const oldExtension = async (tool, args) => {
  if (tool === '_status')
    return { data: { groupTabIds: [1], clients: 1 } };
  if (tool === 'tabs_context_mcp')
    return text('Foxwright tab group (1 tab):\n- tabId 1: "x" http://a.test/');
  if (tool === 'read_page')
    return text('Page: x\nURL: http://a.test/\n- button "Save" [ref=e1]');
  if (tool === 'find')
    return text('1 match for "Save":\n- button "Save" [ref=e1]');
  if (tool === 'computer' && args.action === 'wait')
    return text(`Waited ${args.duration ?? 1}s.`);
  if (tool === 'get_page_text')
    throw new Error('Tab 1 shows a PDF in Firefox\'s built-in PDF viewer, which extensions can\'t read or screenshot.');
  return text(`ok ${tool}`);
};

let helper = await startHelper('0.7.1', oldExtension);
const client = new Client({ name: 'compat-offline', version: '0' });
await client.connect(new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp'], env, stderr: 'inherit' }));
const call = async (name, args = {}) => {
  const r = await client.callTool({ name, arguments: args });
  return { text: (r.content || []).map(c => c.text || '').join('\n'), isError: !!r.isError };
};
const sent = (tool) => helper.requests.filter(r => r.tool === tool).map(r => r.args);

console.log(`Foxwright version compatibility, offline (MCP server and helper ${MINE}, fake extensions)`);

await test('older extension: the first tabs_context_mcp says the extension update comes from the store, and does not ask for setup', async () => {
  const r = await call('tabs_context_mcp', {});
  expect(!r.isError && /tabId 1/.test(r.text), r.text);
  expect(/extension in Firefox \(0\.7\.1\) is older than this MCP server/.test(r.text), r.text);
  expect(/does NOT need to run setup/.test(r.text) && /add-ons store/.test(r.text) && /Check for Updates/.test(r.text), r.text);
  expect(!/version mismatch|update the Foxwright extension;/.test(r.text), `the 0.8.0 wording is back: ${r.text}`);
  const again = await call('tabs_context_mcp', {});
  expect(!/Version note/.test(again.text), `said twice on one connection: ${again.text}`);
});

await test('older extension: read_page {diff} returns the full outline and says diff needs extension 0.8', async () => {
  const r = await call('read_page', { tabId: 1, diff: true, filter: 'interactive' });
  expect(!r.isError && /button "Save" \[ref=e1\]/.test(r.text), r.text);
  expect(/^Note: read_page \{diff\} needs Foxwright extension 0\.8 or newer; the extension in this Firefox is 0\.7\.1\. This is the full outline instead\./.test(r.text), r.text);
  const a = sent('read_page').pop();
  expect(a.diff === undefined && a.filter === 'interactive', `sent to the extension: ${JSON.stringify(a)}`);
});

await test('older extension: read_page / find {wait_for} run at once and say they did not wait', async () => {
  const r = await call('read_page', { tabId: 1, wait_for: 'dialog', timeout: 3 });
  expect(!r.isError && /read_page \{wait_for\} needs Foxwright extension 0\.8 or newer/.test(r.text) && /without waiting for "dialog"/.test(r.text) && /button "Save"/.test(r.text), r.text);
  const a = sent('read_page').pop();
  expect(a.wait_for === undefined && a.timeout === undefined, JSON.stringify(a));
  const f = await call('find', { tabId: 1, query: 'Save', wait_for: 'Saved' });
  expect(!f.isError && /find \{wait_for\} needs Foxwright extension 0\.8 or newer/.test(f.text) && /1 match/.test(f.text), f.text);
  expect(sent('find').pop().wait_for === undefined, JSON.stringify(sent('find').pop()));
});

await test('older extension: computer wait {text | text_gone | ref_gone | until} is refused before it reaches Firefox (it would report "Waited 1s")', async () => {
  for (const extra of [{ text: 'Done' }, { text_gone: 'Loading' }, { ref_gone: 'e5' }, { until: 'idle' }]) {
    const before = sent('computer').length;
    const r = await call('computer', { tabId: 1, action: 'wait', timeout: 2, ...extra });
    const key = Object.keys(extra)[0];
    expect(r.isError && new RegExp(`computer wait with ${key} needs Foxwright extension 0\\.8 or newer; the extension in this Firefox is 0\\.7\\.1`).test(r.text) && /Nothing was waited for/.test(r.text) && /duration/.test(r.text), `${key}: ${r.text}`);
    expect(sent('computer').length === before, `${key}: the wait reached the extension`);
  }
  const plain = await call('computer', { tabId: 1, action: 'wait', duration: 2 });
  expect(!plain.isError && /Waited 2s/.test(plain.text), `a plain wait must still work: ${plain.text}`);
});

await test('older extension: a PDF gets "reading PDFs needs extension 0.8", not "extensions can\'t read"', async () => {
  const r = await call('get_page_text', { tabId: 1 });
  expect(r.isError && /Reading PDFs \(get_page_text\) needs Foxwright extension 0\.8 or newer; the extension in this Firefox is 0\.7\.1/.test(r.text), r.text);
});

await test('older extension: the same notes inside browser_batch', async () => {
  const r = await call('browser_batch', { actions: [{ tool: 'read_page', args: { tabId: 1, diff: true } }, { tool: 'computer', args: { tabId: 1, action: 'wait', text: 'Done' } }] });
  expect(/read_page \{diff\} needs Foxwright extension 0\.8/.test(r.text) && /computer wait with text needs Foxwright extension 0\.8/.test(r.text) && r.isError, r.text);
});

await test(`an MCP server from before 0.8 is refused with "restart this AI client"; the extension (popup) and doctor are told too`, async () => {
  const before = helper.requests.length;
  const s = net.connect(sock);
  let buf = '';
  s.setEncoding('utf8');
  s.on('data', (d) => { buf += d; });
  await new Promise(r => s.once('connect', r));
  s.write(JSON.stringify({ type: 'status', id: 1 }) + '\n' + JSON.stringify({ type: 'request', id: 2, tool: 'tabs_context_mcp', args: {} }) + '\n');
  await sleep(400);
  s.destroy();
  const msgs = buf.split('\n').filter(Boolean).map(l => JSON.parse(l));
  const resp = msgs.find(m => m.id === 2);
  expect(resp?.error && /older than the Foxwright helper/.test(resp.error) && /restart this AI client: quit it completely and open it again/.test(resp.error), JSON.stringify(msgs));
  expect(helper.requests.length === before, 'the refused request reached the extension');
  const told = helper.other.filter(m => m.type === 'old-client');
  expect(told.length === 1 && Number.isFinite(told[0].at), `the extension should hear about it once: ${JSON.stringify(helper.other.map(m => m.type))}`);
  // What the popup then shows, from the extension's own code.
  const notes = X.versionNotes({ connected: true, version: MINE, helperVersion: MINE, oldClientAt: told[0].at });
  expect(notes.length === 1 && notes[0].kind === 'old-client' && /Restart your AI client: quit it completely and open it again/.test(notes[0].text), JSON.stringify(notes));
  // What doctor reads: the helper's (authenticated) status says when it last refused one.
  process.env.FOXWRIGHT_HOME = home;
  const { HelperClient } = await import(path.join(root, 'host/src/client.js'));
  const hc = new HelperClient({ path: sock });
  const st = await hc.status();
  hc.close();
  expect(Number.isFinite(st.oldClientAt) && Date.now() - st.oldClientAt < 10000, JSON.stringify(st));
});

await test('same version: options pass through untouched and nothing is said about versions', async () => {
  await helper.stop();
  helper = await startHelper(MINE, async (tool, args) => (tool === 'read_page' && args.diff ? text('No changes since the previous read_page (3 lines).') : oldExtension(tool, args)));
  let r;
  for (let i = 0; i < 40; i++) { // the MCP server reconnects on the next call
    r = await call('tabs_context_mcp', {});
    if (!r.isError)
      break;
    await sleep(250);
  }
  expect(!r.isError && !/Version note|older|newer/.test(r.text), r.text);
  const d = await call('read_page', { tabId: 1, diff: true, wait_for: 'x', timeout: 2 });
  expect(/^No changes since the previous read_page/.test(d.text), d.text);
  const a = sent('read_page').pop();
  expect(a.diff === true && a.wait_for === 'x' && a.timeout === 2, JSON.stringify(a));
  const w = await call('computer', { tabId: 1, action: 'wait', text: 'Done', timeout: 2 });
  expect(sent('computer').pop()?.text === 'Done', w.text);
});

await test('newer extension (the store updated it first): the agent is told to have setup run and the AI client restarted', async () => {
  await helper.stop();
  helper = await startHelper('99.1.0', oldExtension);
  let r;
  for (let i = 0; i < 40; i++) {
    r = await call('tabs_context_mcp', {});
    if (!r.isError)
      break;
    await sleep(250);
  }
  expect(!r.isError && /This MCP server \(.*\) is older than the Foxwright extension in Firefox \(99\.1\.0\)/.test(r.text) && /npx foxwright-firefox@latest setup/.test(r.text) && /restart this AI client/.test(r.text), r.text);
  const d = await call('read_page', { tabId: 1, diff: true });
  expect(!/needs Foxwright extension/.test(d.text) && sent('read_page').pop().diff === true, d.text);
});

await test('advice by direction (agent, doctor, popup): pure functions', async () => {
  const D = C.describeVersionMismatch;
  expect(D('0.8.1', '0.8.1', '0.8.0') === null && D('0.8.1', '0.8.0', '0.8.3') === null, 'patch releases of one minor version are compatible');
  expect(D('0.8.1', null, null) === null && D('0.8.1', undefined, '0.8.1') === null, 'unknown versions say nothing');
  expect(/does NOT need to run setup/.test(D('0.8.1', '0.8.1', '0.7.1')) && !/Tell the user to run/.test(D('0.8.1', '0.8.1', '0.7.1')), D('0.8.1', '0.8.1', '0.7.1'));
  expect(/older than the Foxwright extension/.test(D('0.8.1', '0.8.1', '0.9.0')) && /restart this AI client/.test(D('0.8.1', '0.8.1', '0.9.0')), D('0.8.1', '0.8.1', '0.9.0'));
  expect(/helper Firefox is running \(0\.8\.1\) is older than this MCP server \(0\.9\.0\)/.test(D('0.9.0', '0.8.1', '0.9.0')), D('0.9.0', '0.8.1', '0.9.0'));
  expect(/older than the installed Foxwright helper \(0\.9\.0\)/.test(D('0.8.1', '0.9.0', '0.8.1')) && /restart this AI client/.test(D('0.8.1', '0.9.0', '0.8.1')) && !/setup/.test(D('0.8.1', '0.9.0', '0.8.1')), D('0.8.1', '0.9.0', '0.8.1'));
  expect(C.compareVersions('0.10.0', '0.9.9') === 1 && C.compareVersions('0.8', '0.8.0') === 0 && C.compareVersions('x', '0.8.0') === null, 'compareVersions');

  const F = C.doctorVersionFindings;
  const older = F({ installed: '0.8.1', running: '0.8.1', ext: '0.7.1' });
  expect(older.length === 1 && older[0].level === 'warn' && /Nothing to run for the older extension/.test(older[0].fix) && !/npx/.test(older[0].fix), JSON.stringify(older));
  const newer = F({ installed: '0.7.1', running: '0.7.1', ext: '0.8.1' });
  expect(newer.length === 1 && newer[0].level === 'bad' && /npx foxwright-firefox@latest setup/.test(newer[0].fix) && /restart your AI client/.test(newer[0].fix), JSON.stringify(newer));
  const stale = F({ installed: '0.8.1', running: '0.8.0', ext: '0.8.1' });
  expect(stale.length === 1 && /still runs helper 0\.8\.0; 0\.8\.1 is installed/.test(stale[0].text) && /Restart Firefox/.test(stale[0].fix), JSON.stringify(stale));
  expect(F({ cmd: '0.8.1', installed: '0.8.1' }).length === 0 && /@latest setup/.test(F({ cmd: '0.8.1', installed: '0.7.1' })[0].fix) && /@latest doctor/.test(F({ cmd: '0.7.1', installed: '0.8.1' })[0].fix), 'doctor command vs installed helper');

  const N = X.versionNotes;
  expect(N({ connected: true, version: '0.8.1', helperVersion: '0.8.0' }).length === 0 && N({ connected: false, version: '0.8.1', helperVersion: null }).length === 0, 'nothing to say');
  const pre = N({ connected: true, version: '0.8.1', helperVersion: null });
  expect(pre.length === 1 && pre[0].kind === 'helper-older' && /from before 0\.8/.test(pre[0].text) && pre[0].cmd === 'npx foxwright-firefox@latest setup' && /restart your AI client/.test(pre[0].text), JSON.stringify(pre));
  const pending = N({ connected: true, version: '0.8.1', helperVersion: '0.9.0' });
  expect(pending.length === 1 && pending[0].kind === 'extension-older' && !pending[0].cmd && /You don't need to run anything/.test(pending[0].text) && /add-ons store/.test(pending[0].text), JSON.stringify(pending));
  expect(N({ connected: true, version: '0.8.1', helperVersion: '0.8.1', oldClientAt: Date.now() - 11 * 60000 }).length === 0, 'the old-client note expires');
});

await helper.stop();
await client.close().catch(() => {});
fs.rmSync(home, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed, ${passed} passed` : `\n${passed}/${passed} passed`);
process.exit(failed ? 1 : 0);
