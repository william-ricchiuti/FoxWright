// MCP-server side connection to the Foxwright helper's local socket.
import net from 'node:net';
import { socketPath } from './paths.js';
import { socketFor } from './browsers.js';

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
      s.setEncoding('utf8');
      s.once('connect', () => {
        this.socket = s;
        this.connecting = null;
        if (this.onConnect)
          setTimeout(() => this.onConnect(), 0);
        // A new helper (extension reload, Firefox restart) doesn't know this client's trusted-input state yet.
        if (this.bidiState !== null)
          s.write(JSON.stringify({ type: 'bidi', available: this.bidiState }) + '\n');
        resolve();
      });
      s.on('data', (d) => {
        buf += d;
        let nl;
        while ((nl = buf.indexOf('\n')) >= 0) {
          const line = buf.slice(0, nl);
          buf = buf.slice(nl + 1);
          if (!line.trim())
            continue;
          let msg;
          try {
            msg = JSON.parse(line);
          } catch {
            continue;
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
        const wasConnected = this.socket === s;
        this.socket = null;
        this.connecting = null;
        for (const p of this.pending.values()) {
          clearTimeout(p.timer);
          p.reject(new Error('Lost connection to Firefox (was it closed or restarted?). Try again.'));
        }
        this.pending.clear();
        if (!wasConnected)
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
      this.socket.write(JSON.stringify({ ...obj, id }) + '\n');
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
  }

  notifyBidi(available) {
    this.bidiState = available;
    if (this.socket && !this.socket.destroyed)
      this.socket.write(JSON.stringify({ type: 'bidi', available }) + '\n');
  }
}

function notRunning(err) {
  const code = err && err.code;
  if (code === 'ENOENT' || code === 'ECONNREFUSED')
    return new Error('Firefox with the Foxwright extension is not running (no helper socket found). Ask the user to open Firefox and make sure the Foxwright extension is installed and enabled. If it is, they should run `npx foxwright-firefox doctor`.');
  return new Error(`Could not reach the Foxwright helper: ${err && err.message}`);
}
