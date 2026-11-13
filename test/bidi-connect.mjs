// The MCP server's WebDriver BiDi client against a fake Firefox that, like the real one, allows only
// one session at a time. Regression test for a race: the startup probe and the first tool call
// both tried to connect at once, the second got "Maximum number of active sessions", and the
// first session was stranded, so real input stayed off for the whole run (seen in CI).
//   node test/bidi-connect.mjs      (no Firefox needed)
import { createRequire } from 'node:module';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { WebSocketServer } = createRequire(path.join(root, 'host', 'package.json'))('ws');

const server = new WebSocketServer({ host: '127.0.0.1', port: 0, path: '/session' });
await new Promise(r => server.once('listening', r));
const port = server.address().port;

let active = null; // the socket that owns the single session
let sessionsCreated = 0;
// A tiny model of one Firefox's browsing contexts, for the context-cache and input tests.
const ff = { contexts: [], probe: new Map(), performed: [], onPerform: null };
server.on('connection', (ws) => {
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
    const ok = (result) => ws.send(JSON.stringify({ type: 'success', id: msg.id, result }));
    if (msg.method === 'browsingContext.getTree') {
      const list = msg.params.root ? ff.contexts.filter(c => c.context === msg.params.root) : ff.contexts;
      return ok({ contexts: list.map(c => ({ context: c.context, url: c.url, children: [] })) });
    }
    if (msg.method === 'script.evaluate')
      return ok({ type: 'success', result: { type: 'string', value: ff.probe.get(msg.params.target.context) ?? null } });
    if (msg.method === 'input.performActions') {
      ff.performed.push(msg.params);
      ff.onPerform?.(msg.params, ws);
      return ok({});
    }
    if (msg.method === 'session.new') {
      // Answer a little later, so overlapping attempts really overlap.
      setTimeout(() => {
        if (active && active !== ws)
          return ws.send(JSON.stringify({ type: 'error', id: msg.id, error: 'session not created', message: 'Maximum number of active sessions' }));
        active = ws;
        sessionsCreated++;
        ws.send(JSON.stringify({ type: 'success', id: msg.id, result: { sessionId: 's1', capabilities: { browserName: 'firefox' } } }));
      }, 50);
    } else {
      ws.send(JSON.stringify({ type: 'success', id: msg.id, result: {} }));
    }
  });
  ws.on('close', () => {
    if (active === ws)
      active = null;
  });
});

process.env.FOXWRIGHT_BIDI_URL = `ws://127.0.0.1:${port}/session`;
const { Bidi } = await import(path.join(root, 'host', 'src', 'bidi.js'));

let failed = 0;
const check = (ok, name, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      ${detail}`}`);
  if (!ok)
    failed++;
};

console.log('Foxwright BiDi connection');
const bidi = new Bidi();
// The startup probe and the first tool calls, all at the same moment.
const results = await Promise.all([bidi.available(), bidi.available(), bidi.available()]);
check(results.every(Boolean), 'concurrent connection attempts all report real input on', `results: ${JSON.stringify(results)}, last error: ${bidi.lastError}`);
check(sessionsCreated === 1, 'only one session is created', `sessions created: ${sessionsCreated}`);
check(await bidi.available(), 'still connected afterwards', `last error: ${bidi.lastError}`);

// ---------- contexts are cached per browser ----------
// Two Firefox profiles: "Work" runs with remote debugging (the BiDi session above), "Personal"
// doesn't. Tab ids restart per profile, so both have a tab 5. After the agent moves to Personal,
// tab 5 must not resolve to Work's cached context (real input would go to the wrong profile).
ff.contexts = [{ context: 'work-tab-5', url: 'http://a.test/' }];
const fakeHelper = {
  browserId: 'work0000000a',
  generation: 1,
  scopeKey() { return `${this.browserId}#${this.generation}`; },
  async call(tool, args) {
    // Only Work's tabs live in the Firefox the BiDi session talks to.
    if (tool === '_mark' && this.browserId === 'work0000000a' && args.tabId === 5)
      ff.probe.set('work-tab-5', args.token);
    if (tool === '_unmark')
      ff.probe.clear();
    return { data: true };
  },
};
check(await bidi.contextFor(5, fakeHelper) === 'work-tab-5', 'finds the context of a tab by probing it');
fakeHelper.browserId = 'personal000b'; // select_browser / switch_browser / failover...
fakeHelper.generation++; // ...always means a new helper connection
const other = await bidi.contextFor(5, fakeHelper).then(c => c, e => e);
check(other instanceof Error && /Could not match/.test(other.message), 'after a browser switch, the same tab id is probed again instead of reusing the other profile\'s context', `got ${other}`);

