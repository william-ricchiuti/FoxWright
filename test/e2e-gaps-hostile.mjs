// Hostile pages vs Foxwright's permission flow (gap area 1). The test is "the person at the computer"
// through its own WebDriver BiDi session: it reads and presses the real permission window.
//
//   FIREFOX=... FOXWRIGHT_E2E_HEADFUL=1 xvfb-run -a -s "-screen 0 1400x900x24" node test/e2e-gaps-hostile.mjs
// Needs a.test, sub.a.test, b.test, c.test, xn--pple-43d.test -> 127.0.0.1 in /etc/hosts.
import fs from 'node:fs';
import { start } from './harness.mjs';
import { connectDriver } from './bidi-driver.mjs';
import { runner, extraServer, person, readPrompt, promptOpen, sleep, expect, refOf, tabIdOf } from './gap-lib.mjs';

const { test, finish } = runner('e2e-gaps-hostile');
const P1 = process.env.FOXWRIGHT_P1, P2 = process.env.FOXWRIGHT_P2;
const xs = await extraServer(P1, P2);
const { P3 } = xs;
const A = `http://a.test:${P3}`; // approved by policy
const B = `http://b.test:${P3}`; // never approved
const C = `http://c.test:${P3}`; // asked about in tests

console.log('Foxwright gap tests: hostile pages vs the permission flow');
const h = await start({ testDriver: true, policy: { mode: 'ask', promptTimeoutSec: 20, confirmUploads: true, allowed: [A] } });
const driver = await connectDriver(h.bidiUrl);
const me = person(driver);
const tabId = tabIdOf((await h.call('tabs_context_mcp', { createIfEmpty: true })).text);

async function tabUrl(id = tabId) {
  const t = await h.call('tabs_context_mcp', {});
  const m = new RegExp(`tabId ${id}: .*? (\\S+)(?: \\(active in its window\\))?$`, 'm').exec(t.text);
  return m ? m[1] : '';
}
const originOf = (u) => { try { return new URL(u).origin; } catch { return null; } };

/** Run a tool call while watching for permission windows; answer each with `answer`. */
async function watch(promise, answer = 'deny') {
  const prompts = [];
  const seen = new Set();
  let done = false;
  const p = promise.finally(() => { done = true; });
  while (!done) {
    if (await promptOpen(driver)) {
      const info = await readPrompt(driver, 500);
      if (info?.w && !seen.has(info.w.context)) {
        seen.add(info.w.context);
        prompts.push({ origin: info.origin, title: info.title, tabline: info.tabline, body: info.body });
        await driver.answer(answer, info.w).catch(() => {});
      }
    }
    await sleep(60);
  }
  return { r: await p, prompts };
}

await test('userinfo trick: http://a.test@b.test asks about b.test, not a.test', async () => {
  const { r, prompts } = await watch(h.call('navigate', { tabId, url: `http://a.test:${P3}@b.test:${P3}/hostile-title.html` }));
  expect(prompts.length === 1 && prompts[0].origin === B, `prompt should show ${B}: ${JSON.stringify(prompts)}`);
  expect(r.isError, 'denied navigation should fail: ' + r.text);
  expect(originOf(await tabUrl()) !== B, 'tab must not be on B');
}, { area: '1a' });

await test('IDN look-alike (Cyrillic а) is shown in punycode in the permission window', async () => {
  const { prompts } = await watch(h.call('navigate', { tabId, url: `http://аpple.test:${P3}/` }));
  expect(prompts.length === 1, JSON.stringify(prompts));
  expect(prompts[0].origin === `http://xn--pple-43d.test:${P3}`, `expected punycode origin, got ${prompts[0].origin}`);
}, { area: '1a' });

await test('very long host: the whole origin is shown and the buttons stay on screen', async () => {
  const host = `accounts-google-com-${'x'.repeat(40)}.${'y'.repeat(62)}.${'z'.repeat(62)}.b.test`;
  const nav = h.call('navigate', { tabId, url: `http://${host}:${P3}/` });
  const info = await readPrompt(driver);
  expect(info?.w, 'no permission window');
  await me.shot(info.w.context, 'test/results/gaps-long-host-prompt.png').catch(() => {});
  const geo = JSON.parse(await driver.evalIn(info.w.context, `JSON.stringify({ bottom: document.getElementById('once').getBoundingClientRect().bottom, vh: innerHeight, scrollH: document.documentElement.scrollHeight })`));
  await driver.answer('deny', info.w);
  await nav;
  expect(info.origin === `http://${host}:${P3}`, `origin shown: ${info.origin}`);
  expect(geo.bottom <= geo.vh, `the Allow button is below the visible window area (bottom ${geo.bottom}px, window ${geo.vh}px): the person has to scroll to find the buttons`);
}, { area: '1a' });

