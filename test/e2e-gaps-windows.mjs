// Container tabs (cookieStoreId, like Multi-Account Containers) inside the
// Foxwright group, and private windows when the extension is allowed in them.
//   FOXWRIGHT_E2E_PREFS='{"privacy.userContext.enabled":true}' FOXWRIGHT_E2E_HEADFUL=1 xvfb-run -a node test/e2e-gaps-windows.mjs
import { start } from './harness.mjs';
import { runner, expect, tabIdOf, chromeEval, connectPerson, extBaseOf, sleep } from './gap-lib.mjs';

const BASE = `http://127.0.0.1:${process.env.FOXWRIGHT_P1}`;
const { test, finish } = runner('e2e-gaps-windows');
const ids = ['kitsune-full@william-ricchiuti.com', 'kitsune@william-ricchiuti.com'];
process.env.FOXWRIGHT_E2E_PREFS = JSON.stringify({ ...JSON.parse(process.env.FOXWRIGHT_E2E_PREFS || '{}'), 'privacy.userContext.enabled': true });
const h = await start({ testDriver: true, extraPolicies: { ExtensionSettings: Object.fromEntries(ids.map(i => [i, { private_browsing: true }])) } });
const d = await connectPerson(h.bidiUrl);
h.useDriver(d);
const r0 = await h.call('tabs_context_mcp', { createIfEmpty: true });
const tabId = tabIdOf(r0.text);
await h.call('navigate', { tabId, url: `${BASE}/basic.html?first` });
const extBase = await extBaseOf(d);
const { context: extCtx } = await d.bidi('browsingContext.create', { type: 'window' });
await d.bidi('browsingContext.navigate', { context: extCtx, url: `${extBase}popup/popup.html`, wait: 'complete' });
const ext = async (body) => {
  const v = await d.evalIn(extCtx, `(async () => JSON.stringify(await (async () => { ${body} })()))()`);
  return v === undefined ? undefined : JSON.parse(v);
};
const info = {};
info.privateAllowed = await chromeEval(d, `WebExtensionPolicy.getByID('${ids[0]}')?.privateBrowsingAllowed`);
info.userContextEnabled = await chromeEval(d, `Services.prefs.getBoolPref('privacy.userContext.enabled', false)`);
const groupId = await ext(`return (await browser.tabs.get(${tabId})).groupId;`);

let ctab;
await test('container tab added to the Foxwright group is listed', async () => {
  // Open a tab in container 1 ("Personal") the way Multi-Account Containers does, then group it.
  await chromeEval(d, `(() => { const w = Services.wm.getMostRecentWindow('navigator:browser'); w.gBrowser.addTab('${BASE}/basic.html?container', { userContextId: 1, triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }); return true; })()`);
  await sleep(1500);
  ctab = await ext(`const t = (await browser.tabs.query({})).find(t => t.url.includes('?container')); await browser.tabs.group({ tabIds: [t.id], groupId: ${groupId} }); return { id: t.id, store: t.cookieStoreId };`);
  info.containerTab = ctab;
  await sleep(500);
  const r = await h.call('tabs_context_mcp', {});
  info.contextListing = r.text.split('\n').filter(l => l.includes(String(ctab.id)));
  expect(r.text.includes(`tabId ${ctab.id}`), r.text);
});

await test('read_page / click / type / screenshot in the container tab', async () => {
  const r = await h.call('read_page', { tabId: ctab.id });
  expect(!r.isError && r.text.includes('Full name'), r.text.slice(0, 400));
  const f = await h.call('find', { tabId: ctab.id, query: 'Clicked 0 times' });
  const ref = /\[ref=([^\]]+)\]/.exec(f.text)?.[1];
  const c = await h.call('computer', { tabId: ctab.id, action: 'left_click', ref });
  expect(!c.isError, c.text);
  const s = await h.call('computer', { tabId: ctab.id, action: 'screenshot' });
  expect(!s.isError && s.images.length === 1, s.text);
  const v = await h.js(ctab.id, `document.getElementById('counter').textContent`);
  expect(v.includes('Clicked 1 times'), v);
});

await test('navigate inside the container tab stays in the container', async () => {
  const r = await h.call('navigate', { tabId: ctab.id, url: `${BASE}/page2.html?container` });
  expect(!r.isError, r.text);
  const t = await ext(`const t = await browser.tabs.get(${ctab.id}); return { store: t.cookieStoreId, url: t.url };`);
  info.afterNav = t;
  await sleep(3000);
  const lc = await h.call('tabs_context_mcp', {});
  info.listedLater = lc.text.includes(`tabId ${ctab.id}`);
  info.bgQuery = await ext(`return (await browser.tabs.query({})).filter(t => t.id === ${ctab.id}).map(t => [t.id, t.groupId, t.cookieStoreId]);`);
  expect(t.store === ctab.store, JSON.stringify(t));
});