// ---------- typing in chunks, with a check before each and after every Enter ----------
const chunks = [];
const progress = {};
await bidi.type('work-tab-5', 'ab\ncd', async ({ afterEnter }) => { chunks.push(afterEnter); }, progress);
const typed = ff.performed.slice(-2).map(p => p.actions[0].actions.filter(x => x.type === 'keyDown').map(x => x.value === '' ? '⏎' : x.value).join(''));
check(JSON.stringify(typed) === '["ab⏎","cd"]' && JSON.stringify(chunks) === '[false,true]' && progress.sent === 5, 'a chunk ends at each Enter, and the next check knows it followed an Enter', `chunks ${JSON.stringify(typed)}, afterEnter ${JSON.stringify(chunks)}, sent ${progress.sent}`);
const stopAt = await bidi.type('work-tab-5', 'x'.repeat(30) + '\n' + 'y'.repeat(30), async ({ afterEnter }) => { if (afterEnter) throw new Error('moved'); }, progress).then(() => null, e => e);
check(stopAt?.message === 'moved' && progress.sent === 31, 'a check that throws stops typing, and progress says how much was delivered', `error ${stopAt?.message}, sent ${progress.sent}`);

// ---------- navigation events: an Enter that submits a form is noticed ----------
check(bidi.watching, 'subscribed to navigation events');
ff.onPerform = (p, ws) => {
  if (!p.actions[0].actions.some(x => x.value === ''))
    return;
  // Like a form submit: the navigation starts right after the key, the new document a bit later.
  setTimeout(() => ws.send(JSON.stringify({ type: 'event', method: 'browsingContext.navigationStarted', params: { context: p.context, url: 'http://a.test/redirect' } })), 20);
  setTimeout(() => {
    ff.contexts[0].url = 'http://b.test/';
    ws.send(JSON.stringify({ type: 'event', method: 'browsingContext.navigationCommitted', params: { context: p.context, url: 'http://b.test/' } }));
  }, 200);
};
const mark = bidi.navMark(['work-tab-5']);
await bidi.type('work-tab-5', '\n');
const started = await bidi.navigatedSince(['work-tab-5'], mark);
const t0 = Date.now();
const settled = await bidi.waitSettled(['work-tab-5']);
const url = await bidi.currentUrl('work-tab-5');
check(started && settled && url === 'http://b.test/' && Date.now() - t0 >= 100, 'after Enter: the navigation it started is seen, and waitSettled waits for the new page', `started ${started}, settled ${settled}, url ${url}, waited ${Date.now() - t0} ms`);

// ---------- drag and scroll stop part-way when the check throws ----------
let n = 0;
ff.performed.length = 0;
const dragErr = await bidi.drag('work-tab-5', 0, 0, 100, 100, async () => { if (++n === 3) throw new Error('paused'); }).then(() => null, e => e);
const ups = ff.performed.flatMap(p => p.actions[0].actions).filter(x => x.type === 'pointerUp').length;
check(dragErr && /cut short/.test(dragErr.message) && ups === 1 && ff.performed.length === 3, 'Stop mid-drag: no more moves, the button is released once, and the error says so', `error ${dragErr?.message}, performs ${ff.performed.length}, pointerUps ${ups}`);
n = 0;
ff.performed.length = 0;
await bidi.scroll('work-tab-5', 10, 10, 0, 3000, async () => { if (++n === 4) throw new Error('paused'); }).catch(() => {});
check(ff.performed.length === 3, 'Stop mid-scroll: the remaining wheel ticks are not sent', `wheel commands sent: ${ff.performed.length}`);

await bidi.close();
await new Promise(r => setTimeout(r, 100));
check(active === null, 'close() releases the session', 'the fake Firefox still has an active session');

server.close();
console.log(failed ? `\n${failed} failed` : '\nall passed');
process.exit(failed ? 1 : 0);
