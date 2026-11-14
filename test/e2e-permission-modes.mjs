// Permission modes, exercised the way a person would use them: read-only and 1-hour approvals,
// upgrading a read-only site, confirming consequential actions, private windows, container tabs,
// the JSON re-fetch, and a host permission revoked in Firefox's add-on settings. The test opens its
// own WebDriver BiDi session to press buttons in Foxwright's windows and toolbar popup. A second
// phase checks the same rules for trusted (WebDriver BiDi) input, where nobody answers the windows.
//
//   FIREFOX=... node test/e2e-permission-modes.mjs
//   (hosts a.test, sub.a.test, b.test and c.test must resolve to 127.0.0.1, as for the gap suites)
import fs from 'node:fs';
import { start } from './harness.mjs';
import { connectDriver } from './bidi-driver.mjs';
import { runner, extraServer, extBaseOf, chromeEval, sleep, expect, refOf, tabIdOf } from './gap-lib.mjs';

const { test, finish } = runner('e2e-permission-modes');
const P1 = process.env.FOXWRIGHT_P1, P2 = process.env.FOXWRIGHT_P2;
const xs = await extraServer(P1, P2);
const { P3 } = xs;
const A = `http://a.test:${P3}`; // read-only, this session; upgrade denied
const B = `http://b.test:${P3}`; // read-only, always; upgrade allowed
const C = `http://c.test:${P3}`; // allowed for 1 hour
const S = `http://sub.a.test:${P3}`; // full access: consequential-action confirmations
const LRO = `http://localhost:${P1}`; // read-only by policy (allowedReadOnly)
const IDS = ['kitsune@william-ricchiuti.com', 'kitsune-full@william-ricchiuti.com'];

console.log('Foxwright permission modes e2e');
const h = await start({
  testDriver: true,
  policy: { mode: 'ask', promptTimeoutSec: 20, confirmUploads: true, allowedReadOnly: [LRO] },
  // Let Foxwright into private windows, so the test can check it still never uses them.
  extraPolicies: { ExtensionSettings: Object.fromEntries(IDS.map(id => [id, { private_browsing: true }])) },
});
let d = await connectDriver(h.bidiUrl);
let tabId = tabIdOf((await h.call('tabs_context_mcp', { createIfEmpty: true })).text);
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
/** Run code in the toolbar popup (an extension page with the browser.* APIs). */
async function ext(body) {
  const v = await d.evalIn(await popupCtx(), `(async () => JSON.stringify(await (async () => { ${body} })()))()`);
  return v === undefined ? undefined : JSON.parse(v);
}
const status = () => ext(`return browser.runtime.sendMessage({ kind: 'status' });`);
const promptOpen = async () => (await d.contexts()).some(x => x.url.includes('/prompt/prompt.html'));

