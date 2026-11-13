// The in-page Stop pill and Alt+Shift+K pressed for real (gap area 2), and page dialogs when the
// person uses an agent tab (gap area 4). Headful under Xvfb: Alt+Shift+K is sent as a real X11 key
// with xdotool, the pill is clicked with a real WebDriver BiDi pointer action.
//
//   FIREFOX=... ZENKO_E2E_HEADFUL=1 xvfb-run -a -s "-screen 0 1400x900x24" node test/e2e-gaps-stop.mjs
import net from 'node:net';
import { start } from './harness.mjs';
import { runner, connectPerson, extBaseOf, x11, sleep, expect, refOf, tabIdOf } from './gap-lib.mjs';

const { test, skip, finish } = runner('e2e-gaps-stop');
const P1 = process.env.ZENKO_P1;
const O = `http://127.0.0.1:${P1}`;

console.log('Zenko gap tests: Stop pill, Alt+Shift+K, dialogs when the person uses the tab');
const h = await start({ testDriver: true, policy: { mode: 'all', confirmUploads: true } });
const d = await connectPerson(h.bidiUrl);
const tabId = tabIdOf((await h.call('tabs_context_mcp', { createIfEmpty: true })).text);
const extBase = await extBaseOf(d);
let popup = null;
async function popupCtx() {
  if (!popup) {
    const { context } = await d.bidi('browsingContext.create', { type: 'window' });
    await d.bidi('browsingContext.navigate', { context, url: `${extBase}popup/popup.html`, wait: 'complete' });
    popup = context;
  }
  return popup;
}
async function resume() {
  await d.evalIn(await popupCtx(), `browser.runtime.sendMessage({ kind: 'resume' }).then(() => true)`);
  await sleep(200);
}
async function isPaused() {
  return JSON.parse(await d.evalIn(await popupCtx(), `browser.runtime.sendMessage({ kind: 'status' }).then(s => JSON.stringify(s.paused))`));
}
async function ctxFor(needle) {
  for (let i = 0; i < 100; i++) {
    const c = (await d.contexts()).find(x => x.url.includes(needle));
    if (c)
      return c.context;
    await sleep(50);
  }
  throw new Error('no context for ' + needle);
}
async function personClick(context, x, y) {
  await d.bidi('input.performActions', { context, actions: [{ type: 'pointer', id: 'person', parameters: { pointerType: 'mouse' }, actions: [{ type: 'pointerMove', x: Math.round(x), y: Math.round(y), origin: 'viewport', duration: 0 }, { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }] }] });
}
/** Where Zenko's pill is, as the page sees it (elementFromPoint hits the closed shadow host). */
const PILL = `(() => { const host = document.querySelector('zenko-ui'); if (!host) return JSON.stringify(null); const cx = innerWidth / 2; const ys = []; for (let y = innerHeight - 1; y > innerHeight - 90; y--) if (document.elementFromPoint(cx, y) === host) ys.push(y); if (!ys.length) return JSON.stringify({ none: true }); const yc = Math.round((Math.min(...ys) + Math.max(...ys)) / 2); const xs = []; for (let x = 0; x < innerWidth; x++) if (document.elementFromPoint(x, yc) === host) xs.push(x); return JSON.stringify({ x0: Math.min(...xs), x1: Math.max(...xs), y0: Math.min(...ys), y1: Math.max(...ys), yc }); })()`;
async function pill(ctx) {
  return JSON.parse(await d.evalIn(ctx, PILL));
}
const centerOf = async (ctx, id) => JSON.parse(await d.evalIn(ctx, `(() => { const r = document.getElementById('${id}').getBoundingClientRect(); return JSON.stringify([r.left + r.width / 2, r.top + r.height / 2]); })()`));
/** Start a long type and wait until it is visibly in progress (some characters landed, far from done). */
async function typingUnderway(ctx, ch, n = 300) { // texts over 300 characters are inserted in one go (input.ts typeText)
  const typing = h.call('computer', { tabId, action: 'type', text: ch.repeat(n) });
  let len = 0;
  for (let i = 0; i < 400 && len < 5; i++) {
    len = await fieldLen(ctx);
    await sleep(10);
  }
  return { typing, len, n };
}
const fieldLen = async (ctx) => JSON.parse(await d.evalIn(ctx, `JSON.stringify(document.getElementById('field').value.length)`));

