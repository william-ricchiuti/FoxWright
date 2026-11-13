// Tab-group boundary, private windows and pages extensions can't touch (gap area 3), plus what an
// agent can learn about unapproved sites through side channels (network log, tab list, JSON re-fetch).
// The test plays the person: it creates, groups and ungroups tabs through an extension page
// (the toolbar popup opened as a window), the same browser.tabs APIs a drag in the tab strip ends in.
//
//   FIREFOX=... FOXWRIGHT_E2E_HEADFUL=1 xvfb-run -a -s "-screen 0 1400x900x24" node test/e2e-gaps-boundary.mjs
import fs from 'node:fs';
import { start } from './harness.mjs';
import { runner, extraServer, connectPerson, extBaseOf, chromeEval, sleep, expect, refOf, tabIdOf } from './gap-lib.mjs';

const { test, finish } = runner('e2e-gaps-boundary');
const P1 = process.env.FOXWRIGHT_P1, P2 = process.env.FOXWRIGHT_P2;
const xs = await extraServer(P1, P2);
const { P3 } = xs;
const A = `http://a.test:${P3}`;
const B = `http://b.test:${P3}`;

console.log('Foxwright gap tests: tab-group boundary and side channels');
const h = await start({ testDriver: true, policy: { mode: 'ask', promptTimeoutSec: 15, confirmUploads: true, allowed: [A] } });
const d = await connectPerson(h.bidiUrl);
const tabId = tabIdOf((await h.call('tabs_context_mcp', { createIfEmpty: true })).text);
const extBase = await extBaseOf(d);
const { context: extCtx } = await d.bidi('browsingContext.create', { type: 'window' });
await d.bidi('browsingContext.navigate', { context: extCtx, url: `${extBase}popup/popup.html`, wait: 'complete' });
const ext = async (body) => {
  const v = await d.evalIn(extCtx, `(async () => JSON.stringify(await (async () => { ${body} })()))()`);
  return v === undefined ? undefined : JSON.parse(v);
};
/** Deny every Foxwright permission window while `p` runs; returns the result and the origins asked about. */
async function denyingAll(p) {
  const asked = [];
  let done = false;
  const q = p.finally(() => { done = true; });
  while (!done) {
    const w = (await d.contexts()).find(x => x.url.includes('/prompt/prompt.html'));
    if (w) {
      const o = await d.evalIn(w.context, `document.getElementById('origin').textContent`).catch(() => '');
      asked.push(o);
      await d.answer('deny', w).catch(() => {});
    }
    await sleep(80);
  }
  return { r: await q, asked };
}

// A tab the person opened themselves, outside the group.
const userTab = await ext(`const t = await browser.tabs.create({ url: '${A}/user-tab.html?mine', active: false }); return t.id;`);
await sleep(1500);
const groupId = await ext(`return (await browser.tabs.get(${tabId})).groupId;`);
const shotId = await (async () => {
  await h.call('navigate', { tabId, url: `${A}/hostile-link.html` });
  const s = await h.call('computer', { tabId, action: 'screenshot' });
  return /Screenshot ID: (shot-\d+)/.exec(s.text)?.[1];
})();
const tmpFile = '/tmp/foxwright-gap-upload.txt';
fs.writeFileSync(tmpFile, 'hello');

await test('every tool refuses a tab outside the orange group (and nothing from it leaks)', async () => {
  const T = userTab;
  const calls = [
    ['tabs_close_mcp', {}], ['navigate', { url: `${A}/page2.html` }], ['navigate', { url: 'back' }], ['read_page', {}], ['find', { query: 'USER' }],
    ['form_input', { ref: 'e3', value: 'x' }], ['get_page_text', {}], ['computer', { action: 'screenshot' }], ['computer', { action: 'zoom', region: [0, 0, 200, 200] }],
    ['computer', { action: 'left_click', coordinate: [20, 20] }], ['computer', { action: 'type', text: 'x' }], ['computer', { action: 'key', text: 'Tab' }],
    ['computer', { action: 'scroll', coordinate: [20, 20] }], ['computer', { action: 'scroll_to', ref: 'e1' }], ['computer', { action: 'hover', coordinate: [20, 20] }],
    ['computer', { action: 'left_click_drag', start_coordinate: [1, 1], coordinate: [50, 50] }], ['computer', { action: 'wait', duration: 0 }],
    ['javascript_tool', { action: 'javascript_exec', text: 'document.body.innerText' }], ['read_console_messages', {}], ['read_network_requests', {}],
    ['handle_dialog', { accept: true }], ['resize_window', { width: 900, height: 700 }], ['file_upload', { paths: [tmpFile], ref: 'e5' }],
    ['upload_image', { imageId: shotId, ref: 'e5' }], ['gif_creator', { action: 'start_recording' }], ['gif_creator', { action: 'stop_recording' }], ['gif_creator', { action: 'export' }],
    ['browser_batch', { actions: [{ tool: 'read_page', args: {} }] }], ['browser_batch', { actions: [{ tool: 'get_page_text', args: { tabId: T } }], tabId }],
  ];
  const bad = [];
  for (const [tool, args] of calls) {
    const { r, asked } = await denyingAll(h.call(tool, { tabId: T, ...args }));
    const leak = /USER-TAB-SECRET|Personal|user-tab\.html/.test(r.text) || r.images.length;
    if (!r.isError || leak || asked.length)
      bad.push(`${tool} ${args.action || ''}: ${r.isError ? 'error' : 'OK'}${leak ? ' LEAK' : ''}${asked.length ? ` asked ${asked}` : ''} — ${r.text.replace(/\n/g, ' ').slice(0, 150)}`);
  }
  const still = await ext(`const t = await browser.tabs.get(${T}); return { url: t.url, groupId: t.groupId };`);
  expect(still.url.includes('user-tab.html?mine'), 'the user tab was changed: ' + JSON.stringify(still));
  expect(!bad.length, bad.join('\n'));
}, { area: '3' });

