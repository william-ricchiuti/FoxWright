// MCP-server side connection to the Foxwright helper's local socket.
import net from 'node:net';
import { socketPath } from './paths.js';
import { socketFor } from './browsers.js';
import { AUTH_VERSION, OLD_HELPER_MSG, readToken, tokenPath, nonce, proof, sameMac, b64, SecureChannel } from './auth.js';

export class HelperClient {
  /** path: a specific helper socket. browserId: follow that Firefox profile (by its registry
   *  entry, so it survives restarts). Neither: the shared socket (the first Firefox connected). */
  constructor({ path, browserId, browserName } = {}) {
    this.path = path || null;
    this.browserId = browserId || null;
    this.browserName = browserName || null;
    this.socket = null;
    this.connecting = null;
    this.pending = new Map();
    this.nextId = 1;
    this.listeners = new Set();
    this.bidiState = null; // last trusted-input state, re-sent on every (re)connect
    this.chan = null; // encryption for the current connection (auth.js)
    this.generation = 0; // counts connections: what is cached about "this browser" is per connection
  }

  /** Identifies the browser behind the current connection, for caches kept per browser (bidi.js). */
  scopeKey() {
    return `${this.browserId || this.path || 'shared'}#${this.generation}`;
  }

  write(obj) {
    if (this.socket && !this.socket.destroyed && this.chan)
      this.socket.write(this.chan.seal(obj) + '\n');
  }

  onEvent(fn) {
    this.listeners.add(fn);
  }