/** Start a call, wait for its window, read it, answer it; returns { info, r }. */
async function withWindow(p, button, opts) {
  const w = await d.promptWindow(15000);
  const info = await d.readWindow(w);
  await d.answer(button, w, opts);
  return { info, r: await p };
}
/** A call that must not open any window (if one appears, it is denied and the test fails). */
async function noWindow(p) {
  let opened = false, done = false;
  const watch = (async () => {
    while (!done) {
      const w = (await d.contexts()).find(x => x.url.includes('/prompt/prompt.html'));
      if (w) {
        opened = true;
        await d.answer('deny', w).catch(() => {});
      }
      await sleep(80);
    }
  })();
  const r = await p.finally(() => { done = true; });
  await watch;
  expect(!opened, `a permission window opened unexpectedly (result: ${r.text.slice(0, 200)})`);
  return r;
}
const page = async () => (await h.call('read_page', { tabId, max_chars: 100000 })).text;
const refFor = async (query) => {
  const f = await h.call('find', { tabId, query });
  const ref = refOf(f.text);
  expect(ref, `no ref for "${query}": ${f.text.slice(0, 300)}`);
  return ref;
};
const logOf = (text) => ((/Log:([^"\n]*)/.exec(text) || [])[1] || '').trim();

await test('the site window offers "Read only" (unticked by default) and "Allow for 1 hour"', async () => {
  const { info, r } = await withWindow(h.call('navigate', { tabId, url: `${A}/consequence.html` }), 'once', { readOnly: true });
  expect(info.origin === A, JSON.stringify(info));
  expect(info.readOnlyShown && !info.readOnlyChecked, 'Read only should be offered and unticked: ' + JSON.stringify(info));
  expect(info.hourShown && info.alwaysShown, 'Allow for 1 hour and Always allow should both be offered: ' + JSON.stringify(info.buttons));
  expect(JSON.stringify(info.buttons) === JSON.stringify(['Deny', 'Always allow', 'Allow for 1 hour', 'Allow this session']), JSON.stringify(info.buttons));
  expect(!r.isError, r.text);
});

await test('read-only site: reading works (read_page, find, get_page_text, screenshot, scroll, PageDown, hover, console, network)', async () => {
  const calls = [
    ['read_page', { tabId }], ['find', { tabId, query: 'Send message' }], ['get_page_text', { tabId }],
    ['computer', { tabId, action: 'screenshot' }], ['computer', { tabId, action: 'scroll', coordinate: [300, 300], scroll_direction: 'down' }],
    ['computer', { tabId, action: 'key', text: 'PageDown' }], ['computer', { tabId, action: 'key', text: 'Home' }],
    ['computer', { tabId, action: 'hover', ref: await refFor('Show details') }],
    ['read_console_messages', { tabId }], ['read_network_requests', { tabId }], ['handle_dialog', { tabId, accept: false }],
  ];
  const bad = [];
  for (const [tool, args] of calls) {
    const r = await noWindow(h.call(tool, args));
    if (r.isError)
      bad.push(`${tool} ${args.action || ''}: ${r.text.slice(0, 160)}`);
  }
  expect(!bad.length, bad.join('\n'));
  const p = await page();
  expect(/Clicks: 0/.test(p) && !logOf(p).trim(), 'reading must not have clicked anything:\n' + p.slice(-400));
});

await test('read-only site: acting asks once to upgrade; Deny leaves the page untouched, later actions fail at once', async () => {
  const ref = await refFor('Show details');
  const { info, r } = await withWindow(h.call('computer', { tabId, action: 'left_click', ref }), 'deny');
  expect(info.origin === A && /click and type/i.test(info.title) && !info.readOnlyShown, 'upgrade window: ' + JSON.stringify(info));
  expect(r.isError && /reading only/.test(r.text) && /declined/.test(r.text), r.text);
  const q = await refFor('Search');
  const later = [
    ['computer', { tabId, action: 'left_click', ref }], ['computer', { tabId, action: 'type', text: 'x' }],
    ['computer', { tabId, action: 'key', text: 'Enter' }], ['computer', { tabId, action: 'key', text: 'Tab' }],
    ['form_input', { tabId, ref: q, value: 'x' }], ['handle_dialog', { tabId, accept: true }],
    ['javascript_tool', { tabId, action: 'javascript_exec', text: 'document.title' }],
  ];
  const bad = [];
  for (const [tool, args] of later) {
    const t0 = Date.now();
    const x = await noWindow(h.call(tool, args));
    if (!x.isError || !/reading only/.test(x.text) || Date.now() - t0 > 5000)
      bad.push(`${tool} ${args.action || ''}: ${x.isError ? '' : 'SUCCEEDED '}${x.text.slice(0, 160)}`);
  }
  expect(!bad.length, bad.join('\n'));
  const p = await page();
  expect(/Clicks: 0/.test(p) && !logOf(p).trim(), 'the read-only page was changed:\n' + p.slice(-400));
});

await test('read-only "Always allow": accepting the upgrade lets the click through; the popup tags the site "read only"', async () => {
  const nav = await withWindow(h.call('navigate', { tabId, url: `${B}/consequence.html` }), 'always', { readOnly: true });
  expect(!nav.r.isError, nav.r.text);
  let s = await status();
  expect(s.allowed.includes(B) && s.readOnly.includes(B), JSON.stringify(s));
  // The popup's site list shows the tag.
  let row = '';
  for (let i = 0; i < 40 && !/read only/.test(row); i++) {
    row = await d.evalIn(await popupCtx(), `[...document.querySelectorAll('#sites li')].map(li => li.textContent).find(t => t.includes('b.test')) || ''`);
    await sleep(100);
  }
  expect(/always · read only/.test(row), 'popup row: ' + row);
  const { info, r } = await withWindow(h.call('computer', { tabId, action: 'left_click', ref: await refFor('Show details') }), 'once');
  expect(/click and type/i.test(info.title), JSON.stringify(info));
  expect(!r.isError, r.text);
  expect(/DETAILS/.test(logOf(await page())), 'the click did not happen');
  s = await status();
  expect(s.sessionAllowed.includes(B) && !s.sessionReadOnly.includes(B), 'the upgrade should be a full-access session approval: ' + JSON.stringify(s));
  const again = await noWindow(h.call('computer', { tabId, action: 'left_click', ref: await refFor('Show details') }));
  expect(!again.isError, again.text);
});

await test('policy "allowedReadOnly": readable without a window, acting asks to upgrade', async () => {
  const nav = await noWindow(h.call('navigate', { tabId, url: `${LRO}/basic.html` }));
  expect(!nav.isError, nav.text);
  expect(!(await noWindow(h.call('read_page', { tabId }))).isError, 'read_page failed');
  const { info, r } = await withWindow(h.call('computer', { tabId, action: 'left_click', ref: await refFor('Clicked 0 times') }), 'deny');
  expect(info.origin === LRO && /click and type/i.test(info.title), JSON.stringify(info));
  expect(r.isError && /reading only/.test(r.text), r.text);
  const s = await status();
  expect(s.managedReadOnly.includes(LRO), JSON.stringify(s.managedReadOnly));
});

await test('embedded frame approved read-only: shown to the agent, but clicking in it asks and Deny refuses', async () => {
  const FR = `http://127.0.0.1:${P1}`;
  const nav = await withWindow(h.call('navigate', { tabId, url: `http://localhost:${P2}/embed.html` }), 'once');
  expect(!nav.r.isError, nav.r.text);
  const top = await page();
  const fref = (/ref=([^\]]+)\][^\n]*\n[^\n]*hidden until the user approves/.exec(top) || /- iframe[^\n]*\[ref=([^\]]+)\]/.exec(top) || [])[1];
  expect(fref, 'no iframe ref: ' + top);
  const { info, r } = await withWindow(h.call('read_page', { tabId, ref_id: fref }), 'once', { readOnly: true });
  expect(info.origin === FR && info.readOnlyShown, 'frame window: ' + JSON.stringify(info));
  expect(!r.isError && /Frame button/.test(r.text), r.text);
  const bref = refOf((await h.call('find', { tabId, query: 'Frame button' })).text, /\[ref=(f\d+e\d+)\]/);
  expect(bref, 'no frame ref');
  const up = await withWindow(h.call('computer', { tabId, action: 'left_click', ref: bref }), 'deny');
  expect(up.info.origin === FR && /click and type/i.test(up.info.title), JSON.stringify(up.info));
  expect(up.r.isError && /reading only/.test(up.r.text), up.r.text);
  const after = await h.call('read_page', { tabId, ref_id: fref });
  expect(!/frame button clicked/.test(after.text), 'the frame was clicked anyway');
});

await test('confirm before consequential actions: off by default; once ticked in the popup, Send/submit/Enter ask and Deny blocks', async () => {
  expect((await status()).confirmActions === false, 'should be off by default');
  const nav = await withWindow(h.call('navigate', { tabId, url: `${S}/consequence.html` }), 'once');
  expect(!nav.r.isError, nav.r.text);
  // Off: a Send button is pressed without asking.
  expect(!(await noWindow(h.call('computer', { tabId, action: 'left_click', ref: await refFor('Send message') }))).isError, 'send (off)');
  await d.evalIn(await popupCtx(), `document.getElementById('confirm-actions').click()`);
  for (let i = 0; i < 20 && !(await status()).confirmActions; i++)
    await sleep(100);
  expect((await status()).confirmActions === true, 'the popup checkbox did not turn it on');
  // A plain button: no question.
  const plain = await noWindow(h.call('computer', { tabId, action: 'left_click', ref: await refFor('Show details') }));
  expect(!plain.isError, plain.text);
  // Send: the window shows the element (labelled as the website's) and the agent's summary.
  const sendRef = await refFor('Send message');
  const den = await withWindow(h.call('computer', { tabId, action: 'left_click', ref: sendRef, action_summary: 'Sends the draft to pat@example.com' }), 'deny');
  expect(den.info.origin === S && /Send message/.test(den.info.element) && /by the website/.test(den.info.element), JSON.stringify(den.info));
  expect(/Sends the draft to pat@example.com/.test(den.info.summary) && /agent/.test(den.info.summary), 'summary: ' + den.info.summary);
  expect(!den.info.alwaysShown && !den.info.hourShown && !den.info.readOnlyShown && den.info.once === 'Allow once', JSON.stringify(den.info.buttons));
  expect(den.r.isError && /did not allow this action/.test(den.r.text), den.r.text);
  let log = logOf(await page());
  expect((log.match(/SENT/g) || []).length === 1, 'denied Send went through: ' + log);
  const ok = await withWindow(h.call('computer', { tabId, action: 'left_click', ref: sendRef }), 'once');
  expect(!ok.r.isError, ok.r.text);
  log = logOf(await page());
  expect((log.match(/SENT/g) || []).length === 2, 'allowed Send did not go through: ' + log);
  // A page-chosen label with direction and zero-width characters is shown cleaned up.
  const tricky = await withWindow(h.call('computer', { tabId, action: 'left_click', ref: await refFor('Delete') }), 'deny');
  expect(/Delete everything now/.test(tricky.info.element) && !/[\u200b-\u200f\u2028-\u202e]/.test(tricky.info.element), 'label: ' + JSON.stringify(tricky.info.element));
  // Enter in a form field submits the form: asks.
  await h.call('computer', { tabId, action: 'left_click', ref: await refFor('Search') });
  await h.call('computer', { tabId, action: 'type', text: 'cats' });
  const enter = await withWindow(h.call('computer', { tabId, action: 'key', text: 'Enter' }), 'deny');
  expect(/submits its form/.test(enter.info.reason), JSON.stringify(enter.info));
  expect(enter.r.isError, enter.r.text);
  const typed = await withWindow(h.call('computer', { tabId, action: 'type', text: 'dogs\n' }), 'deny');
  expect(typed.r.isError && /submits its form/.test(typed.info.reason), typed.r.text);
  expect(!/SUBMITTED/.test(logOf(await page())), 'the form was submitted after Deny');
  // The submit button itself: asks; Allow once submits.
  const sub = await withWindow(h.call('computer', { tabId, action: 'left_click', ref: refOf((await h.call('find', { tabId, query: 'button Search' })).text, /button "Search"[^\n]*\[ref=([^\]]+)\]/) || await refFor('Search') }), 'once');
  expect(/submits a form/.test(sub.info.reason), JSON.stringify(sub.info));
  expect(/SUBMITTED/.test(logOf(await page())), 'Allow once did not submit');
  // A newline in a textarea that isn't a form field: no question.
  await h.call('computer', { tabId, action: 'left_click', ref: await refFor('Chat') });
  expect(!(await noWindow(h.call('computer', { tabId, action: 'type', text: 'a\nb' }))).isError, 'textarea typing');
  // Off again: no questions.
  await d.evalIn(await popupCtx(), `document.getElementById('confirm-actions').click()`);
  await sleep(300);
  expect(!(await noWindow(h.call('computer', { tabId, action: 'left_click', ref: sendRef }))).isError, 'send after turning it off');
});

