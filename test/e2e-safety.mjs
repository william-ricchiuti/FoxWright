// Safety controls, exercised the way a person would use them. The test opens its own WebDriver
// BiDi session (the MCP server is told not to use it) to press buttons in Foxwright's permission
// window and toolbar popup, which are extension pages that web pages and the agent can't reach.
//
//   node test/e2e-safety.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { start } from './harness.mjs';
import { connectDriver } from './bidi-driver.mjs';

const results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true, ms: Date.now() - t0 });
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push({ name, ok: false, ms: Date.now() - t0, err: e.message });
    console.log(`  ✗ ${name}\n      ${e.message.split('\n').join('\n      ')}`);
  }
}
const expect = (c, m) => { if (!c) throw new Error(m); };

const P1 = process.env.FOXWRIGHT_P1, P2 = process.env.FOXWRIGHT_P2;
const ORIGIN = {
  deny: `http://localhost:${P2}`,
  once: `http://127.0.0.1:${P1}`,
  always: `http://127.0.0.1:${P2}`,
  upload: `http://localhost:${P1}`,
};

console.log('Foxwright safety e2e');
const h = await start({ testDriver: true, policy: { mode: 'ask', promptTimeoutSec: 30, confirmUploads: true } });

const driver = await connectDriver(h.bidiUrl);
h.useDriver(driver);
const { bidi, contexts, evalIn, promptWindow, answer } = driver;

let popup = null;
async function openPopup(extBase) {
  if (popup)
    return popup;
  const { context } = await bidi('browsingContext.create', { type: 'window' }); // own window: the agent's tab stays visible
  await bidi('browsingContext.navigate', { context, url: `${extBase}popup/popup.html`, wait: 'complete' });
  popup = context;
  return context;
}
const extBaseOf = (promptUrl) => promptUrl.replace(/prompt\/prompt\.html.*$/, '');

const ctx = await h.call('tabs_context_mcp', { createIfEmpty: true });
const tabId = parseInt(/tabId (\d+)/.exec(ctx.text)[1], 10);
let extBase = '';

await test('permission window: buttons start disabled, then Deny refuses the site', async () => {
  const nav = h.call('navigate', { tabId, url: `${ORIGIN.deny}/basic.html` });
  const w = await promptWindow();
  extBase = extBaseOf(w.url);
  const disabledAtFirst = await evalIn(w.context, `['deny','once','always'].every(id => document.getElementById(id).disabled)`);
  expect(disabledAtFirst, 'buttons should be disabled right after the window opens');
  const primary = await evalIn(w.context, `document.querySelector('.actions .primary').id`);
  expect(primary === 'once', `default button should be "Allow this session", was ${primary}`);
  await answer('deny');
  const r = await nav;
  expect(r.isError && /did not allow|denied|not allowed|refused/i.test(r.text), r.text);
  const t = await h.call('tabs_context_mcp', {});
  expect(!t.text.includes(ORIGIN.deny), 'the tab must not have navigated:\n' + t.text);
});

await test('Allow this session: navigation goes through, and the same site isn\'t asked again', async () => {
  const nav = h.call('navigate', { tabId, url: `${ORIGIN.once}/basic.html` });
  await answer('once');
  const r = await nav;
  expect(!r.isError, r.text);
  const again = await h.call('navigate', { tabId, url: `${ORIGIN.once}/page2.html` });
  expect(!again.isError && again.text.includes('page2.html'), again.text);
  expect(!(await contexts()).some(x => x.url.includes('/prompt/prompt.html')), 'no second prompt expected');
});

