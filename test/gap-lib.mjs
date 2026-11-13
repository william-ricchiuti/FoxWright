// Shared helpers for the gap suites (e2e-gaps-*.mjs): a test runner, an extra fixture server
// with redirects and a hit log, and "person at the computer" helpers (BiDi, xdotool).
//
// Hostnames: the suites use a.test, sub.a.test, b.test, c.test and xn--pple-43d.test, which must
// resolve to 127.0.0.1 (add them to /etc/hosts in the test container).
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

export const sleep = ms => new Promise(r => setTimeout(r, ms));
export const expect = (c, m) => { if (!c) throw new Error(m); };
export const refOf = (t, re = /\[ref=([^\]]+)\]/) => (re.exec(t || '') || [])[1];
const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

export function runner(suite) {
  const results = [];
  async function test(name, fn, { area = '', expectFail = false } = {}) {
    const t0 = Date.now();
    try {
      await fn();
      results.push({ name, area, ok: true, ms: Date.now() - t0 });
      console.log(`  ✓ ${name}`);
    } catch (e) {
      results.push({ name, area, ok: false, ms: Date.now() - t0, err: e.message });
      console.log(`  ✗ ${name}\n      ${String(e.message).split('\n').join('\n      ')}`);
    }
  }
  function skip(name, why, { area = '' } = {}) {
    results.push({ name, area, ok: null, skipped: why });
    console.log(`  - ${name} (not testable here: ${why})`);
  }
  function finish() {
    const passed = results.filter(r => r.ok === true).length;
    const failed = results.filter(r => r.ok === false).length;
    const skipped = results.filter(r => r.ok === null).length;
    console.log(`\n${suite}: ${passed} passed, ${failed} failed, ${skipped} not testable`);
    fs.mkdirSync(path.join(root, 'test/results'), { recursive: true });
    fs.writeFileSync(path.join(root, `test/results/${suite}.json`), JSON.stringify(results, null, 2));
    return failed ? 1 : 0;
  }
  return { test, skip, finish, results };
}

/**
 * A third fixture server (port P3), reachable under several host names. Routes:
 *   /redirect?to=URL[&code=302]  HTTP redirect
 *   /log?...                      records the hit (see hits) and returns 204
 *   /<fixture file>               test/fixtures file, with :8765/:8766/:8767 replaced by the real ports
 */
export async function extraServer(P1, P2) {
  const hits = [];
  const flips = {};
  const fixtures = path.join(root, 'test', 'fixtures');
  let P3;
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    hits.push({ host: req.headers.host, path: u.pathname, query: u.search, cookie: req.headers.cookie || '', at: Date.now() });
    if (u.pathname === '/redirect') {
      res.writeHead(Number(u.searchParams.get('code') || 302), { location: u.searchParams.get('to') });
      return res.end();
    }
    if (u.pathname === '/flipjson') {
      // First request: JSON from this origin. Later ones: a redirect elsewhere (a TOCTOU for re-fetches).
      const key = u.search;
      flips[key] = (flips[key] || 0) + 1;
      if (flips[key] === 1) {
        res.writeHead(200, { 'content-type': 'application/json' });
        return res.end(JSON.stringify({ from: 'approved site', n: 1 }));
      }
      res.writeHead(302, { location: u.searchParams.get('to') });
      return res.end();
    }
    if (u.pathname === '/log') {
      res.writeHead(204, { 'access-control-allow-origin': '*' });
      return res.end();
    }
    if (u.pathname === '/setcookie') {
      res.writeHead(200, { 'set-cookie': `zsess=${u.searchParams.get('v') || 'secret'}; Path=/; SameSite=Lax`, 'content-type': 'text/html' });
      return res.end('<title>cookie set</title>cookie set');
    }
    const p = path.join(fixtures, decodeURIComponent(u.pathname));
    if (!p.startsWith(fixtures) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
      res.writeHead(404);
      return res.end('not found');
    }
    const ct = { html: 'text/html; charset=utf-8', js: 'text/javascript', json: 'application/json' }[path.extname(p).slice(1)] || 'application/octet-stream';
    res.writeHead(200, { 'content-type': ct });
    if (p.endsWith('.html'))
      return res.end(fs.readFileSync(p, 'utf8').replaceAll(':8765', `:${P1}`).replaceAll(':8766', `:${P2}`).replaceAll(':8767', `:${P3}`));
    fs.createReadStream(p).pipe(res);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  P3 = server.address().port;
  return { P3, hits, close: () => server.close() };
}