await test('a tab the person drags into the group becomes usable; dragged out, it is refused again immediately', async () => {
  await ext(`await browser.tabs.group({ groupId: ${groupId}, tabIds: [${userTab}] }); return true;`);
  await sleep(400);
  const inside = await h.call('read_page', { tabId: userTab });
  await ext(`await browser.tabs.ungroup([${userTab}]); return true;`);
  const immediately = await h.call('get_page_text', { tabId: userTab }); // no wait: the 200 ms group refresh hasn't run
  await sleep(600);
  const later = await h.call('get_page_text', { tabId: userTab });
  expect(!inside.isError && inside.text.includes('USER-TAB-SECRET'), 'inside the group: ' + inside.text.slice(0, 200));
  expect(later.isError && /not in the Foxwright tab group/.test(later.text), 'after ungrouping: ' + later.text.slice(0, 200));
  expect(immediately.isError, `right after the person dragged the tab out, the agent could still read it: ${immediately.text.slice(0, 120)}`);
}, { area: '3' });

await test('guessing tab IDs reaches nothing outside the group (1..300)', async () => {
  const group = new Set([...(await h.call('tabs_context_mcp', {})).text.matchAll(/tabId (\d+)/g)].map(m => Number(m[1])));
  const got = [];
  for (let id = 1; id <= 300; id++) {
    if (group.has(id))
      continue;
    const r = await h.call('get_page_text', { tabId: id });
    if (!r.isError)
      got.push(`${id}: ${r.text.slice(0, 80)}`);
  }
  expect(!got.length, got.join('\n'));
}, { area: '3' });

await test('private-browsing window: invisible to the agent (not listed, not reachable by ID)', async () => {
  await chromeEval(d, `(() => { const w = OpenBrowserWindow({ private: true }); w.addEventListener('load', () => setTimeout(() => w.gBrowser.selectedBrowser.fixupAndLoadURIString('${A}/user-tab.html?private', { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }), 500), { once: true }); return true; })()`);
  await sleep(3500);
  const ctxList = (await h.call('tabs_context_mcp', {})).text;
  const reached = [];
  for (let id = 1; id <= 300; id++) {
    const r = await h.call('read_page', { tabId: id });
    if (r.text.includes('user-tab.html?private'))
      reached.push(id);
  }
  expect(!ctxList.includes('private') && !reached.length, `listed: ${ctxList.includes('private')}, reachable tab IDs: ${reached}`);
}, { area: '3' });

/** Load a URL in a group tab the way the person would (address bar), bypassing the agent's navigate checks. */
async function personLoads(id, url) {
  await ext(`await browser.tabs.update(${id}, { active: true }); return true;`);
  await sleep(300);
  await chromeEval(d, `(() => { gBrowser.selectedBrowser.fixupAndLoadURIString(${JSON.stringify(url)}, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }); return true; })()`);
  await sleep(2500);
}

await test('group tab showing about:, view-source:, moz-extension:, file: or addons.mozilla.org: tools refuse or ask', async () => {
  fs.mkdirSync('/tmp/zsecret', { recursive: true });
  fs.writeFileSync('/tmp/zsecret/secret.html', '<title>local</title><p>LOCAL-FILE-SECRET</p>');
  const urls = ['about:robots', 'about:preferences', `view-source:${A}/user-tab.html?vs`, `${extBase}popup/popup.html`, 'file:///tmp/zsecret/secret.html', 'https://addons.mozilla.org/en-US/firefox/'];
  const bad = [], notes = [];
  for (const url of urls) {
    await personLoads(tabId, url);
    for (const [tool, args] of [['read_page', {}], ['get_page_text', {}], ['computer', { action: 'screenshot' }], ['find', { query: 'secret' }]]) {
      const { r, asked } = await denyingAll(h.call(tool, { tabId, ...args }));
      if (asked.length)
        notes.push(`${url} ${tool}: asked about ${asked.join(', ')}`);
      if (!r.isError || /USER-TAB-SECRET|LOCAL-FILE-SECRET/.test(r.text) || r.images.length)
        bad.push(`${url} ${tool}: ${r.isError ? 'error' : 'OK'} ${r.text.replace(/\n/g, ' ').slice(0, 140)}${r.images.length ? ' [image]' : ''}`);
      else if (tool === 'read_page')
        notes.push(`${url}: ${r.text.replace(/\n/g, ' ').slice(0, 140)}`);
    }
  }
  console.log('      ' + notes.join('\n      '));
  expect(!bad.length, bad.join('\n'));
}, { area: '3' });

