// The Zenko helper ("native messaging host").
//
// Firefox starts this process when the Zenko extension calls
// runtime.connectNative('zenko'). It relays JSON messages between:
//   - the extension, over stdin/stdout (Firefox's native-messaging framing), and
//   - MCP servers (one per AI client), over a Unix socket in ~/.zenko (mode 0600)
//     or a per-user named pipe on Windows.
// No TCP port is opened, so other users and web pages can't reach it.
//
import net from 'node:net';
import fs from 'node:fs';
import path from 'node:path';
import { socketPath, zenkoDir, logPath, browsersDir, browserSocketPath } from './paths.js';

const MAX_TO_EXTENSION = 1024 * 1024; // Firefox limit for host -> extension messages
const CHUNK_BYTES = 600 * 1024;

let logStream = null;
function log(...args) {
  try {
    if (!logStream) {
      fs.mkdirSync(zenkoDir(), { recursive: true, mode: 0o700 });
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
let browserInfo = { browserId: '', name: 'Firefox' }; // from the extension's hello
let ownListening = false;
let serverError = null;
let bidiAvailable = false; // true if any connected MCP server has trusted input
const VERSION = typeof __ZENKO_VERSION__ !== 'undefined' ? __ZENKO_VERSION__ : '0.0.0';

function updateBidi() {
  const any = [...clients.values()].some(c => c.bidi);
  if (any !== bidiAvailable) {
    bidiAvailable = any;
    writeToExtension({ type: 'bidi', available: bidiAvailable });
  }
}

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
    sendClient(clientId, { type: 'status', id: msg.id, extension: extensionInfo, helper: { version: VERSION }, clients: clients.size, pid: process.pid, browser: { ...browserInfo, primary: ownsSocket } });
  } else if (msg.type === 'bidi') {
    // Per client: Firefox allows one BiDi session, so a second MCP server may not have one
    // while the first still does.
    const c = clients.get(clientId);
    if (c)
      c.bidi = !!msg.available;
    updateBidi();
  }
}

function onExtensionMessage(msg) {
  if (msg.type === 'name') {
    browserInfo.name = cleanName(msg.name) || browserInfo.name;
    writeRegistry();
    return;
  }
  if (msg.type === 'hello') {
    extensionInfo = { version: msg.version, full: !!msg.full };
    browserInfo = { browserId: /^[a-f0-9]{12}$/.test(msg.browserId || '') ? msg.browserId : '', name: cleanName(msg.name) || 'Firefox' };
    writeRegistry();
    log('extension connected', extensionInfo, browserInfo);
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
  // Only tighten our own folder: ZENKO_SOCKET could point into $HOME or a shared directory.
  if (path.resolve(dir) === path.resolve(zenkoDir())) {
    try {
      fs.chmodSync(dir, 0o700);
    } catch { /* ignore */ }
  }
}

const cleanName = (s) => (typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f-\u009f]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) : '');

/** ~/.zenko/browsers/<pid>.json: lets MCP servers list the connected Firefox profiles. */
function registryFile() {
  return path.join(browsersDir(), `${process.pid}.json`);
}
function writeRegistry() {
  if (!ownListening)
    return;
  try {
    fs.writeFileSync(registryFile(), JSON.stringify({ pid: process.pid, socket: browserSocketPath(), browserId: browserInfo.browserId, name: browserInfo.name, version: VERSION, started: startedAt }), { mode: 0o600 });
  } catch (e) {
    log('could not write the browser registry', String(e));
  }
}
const startedAt = Date.now();

/** Every helper also listens on its own socket, so several Firefox profiles can be connected at once. */
function listenOwn() {
  fs.mkdirSync(browsersDir(), { recursive: true, mode: 0o700 }); // the registry lives here on every OS
  if (process.platform !== 'win32') {
    try {
      fs.chmodSync(browsersDir(), 0o700);
    } catch { /* ignore */ }
  }
  const own = browserSocketPath();
  try {
    fs.unlinkSync(own); // a crashed helper with the same pid left it behind
  } catch { /* none */ }
  const server = net.createServer(onClientSocket);
  server.on('error', (err) => log(`could not listen on ${own}: ${err.message}`));
  server.listen(own, () => {
    if (process.platform !== 'win32') {
      try {
        fs.chmodSync(own, 0o600);
      } catch { /* ignore */ }
    }
    ownListening = true;
    writeRegistry();
    log(`also listening on ${own}`);
  });
}

function onClientSocket(socket) {
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
    updateBidi();
  };
  socket.on('close', bye);
  socket.on('error', bye);
}

function listen() {
  const sp = socketPath();
  prepareSocketDir();
  const server = net.createServer(onClientSocket);

  let attempts = 0;
  server.on('error', (err) => {
    if (err.code === 'EADDRINUSE') {
      // Is another helper alive on it? Usually the previous helper of a just-reloaded
      // extension that is still shutting down, so keep retrying rather than giving up.
      const probe = net.connect(sp);
      probe.on('connect', () => {
        probe.destroy();
        attempts++;
        // Usually another Firefox profile owns the shared socket. That's fine: this helper is
        // reachable on its own socket (listenOwn), and takes over the shared one when it's free.
        if (attempts === 8)
          log('another Firefox profile has the shared socket; this one is available as an additional browser');
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
  for (const f of [registryFile(), process.platform !== 'win32' ? browserSocketPath() : null].filter(Boolean)) {
    try {
      fs.unlinkSync(f);
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
  listenOwn();
  // Keep the extension's event page busy so Firefox never idles it out while we're connected.
  setInterval(() => writeToExtension({ type: 'ping' }), 20000).unref();
}
