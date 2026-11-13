// Trusted input (WebDriver BiDi owned by the MCP server) vs the safety controls.
// The test has no BiDi session of its own here (Firefox allows one), so the person acts through
// real X11 input (xdotool: Alt+Shift+K), and pages report what they received to the fixture server.
// Each scenario gets a fresh Firefox, because nothing can press Resume without a BiDi session.
//
//   FIREFOX=... ZENKO_E2E_HEADFUL=1 xvfb-run -a -s "-screen 0 1400x900x24" node test/e2e-gaps-trusted.mjs
import { start } from './harness.mjs';
import { runner, extraServer, x11, sleep, expect, refOf, tabIdOf } from './gap-lib.mjs';

const { test, skip, finish } = runner('e2e-gaps-trusted');
const P1 = process.env.ZENKO_P1, P2 = process.env.ZENKO_P2;
const xs = await extraServer(P1, P2);
const { P3 } = xs;
const A = `http://a.test:${P3}`;
console.log('Zenko gap tests: trusted (BiDi) input vs Stop / Alt+Shift+K / the pill / focus');

/** Latest value a page reported for a beacon key (e.g. len, tabs, bar). */
function beacon(key, since = 0) {
  let v = null;
  for (const hit of xs.hits) {
    if (hit.at < since)
      continue;
    const m = new RegExp(`[?&]${key}=([^&]*)`).exec(hit.query);
    if (m)
      v = decodeURIComponent(m[1]);
  }
  return v;
}
async function waitBeacon(key, pred, ms = 8000, since = 0) {
  const t0 = Date.now();
  while (Date.now() - t0 < ms) {
    const v = beacon(key, since);
    if (v !== null && pred(v))
      return v;
    await sleep(20);
  }
  return beacon(key, since);
}
async function fresh(policy = { mode: 'all', confirmUploads: false }) {
  const h = await start({ trusted: true, policy });
  const ctx = await h.call('tabs_context_mcp', { createIfEmpty: true });
  if (!/Input mode: trusted/.test(ctx.text))
    throw new Error('trusted input did not start: ' + ctx.text);
  return { h, tabId: tabIdOf(ctx.text) };
}

if (!x11.available()) {
  skip('trusted-mode Stop tests', 'need headful Firefox under X11 with xdotool');
} else {
  await test('trusted typing: Alt+Shift+K mid-way stops it and the agent is told', async () => {
    const { h, tabId } = await fresh();
    try {
      const since = Date.now();
      await h.call('navigate', { tabId, url: `${A}/beacon-field.html?t1` });
      await h.call('computer', { tabId, action: 'left_click', ref: refOf((await h.call('find', { tabId, query: 'Field' })).text) });
      const typing = h.call('computer', { tabId, action: 'type', text: 'q'.repeat(3000) });
      const at = await waitBeacon('len', v => Number(v) > 0, 10000, since);
      x11.key('alt+shift+k');
      const r = await typing;
      await sleep(1500);
      const final = Number(await waitBeacon('len', () => false, 1500, since));
      const later = await h.call('read_page', { tabId });
      console.log(`      (Alt+Shift+K at ${at} chars; final ${final} of 3000; result: ${r.isError ? 'error' : 'success'}: ${r.text.slice(0, 100)}; later call paused: ${/paused/i.test(later.text)})`);
      expect(/paused/i.test(later.text), 'the shortcut did not pause Zenko at all: ' + later.text.slice(0, 80));
      expect(final < 3000 && r.isError, `typing went on to ${final} of 3000 characters after the person pressed Alt+Shift+K at ${at}, and the agent was told: ${r.isError ? 'error' : 'SUCCESS'} "${r.text.slice(0, 90)}"`);
    } finally {
      await h.stop();
    }
  }, { area: '2-trusted' });

  await test('trusted key repeat (Tab x100): Alt+Shift+K mid-way stops it', async () => {
    const { h, tabId } = await fresh();
    try {
      const since = Date.now();
      await h.call('navigate', { tabId, url: `${A}/beacon-field.html?t2` });
      await h.call('computer', { tabId, action: 'left_click', ref: refOf((await h.call('find', { tabId, query: 'Field' })).text) });
      const keys = h.call('computer', { tabId, action: 'key', text: 'Tab', repeat: 100 });
      const at = await waitBeacon('tabs', v => Number(v) > 0, 10000, since);
      x11.key('alt+shift+k');
      const r = await keys;
      await sleep(1500);
      const final = Number(await waitBeacon('tabs', () => false, 1500, since));
      console.log(`      (Alt+Shift+K after ${at} Tabs; final ${final} of 100; result: ${r.isError ? 'error' : 'success'}: ${r.text.slice(0, 100)})`);
      expect(final < 100 && r.isError, `${final} of 100 Tab presses landed after Stop at ${at}; agent told: ${r.isError ? 'error' : 'SUCCESS'}`);
    } finally {
      await h.stop();
    }
  }, { area: '2-trusted' });
}

