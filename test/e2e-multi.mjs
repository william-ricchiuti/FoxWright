// Several Firefox profiles connected to Foxwright at once: list_connected_browsers, select_browser,
// switch_browser (the user clicks Connect in one browser's window), and the shared socket moving
// to the other browser when the first one closes.
//   FIREFOX=/path/to/firefox node test/e2e-multi.mjs
import { start } from './harness.mjs';
import { connectDriver } from './bidi-driver.mjs';

const results = [];
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function test(name, fn) {
  const t0 = Date.now();
  try {
    await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)`);
  } catch (e) {
    results.push({ name, ok: false, err: e.message });
    console.log(`  ✗ ${name}\n      ${String(e.message).split('\n').join('\n      ')}`);
  }
}
const expect = (c, m) => { if (!c) throw new Error(m); };
const BASE = `http://127.0.0.1:${process.env.FOXWRIGHT_P1}`;

console.log('Foxwright: several Firefox profiles');
const a = await start({ trusted: true }); // the first browser: owns the shared socket; `a.call` is the agent (with real input)
const b = await start({ alongside: a, testDriver: true }); // a second profile; the test can press its buttons
const driver = await connectDriver(b.bidiUrl);
const ids = (t) => [...t.matchAll(/deviceId ([a-f0-9]{12})/g)].map(m => m[1]);
let first = '', second = '';

await test('list_connected_browsers shows both, and which one is in use', async () => {
  const r = await a.call('list_connected_browsers');
  expect(!r.isError && ids(r.text).length === 2, r.text);
  const inUse = /deviceId ([a-f0-9]{12})[^\n]*\[inUse\]/.exec(r.text)?.[1];
  expect(inUse, 'one browser should be marked [inUse]:\n' + r.text);
  first = inUse;
  second = ids(r.text).find(x => x !== inUse);
});

await test('select_browser moves the agent to the other browser, with its own tabs', async () => {
  await a.call('tabs_context_mcp', { createIfEmpty: true });
  await a.call('navigate', { url: `${BASE}/basic.html` });
  const sel = await a.call('select_browser', { deviceId: second });
  expect(!sel.isError, sel.text);
  await a.call('tabs_context_mcp', { createIfEmpty: true });
  await a.call('navigate', { url: `${BASE}/page2.html` });
  const t2 = await a.call('tabs_context_mcp', {});
  expect(t2.text.includes('page2.html') && !t2.text.includes('basic.html'), 'the second browser should only have its own tab:\n' + t2.text);
  await a.call('select_browser', { deviceId: first });
  const t1 = await a.call('tabs_context_mcp', {});
  expect(t1.text.includes('basic.html') && !t1.text.includes('page2.html'), 'back in the first browser:\n' + t1.text);
});

await test('select_browser refuses an unknown deviceId', async () => {
  const r = await a.call('select_browser', { deviceId: '000000000000' });
  expect(r.isError && /No connected browser/.test(r.text), r.text);
});

await test('switch_browser: the browser where the user clicks Connect is used', async () => {
  const sw = a.call('switch_browser');
  const w = await driver.promptWindow();
  let title = '';
  for (let i = 0; i < 40 && !/Use this Firefox/.test(title); i++) { // filled in by the window's script
    title = await driver.evalIn(w.context, `document.getElementById('title').textContent`);
    await sleep(50);
  }
  expect(/Use this Firefox/.test(title), 'pairing window title: ' + title);
  await driver.answer('once');
  const r = await sw;
  expect(!r.isError && r.text.includes(second), r.text);
  const l = await a.call('list_connected_browsers');
  expect(new RegExp(`${second}[^\\n]*\\[inUse\\]`).test(l.text), 'the picked browser should be in use:\n' + l.text);
  const t = await a.call('tabs_context_mcp', {});
  expect(t.text.includes('page2.html'), 'actions now go to the second browser:\n' + t.text);
});

// The first browser has remote debugging (the agent's MCP server holds its BiDi session); the second
// doesn't. Tab ids restart in every Firefox, so both can have a tab with the same id: after
// select_browser, trusted input must not reuse the first browser's cached context for that id.
await test('trusted input never follows a tab id into the other browser (BiDi contexts are per browser)', async () => {
  const tabIn = async (dev) => {
    await a.call('select_browser', { deviceId: dev });
    return Number(/Created tab (\d+)/.exec((await a.call('tabs_create_mcp', {})).text)?.[1]);
  };
  let t1 = await tabIn(first), t2 = await tabIn(second);
  for (let i = 0; i < 20 && t1 !== t2; i++) { // open tabs in whichever browser is behind until the ids meet
    if (t1 < t2)
      t1 = await tabIn(first);
    else
      t2 = await tabIn(second);
  }
  expect(t1 === t2, `could not get the same tab id in both browsers (${t1} vs ${t2})`);
  const fill = async (dev, text) => {
    await a.call('select_browser', { deviceId: dev });
    await a.call('navigate', { tabId: t1, url: `${BASE}/basic.html?same-id` });
    const ref = /\[ref=([^\]]+)\]/.exec((await a.call('find', { tabId: t1, query: 'Full name' })).text)?.[1];
    const c = await a.call('computer', { tabId: t1, action: 'left_click', ref });
    const ty = await a.call('computer', { tabId: t1, action: 'type', text });
    return `${c.text.split('\n')[0]} / ${ty.text.split('\n')[0]}`;
  };
  const r1 = await fill(first, 'first-');
  const r2 = await fill(second, 'second-');
  const value = async (dev) => {
    await a.call('select_browser', { deviceId: dev });
    return (await a.call('javascript_tool', { tabId: t1, text: 'document.getElementById("name").value' })).text.replace(/^"|"$/g, '');
  };
  const v1 = await value(first), v2 = await value(second);
  console.log(`      (tab ${t1} in both; first browser: ${r1} -> ${JSON.stringify(v1)}; second: ${r2} -> ${JSON.stringify(v2)})`);
  expect(/trusted input/.test(r1), 'the first browser should use trusted input: ' + r1);
  expect(v1 === 'first-' && v2 === 'second-', `typing in the second browser went to the first one's tab ${t1}: first ${JSON.stringify(v1)}, second ${JSON.stringify(v2)}`);
  await a.call('select_browser', { deviceId: first });
});

await test('when the first browser closes, an agent that never picked one is told it moved', async () => {
  // b's own MCP client never selected a browser: it uses the shared socket, i.e. the first browser.
  const before = await b.call('tabs_context_mcp', { createIfEmpty: true });
  expect(before.text.includes('basic.html'), 'should start in the first browser:\n' + before.text);
  await a.stopFirefoxOnly();
  let r = null;
  for (let i = 0; i < 30; i++) { // the second helper takes over the shared socket within a few seconds
    r = await b.call('tabs_context_mcp', { createIfEmpty: true });
    if (!r.isError)
      break;
    await sleep(500);
  }
  expect(r && !r.isError, 'should reconnect to the remaining browser: ' + r?.text);
  expect(/closed; now connected to/.test(r.text) && r.text.includes('page2.html'), 'the agent should be told it is in another browser now:\n' + r.text);
});

driver.close();
await b.stop();
await a.stop();
const passed = results.filter(r => r.ok).length;
console.log(`\n${passed}/${results.length} multi-browser tests passed`);
process.exit(passed === results.length ? 0 : 1);