await test('pressing the in-page Stop pill (real click) pauses: every later call fails with "paused"', async () => {
  await h.call('navigate', { tabId, url: `${O}/hostile-pill.html?s1` });
  await h.call('read_page', { tabId });
  const ctx = await ctxFor('hostile-pill.html?s1');
  await sleep(300);
  const p = await pill(ctx);
  expect(p && !p.none, 'pill not found on the page: ' + JSON.stringify(p));
  await personClick(ctx, p.x1 - 22, p.yc);
  await sleep(400);
  const calls = [['read_page', {}], ['navigate', { url: `${O}/page2.html` }], ['computer', { action: 'screenshot' }], ['tabs_create_mcp', {}], ['find', { query: 'x' }]];
  const bad = [];
  for (const [tool, args] of calls) {
    const r = await h.call(tool, { tabId, ...args });
    if (!(r.isError && /paused/i.test(r.text)))
      bad.push(`${tool}: ${r.text.slice(0, 120)}`);
  }
  await resume();
  expect(!bad.length, 'calls after Stop that did not fail with "paused":\n' + bad.join('\n'));
}, { area: '2' });

await test('pressing the Stop pill while a long type is running stops the typing', async () => {
  await h.call('navigate', { tabId, url: `${O}/hostile-pill.html?s2` });
  const ctx = await ctxFor('hostile-pill.html?s2');
  const ref = refOf((await h.call('find', { tabId, query: 'Field' })).text);
  await h.call('computer', { tabId, action: 'left_click', ref });
  const p = await pill(ctx);
  const { typing, len: atClick, n: total } = await typingUnderway(ctx, 'x');
  expect(p && !p.none, 'pill not found: ' + JSON.stringify(p));
  await personClick(ctx, p.x1 - 22, p.yc);
  const r = await typing;
  await sleep(300);
  const n = await fieldLen(ctx);
  await resume();
  console.log(`      (Stop clicked when ${atClick} of ${total} characters were in; final ${n})`);
  expect(r.isError && /paused|stopped/i.test(r.text), 'type result: ' + r.text.slice(0, 200));
  expect(n > 0 && n < total, `expected a partial value, got ${n} characters`);
}, { area: '2' });

await test('after the pill fades, it no longer catches clicks meant for the page (button under it)', async () => {
  await h.call('navigate', { tabId, url: `${O}/hostile-pill.html?s3` });
  const ctx = await ctxFor('hostile-pill.html?s3');
  await h.call('read_page', { tabId });
  await sleep(300);
  const p = await pill(ctx);
  expect(p && !p.none, 'pill not found: ' + JSON.stringify(p));
  await sleep(7500); // hidden after 6 s of no agent activity
  const hit = await d.evalIn(ctx, `(() => { const e = document.elementFromPoint(${p.x1 - 22}, ${p.yc}); return e ? e.tagName.toLowerCase() + (e.id ? '#' + e.id : '') : 'none'; })()`);
  await personClick(ctx, p.x1 - 22, p.yc);
  await sleep(500);
  const status = await d.evalIn(ctx, `document.getElementById('status').textContent`);
  const paused = await isPaused();
  const after = await h.call('read_page', { tabId });
  await resume();
  expect(!paused && !after.isError && /bottom bar: 1/.test(status), `a click on the page's own bottom bar ${paused ? 'PAUSED ZENKO' : 'did not pause'}; the page's button ${/: 1/.test(status) ? 'got' : 'did NOT get'} the click (${status}); elementFromPoint there = ${hit} (invisible pill still on top); next call: ${after.text.slice(0, 80)}`);
}, { area: '2' });

