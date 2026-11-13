// A minimal WebDriver BiDi client for tests that need to act like the person at the computer:
// pressing buttons in Foxwright's permission window or toolbar popup (extension pages that web
// pages and the agent can't reach). Needs Firefox started by the harness with `testDriver: true`.
import { WebSocket } from './ws-shim.mjs';

const sleep = ms => new Promise(r => setTimeout(r, ms));

export async function connectDriver(url) {
  const ws = new WebSocket(url);
  await new Promise((resolve, reject) => {
    ws.addEventListener('open', resolve);
    ws.addEventListener('error', reject);
  });
  let nextId = 0;
  const pending = new Map();
  ws.addEventListener('message', (e) => {
    const m = JSON.parse(e.data);
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
  await bidi('session.new', { capabilities: {} });

  const contexts = async () => (await bidi('browsingContext.getTree', {})).contexts;
  async function evalIn(context, expression) {
    const r = await bidi('script.evaluate', { expression, target: { context }, awaitPromise: true });
    if (r.type === 'exception')
      throw new Error(`evaluate failed: ${r.exceptionDetails?.text}`);
    return r.result?.value;
  }
  /** Wait for Foxwright's permission window; returns its browsing context ({ context, url }). */
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
  /**
   * Press a button in the permission window ('deny' | 'once' | 'always' | 'hour'), waiting until it's
   * enabled. { readOnly: true } first ticks "Read only (no clicking or typing)", like a person would.
   */
  async function answer(button, w, { readOnly = false } = {}) {
    w = w || await promptWindow();
    // A person looks at the window first: bring it to the front so its buttons arm (headful runs).
    await bidi('browsingContext.activate', { context: w.context }).catch(() => {});
    for (let i = 0; i < 100 && await evalIn(w.context, `document.getElementById('${button}').disabled`); i++)
      await sleep(50);
    if (readOnly) {
      if (await evalIn(w.context, `document.getElementById('readonly-row').hidden`))
        throw new Error('this window has no "Read only" choice');
      await evalIn(w.context, `(() => { const c = document.getElementById('readonly'); if (!c.checked) c.click(); return c.checked; })()`);
    }
    await evalIn(w.context, `document.getElementById('${button}').click()`);
    return w;
  }
  /** What the permission window shows (waits until it has filled itself in). */
  async function readWindow(w) {
    w = w || await promptWindow();
    for (let i = 0; i < 100; i++) {
      const v = await evalIn(w.context, `JSON.stringify((() => { const $ = (x) => document.getElementById(x); return {
        origin: $('origin').textContent, title: $('title').textContent, body: $('body').textContent, tabline: $('tabline').textContent,
        readOnlyShown: !$('readonly-row').hidden, readOnlyChecked: $('readonly').checked,
        alwaysShown: !$('always').hidden, hourShown: !$('hour').hidden, once: $('once').textContent,
        element: $('element').hidden ? '' : $('elname').textContent, reason: $('elreason').textContent,
        summary: $('summary').hidden ? '' : $('summary').textContent,
        buttons: [...document.querySelectorAll('.actions button')].filter(b => !b.hidden).map(b => b.textContent) }; })())`).catch(() => null);
      if (v) {
        const o = JSON.parse(v);
        if (o.origin)
          return { ...o, w };
      }
      await sleep(50);
    }
    throw new Error('the permission window never filled in');
  }
  /** Keep answering every permission window with `button` until stopped (a scripted user). */
  function autoAnswer(button = 'once') {
    let stopped = false;
    let count = 0;
    (async () => {
      while (!stopped) {
        try {
          const w = (await contexts()).find(x => x.url.includes('/prompt/prompt.html'));
          if (w) {
            await answer(button, w);
            count++;
          }
        } catch { /* window closed meanwhile */ }
        await sleep(250);
      }
    })();
    return { stop: () => { stopped = true; }, get count() { return count; } };
  }
  return { bidi, contexts, evalIn, promptWindow, answer, readWindow, autoAnswer, close: () => ws.close() };
}
