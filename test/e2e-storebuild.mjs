// The core flows on the store build (what people install from addons.mozilla.org), which has no
// javascript_tool. Page state is read with the harness's pageEval() instead: through the test's own
// WebDriver BiDi session in synthetic mode, through the fixture page probe in trusted mode (where
// the MCP server holds Firefox's only BiDi session).
//
//   FIREFOX=... node test/e2e-storebuild.mjs                          store build, synthetic input
//   FIREFOX=... FOXWRIGHT_E2E_TRUSTED=1 node test/e2e-storebuild.mjs  store build, trusted input
//   FOXWRIGHT_E2E_BUILD=full|<folder>                                 another build (e.g. the signed AMO XPI, unzipped)
//
// Synthetic mode runs with the "ask" policy and also covers the permission window (Allow/Deny),
// Pause, and screenshot masking of a frame from an unapproved site; trusted mode can't press
// buttons in extension pages (no BiDi session for the test) and skips those.
import { start } from './harness.mjs';
import { connectDriver } from './bidi-driver.mjs';
import { runner, sleep, expect, tabIdOf } from './gap-lib.mjs';

const TRUSTED = !!process.env.FOXWRIGHT_E2E_TRUSTED;
const P1 = process.env.FOXWRIGHT_P1, P2 = process.env.FOXWRIGHT_P2;
const BASE = `http://127.0.0.1:${P1}`;
const DENY = `http://localhost:${P1}`; // never approved; denied in the permission test
const ONCE = `http://127.0.0.1:${P2}`; // approved for the session in the permission test
const UNAPPROVED_FRAME = `http://localhost:${P2}`; // basic.html's cross-origin frame; stays unapproved

const { test, skip, finish } = runner(TRUSTED ? 'e2e-storebuild-trusted' : 'e2e-storebuild');
const build = process.env.FOXWRIGHT_E2E_BUILD || 'store';
console.log(`Foxwright store-build e2e (${build} build, ${TRUSTED ? 'trusted / WebDriver BiDi' : 'synthetic events'})`);
const h = await start(TRUSTED
  ? { build, trusted: true, policy: { mode: 'all', confirmUploads: false } }
  : { build, testDriver: true, policy: { mode: 'ask', promptTimeoutSec: 30, confirmUploads: false, allowed: [BASE] } });
let driver = null;
if (!TRUSTED) {
  driver = await connectDriver(h.bidiUrl);
  h.useDriver(driver);
}
console.log(`  (extension: ${h.sourceDir}; page state read via ${h.pageEvalMode})`);

let tabId;
async function call(name, args = {}) {
  const r = await h.call(name, { tabId, ...args });
  if (r.isError)
    throw new Error(`${name} failed: ${r.text}`);
  return r;
}
const nav = url => call('navigate', { url: url.startsWith('http') ? url : BASE + url });
const page = code => h.pageEval(tabId, code);
async function refFor(query, role) {
  const r = await call('find', { query });
  const lines = r.text.split('\n').filter(l => l.includes('[ref='));
  const line = lines.find(l => !role || l.trim().startsWith(`- ${role}`)) || lines[0];
  expect(line, `find "${query}" returned nothing:\n${r.text}`);
  return { ref: /\[ref=([^\]]+)\]/.exec(line)[1], line, coord: (/at \((\d+), (\d+)\)/.exec(line) || []).slice(1).map(Number) };
}
/** Poll page state until `ok(value)`; return the last value. */
async function until(code, ok, ms = 3000) {
  const t0 = Date.now();
  let v;
  do {
    v = await page(code);
    if (ok(v))
      return v;
    await sleep(100);
  } while (Date.now() - t0 < ms);
  return v;
}

await test('tabs_context_mcp gives a tab and reports the input mode', async () => {
  const r = await h.call('tabs_context_mcp', { createIfEmpty: true });
  tabId = tabIdOf(r.text);
  expect(tabId > 0, r.text);
  expect(r.text.includes(TRUSTED ? 'Input mode: trusted' : 'Input mode: synthetic'), r.text);
});