if (!x11.available()) {
  skip('Alt+Shift+K pauses', 'needs headful Firefox under X11 with xdotool', { area: '2' });
} else {
  await test('Alt+Shift+K (real X11 key press) pauses, and interrupts a long type', async () => {
    await h.call('navigate', { tabId, url: `${O}/hostile-pill.html?k1` });
    const ctx = await ctxFor('hostile-pill.html?k1');
    const ref = refOf((await h.call('find', { tabId, query: 'Field' })).text);
    await h.call('computer', { tabId, action: 'left_click', ref });
    const { typing, len: atKey, n: total } = await typingUnderway(ctx, 'y');
    x11.key('alt+shift+k');
    const r = await typing;
    await sleep(300);
    const n = await fieldLen(ctx);
    const later = await h.call('read_page', { tabId });
    await resume();
    expect(r.isError && /paused|stopped/i.test(r.text), 'type result: ' + r.text.slice(0, 200));
    console.log(`      (Alt+Shift+K pressed when ${atKey} of ${total} characters were in; final ${n})`);
    expect(n > 0 && n < total, `expected a partial value, got ${n}`);
    expect(later.isError && /paused/i.test(later.text), 'later call: ' + later.text.slice(0, 100));
  }, { area: '2' });

  await test('a page that hides the pill and shows a fake one: the fake Stop does nothing, Alt+Shift+K still works', async () => {
    await h.call('navigate', { tabId, url: `${O}/hostile-pill.html?hide&fake&remove` });
    const ctx = await ctxFor('hostile-pill.html?hide');
    await h.call('read_page', { tabId });
    await sleep(300);
    const p = await pill(ctx);
    const fake = JSON.parse(await d.evalIn(ctx, `(() => { const r = document.getElementById('fakestop').getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2 }); })()`));
    await personClick(ctx, fake.x, fake.y);
    await sleep(400);
    const pausedByFake = await isPaused();
    x11.key('alt+shift+k');
    await sleep(600);
    const pausedByKey = await isPaused();
    await resume();
    console.log(`      (real pill visible to the person: ${!!(p && !p.none)}; fake Stop paused Zenko: ${pausedByFake}; documented: a page can hide/imitate the pill)`);
    expect(pausedByKey, 'Alt+Shift+K did not pause Zenko on a page that hides the pill');
  }, { area: '2' });
}

await test('a command already queued behind a running one does not run after Pause (second agent on the same tab)', async () => {
  await h.call('navigate', { tabId, url: `${O}/hostile-pill.html?q1` });
  const ctx = await ctxFor('hostile-pill.html?q1');
  const ref = refOf((await h.call('find', { tabId, query: 'Field' })).text);
  await h.call('computer', { tabId, action: 'left_click', ref });
  const { typing } = await typingUnderway(ctx, 'w');
  // A second AI client (its own MCP server, so its own queue) sends a command for the same tab now:
  // it passes the extension's paused check and waits in the per-tab queue behind the typing.
  const sock = net.connect(h.sock);
  let reply = '';
  sock.on('data', (x) => { reply += x; });
  await new Promise(r => sock.once('connect', r));
  sock.write(JSON.stringify({ type: 'request', id: 1, tool: 'form_input', args: { tabId, ref, value: 'QUEUED-AFTER-STOP' } }) + '\n');
  await sleep(100);
  await d.evalIn(await popupCtx(), `browser.runtime.sendMessage({ kind: 'pause' }).then(() => true)`);
  const r = await typing;
  for (let i = 0; i < 50 && !reply.includes('"response"'); i++)
    await sleep(100);
  sock.destroy();
  const value = await d.evalIn(ctx, `document.getElementById('field').value`);
  await resume();
  console.log(`      (typing: ${r.text.slice(0, 60)}; queued call answered: ${reply.trim().slice(0, 160)})`);
  expect(!value.includes('QUEUED-AFTER-STOP'), `the queued form_input ran after the person pressed Pause (field now ${JSON.stringify(value.slice(0, 40))}); its caller was told: ${reply.trim().slice(0, 160)}`);
}, { area: '2' });

// ---------- dialogs when the person uses the tab ----------
const promptEvents = () => d.events.filter(e => e.method === 'browsingContext.userPromptOpened');
async function handleAll(ctx) {
  for (let i = 0; i < 20; i++) {
    try {
      await d.bidi('browsingContext.handleUserPrompt', { context: ctx, accept: true });
    } catch {
      return;
    }
    await sleep(50);
  }
}

await test('a person clicks a confirm() button after the agent has been idle: the real dialog appears', async () => {
  await h.call('navigate', { tabId, url: `${O}/hostile-dialogs.html?d1` });
  const ctx = await ctxFor('hostile-dialogs.html?d1');
  await h.call('read_page', { tabId });
  await sleep(10000); // README: "while the agent is working in a tab (and for a few seconds after)"
  const n0 = promptEvents().length;
  const [cx, cy] = await centerOf(ctx, 'confirm');
  personClick(ctx, cx, cy).catch(() => {});
  let shown = false;
  for (let i = 0; i < 40 && !shown; i++) {
    shown = promptEvents().length > n0;
    await sleep(100);
  }
  if (shown)
    await handleAll(ctx);
  await sleep(300);
  const out = await d.evalIn(ctx, `document.getElementById('out').textContent`);
  expect(shown && /confirm returned true/.test(out), `real dialog shown: ${shown}; page says: ${out}`);
}, { area: '4' });

