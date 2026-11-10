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
server.on('connection', (ws) => {
  ws.on('message', (data) => {
    const msg = JSON.parse(String(data));
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

process.env.ZENKO_BIDI_URL = `ws://127.0.0.1:${port}/session`;
const { Bidi } = await import(path.join(root, 'host', 'src', 'bidi.js'));

let failed = 0;
const check = (ok, name, detail = '') => {
  console.log(`  ${ok ? '✓' : '✗'} ${name}${ok ? '' : `\n      ${detail}`}`);
  if (!ok)
    failed++;
};

console.log('Zenko BiDi connection');
const bidi = new Bidi();
// The startup probe and the first tool calls, all at the same moment.
const results = await Promise.all([bidi.available(), bidi.available(), bidi.available()]);
check(results.every(Boolean), 'concurrent connection attempts all report real input on', `results: ${JSON.stringify(results)}, last error: ${bidi.lastError}`);
check(sessionsCreated === 1, 'only one session is created', `sessions created: ${sessionsCreated}`);
check(await bidi.available(), 'still connected afterwards', `last error: ${bidi.lastError}`);

await bidi.close();
await new Promise(r => setTimeout(r, 100));
check(active === null, 'close() releases the session', 'the fake Firefox still has an active session');

server.close();
console.log(failed ? `\n${failed} failed` : '\n4/4 passed');
process.exit(failed ? 1 : 0);