await test('JSON re-fetch (get_page_text) never follows a redirect', async () => {
  // Firefox resolves *.test only for page loads in this setup, not for the extension's own fetch: use 127.0.0.1.
  const R = `http://127.0.0.1:${P3}`;
  const url = `${R}/flipjson?k=${Date.now()}&to=${encodeURIComponent(`${B}/b-secret.json`)}`;
  const nav = await withWindow(h.call('navigate', { tabId, url }), 'once');
  expect(nav.info.origin === R, JSON.stringify(nav.info)); // navigate itself reports the JSON viewer
  const before = xs.hits.filter(x => x.path === '/b-secret.json').length;
  const r = await noWindow(h.call('get_page_text', { tabId }));
  const after = xs.hits.filter(x => x.path === '/b-secret.json').length;
  expect(r.isError && /redirect/i.test(r.text) && !/B-JSON-SECRET/.test(r.text), r.text.slice(0, 400));
  expect(after === before, `the re-fetch requested the redirect target (${after - before} request(s))`);
  // Without a redirect the re-fetch still works.
  await noWindow(h.call('navigate', { tabId, url: `${R}/data.json` }));
  const ok = await noWindow(h.call('get_page_text', { tabId }));
  expect(!ok.isError && /fetched the URL again/.test(ok.text), ok.text.slice(0, 300));
});