  connect() {
    if (this.socket && !this.socket.destroyed)
      return Promise.resolve();
    if (this.connecting)
      return this.connecting;
    let target = this.path || socketPath();
    if (this.browserId) {
      target = socketFor(this.browserId);
      if (!target)
        return Promise.reject(new Error(`The Firefox you selected${this.browserName ? ` ("${this.browserName}")` : ''} isn't connected to Foxwright right now. Ask the user to open it, or call list_connected_browsers and select another.`));
    }
    this.connecting = new Promise((resolve, reject) => {
      const s = net.connect(target);
      let buf = '';
      let chan = null; // set once the helper has proved it knows the key (see auth.js)
      let ns = null, nc = null, key = null;
      let settled = false, opened = false;
      const handshakeFailed = (msg) => {
        if (settled)
          return;
        settled = true;
        clearTimeout(timer);
        this.connecting = null;
        s.destroy();
        reject(Object.assign(new Error(msg), { code: 'EAUTH' }));
      };
      // A helper from before 0.8 never sends the challenge: say so instead of hanging.
      const timer = setTimeout(() => handshakeFailed(OLD_HELPER_MSG), 4000);
      s.setEncoding('utf8');
      const ready = () => {
        settled = true;
        opened = true;
        clearTimeout(timer);
        this.socket = s;
        this.chan = chan;
        this.generation++;
        this.connecting = null;
        if (this.onConnect)
          setTimeout(() => this.onConnect(), 0);
        // A new helper (extension reload, Firefox restart) doesn't know this client's trusted-input state yet.
        if (this.bidiState !== null)
          this.write({ type: 'bidi', available: this.bidiState });
        resolve();
      };
      const handshake = (line) => {
        let msg;
        try {
          msg = JSON.parse(line);
        } catch {
          return handshakeFailed(`Something other than the Foxwright helper answered on ${target}. Not sending anything to it. ${OLD_HELPER_MSG}`);
        }
        if (!ns) {
          ns = msg?.type === 'auth-challenge' && msg.v === AUTH_VERSION ? b64(msg.ns, 32) : null;
          if (!ns)
            return handshakeFailed(msg?.type === 'auth-challenge' ? `The Foxwright helper uses a different handshake version (${msg.v}). Ask the user to run \`npx foxwright-firefox@latest setup\`, restart Firefox, and update this MCP server.` : OLD_HELPER_MSG);
          try {
            key = readToken();
          } catch (e) {
            return handshakeFailed(`Could not read Foxwright's key file ${tokenPath()}: ${e.message}`);
          }
          nc = nonce();
          s.write(JSON.stringify({ type: 'auth', v: AUTH_VERSION, nc: nc.toString('base64'), mac: proof(key, 'client', ns, nc).toString('base64') }) + '\n');
          return;
        }
        if (msg?.type === 'auth-failed')
          return handshakeFailed(`The Foxwright helper refused this MCP server: ${msg.error || 'authentication failed'}`);
        const mac = msg?.type === 'auth-ok' ? b64(msg.mac, 32) : null;
        if (!mac || !sameMac(mac, proof(key, 'helper', ns, nc)))
          return handshakeFailed(`Whatever is listening on ${target} could not prove it is the Foxwright helper (it doesn't know this computer's Foxwright key in ${tokenPath()}), so nothing was sent to it. Ask the user to close Firefox, check for unexpected programs, then reopen Firefox; if it persists, run \`npx foxwright-firefox doctor\`.`);
        chan = new SecureChannel(key, ns, nc, 'client');
        ready();
      };
      s.on('data', (d) => {
        buf += d;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim())
            continue;
          if (!chan) {
            if (!settled)
              handshake(line);
            continue;
          }
          let msg;
          try {
            msg = chan.open(line);
          } catch {
            // Tampered, replayed or garbled: this connection can't be trusted any more.
            s.destroy();
            return;
          }
          if (msg.type === 'event') {
            for (const fn of this.listeners) fn(msg);
            continue;
          }
          const p = this.pending.get(msg.id);
          if (p) {
            this.pending.delete(msg.id);
            clearTimeout(p.timer);
            if (msg.type === 'response' && msg.error) {
              const err = new Error(msg.error);
              err.fromHelper = true; // a decision by the extension (permission, pause...), not a transport glitch
              p.reject(err);
            }
            else
              p.resolve(msg.type === 'response' ? msg.result : msg);
          }
        }
      });
      const fail = (err) => {
        clearTimeout(timer);
        if (this.socket === s) {
          this.socket = null;
          this.chan = null;
        }
        if (opened) {
          for (const p of this.pending.values()) {
            clearTimeout(p.timer);
            p.reject(new Error('Lost connection to Firefox (was it closed or restarted?). Try again.'));
          }
          this.pending.clear();
          return;
        }
        if (settled)
          return; // a failed handshake already reported this socket
        settled = true;
        this.connecting = null;
        reject(notRunning(err));
      };
      s.on('error', fail);
      s.on('close', () => fail(new Error('closed')));
    });
    return this.connecting;
  }

  async send(obj, timeoutMs) {
    await this.connect();
    const id = this.nextId++;
    return new Promise((resolve, reject) => {
      const timer = setTimeout(() => {
        this.pending.delete(id);
        reject(new Error(`Firefox did not answer within ${Math.round(timeoutMs / 1000)}s. The action may still have happened: check the page (read_page or a screenshot) before retrying.`));
      }, timeoutMs);
      this.pending.set(id, { resolve, reject, timer });
      this.write({ ...obj, id });
    });
  }

  call(tool, args = {}, timeoutMs = 180000) {
    return this.send({ type: 'request', tool, args }, timeoutMs);
  }

  status() {
    return this.send({ type: 'status' }, 5000);
  }

  /** Switch to another browser (see the constructor). Open requests on the old one fail. */
  use({ path, browserId, browserName } = {}) {
    this.path = path || null;
    this.browserId = browserId || null;
    this.browserName = browserName || null;
    this.close();
  }

  close() {
    if (this.socket && !this.socket.destroyed)
      this.socket.destroy();
    this.socket = null;
    this.chan = null;
  }

  notifyBidi(available) {
    this.bidiState = available;
    this.write({ type: 'bidi', available });
  }
}

function notRunning(err) {
  const code = err && err.code;
  if (code === 'ENOENT' || code === 'ECONNREFUSED')
    return Object.assign(new Error('Firefox with the Foxwright extension is not running (no helper socket found). Ask the user to open Firefox and make sure the Foxwright extension is installed and enabled. If it is, they should run `npx foxwright-firefox doctor`.'), { code });
  return Object.assign(new Error(`Could not reach the Foxwright helper: ${err && err.message}`), { code });
}
