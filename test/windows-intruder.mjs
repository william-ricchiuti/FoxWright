// Runs as a SECOND, unprivileged Windows account (see test/e2e-windows-users.mjs) and tries to
// reach the first account's Foxwright: read its key and pipe name, talk to its named pipe, or
// pre-create ("squat") the pipe so the first account's MCP server talks to us instead.
// Writes what it saw as JSON to the file given as the last argument. No dependencies.
//
//   node test/windows-intruder.mjs probe <ownerFoxwrightDir> <out.json>
//   node test/windows-intruder.mjs squat <pipePath> <seconds> <out.json>
import fs from 'node:fs';
import net from 'node:net';
import path from 'node:path';
import crypto from 'node:crypto';

const [mode, a1, a2, a3] = process.argv.slice(2);
const out = { mode, user: process.env.USERNAME, results: {} };
const save = (file) => fs.writeFileSync(file, JSON.stringify(out, null, 2));
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

function tryRead(file) {
  try {
    return { ok: true, bytes: fs.readFileSync(file).length };
  } catch (e) {
    return { ok: false, code: e.code };
  }
}

/** Connect, collect whatever the pipe says for `ms`, optionally sending `send` lines first. */
function talk(pipe, send, ms = 3000) {
  return new Promise((resolve) => {
    const r = { connected: false, received: '' };
    const s = net.connect(pipe);
    s.on('connect', () => {
      r.connected = true;
      for (const line of send)
        s.write(line + '\n');
    });
    s.on('data', (d) => { r.received += d.toString('utf8').slice(0, 4000); });
    s.on('error', (e) => { r.error = e.code || e.message; });
    setTimeout(() => {
      s.destroy();
      resolve(r);
    }, ms);
  });
}

if (mode === 'probe') {
  const dir = a1;
  out.results.readKey = tryRead(path.join(dir, 'auth-token'));
  out.results.readPipeId = tryRead(path.join(dir, 'pipe-id'));
  try {
    out.results.listDir = { ok: true, names: fs.readdirSync(dir) };
  } catch (e) {
    out.results.listDir = { ok: false, code: e.code };
  }
  let pipes = [];
  try {
    pipes = fs.readdirSync('\\\\.\\pipe\\').filter(n => /foxwright/i.test(n));
  } catch (e) {
    out.results.enumerateError = e.code;
  }
  out.results.pipesSeen = pipes;
  out.results.talks = [];
  for (const name of pipes) {
    const pipe = `\\\\.\\pipe\\${name}`;
    // 1) An old-style request with no handshake. 2) A handshake with a made-up key.
    const plain = await talk(pipe, [JSON.stringify({ type: 'status', id: 1 }), JSON.stringify({ id: 2, tool: 'tabs_context_mcp', args: {} })]);
    const fake = await talk(pipe, [JSON.stringify({ type: 'auth', v: 1, nc: crypto.randomBytes(32).toString('base64'), mac: crypto.randomBytes(32).toString('base64') })]);
    out.results.talks.push({ name, plain, fake });
  }
  save(a2);
} else if (mode === 'squat') {
  const pipe = a1;
  const seconds = Number(a2) || 30;
  out.results.received = [];
  const server = net.createServer((sock) => {
    const conn = { data: '' };
    out.results.received.push(conn);
    // Pretend to be the helper: a challenge, then "ok" for any answer.
    sock.write(JSON.stringify({ type: 'auth-challenge', v: 1, ns: crypto.randomBytes(32).toString('base64') }) + '\n');
    sock.on('data', (d) => {
      conn.data += d.toString('utf8').slice(0, 20000);
      if (!conn.answered) {
        conn.answered = true;
        sock.write(JSON.stringify({ type: 'auth-ok', mac: crypto.randomBytes(32).toString('base64') }) + '\n');
      }
      save(a3);
    });
    sock.on('error', () => {});
  });
  server.on('error', (e) => {
    out.results.listenError = e.code || e.message;
    save(a3);
  });
  server.listen(pipe, () => {
    out.results.listening = true;
    save(a3);
  });
  await sleep(seconds * 1000);
  server.close();
  save(a3);
  process.exit(0);
}