await test('trusted click on a page button under the faded pill reaches the page (and does not pause Zenko)', async () => {
  const { h, tabId } = await fresh();
  try {
    const since = Date.now();
    await h.call('navigate', { tabId, url: `${A}/beacon-field.html?t3` });
    const ref = refOf((await h.call('find', { tabId, query: 'Bottom bar' })).text);
    await sleep(7500); // the pill fades after 6 s without agent activity
    const r = await h.call('computer', { tabId, action: 'left_click', ref });
    await sleep(800);
    const bar = Number(await waitBeacon('bar', v => Number(v) > 0, 1500, since));
    const later = await h.call('read_page', { tabId });
    const paused = /paused/i.test(later.text);
    console.log(`      (click result: ${r.text.replace(/\n/g, ' ').slice(0, 120)}; page counted ${bar} click(s); Zenko paused: ${paused})`);
    expect(bar >= 1 && !paused, `the agent's own trusted click on the page's bottom bar ${paused ? 'PAUSED ZENKO (it hit the invisible Stop pill)' : 'did not pause'}; the page got ${bar} click(s)`);
  } finally {
    await h.stop();
  }
}, { area: '1/2-pill' });

await test('trusted click on a small bottom-centre page button (fully under the faded pill) reaches the page', async () => {
  const { h, tabId } = await fresh();
  try {
    const since = Date.now();
    await h.call('navigate', { tabId, url: `${A}/beacon-field.html?t3small` });
    const ref = refOf((await h.call('find', { tabId, query: 'Bottom bar' })).text);
    await sleep(7500); // the pill fades after 6 s without agent activity
    const r = await h.call('computer', { tabId, action: 'left_click', ref });
    await sleep(800);
    const bar = Number(await waitBeacon('bar', v => Number(v) > 0, 1500, since));
    const later = await h.call('read_page', { tabId });
    const paused = /paused/i.test(later.text);
    console.log(`      (click result: ${r.text.replace(/\n/g, ' ').slice(0, 120)}; page counted ${bar} click(s); Zenko paused: ${paused})`);
    expect(bar >= 1 && !paused, `the agent's own trusted click on the page's bottom bar ${paused ? 'PAUSED ZENKO (it hit the invisible Stop pill)' : 'did not pause'}; the page got ${bar} click(s)`);
  } finally {
    await h.stop();
  }
}, { area: '1/2-pill' });

await test('trusted typing into an approved page does not leak keystrokes to an unapproved frame that grabs focus', async () => {
  const { h, tabId } = await fresh({ mode: 'ask', promptTimeoutSec: 5, allowed: [A] });
  try {
    const since = Date.now();
    await h.call('navigate', { tabId, url: `${A}/steal-parent.html` });
    await sleep(1500);
    const ref = refOf((await h.call('find', { tabId, query: 'Message' })).text);
    await h.call('computer', { tabId, action: 'left_click', ref });
    const r = await h.call('computer', { tabId, action: 'type', text: 'my-secret-reply-to-the-bank' });
    await sleep(1500);
    const stolen = xs.hits.filter(x => x.at >= since && /b-got=/.test(x.query)).map(x => decodeURIComponent(/b-got=([^&]*)/.exec(x.query)[1])).join('');
    const page = await h.call('read_page', { tabId });
    const landed = (/textbox "Message"[^\n]*?: "?([^"\n]*)/.exec(page.text) || [])[1] || '';
    console.log(`      (type result: ${r.text.replace(/\n/g, ' ').slice(0, 120)}; A's field got ${JSON.stringify(landed)}; the unapproved frame got ${JSON.stringify(stolen)})`);
    expect(!stolen, `keystrokes reached the unapproved b.test frame: ${JSON.stringify(stolen)}`);
  } finally {
    await h.stop();
  }
}, { area: '1-trusted' });

xs.close();
process.exit(finish());
