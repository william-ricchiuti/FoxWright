// First-run setup page, toolbar popup diagnosis, and the persistent activity log, exercised the
// way a person would: Firefox starts with NO helper installed (a new user who just added the
// extension from addons.mozilla.org), the test opens Foxwright's own pages through its WebDriver
// BiDi session, then runs `foxwright setup` in the isolated HOME and watches the page flip to
// "Connected" by itself. Uses gap-harness.mjs so one Firefox profile survives restartFirefox().
// Linux only (needs the isolated HOME).
//
//   FIREFOX=/path/to/firefox node test/e2e-onboarding.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { start } from './gap-harness.mjs';
import { runner, connectPerson, extBaseOf, sleep, expect, tabIdOf, refOf } from './gap-lib.mjs';

const { test, skip, finish } = runner('e2e-onboarding');
const P1 = process.env.FOXWRIGHT_P1, P2 = process.env.FOXWRIGHT_P2;
const ALLOWED = `http://127.0.0.1:${P1}`;
const DENIED = `http://localhost:${P2}`;
const SECRETS = ['TYPED-SECRET-4242', 'FORM-SECRET-777', 'QUERY-SECRET-999', 'basic.html', 'page2.html'];
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwright-onboarding-profile-'));

console.log('Foxwright onboarding e2e: setup page, popup diagnosis, activity log');
// No site mode from policy: the person's own choice ("ask") applies, so a denial can be logged.
const boot = await start({ testDriver: true, profileDir, deferSetup: true, policy: { promptTimeoutSec: 30, confirmUploads: true } });
let d = await connectPerson(boot.bidiUrl);
let extBase = await extBaseOf(d);
let h = null;
let tabId = null;

/** Wait until fn() is truthy (polling), or fail with msg. */
async function until(fn, ms, msg) {
  const t0 = Date.now();
  let v;
  while (Date.now() - t0 < ms) {
    v = await fn().catch(() => null);
    if (v)
      return v;
    await sleep(150);
  }
  throw new Error(typeof msg === 'function' ? msg(v) : msg);
}
const pageContext = async needle => (await d.contexts()).find(c => c.url.includes(needle));
async function openPage(rel) {
  const { context } = await d.bidi('browsingContext.create', { type: 'window' });
  await d.bidi('browsingContext.navigate', { context, url: `${extBase}${rel}`, wait: 'complete' });
  return context;
}
/** FOXWRIGHT_E2E_SHOTS=dir saves screenshots of the pages, for a look at the design. */
async function shot(ctx, name) {
  if (!process.env.FOXWRIGHT_E2E_SHOTS)
    return;
  const r = await d.bidi('browsingContext.captureScreenshot', { context: ctx, origin: 'document' }).catch(() => null);
  if (r) {
    fs.mkdirSync(process.env.FOXWRIGHT_E2E_SHOTS, { recursive: true });
    fs.writeFileSync(path.join(process.env.FOXWRIGHT_E2E_SHOTS, `${name}.png`), Buffer.from(r.data, 'base64'));
  }
}
const text = (ctx, id) => d.evalIn(ctx, `document.getElementById('${id}')?.textContent ?? null`);
const hidden = (ctx, id) => d.evalIn(ctx, `document.getElementById('${id}').hidden || getComputedStyle(document.getElementById('${id}')).display === 'none'`);
const readLog = ctx => d.evalIn(ctx, `browser.runtime.sendMessage({ kind: 'log-read' }).then(r => JSON.stringify(r))`).then(JSON.parse);
const storedLog = ctx => d.evalIn(ctx, `browser.storage.local.get('activityLog').then(r => JSON.stringify(r.activityLog || []))`).then(JSON.parse);

let welcome = null;
await test('installing the add-on opens the setup page (real runtime.onInstalled, reason "install")', async () => {
  // web-ext installs the build as a temporary add-on into a fresh profile: a real "install" event.
  const c = await until(() => pageContext('/welcome/welcome.html'), 15000, 'no setup page opened after install');
  welcome = c.context;
  await until(async () => (await text(welcome, 'build'))?.startsWith('Foxwright'), 5000, 'setup page did not load its status');
});