await test('non-web URLs are refused without a permission window and the tab stays put', async () => {
  await h.call('navigate', { tabId, url: `${A}/hostile-link.html` });
  const before = await tabUrl();
  const urls = ['data:text/html,<h1>x</h1>', 'javascript:alert(1)', 'JAVASCRIPT:alert(1)', ' javascript:alert(1)', 'java\tscript:alert(1)', 'jav&#x09;ascript:alert(1)',
    'file:///etc/passwd', 'view-source:http://a.test/', 'about:config', 'about:debugging', 'moz-extension://00000000-0000-0000-0000-000000000000/popup/popup.html',
    `blob:${A}/0b7b1f0e-1111-2222-3333-444455556666`, 'chrome://browser/content/browser.xhtml', 'resource://gre/modules/', 'jar:http://b.test/x.jar!/', 'ftp://b.test/', 'ws://b.test/', 'https:b.test', 'http:/b.test'];
  const bad = [];
  for (const url of urls) {
    const { r, prompts } = await watch(h.call('navigate', { tabId, url }));
    const now = await tabUrl();
    const leftSite = originOf(now) !== originOf(before);
    if (leftSite && !prompts.length)
      bad.push(`${JSON.stringify(url)} -> tab now on ${now} without a permission window`);
    if (prompts.length && !prompts.every(p => /^https?:\/\//.test(p.origin)))
      bad.push(`${JSON.stringify(url)} -> permission window for ${JSON.stringify(prompts.map(p => p.origin))}`);
    if (!r.isError && !prompts.length && !leftSite)
      bad.push(`${JSON.stringify(url)} -> no error, no prompt: ${r.text.slice(0, 120)}`);
    if (leftSite)
      await h.call('navigate', { tabId, url: before });
  }
  expect(!bad.length, bad.join('\n'));
}, { area: '1a' });

await test('protocol-relative and odd spellings ask about the real host', async () => {
  const cases = [[`//b.test:${P3}/x`, `https://b.test:${P3}`], [`HTTP://B.TEST:${P3}/x`, B], [`http://b.test:${P3}\\@a.test:${P3}/`, B], [`http://a.test:${P3}#@b.test:${P3}`, null], [`b.test:${P3}/x`, `https://b.test:${P3}`]];
  const bad = [];
  for (const [url, want] of cases) {
    const { prompts } = await watch(h.call('navigate', { tabId, url }));
    const shown = prompts.map(p => p.origin);
    if (want ? !(shown.length === 1 && shown[0] === want) : shown.length)
      bad.push(`${url}: expected ${want || 'no prompt'}, got ${JSON.stringify(shown)}`);
  }
  expect(!bad.length, bad.join('\n'));
}, { area: '1a' });

await test('redirect: approve A, A redirects to B; B is not readable without its own approval', async () => {
  const t0 = Date.now();
  const { r, prompts: navPrompts } = await watch(h.call('navigate', { tabId, url: `${A}/redirect?to=${encodeURIComponent(`${B}/hostile-title.html?r=1`)}` }));
  console.log(`      (navigate took ${Date.now() - t0} ms and opened ${navPrompts.length} permission window(s) itself: ${JSON.stringify(navPrompts.map(p => p.origin))})`);
  expect(!r.isError && r.text.includes(`ended up on ${B}`) && !r.text.includes('SECRET-B'), r.text);
  const calls = [['read_page', {}], ['find', { query: 'SECRET' }], ['get_page_text', {}], ['computer', { action: 'screenshot' }], ['computer', { action: 'left_click', coordinate: [50, 50] }], ['computer', { action: 'zoom', region: [0, 0, 300, 200] }], ['read_console_messages', {}], ['read_network_requests', {}], ['handle_dialog', { accept: true }], ['form_input', { ref: 'e1', value: 'x' }], ['javascript_tool', { action: 'javascript_exec', text: 'document.body.innerText' }]];
  const bad = [];
  for (const [tool, args] of calls) {
    const { r: res, prompts } = await watch(h.call(tool, { tabId, ...args }));
    if (!res.isError || res.text.includes('SECRET-B') || res.images.length)
      bad.push(`${tool}: ${res.isError ? 'error' : 'OK'} ${res.text.slice(0, 160)}${res.images.length ? ' [image returned]' : ''}`);
    if (!prompts.length || prompts.some(p => p.origin !== B))
      bad.push(`${tool}: expected one prompt for ${B}, got ${JSON.stringify(prompts.map(p => p.origin))}`);
  }
  expect(!bad.length, bad.join('\n'));
}, { area: '1a' });

await test('the page title shown in the permission window is labelled, short, and free of bidi/zero-width tricks', async () => {
  // The tab is on B (hostile title) from the redirect test.
  const read = h.call('read_page', { tabId });
  const info = await readPrompt(driver);
  await driver.answer('deny', info.w);
  await read;
  expect(info.tabline.startsWith('Page title (set by the website): “'), info.tabline);
  expect(info.tabline.length < 120, `title line too long (${info.tabline.length})`);
  const bidi = /[‪-‮⁦-⁩​-‏]/.exec(info.tabline);
  expect(!bidi, `the page title reaches the permission window with control character U+${bidi?.[0].codePointAt(0).toString(16).toUpperCase().padStart(4, '0')} (right-to-left override / zero-width); shown as ${JSON.stringify(info.tabline)}`);
}, { area: '1a' });

await test('navigate "back" into an unapproved site asks first (README: approve before the agent opens a site)', async () => {
  // History: ... A -> (redirect) B; now go to A, then back.
  await h.call('navigate', { tabId, url: `${A}/hostile-link.html?h=1` });
  const hitsBefore = xs.hits.filter(x => x.host.startsWith('b.test')).length;
  const { r, prompts } = await watch(h.call('navigate', { tabId, url: 'back' }));
  const hitsAfter = xs.hits.filter(x => x.host.startsWith('b.test')).length;
  const now = await tabUrl();
  const onB = originOf(now) === B;
  if (onB)
    await h.call('navigate', { tabId, url: `${A}/hostile-link.html` });
  console.log(`      (back: tab now ${now}; prompts ${JSON.stringify(prompts.map(p => p.origin))}; requests to B ${hitsAfter - hitsBefore}; tool: ${r.text.replace(/\n/g, ' ').slice(0, 160)})`);
  expect(!onB, `"back" loaded ${now} (B, never approved; ${hitsAfter - hitsBefore} request(s) reached B) without asking first (any window came afterwards, from the "on screen now" summary). Tool said: ${r.text.slice(0, 200)}`);
}, { area: '1a' });

await test('clicking a same-tab link to an unapproved site: no surprise permission window from the tool itself, returns promptly', async () => {
  await h.call('navigate', { tabId, url: `${A}/hostile-link.html` });
  const ref = refOf((await h.call('find', { tabId, query: 'Read the docs' })).text);
  const t0 = Date.now();
  const { r, prompts } = await watch(h.call('computer', { tabId, action: 'left_click', ref }));
  const ms = Date.now() - t0;
  expect(!r.text.includes('SECRET-B'), 'B content leaked: ' + r.text);
  expect(/hasn't approved/.test(r.text), 'the result should say B is not approved: ' + r.text.slice(0, 300));
  expect(!prompts.length && ms < 8000, `a plain click opened ${prompts.length} permission window(s) for ${JSON.stringify(prompts.map(p => p.origin))} and took ${ms} ms (the "on screen now" summary reads the new, unapproved page)`);
}, { area: '1a' });

await test('target=_blank link to an unapproved site asks before opening the tab', async () => {
  await h.call('navigate', { tabId, url: `${A}/hostile-link.html` });
  const ref = refOf((await h.call('find', { tabId, query: 'Docs in new tab' })).text);
  const before = (await h.call('tabs_context_mcp', {})).text;
  const { r, prompts } = await watch(h.call('computer', { tabId, action: 'left_click', ref }));
  const after = (await h.call('tabs_context_mcp', {})).text;
  expect(prompts.length === 1 && prompts[0].origin === B, JSON.stringify(prompts));
  expect(!after.includes('blanklink') || before.includes('blanklink'), 'a tab on B was created despite Deny:\n' + after);
  expect(/didn't/.test(r.text), r.text);
}, { area: '1a' });

await test('page navigates itself to B right after approval: B is never read without asking', async () => {
  const bad = [];
  const navPrompts = [];
  for (const ms of [0, 30, 120, 300, 700]) {
    const t0 = Date.now();
    const nv = await watch(h.call('navigate', { tabId, url: `${A}/hostile-nav.html?ms=${ms}` }));
    navPrompts.push(`ms=${ms}: navigate took ${Date.now() - t0} ms, prompts ${JSON.stringify(nv.prompts.map(p => p.origin))}, ${nv.r.text.replace(/\n/g, ' ').slice(0, 90)}`);
    if (nv.r.text.includes('SECRET-B'))
      bad.push(`ms=${ms} navigate returned B content`);
    for (const tool of ['read_page', 'get_page_text', 'find']) {
      const { r, prompts } = await watch(h.call(tool, { tabId, query: 'SECRET' }));
      if (r.text.includes('SECRET-B') && !prompts.length)
        bad.push(`ms=${ms} ${tool} returned B content without a prompt`);
    }
  }
  console.log('      ' + navPrompts.join('\n      '));
  expect(!bad.length, bad.join('\n'));
}, { area: '1f' });

await test('embedded frame navigates to an unapproved site after load: hidden and not clickable', async () => {
  await watch(h.call('navigate', { tabId, url: `${A}/hostile-frame-nav.html` }));
  const { r: early } = await watch(h.call('read_page', { tabId }));
  await sleep(2500); // the frame has gone to B
  const { r: late } = await watch(h.call('read_page', { tabId }));
  const { r: f } = await watch(h.call('find', { tabId, query: 'B-FRAME-SECRET button' }));
  const hitsBefore = xs.hits.filter(x => x.query.includes('bclicked')).length;
  const { r: click, prompts } = await watch(h.call('computer', { tabId, action: 'left_click', coordinate: [100, 120] }));
  await sleep(500);
  const clicked = xs.hits.filter(x => x.query.includes('bclicked')).length > hitsBefore;
  expect(early.text.includes('Inner A button') || /hidden until/.test(early.text), 'early read: ' + early.text.slice(0, 400));
  expect(!late.text.includes('B-FRAME-SECRET') && /hidden until the user approves/.test(late.text), 'late read: ' + late.text);
  expect(!/button "B-FRAME-SECRET/.test(f.text), 'find: ' + f.text);
  expect(prompts.length >= 1 && prompts[0].origin === B && !clicked && click.isError, `click into the B frame: prompts ${JSON.stringify(prompts.map(p => p.origin))}, clicked=${clicked}, ${click.text.slice(0, 200)}`);
}, { area: '1f' });

/** Decode a JPEG/PNG (base64) in the page and return the RGB at (x, y). */
async function pixel(ctx, b64, mime, x, y) {
  return JSON.parse(await driver.evalIn(ctx, `(async () => { const i = new Image(); i.src = 'data:${mime};base64,${b64}'; await i.decode(); const c = document.createElement('canvas'); c.width = i.width; c.height = i.height; const g = c.getContext('2d'); g.drawImage(i, 0, 0); return JSON.stringify([...g.getImageData(${x}, ${y}, 1, 1).data].slice(0, 3).concat([i.width, i.height])); })()`));
}

await test('screenshot of an approved page does not show an unapproved embedded frame (README: frames stay hidden until approved)', async () => {
  await h.call('navigate', { tabId, url: `${A}/hostile-shot.html` });
  await sleep(800);
  const shot = await h.call('computer', { tabId, action: 'screenshot' });
  expect(shot.images.length === 1, shot.text);
  fs.writeFileSync('test/results/gaps-shot-xorigin-frame.jpg', Buffer.from(shot.images[0].data, 'base64'));
  const ctx = await me.tabContext('hostile-shot.html');
  // The B frame is at CSS (0..400, 60..260); the screenshot may be scaled.
  const [r0, g0, b0, w] = await pixel(ctx, shot.images[0].data, 'image/jpeg', 1, 1);
  const vw = JSON.parse(await driver.evalIn(ctx, 'JSON.stringify(innerWidth)'));
  const s = w / vw;
  const [r, g, b] = await pixel(ctx, shot.images[0].data, 'image/jpeg', Math.round(200 * s), Math.round(160 * s));
  // Hidden would mean the page's white background shows there; anything else is the B frame's content.
  const magenta = !(r > 235 && g > 235 && b > 235);
  // Control: the same frame from the approved origin must show up (otherwise the check proves nothing).
  await h.call('navigate', { tabId, url: `${A}/hostile-shot.html?control` });
  const ctl = await h.call('computer', { tabId, action: 'screenshot' });
  const ctx2 = await me.tabContext('hostile-shot.html?control');
  await driver.evalIn(ctx2, `document.getElementById('bf').src = '/b-frame.html'`);
  await sleep(800);
  const ctl2 = await h.call('computer', { tabId, action: 'screenshot' });
  fs.writeFileSync('test/results/gaps-shot-control-frame.jpg', Buffer.from(ctl2.images[0].data, 'base64'));
  const [cr, cg, cb] = await pixel(ctx2, ctl2.images[0].data, 'image/jpeg', Math.round(200 * s), Math.round(160 * s));
  console.log(`      (cross-origin B frame pixel rgb(${r},${g},${b}); same-origin control frame pixel rgb(${cr},${cg},${cb}))`);
  void ctl;
  void magenta;
  // Hidden means Foxwright greyed the frame out (dark grey with stripes, never the frame's own light
  // button) and said so in the result.
  const masked = r < 160 && g < 160 && b < 160 && Math.abs(r - g) < 20 && Math.abs(g - b) < 20;
  const visibleInControl = cr > 180 && cg > 180 && cb > 180;
  expect(visibleInControl, `control: an approved frame should be visible, got rgb(${cr},${cg},${cb})`);
  expect(masked && /hasn't approved/.test(shot.text), `the screenshot shows the unapproved B frame (pixel at its centre is rgb(${r},${g},${b}); result text: ${shot.text.slice(0, 200)}; see test/results/gaps-shot-xorigin-frame.jpg). read_page hides this frame, the screenshot must too.`);
}, { area: '1f' });

await test('permission window buttons ignore clicks for the first moment, then work (click-jack guard timing)', async () => {
  await h.call('navigate', { tabId, url: `${A}/hostile-link.html` });
  const nav = h.call('navigate', { tabId, url: `${C}/b-frame.html?delay` });
  const w = await driver.promptWindow();
  const t0 = Date.now();
  // A person's click lands on "Allow this session" right as the window appears.
  const rect = JSON.parse(await driver.evalIn(w.context, `(() => { const r = document.getElementById('once').getBoundingClientRect(); return JSON.stringify({ x: r.left + r.width / 2, y: r.top + r.height / 2, disabled: document.getElementById('once').disabled, since: performance.now() }); })()`));
  await me.click(w.context, rect.x, rect.y).catch(() => {});
  console.log(`      (person's click lands ${Math.round(rect.since)} ms after the window document started; button disabled at that moment: ${rect.disabled})`);
  const tClick = Date.now() - t0;
  await sleep(150);
  const stillOpen = await promptOpen(driver);
  let enabledAt = null;
  for (let i = 0; i < 100; i++) {
    if (!(await driver.evalIn(w.context, `document.getElementById('once').disabled`).catch(() => true))) {
      enabledAt = Date.now() - t0;
      break;
    }
    await sleep(20);
  }
  // Losing focus disarms the buttons again (another window, e.g. one the page opened, takes focus).
  const tabCtx = await me.tabContext('hostile-link.html');
  await driver.bidi('browsingContext.activate', { context: tabCtx }).catch(() => {});
  await sleep(150);
  const disarmed = await driver.evalIn(w.context, `document.getElementById('once').disabled`).catch(() => null);
  await driver.bidi('browsingContext.activate', { context: w.context }).catch(() => {});
  if (stillOpen)
    await driver.answer('deny', w).catch(() => {});
  const r = await nav;
  if (!stillOpen && rect.disabled)
    throw new Error(`the person's click on a still-disabled "Allow this session" button was accepted: ${r.text.slice(0, 160)}`);
  expect(stillOpen || !rect.disabled, `an early click (${tClick} ms after the window appeared) was accepted`);
  expect(enabledAt !== null && enabledAt >= 500, `buttons enabled after ${enabledAt} ms (expected about 800 ms)`);
  expect(r.isError, r.text);
  console.log(`      (early click at ${tClick} ms ignored; buttons enabled after ~${enabledAt} ms; disabled again after focus moved away: ${disarmed})`);
  expect(disarmed === true, 'buttons should disarm when the window loses focus');
}, { area: '1b' });

await test('a page that keeps focusing itself does not keep the permission window disarmed forever', async () => {
  await h.call('navigate', { tabId, url: `${A}/focus-steal.html` });
  const nav = h.call('navigate', { tabId, url: `${C}/b-frame.html?steal` });
  const w = await driver.promptWindow();
  let armed = false;
  for (let i = 0; i < 100 && !armed; i++) {
    armed = !(await driver.evalIn(w.context, `document.getElementById('once').disabled`).catch(() => true));
    await sleep(50);
  }
  await driver.answer('deny', w).catch(() => {});
  await nav;
  expect(armed, 'the buttons never became usable within 5 s while the page stole focus');
}, { area: '1b' });

await test('a page-made look-alike window cannot answer the real permission window', async () => {
  await h.call('navigate', { tabId, url: `${A}/hostile-fakeprompt.html` });
  const ctx = await me.tabContext('hostile-fakeprompt.html');
  await me.click(ctx, 150, 40); // the person clicks "Continue": the page opens its fake window
  await sleep(800);
  const fake = (await driver.contexts()).find(x => x.url.includes('fake-prompt.html'));
  const nav = h.call('navigate', { tabId, url: `${C}/b-frame.html?fake` });
  const real = await driver.promptWindow();
  if (fake)
    await driver.evalIn(fake.context, `document.getElementById('always').click()`);
  await sleep(1200);
  const stillPending = await promptOpen(driver);
  await driver.answer('deny', real);
  const r = await nav;
  const group = (await h.call('tabs_context_mcp', {})).text;
  expect(fake, 'the page could not even open its window (popup blocked)');
  expect(stillPending && r.isError, `the fake window's "Always allow" affected the real request: ${r.text}`);
  console.log(`      (the page's popup ${/fake-prompt/.test(group) ? 'joined' : 'did not join'} the Foxwright tab group)`);
}, { area: '1b' });

await test('hostile page: prototype pollution, JSON/Promise/addEventListener overrides and forged hook state do not break or fool Foxwright', async () => {
  await h.call('navigate', { tabId, url: `${A}/hostile-hooks.html` });
  const page = await h.call('read_page', { tabId });
  expect(!page.isError && page.text.includes('Delete everything'), page.text.slice(0, 300));
  const nameRef = refOf((await h.call('find', { tabId, query: 'Name' })).text);
  const fi = await h.call('form_input', { tabId, ref: nameRef, value: 'Ada' });
  expect(!fi.isError, fi.text);
  const goRef = refOf((await h.call('find', { tabId, query: 'Delete everything' })).text);
  const t0 = Date.now();
  const click = await h.call('computer', { tabId, action: 'left_click', ref: goRef });
  const ms = Date.now() - t0;
  const con = await h.call('read_console_messages', {});
  const still = await h.call('read_page', { tabId });
  const ctx = await me.tabContext('hostile-hooks.html');
  const detect = await driver.evalIn(ctx, 'detect()');
  console.log(`      (what the page can see of Foxwright: ${JSON.stringify(detect)})`);
  expect(!click.isError && ms < 5000, `click: ${ms} ms ${click.text}`);
  expect(!/FORGED/.test(click.text + con.text), 'forged dialog/console entries reached the agent: ' + click.text + con.text);
  expect(!still.isError && !/paused/i.test(still.text), 'spoofed messages paused or broke Foxwright: ' + still.text.slice(0, 200));
  expect(/textbox "Name"[^\n]*Ada/.test(still.text), 'form_input value not visible: ' + still.text.slice(0, 500));
}, { area: '1g' });

driver.close();
await h.stop();
xs.close();
process.exit(finish());