if (h.isStore) {
  await test('javascript_tool is not part of the store build', async () => {
    const r = await h.call('javascript_tool', { tabId, action: 'javascript_exec', text: '1+1' });
    expect(r.isError && /not available in the Firefox Add-ons store edition/.test(r.text), r.text);
  });
} else
  skip('javascript_tool is not part of the store build', `testing the ${build} build`);

await test('pageEval reads page state (no javascript_tool)', async () => {
  await nav('/basic.html');
  expect(await page('document.querySelector("#signup") !== null'), 'not on basic.html');
  expect(await page('1 + 1') === 2, 'arithmetic');
  expect(await h.pageEvalText(tabId, '"a\\nb"') === '"a\\nb"', 'pageEvalText formats like javascript_tool');
  expect(await page('const a = 2; a * 21') === 42, 'REPL semantics: value of the last statement');
  expect(await page('location.pathname') === '/basic.html', 'wrong page');
});

await test('outline and find', async () => {
  const r = await call('read_page', {});
  expect(r.text.includes('textbox "Full name"') && r.text.includes('button "Create account"'), r.text.slice(0, 800));
  const { line } = await refFor('plan dropdown');
  expect(line.includes('combobox "Plan"'), line);
});

await test('forms: form_input text, select, checkbox, range and date', async () => {
  await call('form_input', { ref: (await refFor('Full name', 'textbox')).ref, value: 'Ada Lovelace' });
  await call('form_input', { ref: (await refFor('Plan', 'combobox')).ref, value: 'Pro plan' });
  await call('form_input', { ref: (await refFor('accept the terms', 'checkbox')).ref, value: true });
  await call('form_input', { ref: (await refFor('Volume', 'slider')).ref, value: 70 });
  await call('form_input', { ref: (await refFor('Birthday')).ref, value: '2026-09-23' });
  const v = await page('({ name: document.getElementById("name").value, plan: document.getElementById("plan").value, terms: document.getElementById("terms").checked, vol: document.getElementById("vol").value, bday: document.getElementById("bday").value })');
  expect(JSON.stringify(v) === JSON.stringify({ name: 'Ada Lovelace', plan: 'pro', terms: true, vol: '70', bday: '2026-09-23' }), JSON.stringify(v));
});

await test('typing: click + type into a field and multi-line text into a textarea', async () => {
  await call('computer', { action: 'left_click', ref: (await refFor('Email', 'textbox')).ref });
  await call('computer', { action: 'type', text: 'ada@example.com' });
  await call('computer', { action: 'left_click', ref: (await refFor('Bio', 'textbox')).ref });
  await call('computer', { action: 'type', text: 'line one\nline two' });
  const v = await page('[document.getElementById("email").value, document.getElementById("bio").value]');
  expect(v[0] === 'ada@example.com' && v[1] === 'line one\nline two', JSON.stringify(v));
});

await test('keys: ctrl+a Backspace clears, Tab moves focus, Enter submits', async () => {
  const { ref } = await refFor('Full name', 'textbox');
  await call('computer', { action: 'left_click', ref });
  await call('computer', { action: 'key', text: 'ctrl+a Backspace' });
  expect(await page('document.getElementById("name").value') === '', 'field not cleared');
  await call('computer', { action: 'type', text: 'Ada' });
  await call('computer', { action: 'key', text: 'Tab' });
  expect(await page('document.activeElement.id') === 'email', 'focus did not move to the email field');
  await call('computer', { action: 'key', text: 'Enter' });
  const t = await until('document.getElementById("result").textContent', v => /^SUBMITTED/.test(v));
  expect(/^SUBMITTED name=Ada email=ada@example.com plan=pro terms=true/.test(t), t);
});

await test('clicks: by screenshot coordinate, double and right click', async () => {
  const shot = await call('computer', { action: 'screenshot' });
  expect(shot.images.length === 1, 'no image');
  const { coord } = await refFor('Clicked 0 times', 'button');
  expect(coord.length === 2, 'no coordinates from find');
  await call('computer', { action: 'left_click', coordinate: coord });
  expect(await until('document.getElementById("counter").textContent', v => v === 'Clicked 1 times') === 'Clicked 1 times', 'counter not clicked');
  await call('computer', { action: 'double_click', ref: (await refFor('Double-click me', 'button')).ref });
  await call('computer', { action: 'right_click', ref: (await refFor('Right-click me', 'button')).ref });
  const v = await page('[document.getElementById("dbl").textContent, document.getElementById("ctx").textContent]');
  expect(v[0] === 'double clicked' && v[1] === 'custom menu opened', JSON.stringify(v));
});