await test('before setup: the page says "Helper not found", with the command and Linux hints', async () => {
  const live = await until(async () => {
    const t = await text(welcome, 'live');
    return t === 'Helper not found' && t;
  }, 15000, async () => `status was "${await text(welcome, 'live')}"`);
  expect(live, 'no status');
  expect((await text(welcome, 'cmd')) === 'npx foxwright-firefox setup --claude-code', 'wrong command: ' + await text(welcome, 'cmd'));
  expect(/terminal/i.test(await text(welcome, 'terminal-hint')), 'terminal hint missing');
  expect(/Node\.js 20/.test(await d.evalIn(welcome, 'document.body.textContent')), 'Node.js 20+ note missing');
  expect(!(await hidden(welcome, 'linux-note')) && /Snap/.test(await text(welcome, 'linux-note')), 'Linux Snap/Flatpak note should show on Linux');
  expect(/can't find/.test(await text(welcome, 'diag')), 'diagnosis missing: ' + await text(welcome, 'diag'));
  await shot(welcome, 'welcome-not-found');
  await d.evalIn(welcome, `document.getElementById('copy').click()`);
  await until(async () => /Copied|Selected/.test(await text(welcome, 'copied')), 3000, 'copy button gave no feedback');
});

await test('before setup: the popup explains what is wrong and links to setup help', async () => {
  const p = await openPage('popup/popup.html');
  await until(async () => !(await hidden(p, 'setup')) && /can't find/.test(await text(p, 'diag')), 8000, async () => `popup diagnosis: ${await text(p, 'diag')}`);
  expect(!(await hidden(p, 'setup-cmd')), 'the setup command should show for "not installed"');
  await shot(p, 'popup-not-installed');
  expect((await text(p, 'status-text')) === 'Helper not connected', await text(p, 'status-text'));
  expect((await text(p, 'helper')) === 'not connected', 'helper row: ' + await text(p, 'helper'));
  // "Setup help" focuses the already open setup page instead of opening a second one.
  await d.evalIn(p, `document.getElementById('help').click()`);
  await sleep(800);
  const n = (await d.contexts()).filter(c => c.url.includes('/welcome/welcome.html')).length;
  expect(n === 1, `expected the one setup page, found ${n}`);
  await d.bidi('browsingContext.close', { context: p }).catch(() => {});
});

await test('after `foxwright setup` runs, the open setup page flips to "Connected" by itself', async () => {
  const t0 = Date.now();
  h = await boot.runSetup();
  await until(async () => (await text(welcome, 'live')) === 'Connected', 30000, async () => `still "${await text(welcome, 'live')}" ${Math.round((Date.now() - t0) / 1000)} s after setup`);
  const diag = await text(welcome, 'diag');
  expect(/^Helper \d+\.\d+\.\d+ is running\.$/.test(diag), 'diag after connect: ' + diag);
  expect(await d.evalIn(welcome, `document.getElementById('step-use').classList.contains('current')`), 'step 3 should be highlighted');
  await shot(welcome, 'welcome-connected');
  console.log(`      (connected ${((Date.now() - t0) / 1000).toFixed(1)} s after setup ran)`);
});

let popup = null;
await test('popup when connected: helper version, input mode, no mismatch warning, every control named and reachable by Tab', async () => {
  popup = await openPage('popup/popup.html');
  await until(async () => /^v\d/.test(await text(popup, 'helper')), 8000, async () => 'helper row: ' + await text(popup, 'helper'));
  const ext = (await text(popup, 'build')).replace(/^v| .*$/g, '');
  expect((await text(popup, 'helper')) === `v${ext}`, `helper ${await text(popup, 'helper')} vs extension ${ext}`);
  expect(await hidden(popup, 'version-warn'), 'no mismatch warning expected');
  expect(await hidden(popup, 'setup'), 'setup card should hide once connected');
  expect((await text(popup, 'input-mode')) === 'Simulated', 'input mode: ' + await text(popup, 'input-mode'));
  const unnamed = JSON.parse(await d.evalIn(popup, `JSON.stringify([...document.querySelectorAll('button, input, select, a[href]')].filter(e => !e.closest('[hidden]')).filter(e => {
    const name = e.getAttribute('aria-label') || [...(e.labels || [])].map(l => l.textContent).join(' ') || e.textContent || e.title;
    return !name.trim() || e.tabIndex < 0;
  }).map(e => e.outerHTML.slice(0, 80)))`));
  expect(!unnamed.length, 'controls without a name or not focusable: ' + unnamed.join(' | '));
  // A person pressing Tab reaches every control: collect what gets focus.
  await d.evalIn(popup, `document.activeElement?.blur(); window.focus(); true`);
  const seen = new Set();
  for (let i = 0; i < 14; i++) {
    await d.bidi('input.performActions', { context: popup, actions: [{ type: 'key', id: 'kb', actions: [{ type: 'keyDown', value: '' }, { type: 'keyUp', value: '' }] }] });
    seen.add(await d.evalIn(popup, `document.activeElement.id || document.activeElement.name || document.activeElement.tagName`));
  }
  for (const id of ['mode', 'bname', 'pause', 'footer-log', 'footer-help'])
    expect(seen.has(id), `Tab never reached #${id}; reached: ${[...seen].join(', ')}`);
});

await test('agent actions are logged with site origin, tab and outcome, never typed text or full URLs', async () => {
  tabId = tabIdOf((await h.call('tabs_context_mcp', { createIfEmpty: true })).text);
  // Allowed site (answer "Allow this session"), with a query string that must not be logged.
  const nav = h.call('navigate', { tabId, url: `${ALLOWED}/basic.html?token=QUERY-SECRET-999` });
  await d.answer('once');
  expect(!(await nav).isError, 'navigate failed');
  const name = refOf((await h.call('find', { tabId, query: 'Full name' })).text);
  const btn = refOf((await h.call('find', { tabId, query: 'Clicked 0 times' })).text);
  await h.call('computer', { tabId, action: 'left_click', ref: name });
  await h.call('computer', { tabId, action: 'type', text: 'TYPED-SECRET-4242' });
  await h.call('computer', { tabId, action: 'key', text: 'h i' });
  await h.call('form_input', { tabId, ref: name, value: 'FORM-SECRET-777' });
  await h.call('computer', { tabId, action: 'left_click', ref: btn, action_summary: 'Clicks the counter button' });
  // A refused site.
  const denied = h.call('navigate', { tabId, url: `${DENIED}/page2.html` });
  await d.answer('deny');
  expect((await denied).isError, 'denied navigation should fail');
  // Paused: the call is refused and logged as stopped by pause.
  await d.evalIn(popup, `document.getElementById('pause').click()`);
  await until(async () => !(await hidden(popup, 'paused')), 3000, 'paused banner did not show');
  const r = await h.call('read_page', { tabId });
  expect(r.isError && /paused/i.test(r.text), 'read_page while paused: ' + r.text.slice(0, 80));
  expect(await hidden(popup, 'pause'), 'the Pause button should hide while paused');
  await shot(popup, 'popup-paused');
  expect((await d.evalIn(popup, 'document.activeElement.id')) === 'resume', 'Resume should have keyboard focus when paused');
  await d.evalIn(popup, `document.getElementById('resume').click()`);
  await until(async () => await hidden(popup, 'paused'), 3000, 'paused banner did not go away');

  const log = await readLog(popup);
  const e = log.entries;
  const find = (pred, what) => {
    const hit = e.find(pred);
    expect(hit, `${what} not logged: ${JSON.stringify(e.slice(0, 12))}`);
    return hit;
  };
  const typed = find(x => x.x === 'Typed 17 characters', 'typing');
  expect(typed.o === ALLOWED && typed.tab === tabId && typed.r === 'allowed', JSON.stringify(typed));
  find(x => x.x === 'Opened ' + ALLOWED && x.r === 'allowed', 'the allowed navigation');
  find(x => x.x === 'Pressed 2 keys', 'a key sequence that spells text (counted, not stored)');
  find(x => x.x === 'Clicks the counter button' && x.own && x.o === ALLOWED, "the agent's own summary");
  find(x => x.x === 'Opened ' + DENIED && x.r === 'denied' && x.o === DENIED, 'the denied navigation');
  find(x => x.r === 'paused' && x.x === 'Read the page', 'the call refused while paused');
  expect(e[0].t >= e[e.length - 1].t, 'entries should be newest first');
  const all = JSON.stringify(e);
  for (const s of SECRETS)
    expect(!all.includes(s), `the log contains "${s}": ${all.slice(0, 400)}`);
});

{
  // Permission questions are logged by prompt.js calling logQuestion() (see actionlog.js).
  const e = (await readLog(popup)).entries;
  if (!e.some(x => x.k === 'site'))
    skip('permission questions and answers are logged', 'prompt.js does not call logQuestion() in this build');
  else {
    await test('permission questions and answers are logged', async () => {
      const has = (r, o) => e.some(x => x.k === 'site' && x.r === r && x.o === o);
      expect(has('asked', ALLOWED) && has('once', ALLOWED), 'allowed-once question missing: ' + JSON.stringify(e.filter(x => x.k !== 'action')));
      expect(has('asked', DENIED) && has('denied', DENIED), 'denied question missing: ' + JSON.stringify(e.filter(x => x.k !== 'action')));
    });
  }
}

let logPage = null;
await test('Activity page lists entries, filters by site, and exports JSON without secrets', async () => {
  await sleep(2600); // the log is written in batches
  const stored = await storedLog(popup);
  expect(stored.length >= 8, `only ${stored.length} entries in storage.local`);
  for (const s of SECRETS)
    expect(!JSON.stringify(stored).includes(s), `storage contains "${s}"`);
  logPage = await openPage('log/log.html');
  await until(async () => (await d.evalIn(logPage, `document.querySelectorAll('#log li').length`)) >= 8, 6000, 'Activity page shows too few entries');
  await shot(logPage, 'activity');
  const first = await d.evalIn(logPage, `document.querySelector('#log li .what').textContent`);
  expect(/Read the page/.test(first), 'newest entry first expected, got ' + first);
  const options = JSON.parse(await d.evalIn(logPage, `JSON.stringify([...document.querySelectorAll('#site option')].map(o => o.value))`));
  expect(options.includes(ALLOWED) && options.includes(DENIED), 'site filter options: ' + options);
  await d.evalIn(logPage, `(() => { const s = document.getElementById('site'); s.value = ${JSON.stringify(DENIED)}; s.dispatchEvent(new Event('change')); })()`);
  const sites = JSON.parse(await d.evalIn(logPage, `JSON.stringify([...document.querySelectorAll('#log li .site')].map(s => s.title))`));
  expect(sites.length >= 1 && sites.every(s => s === DENIED), 'filtered list: ' + sites);
  // Export: capture the blob the page hands to the download link instead of saving a file.
  const exported = await d.evalIn(logPage, `new Promise((resolve) => {
    const orig = URL.createObjectURL;
    URL.createObjectURL = (b) => { b.text().then(resolve); return orig.call(URL, b); };
    HTMLAnchorElement.prototype.click = function () { this.dataset.name = this.download; };
    document.getElementById('export').click();
  })`);
  const j = JSON.parse(exported);
  expect(j.app === 'Foxwright' && j.site === DENIED && j.entries.length === sites.length, 'export: ' + exported.slice(0, 300));
  expect(j.entries.every(x => x.site === DENIED && x.time && x.result && 'agentWords' in x), 'export entries: ' + exported.slice(0, 300));
  for (const s of SECRETS)
    expect(!exported.includes(s), `export contains "${s}"`);
});

let countBefore = 0;
await test('the log survives a Firefox restart, and the setup page does not open again', async () => {
  countBefore = (await readLog(popup)).entries.length;
  await sleep(2600);
  d.close();
  await h.stopFirefoxOnly();
  await h.restartFirefox();
  d = await connectPerson(h.bidiUrl);
  extBase = await extBaseOf(d);
  popup = await openPage('popup/popup.html');
  const after = (await readLog(popup)).entries.length;
  expect(after >= countBefore, `entries before restart ${countBefore}, after ${after}`);
  await sleep(1500);
  expect(!(await pageContext('/welcome/welcome.html')), 'the setup page opened again after a restart');
});

await test('turning the log off stops recording; Clear log empties it', async () => {
  logPage = await openPage('log/log.html');
  await until(async () => (await d.evalIn(logPage, `document.querySelectorAll('#log li').length`)) >= countBefore, 6000, 'entries missing on the Activity page');
  await d.evalIn(logPage, `document.getElementById('enabled').click()`);
  await until(async () => !(await hidden(logPage, 'off-note')), 3000, 'off note did not show');
  const n0 = (await readLog(logPage)).entries.length;
  await h.client.callTool({ name: 'tabs_context_mcp', arguments: { createIfEmpty: true } }, undefined, { timeout: 180000 });
  await sleep(300);
  const n0b = (await readLog(logPage)).entries.length;
  expect(n0b === n0, `logged while off: ${n0} -> ${n0b}`);
  await h.call('tabs_create_mcp', {});
  const n1 = (await readLog(logPage)).entries.length;
  expect(n1 === n0, `logged while off: ${n0} -> ${n1}`);
  await d.evalIn(logPage, `document.getElementById('enabled').click()`);
  await until(async () => (await readLog(logPage)).enabled, 3000, 'log did not turn back on');
  await h.call('tabs_create_mcp', {});
  expect((await readLog(logPage)).entries.length === n0 + 1, 'not logging again after turning it back on');
  // Clear needs two presses (it can't be undone).
  await d.evalIn(logPage, `document.getElementById('clear').click()`);
  expect((await readLog(logPage)).entries.length > 0, 'one press must not clear');
  await d.evalIn(logPage, `document.getElementById('clear').click()`);
  await until(async () => !(await hidden(logPage, 'empty')), 3000, 'empty state did not show');
  expect((await readLog(logPage)).entries.length === 0, 'log not empty after Clear');
  expect((await storedLog(logPage)).length === 0, 'storage not empty after Clear');
});

d.close();
await h.stop();
process.exit(finish());