/** The person at the computer, through the test's own WebDriver BiDi session. */
export function person(driver) {
  const { bidi, contexts, evalIn } = driver;
  /** BiDi context of the content tab whose URL contains `needle`. */
  async function tabContext(needle, ms = 10000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const c = (await contexts()).find(x => x.url.includes(needle));
      if (c)
        return c.context;
      await sleep(50);
    }
    throw new Error(`no browsing context with URL containing ${needle}`);
  }
  /** A real (trusted) mouse click at viewport CSS pixels of a context. */
  async function click(context, x, y) {
    await bidi('input.performActions', { context, actions: [{ type: 'pointer', id: 'person-mouse', parameters: { pointerType: 'mouse' }, actions: [{ type: 'pointerMove', x: Math.round(x), y: Math.round(y), origin: 'viewport', duration: 0 }, { type: 'pointerDown', button: 0 }, { type: 'pointerUp', button: 0 }] }] });
    await bidi('input.releaseActions', { context }).catch(() => {});
  }
  async function keys(context, values) {
    const acts = [];
    for (const v of values)
      acts.push({ type: 'keyDown', value: v });
    for (const v of [...values].reverse())
      acts.push({ type: 'keyUp', value: v });
    await bidi('input.performActions', { context, actions: [{ type: 'key', id: 'person-keys', actions: acts }] });
  }
  /** Run JS in an extension page we opened (toolbar popup as a window): it has the browser.* APIs. */
  let extCtx = null;
  async function extPage(extBase) {
    if (extCtx)
      return extCtx;
    const { context } = await bidi('browsingContext.create', { type: 'window' });
    await bidi('browsingContext.navigate', { context, url: `${extBase}popup/popup.html`, wait: 'complete' });
    extCtx = context;
    return context;
  }
  async function ext(extBase, expr) {
    return evalIn(await extPage(extBase), `(async () => JSON.stringify(await (async () => { ${expr} })()))()`).then(v => (v === undefined ? undefined : JSON.parse(v)));
  }
  async function shot(context, file) {
    const r = await bidi('browsingContext.captureScreenshot', { context });
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  }
  return { tabContext, click, keys, extPage, ext, shot, evalIn, bidi, contexts };
}

/** Wait for the permission window and read what it shows; null if none appears within ms. */
export async function readPrompt(driver, ms = 8000) {
  let w;
  try {
    w = await driver.promptWindow(ms);
  } catch {
    return null;
  }
  for (let i = 0; i < 60; i++) {
    const info = await driver.evalIn(w.context, `JSON.stringify({ origin: document.getElementById('origin').textContent, title: document.getElementById('title').textContent, body: document.getElementById('body').textContent, tabline: document.getElementById('tabline').textContent, files: document.getElementById('files').textContent, disabled: document.getElementById('once').disabled, docTitle: document.title })`).catch(() => null);
    if (info) {
      const o = JSON.parse(info);
      if (o.origin || o.files)
        return { ...o, w };
    }
    await sleep(50);
  }
  return { w };
}

export async function promptOpen(driver) {
  return (await driver.contexts()).some(x => x.url.includes('/prompt/prompt.html'));
}

/** Real X11 input (headful Firefox under Xvfb): the only way a test can press Alt+Shift+K. */
export const x11 = {
  available: () => !!process.env.DISPLAY && (() => { try { execFileSync('which', ['xdotool']); return true; } catch { return false; } })(),
  key: (combo) => execFileSync('xdotool', ['key', '--clearmodifiers', combo]),
  click: (x, y) => execFileSync('xdotool', ['mousemove', String(Math.round(x)), String(Math.round(y)), 'click', '1']),
};