await test('HTML5 drag and drop', async () => {
  const pos = await page('document.getElementById("drop").scrollIntoView({block:"center"}); [document.getElementById("drag"), document.getElementById("drop")].map(e => { const r = e.getBoundingClientRect(); return [Math.round(r.left + r.width/2), Math.round(r.top + r.height/2)]; })');
  await call('computer', { action: 'left_click_drag', start_coordinate: pos[0], coordinate: pos[1] });
  const t = await until('document.getElementById("drop").textContent', v => v === 'dropped: fox');
  expect(t === 'dropped: fox', t);
});

await test('iframes: click in a same-origin frame, fill a srcdoc frame', async () => {
  const r = await call('read_page', { filter: 'interactive' });
  const fref = /button "Frame button" \[ref=(f\d+e\d+)\]/.exec(r.text)?.[1];
  expect(fref, 'no frame button:\n' + r.text);
  await call('computer', { action: 'left_click', ref: fref });
  const t = await until('document.getElementById("same-frame").contentDocument.getElementById("fbtn").textContent', v => v === 'frame button clicked');
  expect(t === 'frame button clicked', t);
  await nav('/frames2.html');
  const line = (await call('read_page', { max_chars: 200000 })).text.split('\n').find(l => l.includes('textbox "Coupon code"'));
  expect(line, 'no srcdoc field');
  await call('form_input', { ref: /\[ref=([^\]]+)\]/.exec(line)[1], value: 'FOX10' });
  expect(await page('document.getElementById("srcdoc-frame").contentDocument.getElementById("coupon").value') === 'FOX10', 'srcdoc field not filled');
});

await test('dialogs: confirm answered Cancel, then OK after handle_dialog', async () => {
  const { ref } = await refFor('Delete everything', 'button');
  const r1 = await call('computer', { action: 'left_click', ref });
  expect(/Foxwright answered: Cancel/.test(r1.text), r1.text);
  expect(await page('document.getElementById("dlg").textContent') === 'Kept', 'page did not see Cancel');
  await call('handle_dialog', { accept: true });
  const r2 = await call('computer', { action: 'left_click', ref });
  expect(r2.text.includes('Foxwright answered: OK'), r2.text);
  expect(await page('document.getElementById("dlg").textContent') === 'Deleted', 'page did not see OK');
});

await test('React: click + type and form_input update component state', async () => {
  await nav('/react.html');
  const { ref } = await refFor('Your name', 'textbox');
  await call('computer', { action: 'left_click', ref });
  await call('computer', { action: 'type', text: 'Foxwright' });
  expect(await until('document.getElementById("echo").textContent', v => v === 'Hello, Foxwright') === 'Hello, Foxwright', 'React did not see typing');
  await call('form_input', { ref, value: 'Inari' });
  await call('computer', { action: 'left_click', ref: (await refFor('Count', 'button')).ref });
  await call('computer', { action: 'left_click', ref });
  await call('computer', { action: 'key', text: 'Enter' });
  const v = await until('document.getElementById("rresult").textContent', x => x.startsWith('SAVED'));
  expect(v === 'SAVED {"name":"Inari","agree":false,"size":"m"}', v);
  expect(await page('document.getElementById("rcount").textContent') === 'Count: 1', 'count button');
});

await test('tabs: a second tab, read separately, then closed', async () => {
  const t2 = Number(/Created tab (\d+)/.exec((await h.call('tabs_create_mcp', {})).text)?.[1]);
  expect(t2 > 0, 'no tab created');
  const n = await h.call('navigate', { tabId: t2, url: `${BASE}/page2.html?tab=2` });
  expect(!n.isError, n.text);
  expect(await h.pageEval(t2, 'location.search') === '?tab=2', 'second tab state');
  expect(await page('location.pathname') === '/react.html', 'first tab state');
  const ctx = await h.call('tabs_context_mcp', {});
  expect(ctx.text.includes(`tabId ${t2}`) && ctx.text.includes(`tabId ${tabId}`), ctx.text);
  const c = await h.call('tabs_close_mcp', { tabId: t2 });
  expect(!c.isError, c.text);
  expect(!(await h.call('tabs_context_mcp', {})).text.includes(`tabId ${t2}:`), 'tab still listed');
});

