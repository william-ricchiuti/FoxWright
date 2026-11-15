// The helper's local socket handshake (host/src/auth.js): MCP server and helper must both prove they
// know ~/.foxwright/auth-token before any tool traffic, and everything after that is encrypted.
// Runs the real helper (host/src/cli.js host) against a fake extension on its stdio and a temporary
// FOXWRIGHT_HOME; no Firefox needed.
//   node test/socket-auth.mjs
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-auth-'));
process.env.FOXWRIGHT_HOME = home;
const { HelperClient } = await import(path.join(root, 'host/src/client.js'));
const { socketPath } = await import(path.join(root, 'host/src/paths.js'));
const sleep = ms => new Promise(r => setTimeout(r, ms));

let failed = 0, passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${String(e?.message || e).split('\n').join('\n      ')}`);
  }
}
const expect = (c, m) => { if (!c) throw new Error(m); };

// ---------- the real helper, with a fake extension on its stdio ----------
const helper = spawn(process.execPath, [path.join(root, 'host/src/cli.js'), 'host'], { env: { ...process.env, FOXWRIGHT_HOME: home }, stdio: ['pipe', 'pipe', 'inherit'] });
const seenByExtension = [];
function toHelper(obj) {
  const body = Buffer.from(JSON.stringify(obj));
  const h = Buffer.alloc(4);
  h.writeUInt32LE(body.length);
  helper.stdin.write(Buffer.concat([h, body]));
}
let inBuf = Buffer.alloc(0);
helper.stdout.on('data', (d) => {
  inBuf = Buffer.concat([inBuf, d]);
  while (inBuf.length >= 4 && inBuf.length >= 4 + inBuf.readUInt32LE(0)) {
    const msg = JSON.parse(inBuf.subarray(4, 4 + inBuf.readUInt32LE(0)).toString());
    inBuf = inBuf.subarray(4 + inBuf.readUInt32LE(0));
    seenByExtension.push(msg);
    if (msg.type === 'request') // echo, like a tool result
      toHelper({ type: 'response', id: msg.id, result: { content: [{ type: 'text', text: `echo ${msg.tool} ${JSON.stringify(msg.args)}` }] } });
  }
});
toHelper({ type: 'hello', version: '9.9.9', full: true, browserId: 'abcdefabcdef', name: 'Test' });
const sock = socketPath();
for (let i = 0; i < 100 && !fs.existsSync(sock); i++)
  await sleep(50);

/** A raw connection: returns lines received and a writer. */
function raw(target = sock) {
  const s = net.connect(target);
  const lines = [];
  let buf = '';
  s.setEncoding('utf8');
  s.on('data', (d) => {
    buf += d;
    let nl;
    while ((nl = buf.indexOf('\n')) >= 0) {
      lines.push(buf.slice(0, nl));
      buf = buf.slice(nl + 1);
    }
  });
  s.on('error', () => {});
  const closed = new Promise(r => s.on('close', r));
  return { s, lines, closed, send: (o) => s.write((typeof o === 'string' ? o : JSON.stringify(o)) + '\n') };
}

console.log('Foxwright socket authentication');

await test('an MCP server with the key gets status and tool results', async () => {
  const c = new HelperClient();
  const st = await c.status();
  expect(st.extension?.version === '9.9.9' && st.extension.full === true, JSON.stringify(st));
  const r = await c.call('read_page', { tabId: 1 });
  expect(/echo read_page/.test(r.content[0].text), JSON.stringify(r));
  c.close();
});

await test('the key file is private (0600) and the helper only answers after the handshake', async () => {
  const mode = fs.statSync(path.join(home, 'auth-token')).mode & 0o777;
  expect(process.platform === 'win32' || mode === 0o600, `auth-token mode ${mode.toString(8)}`);
  const r = raw();
  await sleep(200);
  const first = JSON.parse(r.lines[0] || '{}');
  expect(first.type === 'auth-challenge' && first.v === 1 && first.ns, 'first line should be the challenge: ' + r.lines[0]);
  r.s.destroy();
});

await test('an MCP server from before the handshake gets a clear "update" error, not tool results', async () => {
  const before = seenByExtension.filter(m => m.type === 'request').length;
  const r = raw();
  await sleep(100);
  r.send({ type: 'request', id: 7, tool: 'computer', args: { action: 'type', text: 'hunter2' } });
  r.send({ type: 'status', id: 8 });
  await sleep(300);
  const msgs = r.lines.slice(1).map(l => JSON.parse(l));
  const resp = msgs.find(m => m.id === 7), st = msgs.find(m => m.id === 8);
  expect(resp?.type === 'response' && /older than the Foxwright helper/.test(resp.error), JSON.stringify(msgs));
  expect(st?.type === 'status' && !st.extension && !st.pid && /older/.test(st.error), 'status without auth must not reveal anything: ' + JSON.stringify(st));
  expect(seenByExtension.filter(m => m.type === 'request').length === before, 'the request reached the extension');
  r.s.destroy();
});

await test('a client with the wrong key is refused and gets no events', async () => {
  const r = raw();
  await sleep(100);
  const ch = JSON.parse(r.lines[0]);
  const crypto = await import('node:crypto');
  const nc = crypto.randomBytes(32);
  const mac = crypto.createHmac('sha256', crypto.randomBytes(32)).update(`foxwright-auth-v1|client|${ch.ns}|${nc.toString('base64')}`).digest();
  r.send({ type: 'auth', v: 1, nc: nc.toString('base64'), mac: mac.toString('base64') });
  toHelper({ type: 'event', event: 'paused' });
  await Promise.race([r.closed, sleep(1000)]);
  const msgs = r.lines.slice(1).map(l => JSON.parse(l));
  expect(msgs.length === 1 && msgs[0].type === 'auth-failed', JSON.stringify(msgs));
  expect(r.s.destroyed || r.s.readableEnded, 'connection should be closed');
});

await test('garbage and a long line before the handshake do not hurt the helper', async () => {
  const r = raw();
  r.send('not json');
  r.send('{"type":"auth","v":1,"nc":"!!","mac":[]}');
  r.s.write('y'.repeat(200 * 1024));
  await Promise.race([r.closed, sleep(1000)]);
  const c = new HelperClient();
  expect((await c.status()).extension, 'helper should still answer');
  c.close();
});

await test('a helper from before the handshake: the MCP server says to update instead of hanging', async () => {
  const p = path.join(home, 'old.sock');
  const old = net.createServer((s) => {
    let b = '';
    s.on('data', (d) => {
      b += d;
      for (const l of b.split('\n').slice(0, -1))
        s.write(JSON.stringify({ type: 'status', id: JSON.parse(l).id, extension: { version: '0.7.1' } }) + '\n');
      b = b.slice(b.lastIndexOf('\n') + 1);
    });
  });
  await new Promise(r => old.listen(p, r));
  const c = new HelperClient({ path: p });
  const t0 = Date.now();
  const e = await c.status().then(() => null, e => e);
  old.close();
  expect(e && /older than this MCP server/.test(e.message) && Date.now() - t0 < 6000, `${e?.message} after ${Date.now() - t0} ms`);
});

await test('an impostor on the socket (no key) gets nothing: the MCP server checks the helper\'s proof first', async () => {
  const p = path.join(home, 'impostor.sock');
  const got = [];
  const imp = net.createServer((s) => {
    s.write(JSON.stringify({ type: 'auth-challenge', v: 1, ns: Buffer.alloc(32, 7).toString('base64') }) + '\n');
    s.on('data', (d) => {
      got.push(String(d));
      s.write(JSON.stringify({ type: 'auth-ok', mac: Buffer.alloc(32, 1).toString('base64') }) + '\n');
    });
  });
  await new Promise(r => imp.listen(p, r));
  const c = new HelperClient({ path: p });
  const e = await c.call('computer', { action: 'type', text: 'my-secret-text' }).then(() => null, e => e);
  await sleep(100);
  imp.close();
  expect(e && /could not prove it is the Foxwright helper/.test(e.message), e?.message);
  expect(!got.join('').includes('my-secret-text') && !got.join('').includes('request'), 'the impostor received: ' + got.join(''));
});

await test('a relay in the middle sees only ciphertext, and a changed byte ends the connection', async () => {
  const p = path.join(home, 'relay.sock');
  const seen = [];
  let tamper = false;
  const relay = net.createServer((client) => {
    const up = net.connect(sock);
    up.on('data', d => client.write(d));
    let n = 0;
    client.on('data', (d) => {
      seen.push(String(d));
      if (tamper && n++ === 1) { // [0] is the handshake line, [1] the first encrypted request
        const s = String(d);
        const i = s.length - 5; // flip a base64 character in the encrypted line
        d = Buffer.from(s.slice(0, i) + (s[i] === 'A' ? 'B' : 'A') + s.slice(i + 1));
      }
      up.write(d);
    });
    client.on('close', () => up.destroy());
    up.on('close', () => client.destroy());
    client.on('error', () => {});
    up.on('error', () => {});
  });
  await new Promise(r => relay.listen(p, r));
  const c = new HelperClient({ path: p });
  const r = await c.call('computer', { action: 'type', text: 'my-secret-text' });
  expect(/echo computer/.test(r.content[0].text), JSON.stringify(r));
  expect(!seen.join('').includes('my-secret-text'), 'typed text visible to the relay');
  tamper = true;
  c.close();
  const c2 = new HelperClient({ path: p });
  await c2.connect();
  const before = seenByExtension.filter(m => m.type === 'request').length;
  const e = await c2.call('computer', { action: 'type', text: 'x' }, 3000).then(() => null, e => e);
  relay.close();
  expect(e, 'a tampered request should not succeed');
  expect(seenByExtension.filter(m => m.type === 'request').length === before, 'the tampered request reached the extension');
});

helper.kill();
fs.rmSync(home, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed, ${passed} passed` : `\n${passed}/${passed} passed`);
process.exit(failed ? 1 : 0);
