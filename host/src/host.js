// The Kitsune helper ("native messaging host").
//
// Firefox starts this process when the Kitsune extension calls
// runtime.connectNative('kitsune'). It relays JSON messages between:
//   - the extension, over stdin/stdout (Firefox's native-messaging framing), and
//   - MCP servers (one per AI client), over a Unix socket in ~/.kitsune (mode 0600)
//     or a per-user named pipe on Windows.
// No TCP port is opened, so other users and web pages can't reach it.
//
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { socketPath, kitsuneDir, logPath } from './paths.js';

const MAX_TO_EXTENSION = 1024 * 1024; // Firefox limit for host -> extension messages
const CHUNK_BYTES = 600 * 1024;

let logStream = null;
function log(...args) {
  try {
    if (!logStream) {
      fs.mkdirSync(kitsuneDir(), { recursive: true, mode: 0o700 });
      const p = logPath();
      try {
        if (fs.statSync(p).size > 2 * 1024 * 1024)
          fs.renameSync(p, p + '.1');
      } catch { /* no log yet */ }
      logStream = fs.createWriteStream(p, { flags: 'a' });
    }
    logStream.write(`[${new Date().toISOString()}] ${args.map(a => typeof a === 'string' ? a : JSON.stringify(a)).join(' ')}\n`);
  } catch { /* logging must never crash the helper */ }
}

// ---------- extension side (stdio framing) ----------

function writeToExtension(obj) {
  const json = Buffer.from(JSON.stringify(obj), 'utf8');
  if (json.length > MAX_TO_EXTENSION - 16) {
    const b64 = json.toString('base64');
    const per = Math.floor(CHUNK_BYTES / 3) * 4;
    const n = Math.ceil(b64.length / per);
    const cid = `c${Date.now()}${Math.random().toString(36).slice(2, 8)}`;
    for (let i = 0; i < n; i++)
      writeFrame({ type: 'chunk', cid, i, n, data: b64.slice(i * per, (i + 1) * per) });
    return;
  }
  writeFrame(obj);
}

function writeFrame(obj) {
  const body = Buffer.from(JSON.stringify(obj), 'utf8');
  const header = Buffer.alloc(4);
  header.writeUInt32LE(body.length, 0);
  process.stdout.write(Buffer.concat([header, body]));
}

let inBuf = Buffer.alloc(0);
function readExtension() {
  process.stdin.on('data', (chunk) => {
    inBuf = Buffer.concat([inBuf, chunk]);
    while (inBuf.length >= 4) {
      const len = inBuf.readUInt32LE(0);
      if (inBuf.length < 4 + len)
        break;
      const body = inBuf.subarray(4, 4 + len);
      inBuf = inBuf.subarray(4 + len);
      let msg;
      try {
        msg = JSON.parse(body.toString('utf8'));
      } catch (e) {
        log('bad frame from extension', String(e));
        continue;
      }
      onExtensionMessage(msg);
    }
  });
  process.stdin.on('end', shutdown);
  process.stdin.on('error', shutdown);
}

// ---------- client side (MCP servers) ----------

const clients = new Map(); // clientId -> { socket, buf }
const pending = new Map(); // global request id -> { clientId, id }
let nextClient = 1;
let nextId = 1;
let extensionInfo = null;
let serverError = null;
let bidiAvailable = false;

function sendClient(clientId, obj) {
  const c = clients.get(clientId);
  if (c && !c.socket.destroyed)
    c.socket.write(JSON.stringify(obj) + '\n');
}

function broadcastClientCount() {
  writeToExtension({ type: 'clients', count: clients.size });
}

function onClientMessage(clientId, msg) {
  if (msg.type === 'request') {
    const gid = nextId++;
    pending.set(gid, { clientId, id: msg.id });
    writeToExtension({ type: 'request', id: gid, tool: msg.tool, args: msg.args || {} });
  } else if (msg.type === 'status') {
    sendClient(clientId, { type: 'status', id: msg.id, extension: extensionInfo, clients: clients.size, pid: process.pid });
  } else if (msg.type === 'bidi') {
    if (bidiAvailable !== !!msg.available) {
      bidiAvailable = !!msg.available;
      writeToExtension({ type: 'bidi', available: bidiAvailable });
    }
  }
}

