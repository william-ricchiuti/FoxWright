// Mutual authentication and encryption for the helper's local socket (named pipe on Windows).
//
// Why: on Windows the helper listens on a named pipe. Pipe names can be listed by any local user,
// so another user could create Foxwright's pipe first while Firefox is closed and then receive what
// MCP servers send (typed text, upload contents) or answer with forged results; with Firefox open,
// such a squatter could even relay between the MCP server and the real helper's own pipe. On macOS
// and Linux the socket is already private (0600 in a 0700 folder); the same protocol runs there too,
// so it is exercised by every test run.
//
// Protocol (one JSON line each, then encrypted lines):
//   helper -> client  {"type":"auth-challenge","v":1,"ns":<32 random bytes, base64>}
//   client -> helper  {"type":"auth","v":1,"nc":<32 random bytes>,"mac":HMAC(key, "client"|ns|nc)}
//   helper -> client  {"type":"auth-ok","mac":HMAC(key, "helper"|ns|nc)}   or {"type":"auth-failed","error":...}
// `key` is a random 32-byte secret in ~/.foxwright/auth-token, readable only by the user (0600 on
// macOS/Linux; on Windows the user's profile folder's own permissions protect it). Neither side ever
// sends the key. The client checks the helper's MAC before sending anything else, so a squatter learns
// nothing. After that, every line is AES-256-GCM with per-direction keys derived from the key and
// both nonces (HKDF) and a message counter as IV, so a relay in the middle can neither read nor
// change, replay or reorder messages.
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import { foxwrightDir } from './paths.js';

export const AUTH_VERSION = 1;

export const OLD_HELPER_MSG = 'The Foxwright helper is older than this MCP server (it does not do the secure handshake added in Foxwright 0.8). Ask the user to run `npx foxwright-firefox@latest setup` and then restart Firefox.';
export const OLD_CLIENT_MSG = 'This Foxwright MCP server is older than the Foxwright helper and cannot authenticate to it (the helper now requires the secure handshake added in Foxwright 0.8). Update the MCP server: use `npx -y foxwright-firefox@latest mcp` in the AI client\'s MCP settings (or run `npx foxwright-firefox@latest setup`), then restart the AI client.';

export function tokenPath(dir = foxwrightDir()) {
  return path.join(dir, 'auth-token');
}

const valid = (t) => typeof t === 'string' && /^[a-f0-9]{64}$/.test(t);

/** The shared key (32 bytes), created on first use. `dir`: the Foxwright folder (default ~/.foxwright). */
export function readToken(dir = foxwrightDir()) {
  const file = tokenPath(dir);
  let t;
  try {
    t = fs.readFileSync(file, 'utf8').trim();
  } catch { /* first run */ }
  if (valid(t))
    return Buffer.from(t, 'hex');
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  const fresh = crypto.randomBytes(32).toString('hex');
  try {
    // The helper and an MCP server may both get here first: create exclusively, else use the winner's.
    fs.writeFileSync(file, fresh, { flag: 'wx', mode: 0o600 });
    return Buffer.from(fresh, 'hex');
  } catch { /* exists */ }
  t = fs.readFileSync(file, 'utf8').trim();
  if (valid(t))
    return Buffer.from(t, 'hex');
  // Corrupt file: replace it (atomically, keeping it private).
  const tmp = `${file}.${process.pid}.tmp`;
  fs.writeFileSync(tmp, fresh, { mode: 0o600 });
  fs.renameSync(tmp, file);
  return Buffer.from(fresh, 'hex');
}

export const nonce = () => crypto.randomBytes(32);

export function proof(key, role, ns, nc) {
  return crypto.createHmac('sha256', key).update(`foxwright-auth-v${AUTH_VERSION}|${role}|${ns.toString('base64')}|${nc.toString('base64')}`).digest();
}

export function sameMac(a, b) {
  return Buffer.isBuffer(a) && Buffer.isBuffer(b) && a.length === b.length && crypto.timingSafeEqual(a, b);
}

/** Decode a base64 field that must hold exactly `len` bytes, or null. */
export function b64(v, len) {
  if (typeof v !== 'string' || !/^[A-Za-z0-9+/]+=*$/.test(v))
    return null;
  const buf = Buffer.from(v, 'base64');
  return buf.length === len ? buf : null;
}

/** Encrypts outgoing and decrypts incoming lines after the handshake. role: 'client' or 'helper'. */
export class SecureChannel {
  constructor(key, ns, nc, role) {
    const salt = Buffer.concat([ns, nc]);
    const derive = (dir) => Buffer.from(crypto.hkdfSync('sha256', key, salt, `foxwright-v${AUTH_VERSION} ${dir}`, 32));
    this.sendKey = derive(role === 'client' ? 'c2s' : 's2c');
    this.recvKey = derive(role === 'client' ? 's2c' : 'c2s');
    this.sendN = 0n;
    this.recvN = 0n;
  }

  static iv(n) {
    const iv = Buffer.alloc(12);
    iv.writeBigUInt64BE(n, 4);
    return iv;
  }

  /** obj -> one line (without the newline). */
  seal(obj) {
    const c = crypto.createCipheriv('aes-256-gcm', this.sendKey, SecureChannel.iv(this.sendN++));
    const body = Buffer.concat([c.update(JSON.stringify(obj), 'utf8'), c.final(), c.getAuthTag()]);
    return body.toString('base64');
  }

  /** One line -> obj. Throws if it was tampered with, replayed or out of order. */
  open(line) {
    const buf = Buffer.from(line, 'base64');
    if (buf.length < 16)
      throw new Error('short message');
    const d = crypto.createDecipheriv('aes-256-gcm', this.recvKey, SecureChannel.iv(this.recvN));
    d.setAuthTag(buf.subarray(buf.length - 16));
    const plain = Buffer.concat([d.update(buf.subarray(0, buf.length - 16)), d.final()]);
    this.recvN++;
    return JSON.parse(plain.toString('utf8'));
  }
}