await test('container tab: the JSON re-fetch is refused (it would use the default cookie jar)', async () => {
  await chromeEval(d, `(() => { const t = gBrowser.addTab(${JSON.stringify(`${S}/data.json?container`)}, { userContextId: 1, triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }); return t.userContextId; })()`);
  await sleep(1500);
  const info = await ext(`const t = (await browser.tabs.query({})).find(x => (x.url || '').includes('data.json?container')); await browser.tabs.group({ groupId: (await browser.tabs.get(${tabId})).groupId, tabIds: [t.id] }); return { id: t.id, store: t.cookieStoreId };`);
  console.log(`      (container tab ${info.id}: cookieStoreId ${info.store})`);
  const before = xs.hits.filter(x => x.query === '?container').length;
  const r = await noWindow(h.call('get_page_text', { tabId: info.id }));
  const after = xs.hits.filter(x => x.query === '?container').length;
  expect(r.isError && /container/.test(r.text), r.text.slice(0, 300));
  expect(after === before, 'the re-fetch was made anyway');
  await h.call('tabs_close_mcp', { tabId: info.id });
});

await test('private windows: a private tab is never listed or usable, even in a "Foxwright" group; new agent tabs open in a normal window', async () => {
  const allowed = await ext(`return browser.extension.isAllowedIncognitoAccess();`);
  expect(allowed, 'Foxwright is not allowed in private windows here (the ExtensionSettings policy did not apply), so this test proves nothing');
  await chromeEval(d, `(() => { const w = OpenBrowserWindow({ private: true }); w.addEventListener('load', () => setTimeout(() => w.gBrowser.selectedBrowser.fixupAndLoadURIString(${JSON.stringify(`${S}/page2.html?private`)}, { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }), 500), { once: true }); return true; })()`);
  let pid = null;
  for (let i = 0; i < 60 && !pid; i++) {
    pid = await ext(`const t = (await browser.tabs.query({})).find(x => x.incognito && (x.url || '').includes('private')); return t ? t.id : null;`);
    await sleep(200);
  }
  expect(pid, 'the private tab never showed up');
  // Moving it into the agent's group can't work (different windows), and must not make it usable.
  const moved = await ext(`try { await browser.tabs.group({ groupId: (await browser.tabs.get(${tabId})).groupId, tabIds: [${pid}] }); return 'grouped'; } catch (e) { return 'refused: ' + e.message; }`);
  // A "Foxwright"-titled orange group inside the private window must not be adopted either.
  await ext(`const g = await browser.tabs.group({ tabIds: [${pid}], createProperties: { windowId: (await browser.tabs.get(${pid})).windowId } }); await browser.tabGroups.update(g, { title: 'Foxwright', color: 'orange' }); return g;`);
  const ctx = await h.call('tabs_context_mcp', {});
  const direct = await noWindow(h.call('read_page', { tabId: pid }));
  console.log(`      (moving the private tab into the agent group: ${moved})`);
  expect(!ctx.text.includes('private') && !ctx.text.includes(`tabId ${pid}:`), 'listed:\n' + ctx.text);
  expect(direct.isError && /private window/.test(direct.text), 'read_page on the private tab: ' + direct.text.slice(0, 200));
  // With the private window focused and the agent's own group gone, a new agent tab still goes to a normal window.
  const groupIds = await ext(`const ts = await browser.tabs.query({}); return ts.filter(t => !t.incognito && t.groupId === ts.find(x => x.id === ${tabId}).groupId).map(t => t.id);`);
  for (const id of groupIds)
    await h.call('tabs_close_mcp', { tabId: id });
  await ext(`const w = (await browser.windows.getAll()).find(x => x.incognito); await browser.windows.update(w.id, { focused: true }); return w.id;`);
  const ctx2 = await h.call('tabs_context_mcp', {});
  expect(/empty/.test(ctx2.text), 'the private "Foxwright" group was adopted:\n' + ctx2.text);
  const made = await h.call('tabs_create_mcp', {});
  const nid = tabIdOf(made.text);
  expect(nid, 'tabs_create_mcp failed: ' + made.text);
  const where = await ext(`const t = await browser.tabs.get(${nid}); return { incognito: t.incognito };`);
  expect(nid && where.incognito === false, `tabs_create_mcp made tab ${nid} in a ${where.incognito ? 'PRIVATE' : 'normal'} window`);
  tabId = nid;
  await ext(`for (const w of await browser.windows.getAll()) if (w.incognito) await browser.windows.remove(w.id); return true;`);
});

