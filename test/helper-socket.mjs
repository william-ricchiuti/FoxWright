// A raw, authenticated connection to a Foxwright helper socket, for tests that speak the socket
// protocol directly (a "second agent", the helper's own status). See host/src/auth.js.
import net from 'node:net';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const { readToken, nonce, proof, b64, SecureChannel } = await import(path.join(root, 'host/src/auth.js'));

/**
 * Connect to `sock` (the shared socket ~/.foxwright/foxwright.sock; the key is read from the same
 * folder unless `dir` says otherwise). Resolves to { send(obj), messages, onMessage(fn), destroy() }
 * once the handshake is done.
 */
export function openHelper(sock, dir = path.dirname(sock)) {
  return new Promise((resolve, reject) => {
    const s = net.connect(sock);
    const key = readToken(dir);
    const messages = [];
    const listeners = new Set();
    let buf = '', ns = null, nc = null, chan = null;
    s.setEncoding('utf8');
    s.on('error', reject);
    const api = {
      messages,
      send: (obj) => s.write(chan.seal(obj) + '\n'),
      onMessage: (fn) => listeners.add(fn),
      destroy: () => s.destroy(),
    };
    s.on('data', (d) => {
      buf += d;
      let nl;
      while ((nl = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, nl);
        buf = buf.slice(nl + 1);
        if (chan) {
          const m = chan.open(line);
          messages.push(m);
          for (const fn of listeners) fn(m);
          continue;
        }
        const m = JSON.parse(line);
        if (!ns) {
          ns = b64(m.ns, 32);
          nc = nonce();
          s.write(JSON.stringify({ type: 'auth', v: 1, nc: nc.toString('base64'), mac: proof(key, 'client', ns, nc).toString('base64') }) + '\n');
        } else if (m.type === 'auth-ok') {
          chan = new SecureChannel(key, ns, nc, 'client');
          resolve(api);
        } else {
          reject(new Error(`handshake failed: ${line}`));
        }
      }
    });
  });
}

/** One request/response over a fresh authenticated connection (e.g. the helper's own status). */
export async function helperRequest(sock, obj, ms = 5000) {
  const h = await openHelper(sock);
  try {
    return await new Promise((resolve, reject) => {
      const t = setTimeout(() => reject(new Error('no answer')), ms);
      h.onMessage((m) => {
        if (m.id === 1) {
          clearTimeout(t);
          resolve(m);
        }
      });
      h.send({ ...obj, id: 1 });
    });
  } finally {
    h.destroy();
  }
}