/** Discover moz-extension://<uuid>/ by provoking one permission window and denying it. */
export async function discoverExtBase(h, driver, tabId, url) {
  const nav = h.call('navigate', { tabId, url });
  const w = await driver.promptWindow();
  await driver.answer('deny', w);
  await nav;
  return w.url.replace(/prompt\/prompt\.html.*$/, '');
}

/** Run JS in Firefox's own chrome window (needs MOZ_REMOTE_ALLOW_SYSTEM_ACCESS, set by the harness's testDriver). */
export async function chromeEval(driver, expression) {
  const t = await driver.bidi('browsingContext.getTree', { 'moz:scope': 'chrome' });
  const ctx = t.contexts.find(c => c.url === 'chrome://browser/content/browser.xhtml') || t.contexts[0];
  const r = await driver.bidi('script.evaluate', { expression, target: { context: ctx.context }, awaitPromise: true });
  if (r.type === 'exception')
    throw new Error(`chrome evaluate failed: ${r.exceptionDetails?.text}`);
  return r.result?.value;
}

/** moz-extension://<uuid>/ of the Zenko build under test, read from Firefox itself. */
export async function extBaseOf(driver) {
  const host = await chromeEval(driver, `(WebExtensionPolicy.getByID('kitsune-full@william-ricchiuti.com') || WebExtensionPolicy.getByID('kitsune@william-ricchiuti.com')).mozExtensionHostname`);
  return `moz-extension://${host}/`;
}

/**
 * Like bidi-driver's connectDriver, but leaves page dialogs alone (unhandledPromptBehavior
 * "ignore") so a test can see whether a real confirm()/alert() appeared, and records events.
 */
export async function connectPerson(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  let nextId = 0;
  const pending = new Map();
  const events = [];
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
    if (m.type === 'event')
      events.push({ ...m, at: Date.now() });
    if (pending.has(m.id)) {
      pending.get(m.id)(m);
      pending.delete(m.id);
    }
  });
  const bidi = (method, params) => new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, (m) => (m.type === 'error' ? reject(new Error(`${method}: ${m.message}`)) : resolve(m.result)));
    ws.send(JSON.stringify({ id, method, params }));
  });
  await bidi('session.new', { capabilities: { alwaysMatch: { unhandledPromptBehavior: { default: 'ignore' } } } });
  await bidi('session.subscribe', { events: ['browsingContext.userPromptOpened', 'browsingContext.userPromptClosed'] });
  const contexts = async () => (await bidi('browsingContext.getTree', {})).contexts;
  async function evalIn(context, expression) {
    const r = await bidi('script.evaluate', { expression, target: { context }, awaitPromise: true });
    if (r.type === 'exception')
      throw new Error(`evaluate failed: ${r.exceptionDetails?.text}`);
    return r.result?.value;
  }
  async function promptWindow(ms = 10000) {
    const t0 = Date.now();
    while (Date.now() - t0 < ms) {
      const c = (await contexts()).find(x => x.url.includes('/prompt/prompt.html'));
      if (c)
        return c;
      await sleep(30);
    }
    throw new Error('no permission window appeared');
  }
  async function answer(button, w) {
    w = w || await promptWindow();
    // A person looks at the window first: bring it to the front so its buttons arm.
    await bidi('browsingContext.activate', { context: w.context }).catch(() => {});
    for (let i = 0; i < 100 && await evalIn(w.context, `document.getElementById('${button}').disabled`); i++)
      await sleep(50);
    await evalIn(w.context, `document.getElementById('${button}').click()`);
    return w;
  }
  return { bidi, contexts, evalIn, promptWindow, answer, events, close: () => ws.close() };
}

export const tabIdOf = (t) => Number((/tabId (\d+)/.exec(t) || /Created tab (\d+)/.exec(t) || [])[1]);