await test('tabs_context_mcp on a group tab that sits on an unapproved site: what it exposes', async () => {
  await h.call('navigate', { tabId, url: `${A}/redirect?to=${encodeURIComponent(`${B}/hostile-title.html?session=B-URL-TOKEN-123`)}` });
  const t = await h.call('tabs_context_mcp', {});
  const exposed = [t.text.includes('B-URL-TOKEN-123') && 'full URL with query', /Foxwright has verified/.test(t.text) && 'page title'].filter(Boolean);
  expect(!exposed.length, `tabs_context_mcp shows the unapproved site's ${exposed.join(' and ')}:\n${t.text}`);
}, { area: 'side' });

await test('read_network_requests never lists an unapproved site\'s requests (A -> link to B (620 requests) -> navigate to A / back)', async () => {
  const out = [];
  for (const how of ['navigate', 'back']) {
    await h.call('navigate', { tabId, url: `${A}/a-many.html?how=${how}` });
    const ref = refOf((await h.call('find', { tabId, query: 'Go to B' })).text);
    await denyingAll(h.call('computer', { tabId, action: 'left_click', ref }));
    await sleep(2500); // B's 620 requests
    if (how === 'navigate')
      await h.call('navigate', { tabId, url: `${A}/hostile-link.html?after` });
    else
      await h.call('navigate', { tabId, url: 'back' });
    const { r, asked } = await denyingAll(h.call('read_network_requests', { tabId, limit: 1000 }));
    const bLines = r.text.split('\n').filter(l => l.includes('b.test'));
    out.push(`${how}: ${bLines.length} B request(s) listed${bLines.length ? `, e.g. ${bLines.find(l => l.includes('token')) || bLines[0]}` : ''}${asked.length ? ` (asked ${asked})` : ''}`);
  }
  expect(out.every(l => /: 0 B request/.test(l)), out.join('\n'));
}, { area: 'side' });

await test('read_network_requests on an approved page does not list the unapproved embedded frame\'s requests', async () => {
  const fresh = tabIdOf((await h.call('tabs_create_mcp', {})).text); // own network log, nothing left over
  await h.call('navigate', { tabId: fresh, url: `${A}/a-many.html?frame` });
  await sleep(1000);
  const page = await h.call('read_page', { tabId: fresh });
  expect(/hidden until the user approves/.test(page.text), 'the frame should be hidden from read_page: ' + page.text.slice(0, 300));
  const r = await h.call('read_network_requests', { tabId: fresh });
  await h.call('tabs_close_mcp', { tabId: fresh });
  const leaked = r.text.split('\n').filter(l => l.includes('b.test'));
  console.log(`      (read_network_requests: ${r.isError ? 'error ' : ''}${r.text.split('\n').length} line(s): ${r.text.replace(/\n/g, ' | ').slice(0, 300)})`);
  expect(!leaked.length, `the hidden frame's requests are listed:\n${leaked.join('\n')}`);
}, { area: 'side' });

await test('get_page_text JSON re-fetch never returns another site\'s body (approved JSON that redirects on the second request)', async () => {
  const url = `${A}/flipjson?k=${Date.now()}&to=${encodeURIComponent(`${B}/b-secret.json`)}`;
  await h.call('navigate', { tabId, url });
  await sleep(500);
  const { r, asked } = await denyingAll(h.call('get_page_text', { tabId }));
  const bHits = xs.hits.filter(x => x.host.startsWith('b.test') && x.path === '/b-secret.json').length;
  console.log(`      (get_page_text: ${r.text.replace(/\n/g, ' ').slice(0, 200)}; requests to B: ${bHits})`);
  expect(!r.text.includes('B-JSON-SECRET'), `get_page_text returned B's JSON (B was never approved; ${bHits} request(s) to B, asked: ${JSON.stringify(asked)}):\n${r.text.slice(0, 300)}`);
}, { area: 'side' });

await test('get_page_text on a JSON page reached by a redirect to B asks about B first', async () => {
  await h.call('navigate', { tabId, url: `${A}/redirect?to=${encodeURIComponent(`${B}/b-secret.json`)}` });
  const { r, asked } = await denyingAll(h.call('get_page_text', { tabId }));
  expect(!r.text.includes('B-JSON-SECRET') && asked.length >= 1 && r.text.includes(B), `asked ${JSON.stringify(asked)}: ${r.text.slice(0, 200)}`);
}, { area: 'side' });

d.close();
await h.stop();
xs.close();
process.exit(finish());