await test('Always allow is listed in the popup and can be revoked there', async () => {
  const nav = h.call('navigate', { tabId, url: `${ORIGIN.always}/page2.html` });
  await answer('always');
  expect(!(await nav).isError, 'navigation should succeed after Always allow');
  const p = await openPopup(extBase);
  let listed = false;
  for (let i = 0; i < 40 && !listed; i++) {
    listed = await evalIn(p, `document.getElementById('sites').textContent.includes('127.0.0.1:${P2}')`);
    if (!listed)
      await sleep(100);
  }
  expect(listed, 'popup should list the always-allowed site');
  await evalIn(p, `[...document.querySelectorAll('#sites li')].find(li => li.textContent.includes('127.0.0.1:${P2}') && li.textContent.includes('always')).querySelector('button.x').click()`);
  await sleep(300);
  // Revoked: the next command on that site asks again (deny it this time).
  const read = h.call('read_page', { tabId });
  await answer('deny');
  const r = await read;
  expect(r.isError, 'read_page should be refused after revoking: ' + r.text);
});

await test('Pause in the popup blocks new commands; Resume lets them through', async () => {
  const p = await openPopup(extBase);
  await h.call('navigate', { tabId, url: `${ORIGIN.once}/basic.html` });
  await evalIn(p, `document.getElementById('pause').click()`);
  await sleep(300);
  const r = await h.call('read_page', { tabId });
  expect(r.isError && /paused/i.test(r.text), r.text);
  await evalIn(p, `document.getElementById('resume').click()`);
  await sleep(300);
  const ok = await h.call('read_page', { tabId });
  expect(!ok.isError, ok.text);
});

await test('Pause interrupts typing that is already in progress', async () => {
  const p = await openPopup(extBase);
  await h.call('navigate', { tabId, url: `${ORIGIN.once}/basic.html` });
  const f = await h.call('find', { tabId, query: 'Full name' });
  const ref = /\[ref=([^\]]+)\]/.exec(f.text)[1];
  await h.call('computer', { tabId, action: 'left_click', ref });
  try {
    const typing = h.call('computer', { tabId, action: 'type', text: 'x'.repeat(300) });
    await sleep(150);
    await evalIn(p, `document.getElementById('pause').click()`);
    const r = await typing;
    expect(r.isError && /paused|stopped/i.test(r.text), 'typing should report the stop: ' + r.text.slice(0, 200));
  } finally {
    await evalIn(p, `document.getElementById('resume').click()`);
    await sleep(300);
  }
  const page = await h.call('read_page', { tabId, max_chars: 100000 });
  const typed = (/textbox "Full name"[^\n]*(?::\s*|\n\s*- \/placeholder: [^\n]*\n\s*- text: )(x+)/.exec(page.text) || [, ''])[1].length;
  expect(typed > 0 && typed < 300, `expected a partial value, got ${typed} characters:\n${page.text.slice(0, 600)}`);
});

await test('Pause answers an open permission window with Deny', async () => {
  const p = await openPopup(extBase);
  const nav = h.call('navigate', { tabId, url: `${ORIGIN.upload}/basic.html` });
  await promptWindow();
  await evalIn(p, `document.getElementById('pause').click()`);
  const r = await nav;
  expect(r.isError, 'navigation must not go through: ' + r.text);
  await sleep(300);
  expect(!(await contexts()).some(x => x.url.includes('/prompt/prompt.html')), 'the permission window should have closed');
  await evalIn(p, `document.getElementById('resume').click()`);
  await sleep(300);
});

await test('file upload: the user approves it in the Foxwright window', async () => {
  await h.call('navigate', { tabId, url: `${ORIGIN.once}/basic.html` });
  const file = path.join(os.tmpdir(), `foxwright-upload-${process.pid}.txt`);
  fs.writeFileSync(file, 'hello from the safety test\n');
  const f = await h.call('find', { tabId, query: 'Avatar' });
  const ref = /\[ref=([^\]]+)\]/.exec(f.text)?.[1];
  expect(ref, f.text);
  const up = h.call('file_upload', { tabId, ref, paths: [file] });
  const w = await promptWindow();
  let shown = '';
  for (let i = 0; i < 40 && !shown; i++) {
    shown = await evalIn(w.context, `document.getElementById('files').textContent`);
    if (!shown)
      await sleep(50);
  }
  expect(shown.includes(path.basename(file)), 'the window should list the file: ' + shown);
  await answer('once');
  const r = await up;
  expect(!r.isError, r.text);
  fs.rmSync(file, { force: true });
});

