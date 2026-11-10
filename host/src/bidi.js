// Optional "trusted input" mode.
//
// If Firefox was started with --remote-debugging-port (e.g. 9222), its WebDriver
// BiDi endpoint can dispatch real, isTrusted=true mouse/keyboard/wheel input into
// the user's existing tabs. Zenko uses it automatically when it's reachable, and
// falls back to the extension's synthetic events when it isn't.
import WebSocket from 'ws';
import crypto from 'node:crypto';

const KEY = {
  Backspace: '', Tab: '', Enter: '', Shift: '', Control: '', Alt: '', Pause: '',
  Escape: '', ' ': ' ', PageUp: '', PageDown: '', End: '', Home: '',
  ArrowLeft: '', ArrowUp: '', ArrowRight: '', ArrowDown: '', Insert: '', Delete: '', Meta: '',
};
for (let i = 1; i <= 12; i++) KEY['F' + i] = String.fromCharCode(0xE031 + i - 1);

const ALIASES = {
  enter: 'Enter', return: 'Enter', tab: 'Tab', escape: 'Escape', esc: 'Escape', backspace: 'Backspace', delete: 'Delete', del: 'Delete',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', page_up: 'PageUp', page_down: 'PageDown', space: ' ', spacebar: ' ', insert: 'Insert',
  shift: 'Shift', ctrl: 'Control', control: 'Control', alt: 'Alt', option: 'Alt', cmd: 'Meta', meta: 'Meta', command: 'Meta', super: 'Meta', win: 'Meta', windows: 'Meta',
};

function keyValue(name) {
  if ([...name].length === 1)
    return name;
  const n = ALIASES[name.toLowerCase()] || (/^f\d{1,2}$/i.test(name) ? name.toUpperCase() : name);
  if (KEY[n] === undefined)
    throw new Error(`Unknown key "${name}".`);
  return KEY[n];
}

const MODS = new Set(['', '', '', '']);

function parseModifiers(s) {
  if (!s)
    return [];
  return s.split('+').map(p => p.trim()).filter(Boolean).map(keyValue).filter(v => MODS.has(v));
}

export class Bidi {
  constructor() {
    this.url = process.env.ZENKO_BIDI_URL || `ws://127.0.0.1:${process.env.ZENKO_BIDI_PORT || 9222}/session`;
    this.disabled = process.env.ZENKO_TRUSTED === '0';
    this.ws = null;
    this.ready = false;
    this.lastFail = 0;
    this.opening = null; // the connection attempt in progress, shared by concurrent callers
    this.nextId = 1;
    this.pending = new Map();
    this.contexts = new Map(); // tabId -> BiDi browsing context id
    this.onChange = () => {};
  }

  async available() {
    if (this.disabled)
      return false;
    if (this.ready && this.ws && this.ws.readyState === WebSocket.OPEN)
      return true;
    if (Date.now() - this.lastFail < 5000) // retry soon: Firefox may still be starting up
      return false;
    // One attempt at a time. Firefox allows a single session, and the startup probe often overlaps
    // the first tool call: a second session.new would be refused and strand the first session.
    if (!this.opening) {
      this.opening = (async () => {
        try {
          await this.open();
          this.onChange(true);
          return true;
        } catch (e) {
          this.lastFail = Date.now();
          this.lastError = String(e?.message || e);
          this.onChange(false);
          return false;
        } finally {
          this.opening = null;
        }
      })();
    }
    return this.opening;
  }

