// Native-messaging link to the Zenko helper (zenko host), which relays
// requests from the MCP server over a user-only Unix socket / named pipe.
/* global browser */
import { state, updateBadge, VERSION, FULL } from './state.js';

const HOST_NAME = 'zenko';
let port = null;
let retryTimer = null;
let retryMs = 2000;
const chunks = new Map();
let requestHandler = null;

export function onRequest(fn) {
  requestHandler = fn;
}

export function send(msg) {
  if (port)
    port.postMessage(msg);
}

function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(connect, retryMs);
  retryMs = Math.min(retryMs * 2, 60000);
}

export function connect() {
  if (port || state.connecting)
    return;
  state.connecting = true;
  let p;
  try {
    p = browser.runtime.connectNative(HOST_NAME);
  } catch (e) {
    state.connecting = false;
    state.lastError = String(e?.message || e);
    updateBadge();
    scheduleRetry();
    return;
  }
  port = p;
  p.onMessage.addListener(onMessage);
  p.onDisconnect.addListener((dp) => {
    const err = dp.error?.message || (browser.runtime.lastError && browser.runtime.lastError.message) || 'Helper exited';
    state.lastError = /No such native application|not found/i.test(err)
      ? 'The Zenko helper is not installed. Run: npx zenko-firefox setup'
      : err;
    state.connected = false;
    state.connecting = false;
    state.clients = 0;
    state.bidi = false;
    port = null;
    chunks.clear();
    updateBadge();
    scheduleRetry();
  });
  p.postMessage({ type: 'hello', version: VERSION, full: FULL, browserId: state.browserId, name: state.browserName });
}

export function reconnectNow() {
  retryMs = 2000;
  clearTimeout(retryTimer);
  if (!port)
    connect();
}

function decodeChunked(msg) {
  let entry = chunks.get(msg.cid);
  if (!entry) {
    entry = { parts: new Array(msg.n), got: 0 };
    chunks.set(msg.cid, entry);
  }
  if (entry.parts[msg.i] === undefined) {
    entry.parts[msg.i] = msg.data;
    entry.got++;
  }
  if (entry.got < msg.n)
    return null;
  chunks.delete(msg.cid);
  const bin = atob(entry.parts.join(''));
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function onMessage(msg) {
  if (msg.type === 'chunk') {
    const full = decodeChunked(msg);
    if (full)
      onMessage(full);
    return;
  }
  if (msg.type === 'hello-ack') {
    state.connected = true;
    state.connecting = false;
    state.lastError = msg.error || null;
    retryMs = 2000;
    updateBadge();
    return;
  }
  if (msg.type === 'clients') {
    state.clients = msg.count || 0;
    updateBadge();
    return;
  }
  if (msg.type === 'bidi') {
    state.bidi = !!msg.available;
    return;
  }
  if (msg.type === 'ping') {
    send({ type: 'pong' });
    return;
  }
  if (msg.type === 'request' && requestHandler) {
    const { id, tool, args } = msg;
    try {
      const result = await requestHandler(tool, args || {});
      send({ type: 'response', id, result });
    } catch (e) {
      send({ type: 'response', id, error: String(e?.message || e) });
    }
  }
}