function onExtensionMessage(msg) {
  if (msg.type === 'hello') {
    extensionInfo = { version: msg.version, full: !!msg.full };
    log('extension connected', extensionInfo);
    writeToExtension({ type: 'hello-ack', error: serverError });
    broadcastClientCount();
    return;
  }
  if (msg.type === 'response') {
    const p = pending.get(msg.id);
    if (!p)
      return;
    pending.delete(msg.id);
    sendClient(p.clientId, { type: 'response', id: p.id, result: msg.result, error: msg.error });
    return;
  }
  if (msg.type === 'event') {
    for (const id of clients.keys())
      sendClient(id, { type: 'event', event: msg.event });
  }
}

function prepareSocketDir() {
  if (process.platform === 'win32')
    return;
  const dir = path.dirname(socketPath());
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  try {
    fs.chmodSync(dir, 0o700);
  } catch { /* ignore */ }
}

function listen() {
  const sp = socketPath();
  prepareSocketDir();
  const server = net.createServer((socket) => {
    const clientId = nextClient++;
    clients.set(clientId, { socket });
    log(`client ${clientId} connected`);
    broadcastClientCount();
    let buf = '';
    socket.setEncoding('utf8');
    socket.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (!line.trim())
          continue;
        try {
          onClientMessage(clientId, JSON.parse(line));
        } catch (e) {
          log('bad client message', String(e));
        }
      }
    });
    const bye = () => {
      if (!clients.has(clientId))
        return;
      clients.delete(clientId);
      for (const [gid, p] of pending)
        if (p.clientId === clientId)
          pending.delete(gid);
      log(`client ${clientId} disconnected`);
      broadcastClientCount();
    };
    socket.on('close', bye);
    socket.on('error', bye);
  });

  let attempts = 0;
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      // Is another helper alive on it? Usually the previous helper of a just-reloaded
      // extension that is still shutting down, so keep retrying rather than giving up.
      const probe = net.connect(sp);
      probe.on('connect', () => {
        probe.destroy();
        attempts++;
        if (attempts === 8) {
          serverError = 'Another Firefox window/profile is already connected to Kitsune. Only one can be connected at a time.';
          log(serverError);
          writeToExtension({ type: 'hello-ack', error: serverError });
        }
        setTimeout(() => server.listen(sp, onListening), Math.min(5000, 250 * attempts));
      });
      probe.on('error', () => {
        // Stale socket file from a crashed helper.
        try {
          fs.unlinkSync(sp);
        } catch { /* ignore */ }
        server.listen(sp, onListening);
      });
    } else {
      serverError = `Helper could not listen on ${sp}: ${err.message}`;
      log(serverError);
    }
  });

  function onListening() {
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(sp, 0o600);
      } catch { /* ignore */ }
    }
    log(`listening on ${sp} (pid ${process.pid})`);
    ownsSocket = true;
    if (serverError) {
      serverError = null;
      writeToExtension({ type: 'hello-ack', error: null });
    }
  }
  server.listen(sp, onListening);
}

let ownsSocket = false;
function shutdown() {
  log('extension disconnected; exiting');
  if (ownsSocket && process.platform !== 'win32') {
    try {
      fs.unlinkSync(socketPath());
    } catch { /* ignore */ }
  }
  process.exit(0);
}
export function runHost() {
  log(`helper starting (argv: ${process.argv.slice(2).join(' ')})`);
  process.on('SIGTERM', shutdown);
  process.on('SIGINT', shutdown);
  readExtension();
  listen();
  // Keep the extension's event page busy so Firefox never idles it out while we're connected.
  setInterval(() => writeToExtension({ type: 'ping' }), 20000).unref();
}