await test('"Allow for 1 hour": stored with its expiry, shown "until HH:MM", survives an extension restart, then asks again', async () => {
  const { r } = await withWindow(h.call('navigate', { tabId, url: `${C}/page2.html` }), 'hour');
  expect(!r.isError, r.text);
  const s = await status();
  const t = s.timed.find(x => x.origin === C);
  expect(t && t.level === 'full' && Math.abs(t.until - Date.now() - 3600e3) < 120e3, 'timed entry: ' + JSON.stringify(s.timed));
  const stored = await ext(`return (await browser.storage.local.get('timed')).timed;`);
  expect(stored?.[C]?.until === t.until, 'not in storage.local: ' + JSON.stringify(stored));
  let row = '';
  for (let i = 0; i < 40 && !/until/.test(row); i++) {
    row = await d.evalIn(await popupCtx(), `[...document.querySelectorAll('#sites li')].map(li => li.textContent).find(t => t.includes('c.test')) || ''`);
    await sleep(100);
  }
  expect(/until \d{1,2}:\d{2}/.test(row), 'popup row: ' + row);
  // Make it expire in a few seconds, then restart the extension (as Firefox may do with an idle event page).
  await ext(`const t = (await browser.storage.local.get('timed')).timed; t[${JSON.stringify(C)}].until = Date.now() + 6000; await browser.storage.local.set({ timed: t }); setTimeout(() => browser.runtime.reload(), 100); return true;`).catch(() => {});
  popup = null;
  const t0 = Date.now();
  let back = null;
  while (Date.now() - t0 < 30000) {
    await sleep(500);
    back = await h.call('tabs_context_mcp', { createIfEmpty: true }).catch(e => ({ isError: true, text: e.message }));
    if (!back.isError && /tabId/.test(back.text))
      break;
  }
  expect(back && !back.isError, 'Foxwright did not come back after the restart: ' + back?.text);
  tabId = tabIdOf(back.text);
  const still = await noWindow(h.call('navigate', { tabId, url: `${C}/page2.html?after-restart` }));
  expect(!still.isError, 'the 1-hour approval did not survive the restart: ' + still.text);
  while (Date.now() - t0 < 8000)
    await sleep(250);
  const asked = await withWindow(h.call('navigate', { tabId, url: `${C}/page2.html?expired` }), 'deny');
  expect(asked.info.origin === C && asked.r.isError, 'an expired approval should ask again: ' + asked.r.text);
  expect(!(await status()).timed.some(x => x.origin === C), 'the expired entry is still listed');
});

