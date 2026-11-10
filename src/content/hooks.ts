// Console capture and non-blocking dialogs, installed from Zenko's isolated content-script
// world (injected at document start in agent tabs, on approved sites only).
//
// The replacement functions are exported into the page with Firefox's exportFunction, but
// their state (the console buffer, the dialog log, the "answer the next dialog" policy) lives
// here, where page scripts can't read, disable or forge it. (An earlier version kept this state
// in the page's own world, so a hostile page could switch the hooks off or answer Zenko's
// requests with made-up dialog reports.)
//
//  1. Records console output and uncaught errors (read_console_messages).
//  2. While the agent is working in the tab, replaces blocking alert/confirm/prompt with
//     stand-ins: alert -> dismissed, confirm -> Cancel, prompt -> null, unless the agent
//     called handle_dialog first. A real modal dialog would freeze the page (and Zenko's
//     content script with it) until a human clicks it. When the agent hasn't acted in the tab
//     recently, the page's real dialogs are shown, so a person using the tab sees them.
// Nothing leaves the tab unless the agent calls a Zenko tool.

declare const exportFunction: (fn: Function, target: any, opts?: { defineAs?: string }) => any;
declare const XPCNativeWrapper: { unwrap<T>(x: T): T };

export interface Hooks {
  console: { level: string; text: string; time: number }[];
  dialogs: { type: string; message: string; answer: string; time: number }[];
  next: { accept: boolean; text?: string } | null;
  agentUntil: number;
  /** Installed before the page's scripts ran (so nothing was missed). */
  early: boolean;
}

/** How long after an agent command dialogs keep being answered automatically. */
export const AGENT_WINDOW_MS = 8000;

(() => {
  const g = globalThis as any;
  if (g.__zenkoHooks)
    return;
  const hooks: Hooks = { console: [], dialogs: [], next: null, agentUntil: 0, early: document.readyState === 'loading' };
  g.__zenkoHooks = hooks;
  const pw = (window as any).wrappedJSObject;
  if (!pw || typeof exportFunction !== 'function')
    return;
  const MAX = 1000;

  const unwrap = (a: any) => {
    try {
      return a && (typeof a === 'object' || typeof a === 'function') ? XPCNativeWrapper.unwrap(a) : a;
    } catch {
      return a;
    }
  };
  const fmt = (raw: any): string => {
    const a = unwrap(raw);
    if (typeof a === 'string')
      return a;
    if (a === null || a === undefined || typeof a !== 'object')
      return String(a);
    try {
      if (typeof a.message === 'string' && typeof a.stack === 'string')
        return `${a.name || 'Error'}: ${a.message}${a.stack ? '\n' + a.stack.split('\n').slice(0, 5).join('\n') : ''}`;
      if (a.nodeType === 1 && typeof a.tagName === 'string')
        return `<${a.tagName.toLowerCase()}${a.id ? '#' + a.id : ''}>`;
      const s = JSON.stringify(a);
      return s === undefined ? String(a) : s.length > 2000 ? s.slice(0, 2000) + '…' : s;
    } catch {
      try {
        return String(a);
      } catch {
        return '[object]';
      }
    }
  };
  const push = (level: string, text: string) => {
    hooks.console.push({ level, text: text.length > 4000 ? text.slice(0, 4000) + '…' : text, time: Date.now() });
    if (hooks.console.length > MAX)
      hooks.console.shift();
  };

  try {
    const pconsole = pw.console;
    for (const level of ['log', 'info', 'warn', 'error', 'debug']) {
      const orig = pconsole[level];
      if (typeof orig !== 'function')
        continue;
      exportFunction(function (...args: any[]) {
        try {
          push(level, args.map(fmt).join(' '));
        } catch { /* never break the page */ }
        try {
          // The page's console must receive an array from the page's own compartment:
          // it isn't allowed to read ours ("Permission denied to access property length").
          const pargs = new pw.Array();
          for (const a of args)
            pargs.push(a);
          return pw.Reflect.apply(orig, pconsole, pargs);
        } catch { /* the page's own console failed; nothing useful to do */ }
      }, pconsole, { defineAs: level });
    }
  } catch { /* console capture unavailable on this page */ }

  window.addEventListener('error', (e: ErrorEvent) => {
    push('exception', `${e.message}${e.filename ? ` (${e.filename}:${e.lineno}:${e.colno})` : ''}`);
  }, true);
  window.addEventListener('unhandledrejection', (e: PromiseRejectionEvent) => {
    push('exception', 'Unhandled promise rejection: ' + fmt(e.reason));
  });

  // ----- dialogs -----
  const agentActive = () => Date.now() < hooks.agentUntil;
  const record = (type: string, message: any, answer: string) => {
    let m = '';
    try {
      m = String(unwrap(message) ?? '');
    } catch { /* ignore */ }
    hooks.dialogs.push({ type, message: m.slice(0, 1000), answer, time: Date.now() });
    if (hooks.dialogs.length > 50)
      hooks.dialogs.shift();
  };
  const take = () => {
    const n = hooks.next;
    hooks.next = null;
    return n;
  };
  try {
    const origAlert = pw.alert, origConfirm = pw.confirm, origPrompt = pw.prompt;
    exportFunction(function alert(message?: any) {
      if (!agentActive())
        return origAlert.call(pw, message);
      take();
      record('alert', message, 'dismissed');
    }, pw, { defineAs: 'alert' });
    exportFunction(function confirm(message?: any) {
      if (!agentActive())
        return origConfirm.call(pw, message);
      const n = take();
      const ok = !!n?.accept;
      record('confirm', message, ok ? 'OK' : 'Cancel');
      return ok;
    }, pw, { defineAs: 'confirm' });
    exportFunction(function prompt(message?: any, def?: any) {
      if (!agentActive())
        return origPrompt.call(pw, message, def);
      const n = take();
      const value = n?.accept ? (n.text ?? (def == null ? '' : String(def))) : null;
      record('prompt', message, value === null ? 'Cancel' : `OK with ${JSON.stringify(value)}`);
      return value;
    }, pw, { defineAs: 'prompt' });
  } catch { /* dialogs stay native */ }
})();
