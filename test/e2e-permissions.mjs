// Permission tests (ask mode). An enterprise policy shortens the prompt timeout and
// pre-approves one origin (localhost:8766); 127.0.0.1:8765 stays unapproved.
// Screenshots of the real UI when run headful under Xvfb:
//   KITSUNE_E2E_HEADFUL=1 xvfb-run -a -s "-screen 0 1400x900x24" node test/e2e-permissions.mjs
import { execFileSync } from 'node:child_process';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { start } from './harness.mjs';

const shots = process.env.KITSUNE_E2E_HEADFUL && process.env.DISPLAY;
const results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
function snap(name) {
  if (!shots)
    return;
  fs.mkdirSync('test/results', { recursive: true });
  execFileSync('import', ['-window', 'root', `test/results/${name}.png`]);
  console.log(`      saved test/results/${name}.png`);
}
async function test(name, fn) {
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false, err: e.message });
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}
const expect = (c, m) => { if (!c) throw new Error(m); };

const h = await start({ policy: { promptTimeoutSec: 5, allowed: ['http://localhost:8766'] } });
const ctx = await h.call('tabs_context_mcp', { createIfEmpty: true });
const tabId = parseInt(/tabId (\d+)/.exec(ctx.text)[1], 10);

await test('navigating to an unapproved site asks first (extension-owned window), then times out', async () => {
  const t0 = Date.now();
  const a = h.call('navigate', { tabId, url: 'http://127.0.0.1:8765/basic.html' });
  await sleep(1500);
  snap('permission-window');
  const b = await h.call('navigate', { tabId, url: 'http://127.0.0.1:8765/page2.html' }); // same origin: shares the prompt
  const r = await a;
  expect(r.isError && /timed out/.test(r.text), r.text);
  expect(b.isError, 'concurrent call must not get through: ' + b.text);
  expect(Date.now() - t0 >= 4500, 'should have waited for the human');
  const t = await h.call('tabs_context_mcp', {});
  expect(!t.text.includes('127.0.0.1:8765'), 'tab must not have navigated:\n' + t.text);
});

await test('policy-approved site works without a prompt; activity glow shows', async () => {
  const r = await h.call('navigate', { tabId, url: 'http://localhost:8766/frame.html' });
  expect(!r.isError, r.text);
  const c = await h.call('computer', { tabId, action: 'left_click', coordinate: [40, 12] });
  expect(!c.isError, c.text);
  await sleep(300);
  snap('activity-glow');
  const p = await h.call('read_page', { tabId });
  expect(p.text.includes('frame button clicked'), p.text);
});

await test('embedded frame from an unapproved site is hidden from read_page', async () => {
  await h.call('navigate', { tabId, url: 'http://localhost:8766/embed.html' });
  const p = await h.call('read_page', { tabId });
  expect(!p.text.includes('Frame button') && /hidden until the user approves/.test(p.text), p.text);
  const f = await h.call('find', { tabId, query: 'Frame button' });
  expect(!f.text.includes('button "Frame button"'), f.text);
});

await test('file uploads need a human confirmation', async () => {
  const file = path.join(os.tmpdir(), 'kitsune-upload.txt');
  fs.writeFileSync(file, 'x');
  const p = await h.call('find', { tabId, query: 'Attachment' });
  const ref = /\[ref=(e\d+)\]/.exec(p.text)[1];
  const pending = h.call('file_upload', { tabId, ref, paths: [file] });
  await sleep(1500);
  snap('upload-window');
  const r = await pending;
  expect(r.isError && /did not approve/.test(r.text), r.text);
});

await test('credential files are refused outright', async () => {
  const dir = path.join(os.tmpdir(), '.ssh');
  fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(path.join(dir, 'id_ed25519'), 'secret');
  const r = await h.call('file_upload', { tabId, ref: 'e1', paths: [path.join(dir, 'id_ed25519')] });
  expect(r.isError && /credential or key/.test(r.text), r.text);
});

await h.stop();
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} permission tests passed`);
fs.writeFileSync('test/results/e2e-permissions.json', JSON.stringify(results, null, 2));
process.exit(failed ? 1 : 0);