if (TRUSTED) {
  for (const name of ['screenshot masks a frame from an unapproved site', 'permission window: Deny refuses the site', 'permission window: Allow this session', 'Pause blocks commands, Resume lets them through'])
    skip(name, 'needs the "ask" policy and a BiDi session of the test\'s own (synthetic mode)');
} else {
  await test('screenshot masks a frame from an unapproved site', async () => {
    await nav('/basic.html');
    const rect = await page('(() => { const f = document.getElementById("xo-frame"); f.scrollIntoView({block:"center"}); const r = f.getBoundingClientRect(); return [r.left + r.width / 2, r.top + r.height / 2, innerWidth]; })()');
    await sleep(200);
    const shot = await call('computer', { action: 'screenshot' });
    expect(/hasn't approved/.test(shot.text) && shot.text.includes(UNAPPROVED_FRAME), `the result should say a frame was greyed out: ${shot.text}`);
    // Decode the JPEG in the page and read the pixel at the frame's centre.
    const px = await page(`new Promise((res, rej) => { const img = new Image(); img.onload = () => { const c = document.createElement('canvas'); c.width = img.width; c.height = img.height; const g = c.getContext('2d'); g.drawImage(img, 0, 0); const s = img.width / ${rect[2]}; res([...g.getImageData(Math.round(${rect[0]} * s), Math.round(${rect[1]} * s), 1, 1).data.slice(0, 3)]); }; img.onerror = rej; img.src = 'data:image/jpeg;base64,${shot.images[0].data}'; })`);
    const [r, g, b] = px;
    // The frame shows a light button on white; masked is dark grey (with stripes).
    expect(r < 160 && g < 160 && b < 160 && Math.abs(r - g) < 20 && Math.abs(g - b) < 20, `the frame's centre is rgb(${r},${g},${b}), not greyed out`);
  });

  let extBase = '';
  await test('permission window: Deny refuses the site', async () => {
    const n = h.call('navigate', { tabId, url: `${DENY}/basic.html` });
    const w = await driver.promptWindow();
    extBase = w.url.replace(/prompt\/prompt\.html.*$/, '');
    await driver.answer('deny', w);
    const r = await n;
    expect(r.isError && /did not allow|denied|not allowed|refused/i.test(r.text), r.text);
    expect(await page('location.origin') === BASE, 'the tab must not have navigated');
  });

  await test('permission window: Allow this session', async () => {
    const n = h.call('navigate', { tabId, url: `${ONCE}/page2.html?allowed` });
    await driver.answer('once');
    const r = await n;
    expect(!r.isError, r.text);
    expect(await page('location.search') === '?allowed', 'page state after allowing');
    const again = await h.call('navigate', { tabId, url: `${ONCE}/basic.html` });
    expect(!again.isError, again.text);
    expect(!(await driver.contexts()).some(x => x.url.includes('/prompt/prompt.html')), 'asked twice');
  });

  await test('Pause blocks commands, Resume lets them through', async () => {
    expect(extBase, 'no extension address (the Deny test failed)');
    const { context: p } = await driver.bidi('browsingContext.create', { type: 'window' });
    await driver.bidi('browsingContext.navigate', { context: p, url: `${extBase}popup/popup.html`, wait: 'complete' });
    await driver.evalIn(p, `document.getElementById('pause').click()`);
    await sleep(300);
    const r = await h.call('read_page', { tabId });
    expect(r.isError && /paused/i.test(r.text), r.text);
    await driver.evalIn(p, `document.getElementById('resume').click()`);
    await sleep(300);
    const ok = await h.call('read_page', { tabId });
    expect(!ok.isError, ok.text);
    await driver.bidi('browsingContext.close', { context: p }).catch(() => {});
  });
}

await h.stop();
process.exit(finish());