await test('host permission turned off in about:addons is reported as such, not as an error page', async () => {
  // The extension restart above forgot "this session" approvals: allow S again if asked.
  const yes = d.autoAnswer('once');
  const first = await h.call('navigate', { tabId, url: `${S}/consequence.html?before-revoke` });
  yes.stop();
  await sleep(300);
  expect(!first.isError, first.text);
  const removed = await chromeEval(d, `(async () => { const { ExtensionPermissions } = ChromeUtils.importESModule('resource://gre/modules/ExtensionPermissions.sys.mjs'); const p = WebExtensionPolicy.getByID('${IDS[1]}') || WebExtensionPolicy.getByID('${IDS[0]}'); await ExtensionPermissions.remove(p.id, { permissions: [], origins: ['<all_urls>'] }, p.extension); return p.canAccessURI(Services.io.newURI('${S}/')); })()`);
  console.log(`      (after revoking, the extension can access ${S}: ${removed})`);
  const r = await noWindow(h.call('navigate', { tabId, url: `${S}/page2.html?revoked` }));
  const rp = await noWindow(h.call('read_page', { tabId }));
  expect(r.isError && /add-on settings/.test(r.text) && /Permissions/.test(r.text), 'navigate: ' + r.text.slice(0, 300));
  expect(rp.isError && /add-on settings/.test(rp.text), 'read_page: ' + rp.text.slice(0, 300));
});

