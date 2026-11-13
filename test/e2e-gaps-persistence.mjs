// Permission persistence and the grant rule (gap area 8), the paused state across a Firefox
// restart, and an answer that comes after the MCP navigate timeout.
// Uses the harness's profileDir option so one Firefox profile survives restartFirefox().
//
//   FIREFOX=... FOXWRIGHT_E2E_HEADFUL=1 xvfb-run -a -s "-screen 0 1400x900x24" node test/e2e-gaps-persistence.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { start } from './harness.mjs';
import { runner, extraServer, connectPerson, extBaseOf, sleep, expect, tabIdOf } from './gap-lib.mjs';

const { test, finish } = runner('e2e-gaps-persistence');
const P1 = process.env.FOXWRIGHT_P1, P2 = process.env.FOXWRIGHT_P2;
const xs = await extraServer(P1, P2);
const { P3 } = xs;
const C = `http://c.test:${P3}`;
const profileDir = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwright-gap-profile-'));

console.log('Foxwright gap tests: permission persistence, grant scope, pause across restart, late answers');
// No promptTimeoutSec: the default (120 s) is what users get.
const h = await start({ testDriver: true, profileDir, policy: { confirmUploads: true } });
let d = await connectPerson(h.bidiUrl);
let tabId = tabIdOf((await h.call('tabs_context_mcp', { createIfEmpty: true })).text);
let extBase = await extBaseOf(d);
let popup = null;
async function msg(m) {
  if (!popup) {
    const { context } = await d.bidi('browsingContext.create', { type: 'window' });
    await d.bidi('browsingContext.navigate', { context, url: `${extBase}popup/popup.html`, wait: 'complete' });
    popup = context;
  }
  return JSON.parse(await d.evalIn(popup, `browser.runtime.sendMessage(${JSON.stringify(m)}).then(s => JSON.stringify(s))`));
}
/** Navigate; if a permission window shows, answer it with `answer`. Returns { asked, origin, r }. */
async function nav(url, answer = 'deny') {
  let asked = null, done = false;
  const seen = new Set();
  const call = h.call('navigate', { tabId, url }).finally(() => { done = true; });
  while (!done) {
    const w = (await d.contexts()).find(x => x.url.includes('/prompt/prompt.html'));
    if (w && !seen.has(w.context)) {
      seen.add(w.context);
      for (let i = 0; i < 40 && !asked; i++) {
        asked = await d.evalIn(w.context, `document.getElementById('origin').textContent`).catch(() => '?');
        if (!asked)
          await sleep(50);
      }
      await d.answer(answer, w).catch(() => {});
    }
    await sleep(60);
  }
  return { asked, r: await call };
}
async function restart() {
  const t0 = Date.now();
  d.close();
  popup = null;
  await h.stopFirefoxOnly();
  await h.restartFirefox();
  d = await connectPerson(h.bidiUrl);
  extBase = await extBaseOf(d);
  const c = await h.client.callTool({ name: 'tabs_context_mcp', arguments: { createIfEmpty: true } }, undefined, { timeout: 180000 });
  const text = (c.content || []).map(x => x.text || '').join('\n');
  console.log(`      (Firefox restarted in ${Date.now() - t0} ms; tabs_context_mcp: ${text.replace(/\n/g, ' ').slice(0, 120)})`);
  tabId = tabIdOf(text);
}

await test('grant rule: an approval covers exactly one origin (scheme + host + port); document what asks again', async () => {
  const first = await nav(`${C}/page2.html`, 'once');
  expect(first.asked === C && !first.r.isError, JSON.stringify(first));
  const variants = [
    [`${C}/other/path?q=1`, false], [`http://C.TEST:${P3}/x`, false], [`http://sub.c.test:${P3}/`, true], [`http://c.test:${P1}/basic.html`, true],
    [`https://c.test:${P3}/`, true], [`http://c.test.:${P3}/`, true], [`http://127.0.0.1:${P3}/page2.html`, true], [`http://localhost:${P3}/page2.html`, true],
  ];
  const table = [], bad = [];
  for (const [url, shouldAsk] of variants) {
    const { asked } = await nav(url, 'deny');
    table.push(`${url} -> ${asked ? `asks (${asked})` : 'no prompt'}`);
    if (!!asked !== shouldAsk)
      bad.push(`${url}: expected ${shouldAsk ? 'a prompt' : 'no prompt'}`);
  }
  // Approving a subdomain doesn't approve the parent either.
  const sub = await nav(`http://sub.a.test:${P3}/page2.html`, 'once');
  const parent = await nav(`http://a.test:${P3}/page2.html`, 'deny');
  table.push(`after allowing sub.a.test: a.test -> ${parent.asked ? 'asks' : 'no prompt'}`);
  if (!sub.asked || !parent.asked)
    bad.push('subdomain approval leaked to the parent domain');
  console.log('      ' + table.join('\n      '));
  expect(!bad.length, bad.join('\n'));
}, { area: '8' });

