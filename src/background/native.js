// Native-messaging link to the Foxwright helper (foxwright host), which relays
// requests from the MCP server over a user-only Unix socket / named pipe.
/* global browser */
import { state, updateBadge, VERSION, FULL } from './state.js';

const HOST_NAME = 'foxwright';
let port = null;
let retryTimer = null;
let retryMs = 2000;
const chunks = new Map();
let requestHandler = null;
let supportsDoctor = false;
let nextDoctorId = 1;
let doctorRequest = null;

function finishDoctor(output) {
  if (doctorRequest) {
    clearTimeout(doctorRequest.timer);
    const { resolve } = doctorRequest;
    doctorRequest = null;
    resolve(output);
  }
}

export function getDoctorReport() {
  if (!port || !state.connected || !supportsDoctor)
    return Promise.resolve(null);
  if (doctorRequest)
    return doctorRequest.promise;
  const id = nextDoctorId++;
  let complete;
  const promise = new Promise(resolve => { complete = resolve; });
  doctorRequest = { id, promise, resolve: complete, timer: setTimeout(() => finishDoctor(null), 9000) };
  try {
    send({ type: 'doctor-report', id });
  } catch {
    finishDoctor(null);
  }
  return promise;
}

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
    state.errorKind = classifyError(state.lastError);
    updateBadge();
    scheduleRetry();
    return;
  }
  port = p;
  p.onMessage.addListener(onMessage);
  p.onDisconnect.addListener((dp) => {
    const err = dp.error?.message || (browser.runtime.lastError && browser.runtime.lastError.message) || 'Helper exited';
    state.errorKind = classifyError(err);
    state.lastError = state.errorKind === 'not-installed'
      ? 'The Foxwright helper is not installed. Run: npx foxwright-firefox setup'
      : err;
    state.helperVersion = null;
    state.connected = false;
    state.connecting = false;
    state.clients = 0;
    state.bidi = false;
    port = null;
    supportsDoctor = false;
    finishDoctor(null);
    chunks.clear();
    updateBadge();
    scheduleRetry();
  });
  p.postMessage({ type: 'hello', version: VERSION, full: FULL, browserId: state.browserId, name: state.browserName });
}

/**
 * Why the native connection failed, for the popup and welcome page:
 *   'not-installed' = Firefox found no registered helper (setup hasn't run, or ran for another
 *   Firefox / a sandboxed Snap or Flatpak build); 'exited' = the helper started and then stopped
 *   (for example Node.js missing or too old, or a crash).
 */
function classifyError(err) {
  return /No such native application|not found/i.test(String(err)) ? 'not-installed' : 'exited';
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
  if (msg.type === 'doctor-result') {
    if (doctorRequest?.id === msg.id)
      finishDoctor(typeof msg.output === 'string' && msg.output.length <= 1500 ? msg.output : null);
    return;
  }
  if (msg.type === 'hello-ack') {
    supportsDoctor = msg.doctorReport === true;
    state.connected = true;
    state.connecting = false;
    state.lastError = msg.error || null;
    state.errorKind = msg.error ? 'helper-error' : null;
    state.helperVersion = typeof msg.version === 'string' ? msg.version.slice(0, 32) : null;
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