await test('documented: a confirm() the person triggers within a few seconds of an agent action is auto-cancelled', async () => {
  await h.call('navigate', { tabId, url: `${O}/hostile-dialogs.html?d2` });
  const ctx = await ctxFor('hostile-dialogs.html?d2');
  await h.call('read_page', { tabId });
  const n0 = promptEvents().length;
  const [cx, cy] = await centerOf(ctx, 'confirm');
  await personClick(ctx, cx, cy).catch(() => {});
  await sleep(800);
  const shown = promptEvents().length > n0;
  if (shown)
    await handleAll(ctx);
  const out = await d.evalIn(ctx, `document.getElementById('out').textContent`);
  console.log(`      (person's click 0.5 s after the agent acted: real dialog shown=${shown}, page: ${out})`);
  expect(!shown && /false/.test(out), 'unexpected: ' + out);
}, { area: '4' });

await test('the agent acts while a real alert (opened when the agent was idle) is on screen: clean, prompt answer', async () => {
  await h.call('navigate', { tabId, url: `${O}/hostile-dialogs.html?d3` });
  const ctx = await ctxFor('hostile-dialogs.html?d3');
  await d.evalIn(ctx, `document.getElementById('later').dataset.ms = '9000'`);
  const ref = refOf((await h.call('find', { tabId, query: 'Schedule late alerts' })).text);
  await h.call('computer', { tabId, action: 'left_click', ref });
  await sleep(10500);
  const open = promptEvents().some(e => e.at > Date.now() - 3000);
  const t0 = Date.now();
  const r = await h.call('read_page', { tabId });
  const ms = Date.now() - t0;
  await handleAll(ctx);
  console.log(`      (real alert open: ${open}; read_page took ${ms} ms: ${r.isError ? 'error: ' : ''}${r.text.slice(0, 100)})`);
  expect(ms < 10000, `read_page hung ${ms} ms behind a real alert: ${r.text.slice(0, 200)}`);
}, { area: '4' });

await test('beforeunload set up by a page the person clicked: navigate returns within its timeout and says what happened', async () => {
  await h.call('navigate', { tabId, url: `${O}/hostile-dialogs.html?d4` });
  const ctx = await ctxFor('hostile-dialogs.html?d4');
  await sleep(9000);
  const r0 = JSON.parse(await d.evalIn(ctx, `(() => { const r = document.getElementById('bu').getBoundingClientRect(); return JSON.stringify({ x: r.left + 10, y: r.top + 5 }); })()`));
  await personClick(ctx, r0.x, r0.y);
  await sleep(300);
  const n0 = promptEvents().length;
  const t0 = Date.now();
  const r = await h.call('navigate', { tabId, url: `${O}/page2.html?after-bu` });
  const ms = Date.now() - t0;
  const shown = promptEvents().length > n0;
  await handleAll(ctx);
  console.log(`      (beforeunload dialog shown: ${shown}; navigate took ${ms} ms: ${r.text.slice(0, 160)})`);
  expect(ms < 35000 && (!shown || !/^Navigated tab \d+ to .*hostile-dialogs\.html\?d4/.test(r.text)), `a "Leave page?" dialog was ${shown ? 'left open' : 'not shown'}, yet navigate (${ms} ms) reported success on the page it never left: ${r.text.slice(0, 200)}`);
}, { area: '4' });

await test('alert/confirm flood while the agent works: answered automatically, the call returns quickly, page text is quoted', async () => {
  await h.call('navigate', { tabId, url: `${O}/hostile-dialogs.html?d5` });
  for (const q of ['Alert flood', 'Confirm flood']) {
    const ref = refOf((await h.call('find', { tabId, query: q })).text);
    const t0 = Date.now();
    const r = await h.call('computer', { tabId, action: 'left_click', ref });
    const ms = Date.now() - t0;
    const notes = (r.text.match(/The page opened a JavaScript/g) || []).length;
    expect(!r.isError && ms < 8000 && notes <= 20, `${q}: ${ms} ms, ${notes} notes, ${r.text.slice(0, 200)}`);
    if (q === 'Confirm flood')
      expect(/confirm\("Zenko answered: OK/.test(r.text) && /Zenko answered: Cancel/.test(r.text), 'page text should stay inside quotes: ' + r.text.slice(0, 300));
  }
}, { area: '4' });

d.close();
await h.stop();
process.exit(finish());