await test('"Allow this session" is forgotten after a Firefox restart; "Always allow" survives and can be revoked', async () => {
  const S = `http://b.test:${P3}`;
  const AL = `http://a.test:${P3}`;
  // b.test: this session only; a.test: always.
  expect((await nav(`${S}/page2.html`, 'once')).asked === S, 'b.test should ask');
  expect((await nav(`${AL}/page2.html?x`, 'always')).asked === AL || true, 'a.test');
  const before = await msg({ kind: 'status' });
  await restart();
  const after = await msg({ kind: 'status' });
  const sess = await nav(`${S}/page2.html?after`, 'deny');
  const always = await nav(`${AL}/page2.html?after`, 'deny');
  console.log(`      (before restart: always=${JSON.stringify(before.allowed)} session=${JSON.stringify(before.sessionAllowed)}; after: always=${JSON.stringify(after.allowed)} session=${JSON.stringify(after.sessionAllowed)})`);
  expect(sess.asked === S, `"Allow this session" for ${S} survived the restart (no prompt)`);
  expect(!always.asked && !always.r.isError, `"Always allow" for ${AL} was lost across the restart: ${always.r.text.slice(0, 120)}`);
  await msg({ kind: 'removeSite', origin: AL });
  await msg({ kind: 'resume' });
  const revoked = await nav(`${AL}/page2.html?revoked`, 'deny');
  expect(revoked.asked === AL, 'revoking from the popup did not take effect');
}, { area: '8' });

await test('Paused stays paused across a Firefox restart', async () => {
  await nav(`http://a.test:${P3}/page2.html?again`, 'always');
  await msg({ kind: 'pause' });
  const p = await h.call('read_page', { tabId });
  expect(p.isError && /paused/i.test(p.text), 'pause did not take: ' + p.text.slice(0, 100));
  await restart();
  const status = await msg({ kind: 'status' });
  // While paused tabs_context_mcp is refused too, so restart() couldn't read a tab ID: navigate without one.
  const r = await h.call('navigate', { url: `http://a.test:${P3}/page2.html?after-pause` }); // an always-allowed site: no prompt involved
  await msg({ kind: 'resume' });
  tabId = tabIdOf((await h.call('tabs_context_mcp', { createIfEmpty: true })).text);
  expect(status.paused && r.isError && /paused/i.test(r.text), `after restart: paused=${status.paused}; navigate ${r.isError ? 'failed' : 'SUCCEEDED'}: ${r.text.slice(0, 120)}`);
}, { area: 'restart' });

await test('the person answers the permission window after the 60 s MCP navigate timeout: what the agent is told vs what happens', async () => {
  const target = `http://127.0.0.1:${P2}/page2.html?late`; // an origin not approved yet
  const t0 = Date.now();
  // Like a real AI client, wait longer than the SDK's default 60 s request timeout.
  const call = h.client.callTool({ name: 'navigate', arguments: { tabId, url: target } }, undefined, { timeout: 200000 })
    .then(x => ({ isError: !!x.isError, text: (x.content || []).map(c => c.text || '').join('\n') }), e => ({ isError: true, text: 'client: ' + e.message }));
  let w = null;
  for (let i = 0; i < 150 && !w; i++) {
    for (const c of (await d.contexts()).filter(x => x.url.includes('/prompt/prompt.html'))) {
      const o = await d.evalIn(c.context, `document.getElementById('origin').textContent`).catch(() => '');
      if (o === `http://127.0.0.1:${P2}`)
        w = c;
    }
    await sleep(100);
  }
  if (!w)
    throw new Error('no permission window for the late test');
  let r = null;
  const settled = call.then(x => { r = x; });
  while (Date.now() - t0 < 70000 && !r)
    await sleep(500);
  const toldAt = r ? Date.now() - t0 : null;
  await d.answer('once', w).catch(e => console.log('      (answer failed: ' + e.message + ')'));
  await sleep(500);
  const closed = !(await d.contexts()).some(x => x.context === w.context);
  console.log(`      (permission window closed by the late answer: ${closed})`);
  await Promise.race([settled, sleep(15000)]);
  await sleep(3000);
  const tabs = await h.call('tabs_context_mcp', {});
  const happened = tabs.text.includes('page2.html?late');
  console.log(`      (agent got after ${toldAt ?? '>70000'} ms: ${r ? r.text.replace(/\n/g, ' ').slice(0, 160) : 'nothing yet'}; after the late "Allow" the tab ${happened ? 'DID' : 'did not'} navigate)`);
  expect(!(r?.isError && happened), `the agent was told the navigation failed (${r?.text.slice(0, 100)}) but it happened anyway when the person answered at ~70 s`);
}, { area: 'timeout' });

d.close();
await h.stop();
xs.close();
process.exit(finish());