await test('upload_image: a screenshot goes into a file input after the user approves it', async () => {
  await h.call('navigate', { tabId, url: `${ORIGIN.once}/basic.html` });
  const bogus = await h.call('upload_image', { tabId, imageId: 'shot-999', ref: 'e1' });
  expect(bogus.isError && /No screenshot/.test(bogus.text), 'unknown IDs must be refused: ' + bogus.text);
  const shot = await h.call('computer', { tabId, action: 'screenshot' });
  const id = /Screenshot ID: (shot-\d+)/.exec(shot.text)?.[1];
  expect(id, 'screenshot result should carry an ID: ' + shot.text);
  const ref = /\[ref=([^\]]+)\]/.exec((await h.call('find', { tabId, query: 'Avatar' })).text)?.[1];
  const up = h.call('upload_image', { tabId, imageId: id, ref, filename: 'bug-report.png' });
  const w = await promptWindow();
  let shown = '';
  for (let i = 0; i < 40 && !shown; i++) {
    shown = await evalIn(w.context, `document.getElementById('files').textContent`);
    if (!shown)
      await sleep(50);
  }
  expect(shown.includes('bug-report.jpg') && shown.includes(id), 'the window should name the screenshot: ' + shown);
  await answer('once');
  const r = await up;
  expect(!r.isError && /Uploaded as bug-report\.jpg/.test(r.text), r.text);
  const got = { text: await h.js(tabId, `(() => { const f = document.getElementById('avatar').files[0]; return f ? f.name + '|' + f.type + '|' + f.size : 'none'; })()`) };
  const [name, type, size] = JSON.parse(got.text).split('|');
  expect(name === 'bug-report.jpg' && type === 'image/jpeg' && Number(size) > 1000, 'file input got: ' + got.text);
});

await test('the popup lists what the agent did, with its own summaries cleaned up', async () => {
  await h.call('navigate', { tabId, url: `${ORIGIN.once}/basic.html` });
  const btn = /\[ref=([^\]]+)\]/.exec((await h.call('find', { tabId, query: 'Clicked 0 times' })).text)?.[1];
  const name = /\[ref=([^\]]+)\]/.exec((await h.call('find', { tabId, query: 'Full name' })).text)?.[1];
  expect(btn && name, 'fixture elements not found');
  await h.call('computer', { tabId, action: 'left_click', ref: btn, action_summary: 'Clicks the\ncounter ‮button' });
  await h.call('form_input', { tabId, ref: name, value: 'Ada' }); // no summary: Foxwright describes it
  const p = await openPopup(extBase);
  let items = [];
  for (let i = 0; i < 50; i++) { // the popup refreshes every 1.5 s
    items = JSON.parse(await evalIn(p, `JSON.stringify([...document.querySelectorAll('#recent li span')].map(s => s.textContent))`));
    if (items[0] === `Filled ${name}`)
      break;
    await sleep(100);
  }
  expect(items[0] === `Filled ${name}`, `newest entry should be Foxwright's own description: ${JSON.stringify(items)}`);
  expect(items[1] === '“Clicks the counter button”', `agent's summary should be quoted, on one line, without control characters: ${JSON.stringify(items)}`);
});

driver.close();
await h.stop();
const passed = results.filter(r => r.ok).length;
console.log(`\n${passed}/${results.length} safety tests passed`);
fs.mkdirSync('test/results', { recursive: true });
fs.writeFileSync('test/results/e2e-safety.json', JSON.stringify(results, null, 2));
process.exit(passed === results.length ? 0 : 1);