d.close();
await h.stop();

// ---------- trusted (WebDriver BiDi) input: the same rules hold on the _point/_focus path ----------
const T = await start({ trusted: true, policy: { mode: 'ask', promptTimeoutSec: 3, allowedReadOnly: [A], allowed: [S], confirmActions: true } });
const tctx = await T.call('tabs_context_mcp', { createIfEmpty: true });
const ttab = tabIdOf(tctx.text);
const trusted = /Input mode: trusted/.test(tctx.text);
const tpage = async () => (await T.call('read_page', { tabId: ttab, max_chars: 100000 })).text;
const tref = async (q) => refOf((await T.call('find', { tabId: ttab, query: q })).text);

await test('trusted input: a read-only site can be scrolled but not clicked (the upgrade window times out)', async () => {
  expect(trusted, 'trusted input did not start: ' + tctx.text);
  expect(!(await T.call('navigate', { tabId: ttab, url: `${A}/consequence.html` })).isError, 'navigate');
  const sc = await T.call('computer', { tabId: ttab, action: 'scroll', coordinate: [300, 300], scroll_direction: 'down' });
  expect(!sc.isError && /trusted input/.test(sc.text), sc.text);
  await T.call('computer', { tabId: ttab, action: 'scroll', coordinate: [300, 300], scroll_direction: 'up', scroll_amount: 10 });
  const c = await T.call('computer', { tabId: ttab, action: 'left_click', ref: await tref('Show details') });
  expect(c.isError && /reading only/.test(c.text), c.text);
  const k = await T.call('computer', { tabId: ttab, action: 'type', text: 'x' });
  expect(k.isError && /reading only/.test(k.text), k.text);
  expect(/Clicks: 0/.test(await tpage()), 'the read-only page was clicked');
});

await test('trusted input with policy "confirmActions": a plain button is clicked, Send and Enter-to-submit wait for the person', async () => {
  expect(trusted, 'trusted input did not start');
  expect(!(await T.call('navigate', { tabId: ttab, url: `${S}/consequence.html` })).isError, 'navigate');
  const plain = await T.call('computer', { tabId: ttab, action: 'left_click', ref: await tref('Show details') });
  expect(!plain.isError && /trusted input/.test(plain.text), plain.text);
  const send = await T.call('computer', { tabId: ttab, action: 'left_click', ref: await tref('Send message') });
  expect(send.isError && /timed out/.test(send.text) && /Send message/.test(send.text), send.text);
  await T.call('computer', { tabId: ttab, action: 'left_click', ref: await tref('Search') });
  const enter = await T.call('computer', { tabId: ttab, action: 'key', text: 'Enter' });
  expect(enter.isError && /submits its form/.test(enter.text), enter.text);
  const log = logOf(await tpage());
  expect(/DETAILS/.test(log) && !/SENT|SUBMITTED/.test(log), 'log: ' + log);
});

await T.stop();
xs.close();
fs.mkdirSync('test/results', { recursive: true });
process.exit(finish());