await test('get_page_text / read_network_requests in the container tab', async () => {
  const r = await h.call('get_page_text', { tabId: ctab.id });
  expect(!r.isError, r.text);
  const n = await h.call('read_network_requests', { tabId: ctab.id });
  info.netInContainer = n.isError ? `error: ${n.text.slice(0, 200)}` : 'ok';
});

await test('tabs_create_mcp next to a container tab opens a normal tab in the group', async () => {
  await ext(`await browser.tabs.update(${ctab.id}, { active: true });`);
  const r = await h.call('tabs_create_mcp', {});
  const id = tabIdOf(r.text);
  const t = await ext(`const t = await browser.tabs.get(${id}); return { store: t.cookieStoreId, group: t.groupId };`);
  info.newTab = t;
  expect(t.group === groupId, JSON.stringify(t));
});

await test('second normal window focused: tabs_create_mcp still lands in the group', async () => {
  const other = await ext(`const w = await browser.windows.create({ url: 'about:blank' }); await browser.windows.update(w.id, { focused: true }); return w.id;`);
  await sleep(1000);
  const r = await h.call('tabs_create_mcp', {});
  const id = tabIdOf(r.text);
  expect(id > 0, r.text);
  const t = await ext(`const t = await browser.tabs.get(${id}); return { win: t.windowId, group: t.groupId };`);
  info.createdWhileOtherFocused = { ...t, other };
  expect(t.group === groupId, JSON.stringify(t));
});

let privTabUrl =`${BASE}/basic.html?private`;
await test('private window (extension allowed there): its tabs stay invisible', async () => {
  await chromeEval(d, `(() => { const w = OpenBrowserWindow({ private: true }); w.addEventListener('load', () => setTimeout(() => w.gBrowser.selectedBrowser.fixupAndLoadURIString('${privTabUrl}', { triggeringPrincipal: Services.scriptSecurityManager.getSystemPrincipal() }), 500), { once: true }); return true; })()`);
  await sleep(3000);
  const priv = await ext(`return (await browser.tabs.query({})).filter(t => t.incognito).map(t => ({ id: t.id, url: t.url }));`);
  info.privateTabsVisibleToExtension = priv.length;
  const r = await h.call('tabs_context_mcp', {});
  expect(!r.text.includes('?private'), r.text);
  for (const p of priv) {
    const x = await h.call('read_page', { tabId: p.id });
    expect(x.isError, `read_page reached private tab ${p.id}: ${x.text.slice(0, 200)}`);
  }
});

await test('private window focused: tabs_create_mcp still opens in a normal window', async () => {
  // The private window opened last is focused now.
  info.windowsBefore = await ext(`return (await browser.windows.getAll({ populate: true })).map(w => ({ id: w.id, type: w.type, incognito: w.incognito, focused: w.focused, tabs: w.tabs.map(t => [t.id, t.groupId, t.url.slice(0, 60)]) }));`);
  info.lastFocusedNormal = await ext(`const w = await browser.windows.getLastFocused({ windowTypes: ['normal'] }); return { id: w.id, incognito: w.incognito };`);
  info.groups = await ext(`return browser.tabGroups.query({});`);
  const r = await h.call('tabs_create_mcp', {});
  const id = tabIdOf(r.text);
  if (!(id > 0)) {
    console.log('DIAG ' + JSON.stringify({ lastFocusedNormal: info.lastFocusedNormal, groups: info.groups }));
    const steps = await ext(`const out = []; let t; const ws = (await browser.windows.getAll({ windowTypes: ['normal'] })).map(w => w.id + (w.incognito ? 'p' : '')); out.push('getAll ' + ws.join(',')); const other = (await browser.windows.getAll({ windowTypes: ['normal'] })).find(w => !w.incognito && w.id !== 1); try { t = await browser.tabs.create({ url: 'about:blank', active: true, windowId: other.id }); out.push('create ok ' + t.id + ' win ' + t.windowId); } catch (e) { out.push('create: ' + e.message); } try { await browser.tabs.group({ groupId: ${groupId}, tabIds: [t.id] }); out.push('group ok'); } catch (e) { out.push('group: ' + e.message); } return out;`);
    console.log('STEPS ' + JSON.stringify(steps));
  }
  expect(id > 0, r.text);
  const t = await ext(`const t = await browser.tabs.get(${id}); return { incognito: t.incognito, group: t.groupId };`);
  info.createdWhilePrivateFocused = t;
  expect(!t.incognito && t.group === groupId, JSON.stringify(t));
  const n = await h.call('navigate', { tabId: id, url: `${BASE}/page2.html?afterpriv` });
  expect(!n.isError, n.text);
});

console.log('INFO ' + JSON.stringify(info));
await h.stop();
process.exit(finish());
