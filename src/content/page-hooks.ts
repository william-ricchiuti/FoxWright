// Runs in the page's MAIN world at document start, only in agent tabs on approved sites.
//  1. Records console output and uncaught errors (read_console_messages).
//  2. Replaces blocking alert/confirm/prompt dialogs with non-blocking stand-ins.
//     A real modal dialog freezes the page's JavaScript (and Kitsune's content script
//     with it) until a human clicks it. Instead, Kitsune answers the dialog, records
//     it, and tells the agent: alert -> dismissed, confirm -> Cancel, prompt -> null,
//     unless the agent called handle_dialog first to accept the next one.
// Nothing leaves the tab unless the agent calls a Kitsune tool.

(() => {
  const w = window as any;
  if (w.__kitsuneConsoleHooked)
    return;
  Object.defineProperty(w, '__kitsuneConsoleHooked', { value: true, enumerable: false });
  const MAX = 1000;
  const buf: { level: string; text: string; time: number }[] = [];
  const dialogs: { type: string; message: string; answer: string; time: number }[] = [];
  let next: { accept: boolean; text?: string } | null = null;

  const fmt = (a: any): string => {
    if (typeof a === 'string')
      return a;
    if (a instanceof Error)
      return `${a.name}: ${a.message}${a.stack ? '\n' + a.stack.split('\n').slice(0, 5).join('\n') : ''}`;
    if (a instanceof Element)
      return `<${a.tagName.toLowerCase()}${a.id ? '#' + a.id : ''}>`;
    try {
      const s = JSON.stringify(a);
      return s === undefined ? String(a) : s.length > 2000 ? s.slice(0, 2000) + '…' : s;
    } catch {
      return String(a);
    }
  };
  const push = (level: string, text: string) => {
    buf.push({ level, text: text.length > 4000 ? text.slice(0, 4000) + '…' : text, time: Date.now() });
    if (buf.length > MAX)
      buf.shift();
  };

  for (const level of ['log', 'info', 'warn', 'error', 'debug'] as const) {
    const orig = console[level];
    if (typeof orig !== 'function')
      continue;
    console[level] = function (this: any, ...args: any[]) {
      try {
        push(level, args.map(fmt).join(' '));
      } catch { /* never break the page */ }
      return orig.apply(this, args);
    };
  }
  window.addEventListener('error', (e: ErrorEvent) => {
    push('exception', `${e.message}${e.filename ? ` (${e.filename}:${e.lineno}:${e.colno})` : ''}`);
  }, true);
  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    push('exception', 'Unhandled promise rejection: ' + fmt(e.reason));
  });

  // ----- dialogs -----
  const record = (type: string, message: any, answer: string) => {
    dialogs.push({ type, message: String(message ?? '').slice(0, 1000), answer, time: Date.now() });
    if (dialogs.length > 50)
      dialogs.shift();
  };
  const take = () => {
    const n = next;
    next = null;
    return n;
  };
  w.alert = function alert(message?: any) {
    take();
    record('alert', message, 'dismissed');
  };
  w.confirm = function confirm(message?: any) {
    const n = take();
    const ok = !!n?.accept;
    record('confirm', message, ok ? 'OK' : 'Cancel');
    return ok;
  };
  w.prompt = function prompt(message?: any, def?: any) {
    const n = take();
    const value = n?.accept ? (n.text ?? (def == null ? '' : String(def))) : null;
    record('prompt', message, value === null ? 'Cancel' : `OK with ${JSON.stringify(value)}`);
    return value;
  };

  // ----- pointer capture for synthetic pointers -----
  // Pages (canvas apps, sliders, drag libraries) call setPointerCapture(e.pointerId) in
  // pointerdown. Firefox rejects that for synthetic events ("Invalid pointer id"), which
  // aborts the page's handler. During a Kitsune-synthesized gesture we emulate capture
  // instead, and tell the content script which element captured the pointer.
  let synthetic = false;
  let emulated: Element | null = null;
  const EP = Element.prototype as any;
  const origSet = EP.setPointerCapture, origRelease = EP.releasePointerCapture, origHas = EP.hasPointerCapture;
  EP.setPointerCapture = function (this: Element, id: number) {
    try {
      return origSet.call(this, id);
    } catch (err) {
      if (!synthetic)
        throw err;
      emulated = this;
      this.dispatchEvent(new CustomEvent('kitsune:pointer-capture', { bubbles: true, composed: true }));
    }
  };
  EP.releasePointerCapture = function (this: Element, id: number) {
    try {
      return origRelease.call(this, id);
    } catch (err) {
      if (!synthetic)
        throw err;
      if (emulated === this) {
        emulated = null;
        this.dispatchEvent(new CustomEvent('kitsune:pointer-release', { bubbles: true, composed: true }));
      }
    }
  };
  EP.hasPointerCapture = function (this: Element, id: number) {
    return origHas.call(this, id) || (synthetic && emulated === this);
  };
  document.addEventListener('kitsune:synthetic-pointer', (e: Event) => {
    synthetic = (e as CustomEvent).detail === 'on';
    if (!synthetic)
      emulated = null;
  });

  document.addEventListener('kitsune:console-request', (e: Event) => {
    const clear = (e as CustomEvent).detail === 'clear';
    const out = JSON.stringify(buf);
    if (clear)
      buf.length = 0;
    document.dispatchEvent(new CustomEvent('kitsune:console-dump', { detail: out }));
  });
  document.addEventListener('kitsune:dialogs-request', () => {
    const out = JSON.stringify(dialogs.splice(0));
    document.dispatchEvent(new CustomEvent('kitsune:dialogs-dump', { detail: out }));
  });
  document.addEventListener('kitsune:dialog-policy', (e: Event) => {
    try {
      const p = JSON.parse(String((e as CustomEvent).detail));
      next = { accept: !!p.accept, text: typeof p.text === 'string' ? p.text : undefined };
    } catch { /* ignore */ }
  });
})();
