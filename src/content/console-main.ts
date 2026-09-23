// Runs in the page's MAIN world at document start, only in tabs Kitsune controls.
// Records console output and uncaught errors into a private buffer that the
// isolated content script can request. Nothing leaves the tab unless the AI calls
// read_console_messages.

(() => {
  const w = window as any;
  if (w.__kitsuneConsoleHooked)
    return;
  Object.defineProperty(w, '__kitsuneConsoleHooked', { value: true, enumerable: false });
  const MAX = 1000;
  const buf: { level: string; text: string; time: number; source?: string }[] = [];

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
  const push = (level: string, text: string, source?: string) => {
    buf.push({ level, text: text.length > 4000 ? text.slice(0, 4000) + '…' : text, time: Date.now(), source });
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

  document.addEventListener('kitsune:console-request', (e: Event) => {
    const clear = (e as CustomEvent).detail === 'clear';
    const out = JSON.stringify(buf);
    if (clear)
      buf.length = 0;
    document.dispatchEvent(new CustomEvent('kitsune:console-dump', { detail: out }));
  });
})();
