// Optional "trusted input" mode.
//
// If Firefox was started with --remote-debugging-port (e.g. 9222), its WebDriver
// BiDi endpoint can dispatch real, isTrusted=true mouse/keyboard/wheel input into
// the user's existing tabs. Foxwright uses it automatically when it's reachable, and
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
    this.url = process.env.FOXWRIGHT_BIDI_URL || `ws://127.0.0.1:${process.env.FOXWRIGHT_BIDI_PORT || 9222}/session`;
    this.disabled = process.env.FOXWRIGHT_TRUSTED === '0';
    this.ws = null;
    this.ready = false;
    this.lastFail = 0;
    this.opening = null; // the connection attempt in progress, shared by concurrent callers
    this.nextId = 1;
    this.pending = new Map();
    // "<browser scope>|<tabId>:<frameId>" -> BiDi browsing context id. The scope (which Firefox
    // profile, which helper connection) is part of the key: tab ids restart in every profile, so
    // tab 3 of "Personal" must never reuse the context found for tab 3 of "Work".
    this.contexts = new Map();
    this.scope = '';
    // Navigation bookkeeping per browsing context, from BiDi events: lets trusted input notice that
    // the page it is typing into is being replaced (see waitSettled).
    this.navs = new Map(); // context -> { started, settled }
    this.watching = false;
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
      // Generous: a Firefox that is still starting up can take a few seconds to answer, and a
      // timeout here means the first actions of a session fall back to synthetic input.
      const ws = new WebSocket(this.url, { handshakeTimeout: 4000 });
      const timer = setTimeout(() => {
        ws.terminate();
        reject(new Error('timeout'));
      }, 6000);
      ws.on('open', async () => {
        this.ws = ws;
        try {
          const r = await this.cmd('session.new', { capabilities: {} });
          // Keystrokes may include text the user gave for a login; only send them to Firefox itself.
          const name = r?.capabilities?.browserName;
          if (name && name.toLowerCase() !== 'firefox')
            throw new Error(`port answered as "${name}", not Firefox`);
          await this.subscribe();
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
        if (msg.type === 'event') {
          this.onEvent(msg.method, msg.params || {});
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
        this.navs.clear();
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

  /**
   * Which browser the cached contexts belong to (browser id + helper connection). A new scope drops
   * every cached context, so the next action re-probes: after select_browser, switch_browser, the
   * shared socket moving to another profile, or any reconnect.
   */
  setScope(scope) {
    scope = String(scope ?? '');
    if (scope !== this.scope) {
      this.scope = scope;
      this.contexts.clear();
    }
  }

  /** Find the BiDi browsing context for a Firefox tab (and optionally one of its frames), using a probe attribute set by the extension. */
  async contextFor(tabId, helper, frameId = 0) {
    if (typeof helper?.scopeKey === 'function')
      this.setScope(helper.scopeKey());
    const key = `${this.scope}|${tabId}:${frameId}`;
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
            expression: 'document.documentElement.getAttribute("data-foxwright-probe")',
            target: { context, sandbox: 'foxwright' }, // isolated realm: page scripts can't see or tamper with the probe
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

  // ---------- navigation events ----------

  /** Ask Firefox for navigation events, one at a time: an event a Firefox version doesn't know must not cost the others. */
  async subscribe() {
    const events = ['browsingContext.navigationStarted', 'browsingContext.navigationCommitted', 'browsingContext.domContentLoaded', 'browsingContext.load',
      'browsingContext.navigationFailed', 'browsingContext.navigationAborted', 'browsingContext.fragmentNavigated', 'browsingContext.contextDestroyed'];
    const ok = await Promise.all(events.map(e => this.cmd('session.subscribe', { events: [e] }).then(() => true, () => false)));
    this.watching = ok[0];
  }

  onEvent(method, p) {
    const c = p.context;
    if (!c)
      return;
    if (method === 'browsingContext.contextDestroyed') {
      this.navs.delete(c);
      return;
    }
    const n = this.navs.get(c) || { started: 0, settled: 0, at: 0 };
    if (method === 'browsingContext.navigationStarted') {
      n.started++;
      n.at = Date.now();
    } else { // a new document is in place, or the navigation ended without one: the URL is final
      n.settled = n.started;
    }
    this.navs.set(c, n);
  }

  /** How many navigations have started in these contexts so far (a marker for navigatedSince). */
  navMark(contexts) {
    return contexts.reduce((sum, c) => sum + (this.navs.get(c)?.started || 0), 0);
  }

  /** After an Enter key: wait briefly for a navigation it may have started (a form submit). True if one started. */
  async navigatedSince(contexts, mark, ms = 150) {
    if (!this.watching)
      return false;
    const t0 = Date.now();
    while (this.navMark(contexts) === mark && Date.now() - t0 < ms)
      await new Promise(r => setTimeout(r, 10));
    return this.navMark(contexts) !== mark;
  }

  /** Wait (up to ms) for navigations under way in these contexts to put their new document in place. False if one is still loading. */
  async waitSettled(contexts, ms = 5000) {
    const t0 = Date.now();
    const busy = () => contexts.some((c) => {
      const n = this.navs.get(c);
      return n && n.settled < n.started && Date.now() - n.at < 10000; // one that never ends (a download) stops counting
    });
    while (busy()) {
      if (Date.now() - t0 > ms)
        return false;
      await new Promise(r => setTimeout(r, 15));
    }
    return true;
  }

  async click(context, x, y, { button = 0, count = 1, modifiers } = {}) {
    x = Math.round(x);
    y = Math.round(y);
    const mods = parseModifiers(modifiers);
    const pointer = [{ type: 'pointerMove', x, y, origin: 'viewport', duration: 0 }];
    for (let i = 0; i < count; i++)
      pointer.push({ type: 'pointerDown', button }, { type: 'pointerUp', button });
    const actions = [{ type: 'pointer', id: 'foxwright-mouse', parameters: { pointerType: 'mouse' }, actions: pointer }];
    if (mods.length) {
      const keys = [...mods.map(v => ({ type: 'keyDown', value: v })), ...pointer.map(() => ({ type: 'pause' })), ...mods.reverse().map(v => ({ type: 'keyUp', value: v }))];
      actions[0].actions = [...mods.map(() => ({ type: 'pause' })), ...pointer];
      actions.push({ type: 'key', id: 'foxwright-keys', actions: keys });
    }
    await this.perform(context, actions);
  }

  async hover(context, x, y) {
    await this.perform(context, [{ type: 'pointer', id: 'foxwright-mouse', parameters: { pointerType: 'mouse' }, actions: [{ type: 'pointerMove', x: Math.round(x), y: Math.round(y), origin: 'viewport', duration: 0 }] }]);
  }

  /**
   * A drag in a few steps, with `guard` (async; throws to stop: Stop pressed, page moved) before
   * each. If it stops part-way, the button is released where the pointer is, so the page isn't
   * left with a button held down, and the error says the drag was cut short.
   */
  async drag(context, sx, sy, ex, ey, guard = async () => {}) {
    const steps = 12;
    const move = (i, duration) => ({ type: 'pointerMove', x: Math.round(sx + (ex - sx) * i / steps), y: Math.round(sy + (ey - sy) * i / steps), origin: 'viewport', duration });
    const parts = [[move(0, 0), { type: 'pointerDown', button: 0 }]];
    for (let i = 1; i <= steps; i += 4)
      parts.push([i, i + 1, i + 2, i + 3].filter(k => k <= steps).map(k => move(k, 20)));
    parts[parts.length - 1].push({ type: 'pointerUp', button: 0 });
    const pointer = (actions) => [{ type: 'pointer', id: 'foxwright-mouse', parameters: { pointerType: 'mouse' }, actions }];
    for (let i = 0; i < parts.length; i++) {
      try {
        await guard();
      } catch (e) {
        if (i > 0) {
          await this.perform(context, pointer([{ type: 'pointerUp', button: 0 }])).catch(() => {});
          e.message = `${e.message} (The drag was cut short: the mouse button was released part-way, so the page may have seen a partial drag.)`;
        }
        throw e;
      }
      await this.perform(context, pointer(parts[i]));
    }
  }

  /** A scroll as one wheel action per few ticks, with `guard` before each, so Stop ends a long scroll. */
  async scroll(context, x, y, dx, dy, guard = async () => {}) {
    const n = Math.max(1, Math.ceil(Math.max(Math.abs(dx), Math.abs(dy)) / 300));
    for (let i = 0; i < n; i++) {
      await guard();
      await this.perform(context, [{ type: 'wheel', id: 'foxwright-wheel', actions: [{ type: 'scroll', x: Math.round(x), y: Math.round(y), deltaX: Math.round(dx / n), deltaY: Math.round(dy / n), origin: 'viewport' }] }]);
    }
  }

  /**
   * Types in small chunks. `guard({ afterEnter })` (async) runs before each chunk and throws to stop
   * (Stop pressed, or the page is no longer the approved site), so a long text ends within a few
   * keystrokes. A chunk always ends after a newline (Enter), because Enter may submit a form and
   * load another page: the next guard gets afterEnter so it can look for that first.
   * `progress.sent` counts the characters delivered so far.
   */
  async type(context, text, guard = async () => {}, progress = {}) {
    const chars = [...text.replace(/\r\n?/g, '\n')];
    progress.sent = 0;
    progress.total = chars.length;
    let afterEnter = false;
    for (let i = 0; i < chars.length;) {
      let j = i;
      while (j < chars.length && j - i < 20) {
        j++;
        if (chars[j - 1] === '\n')
          break;
      }
      await guard({ afterEnter });
      const acts = [];
      for (const ch of chars.slice(i, j)) {
        const v = ch === '\n' ? KEY.Enter : ch;
        acts.push({ type: 'keyDown', value: v }, { type: 'keyUp', value: v });
      }
      await this.perform(context, [{ type: 'key', id: 'foxwright-keys', actions: acts }]);
      afterEnter = chars[j - 1] === '\n';
      progress.sent = j;
      i = j;
    }
  }

  /** Key combos, repeated, in small chunks with `guard` before each; a chunk ends after a combo with Enter (see type). */
  async keys(context, combos, repeat = 1, guard = async () => {}, progress = {}) {
    const seq = [];
    for (const combo of combos) {
      const parts = combo.split('+').filter(p => p !== '');
      if (combo.endsWith('++'))
        parts.push('+');
      const values = parts.map(keyValue);
      const acts = [];
      for (const v of values) acts.push({ type: 'keyDown', value: v });
      for (const v of [...values].reverse()) acts.push({ type: 'keyUp', value: v });
      seq.push({ acts, enter: values.includes(KEY.Enter) });
    }
    const all = Array.from({ length: repeat }, () => seq).flat();
    progress.sent = 0;
    progress.total = all.length;
    let afterEnter = false;
    for (let i = 0; i < all.length;) {
      // About ten key presses per command, so Stop is noticed between them.
      let j = i, n = 0;
      while (j < all.length && (n === 0 || n + all[j].acts.length <= 20)) {
        n += all[j].acts.length;
        j++;
        if (all[j - 1].enter)
          break;
      }
      await guard({ afterEnter });
      await this.perform(context, [{ type: 'key', id: 'foxwright-keys', actions: all.slice(i, j).flatMap(k => k.acts) }]);
      afterEnter = all[j - 1].enter;
      progress.sent = j;
      i = j;
    }
  }
}
