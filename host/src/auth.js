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
const POSIX = process.platform !== 'win32';
const myUid = () => (POSIX && typeof process.getuid === 'function' ? process.getuid() : null);

/** Longest line either side accepts once connected (uploads are at most 25 MB, about 34 MB as base64). */
export const MAX_LINE = 96 * 1024 * 1024;
/** Longest input either side accepts before the handshake is done. */
export const MAX_HANDSHAKE = 64 * 1024;

/**
 * Read the key file. It only counts if it can be trusted: a regular file (never a link), and on
 * macOS/Linux this user's own and readable by nobody else. Returns { key } (hex), { missing: true }
 * or { bad: why }.
 */
function readKeyFile(file) {
  let fd;
  try {
    // O_NOFOLLOW: a link planted at this path must not make us read (and trust) another file.
    fd = fs.openSync(file, fs.constants.O_RDONLY | (fs.constants.O_NOFOLLOW || 0));
  } catch (e) {
    if (e.code === 'ENOENT')
      return { missing: true };
    return { bad: e.code === 'ELOOP' || e.code === 'EMLINK' ? 'is a link to another file' : `can't be read (${e.code || e.message})` };
  }
  try {
    const st = fs.fstatSync(fd);
    if (!st.isFile())
      return { bad: 'is not a regular file' };
    if (myUid() !== null && st.uid !== myUid())
      return { bad: 'belongs to another user' };
    if (POSIX && (st.mode & 0o077))
      return { bad: 'was readable by other users' };
    const t = st.size <= 1024 ? fs.readFileSync(fd, 'utf8').trim() : '';
    return valid(t) ? { key: t } : { bad: 'does not hold a key' };
  } finally {
    fs.closeSync(fd);
  }
}

/** The Foxwright folder must be this user's own; a folder others can write to is made private. */
function prepareKeyDir(dir) {
  fs.mkdirSync(dir, { recursive: true, mode: 0o700 });
  if (myUid() === null)
    return;
  const st = fs.statSync(dir);
  if (st.uid !== myUid())
    throw new Error(`Foxwright's folder ${dir} belongs to another user, so a key kept there can't be trusted. Set FOXWRIGHT_HOME to a folder of your own, or remove that folder.`);
  if (st.mode & 0o022) {
    try {
      fs.chmodSync(dir, 0o700);
    } catch { /* still usable; the key file itself is private */ }
  }
}

/** A private temporary file next to `file` holding `hex`; the caller links or renames it into place. */
function writeTemp(file, hex) {
  const tmp = `${file}.${process.pid}.${crypto.randomBytes(6).toString('hex')}.tmp`;
  fs.writeFileSync(tmp, hex, { flag: 'wx', mode: 0o600 }); // 'wx': never through a link someone left there
  return tmp;
}

/**
 * The shared key (32 bytes), created on first use. `dir`: the Foxwright folder (default ~/.foxwright).
 * The file appears with its contents in one step (a hard link to a finished temporary file), so
 * the helper and an MCP server that both start for the first time agree on the same key, and
 * neither ever reads a half-written one. A file that can't be trusted (see readKeyFile) is replaced
 * by a new key. Both sides read the file again for every connection, so a replaced or deleted key
 * takes effect for the next connection; connections that are already open keep working.
 */
export function readToken(dir = foxwrightDir()) {
  const file = tokenPath(dir);
  let k = readKeyFile(file);
  if (k.key)
    return Buffer.from(k.key, 'hex');
  prepareKeyDir(dir);
  const tmp = writeTemp(file, crypto.randomBytes(32).toString('hex'));
  try {
    if (k.missing) {
      try {
        fs.linkSync(tmp, file); // fails if another process created the file meanwhile: then theirs is used
      } catch (e) {
        if (e.code !== 'EEXIST')
          fs.renameSync(tmp, file); // a file system without hard links
      }
    } else {
      fs.renameSync(tmp, file); // replaces the untrusted file (or the link itself, not what it points to)
    }
  } finally {
    try {
      fs.unlinkSync(tmp);
    } catch { /* renamed away */ }
  }
  // Whoever wrote last wins: use what is there now, not what this process wrote.
  k = readKeyFile(file);
  if (!k.key)
    throw new Error(`Foxwright could not create its key file ${file}${k.bad ? ` (what is there ${k.bad})` : ''}. Remove it, then restart Firefox and the AI client.`);
  return Buffer.from(k.key, 'hex');
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
