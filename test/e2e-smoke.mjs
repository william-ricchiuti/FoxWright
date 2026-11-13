// A short end-to-end smoke test for platforms the full suites don't run on yet (Windows in CI):
// the helper's install (setup), Firefox talking to it (native messaging; a named pipe on Windows),
// and the core tools: tabs_context_mcp, navigate, read_page, click, type, screenshot, then
// `foxwright doctor` while Firefox is connected.
//
//   node host/dist/foxwright.mjs setup         (macOS/Windows: the harness uses your real HOME)
//   FIREFOX=... node test/e2e-smoke.mjs
import { execFileSync } from 'node:child_process';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { start } from './harness.mjs';
import { runner, expect, tabIdOf } from './gap-lib.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = `http://127.0.0.1:${process.env.FOXWRIGHT_P1}`;
const { test, finish } = runner('e2e-smoke');

console.log(`Foxwright smoke test (${process.platform}, Node ${process.versions.node})`);
const h = await start({});
let tabId;
const call = async (name, args = {}) => {
  const r = await h.call(name, { tabId, ...args });
  if (r.isError)
    throw new Error(`${name} failed: ${r.text}`);
  return r;
};
const refOf = async (query) => {
  const r = await call('find', { query });
  const ref = /\[ref=([^\]]+)\]/.exec(r.text)?.[1];
  expect(ref, `find "${query}": ${r.text}`);
  return ref;
};

await test('tabs_context_mcp', async () => {
  const r = await h.call('tabs_context_mcp', { createIfEmpty: true });
  tabId = tabIdOf(r.text);
  expect(tabId > 0, r.text);
});

await test('navigate to a local fixture + read_page', async () => {
  await call('navigate', { url: `${BASE}/basic.html` });
  const r = await call('read_page', {});
  expect(r.text.includes('textbox "Full name"') && r.text.includes('button "Create account"'), r.text.slice(0, 800));
});

await test('click', async () => {
  await call('computer', { action: 'left_click', ref: await refOf('Clicked 0 times') });
  const r = await call('read_page', {});
  expect(r.text.includes('Clicked 1 times'), r.text.slice(0, 1500));
});

await test('type', async () => {
  await call('computer', { action: 'left_click', ref: await refOf('Full name') });
  await call('computer', { action: 'type', text: 'Ada from the smoke test' });
  const r = await call('read_page', { filter: 'interactive' });
  expect(r.text.includes('Ada from the smoke test'), r.text.slice(0, 1500));
});

await test('screenshot', async () => {
  const r = await call('computer', { action: 'screenshot' });
  expect(r.images.length === 1 && r.images[0].data.length > 1000, r.text);
});

await test('doctor sees the running Firefox', async () => {
  let out;
  try {
    out = execFileSync(process.execPath, [path.join(root, 'host/dist/foxwright.mjs'), 'doctor'], { env: h.env, encoding: 'utf8' });
  } catch (e) {
    out = `${e.stdout || ''}${e.stderr || ''}\n(exit ${e.status})`;
  }
  const plain = out.replace(/\x1b\[[0-9;]*m/g, '');
  console.log(plain.split('\n').map(l => `      ${l}`).join('\n'));
  expect(/Firefox connected: extension v/.test(plain), 'doctor did not see the connected extension');
  expect(/All good\./.test(plain), 'doctor found problems');
});

await h.stop();
process.exit(finish());