  open() {
    return new Promise((resolve, reject) => {
      const ws = new WebSocket(this.url, { handshakeTimeout: 1500 });
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('timeout'));
      }, 2500);
      ws.on('open', async () => {
        this.ws = ws;
        try {
          const r = await this.cmd('session.new', { capabilities: {} });
          // Keystrokes may include text the user gave for a login; only send them to Firefox itself.
          const name = r?.capabilities?.browserName;
          if (name && name.toLowerCase() !== 'firefox')
            throw new Error(`port answered as "${name}", not Firefox`);
          this.ready = true;
          clearTimeout(timer);
          resolve();
        } catch (e) {
          clearTimeout(timer);
          ws.close();
          reject(e);
        }
      });
      ws.on('message', (data) => {
        let msg;
        try {
          msg = JSON.parse(String(data));
        } catch {
          return;
        }
        if (msg.id !== undefined && this.pending.has(msg.id)) {
          const p = this.pending.get(msg.id);
          this.pending.delete(msg.id);
          if (msg.type === 'error')
            p.reject(new Error(`${msg.error}: ${msg.message}`));
          else
            p.resolve(msg.result);
        }
      });
      const down = () => {
        clearTimeout(timer);
        const was = this.ready;
        this.ready = false;
        this.ws = null;
        this.contexts.clear();
        for (const p of this.pending.values()) p.reject(new Error('BiDi connection closed'));
        this.pending.clear();
        if (was)
          this.onChange(false);
      };
      ws.on('error', (e) => {
        down();
        reject(e);
      });
      ws.on('close', down);
    });
  }

  cmd(method, params) {
    return new Promise((resolve, reject) => {
      if (!this.ws)
        return reject(new Error('BiDi not connected'));
      const id = this.nextId++;
      const timer = setTimeout(() => {
        if (this.pending.has(id)) {
          this.pending.delete(id);
          reject(new Error(`BiDi ${method} timed out`));
        }
      }, 20000);
      this.pending.set(id, {
        resolve: (v) => { clearTimeout(timer); resolve(v); },
        reject: (e) => { clearTimeout(timer); reject(e); },
      });
      this.ws.send(JSON.stringify({ id, method, params }));
    });
  }

  /** End the WebDriver session (Firefox allows only one) and close the socket. */
  async close() {
    if (!this.ws)
      return;
    try {
      if (this.ready)
        await Promise.race([this.cmd('session.end', {}), new Promise(r => setTimeout(r, 500))]);
    } catch { /* already gone */ }
    try {
      this.ws?.close();
    } catch { /* ignore */ }
  }

  /** Find the BiDi browsing context for a Firefox tab (and optionally one of its frames), using a probe attribute set by the extension. */
  async contextFor(tabId, helper, frameId = 0) {
    const key = `${tabId}:${frameId}`;
    const cached = this.contexts.get(key);
    if (cached) {
      try {
        const t = await this.cmd('browsingContext.getTree', { root: cached, maxDepth: 0 });
        if (t.contexts?.length)
          return cached;
      } catch { /* context gone */ }
      this.contexts.delete(key);
    }
    let candidates;
    if (frameId === 0) {
      const tree = await this.cmd('browsingContext.getTree', { maxDepth: 0 });
      candidates = (tree.contexts || []).map(c => c.context);
    } else {
      const top = await this.contextFor(tabId, helper, 0);
      const tree = await this.cmd('browsingContext.getTree', { root: top });
      candidates = [];
      const walk = (list) => {
        for (const c of list || []) {
          if (c.context !== top)
            candidates.push(c.context);
          walk(c.children);
        }
      };
      walk(tree.contexts);
    }
    const token = crypto.randomBytes(12).toString('hex');
    await helper.call('_mark', { tabId, frameId, token });
    try {
      for (const context of candidates) {
        try {
          const r = await this.cmd('script.evaluate', {
            expression: 'document.documentElement.getAttribute("data-zenko-probe")',
            target: { context, sandbox: 'zenko' }, // isolated realm: page scripts can't see or tamper with the probe
            awaitPromise: false,
            resultOwnership: 'none',
          });
          if (r?.type === 'success' && r.result?.value === token) {
            this.contexts.set(key, context);
            return context;
          }
        } catch { /* restricted or loading context */ }
      }
    } finally {
      helper.call('_unmark', { tabId, frameId }).catch(() => {});
    }
    throw new Error('Could not match the tab to a WebDriver BiDi browsing context.');
  }

  async currentUrl(context) {
    const t = await this.cmd('browsingContext.getTree', { root: context, maxDepth: 0 });
    return t.contexts?.[0]?.url;
  }

  perform(context, actions) {
    return this.cmd('input.performActions', { context, actions });
  }

  async click(context, x, y, { button = 0, count = 1, modifiers } = {}) {
    x = Math.round(x);
    y = Math.round(y);
    const mods = parseModifiers(modifiers);
    const pointer = [{ type: 'pointerMove', x, y, origin: 'viewport', duration: 0 }];
    for (let i = 0; i < count; i++)
      pointer.push({ type: 'pointerDown', button }, { type: 'pointerUp', button });
    const actions = [{ type: 'pointer', id: 'zenko-mouse', parameters: { pointerType: 'mouse' }, actions: pointer }];
    if (mods.length) {
      const keys = [...mods.map(v => ({ type: 'keyDown', value: v })), ...pointer.map(() => ({ type: 'pause' })), ...mods.reverse().map(v => ({ type: 'keyUp', value: v }))];
      actions[0].actions = [...mods.map(() => ({ type: 'pause' })), ...pointer];
      actions.push({ type: 'key', id: 'zenko-keys', actions: keys });
    }
    await this.perform(context, actions);
  }

  async hover(context, x, y) {
    await this.perform(context, [{ type: 'pointer', id: 'zenko-mouse', parameters: { pointerType: 'mouse' }, actions: [{ type: 'pointerMove', x: Math.round(x), y: Math.round(y), origin: 'viewport', duration: 0 }] }]);
  }

  async drag(context, sx, sy, ex, ey) {
    const steps = 12;
    const acts = [{ type: 'pointerMove', x: Math.round(sx), y: Math.round(sy), origin: 'viewport', duration: 0 }, { type: 'pointerDown', button: 0 }];
    for (let i = 1; i <= steps; i++)
      acts.push({ type: 'pointerMove', x: Math.round(sx + (ex - sx) * i / steps), y: Math.round(sy + (ey - sy) * i / steps), origin: 'viewport', duration: 20 });
    acts.push({ type: 'pointerUp', button: 0 });
    await this.perform(context, [{ type: 'pointer', id: 'zenko-mouse', parameters: { pointerType: 'mouse' }, actions: acts }]);
  }

  async scroll(context, x, y, dx, dy) {
    await this.perform(context, [{ type: 'wheel', id: 'zenko-wheel', actions: [{ type: 'scroll', x: Math.round(x), y: Math.round(y), deltaX: Math.round(dx), deltaY: Math.round(dy), origin: 'viewport' }] }]);
  }

  async type(context, text) {
    const acts = [];
    for (const ch of text.replace(/\r\n?/g, '\n')) {
      const v = ch === '\n' ? KEY.Enter : ch;
      acts.push({ type: 'keyDown', value: v }, { type: 'keyUp', value: v });
    }
    // Chunk to keep individual commands reasonable.
    for (let i = 0; i < acts.length; i += 400)
      await this.perform(context, [{ type: 'key', id: 'zenko-keys', actions: acts.slice(i, i + 400) }]);
  }

  async keys(context, combos, repeat = 1) {
    const acts = [];
    for (let r = 0; r < repeat; r++) {
      for (const combo of combos) {
        const parts = combo.split('+').filter(p => p !== '');
        if (combo.endsWith('++'))
          parts.push('+');
        const values = parts.map(keyValue);
        for (const v of values) acts.push({ type: 'keyDown', value: v });
        for (const v of [...values].reverse()) acts.push({ type: 'keyUp', value: v });
      }
    }
    await this.perform(context, [{ type: 'key', id: 'zenko-keys', actions: acts }]);
  }
}
