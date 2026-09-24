// Kitsune content script: injected on demand into tabs the agent controls.
import { takeSnapshot, findElements, setRefPrefix, getRefPrefix } from './snapshot';
import * as input from './input';
import { pageText } from './text';
import { showActivity, hideActivity } from './overlay';

declare const browser: any;

const g = globalThis as any;

function originOf(url: string): string | null {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:')
      return u.origin;
    if (u.protocol === 'file:')
      return 'file://' + u.pathname.replace(/[^/]*$/, '');
    if (u.protocol === 'blob:')
      return originOf(u.pathname);
    return null;
  } catch {
    return null;
  }
}

/**
 * Origin of this document for the "same site as approved" check. about:blank and srcdoc frames
 * (rich editors like TinyMCE and CKEditor 4, webmail composers) have no origin in their URL:
 * they inherit their creator's, which is what the background computes too.
 */
function currentOrigin(): string | null {
  if (location.protocol !== 'about:')
    return originOf(location.href);
  if (self.origin && self.origin !== 'null')
    return self.origin;
  try {
    return originOf(window.parent.location.href); // file: parents give "null" above
  } catch {
    return null; // sandboxed: an opaque origin; its content came from the (approved) parent
  }
}

/** Ask the MAIN-world hook (page-hooks.ts) for its buffer. The page can forge replies, so validate. */
function requestDump(request: string, dump: string, detail = ''): Promise<any[]> {
  return new Promise(resolve => {
    let done = false;
    const onDump = (e: Event) => {
      done = true;
      document.removeEventListener(dump, onDump);
      try {
        const raw = JSON.parse(String((e as CustomEvent).detail));
        resolve(Array.isArray(raw) ? raw.slice(-1000) : []);
      } catch {
        resolve([]);
      }
    };
    document.addEventListener(dump, onDump);
    document.dispatchEvent(new CustomEvent(request, { detail }));
    setTimeout(() => {
      if (!done) {
        document.removeEventListener(dump, onDump);
        resolve([]);
      }
    }, 300);
  });
}

async function consoleDump(clear: boolean) {
  const raw = await requestDump('kitsune:console-request', 'kitsune:console-dump', clear ? 'clear' : '');
  return raw.map((x: any) => ({
    level: String(x?.level ?? 'log').slice(0, 20),
    text: String(x?.text ?? '').slice(0, 4000),
    time: Number.isFinite(x?.time) ? x.time : Date.now(),
  }));
}

async function dialogsDump() {
  const raw = await requestDump('kitsune:dialogs-request', 'kitsune:dialogs-dump');
  return raw.slice(-20).map((x: any) => ({
    type: String(x?.type ?? 'dialog').slice(0, 10),
    message: String(x?.message ?? '').slice(0, 500),
    answer: String(x?.answer ?? '').slice(0, 200),
  }));
}

function frameOffset(args: { frameId: number }) {
  for (const f of Array.from(document.querySelectorAll('iframe, frame'))) {
    let id = -1;
    try {
      id = browser.runtime.getFrameId(f);
    } catch { /* ignore */ }
    if (id === args.frameId) {
      const r = f.getBoundingClientRect();
      const cs = getComputedStyle(f);
      return { x: r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft), y: r.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop) };
    }
  }
  return null;
}

const handlers: Record<string, (args: any) => any> = {
  ping: () => ({ pong: true, url: location.href, prefix: getRefPrefix() }),
  viewport: () => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scrollX: scrollX, scrollY: scrollY }),
  snapshot: (a) => takeSnapshot(a),
  find: (a) => findElements(a.query),
  click: (a) => input.click(a),
  hover: (a) => input.hover(a),
  type: (a) => input.typeText(a),
  key: (a) => input.pressKeys(a),
  scroll: (a) => input.scroll(a),
  scrollTo: (a) => input.scrollTo(a),
  drag: (a) => input.drag(a),
  formInput: (a) => input.formInput(a),
  upload: (a) => input.uploadFiles(a),
  refPoint: (a) => input.refPoint(a),
  locate: (a) => input.locate(a),
  focusInfo: () => input.focusInfo(),
  frameOffset: (a) => frameOffset(a),
  pageText: (a) => pageText(a),
  console: async (a) => consoleDump(!!a.clear),
  dialogs: async () => dialogsDump(),
  dialogPolicy: (a) => {
    document.dispatchEvent(new CustomEvent('kitsune:dialog-policy', { detail: JSON.stringify({ accept: !!a.accept, text: a.text }) }));
    return true;
  },
  activity: (a) => {
    if (a.on === false)
      hideActivity();
    else
      showActivity(a.ms);
    return true;
  },
};

if (!g.__kitsuneContent) {
  g.__kitsuneContent = true;
  browser.runtime.onMessage.addListener((msg: any) => {
    if (!msg || msg.kitsune !== true)
      return undefined;
    if (typeof msg.prefix === 'string')
      setRefPrefix(msg.prefix);
    const here = currentOrigin();
    const opaqueChild = here === null && location.protocol === 'about:' && window !== window.top;
    if (msg.expectOrigin && here !== msg.expectOrigin && !opaqueChild)
      return Promise.resolve({ ok: false, error: `This frame is now showing ${here || location.href}, not ${msg.expectOrigin} (it navigated). Call the tool again.` });
    if (msg.cmd === 'cancel') {
      input.setCancelled(true);
      return Promise.resolve({ ok: true, result: true });
    }
    input.setCancelled(false);
    const h = handlers[msg.cmd];
    if (!h)
      return Promise.resolve({ ok: false, error: `Unknown content command ${msg.cmd}` });
    return (async () => {
      try {
        return { ok: true, result: await h(msg.args || {}) };
      } catch (e: any) {
        return { ok: false, error: e?.message || String(e) };
      }
    })();
  });
}
