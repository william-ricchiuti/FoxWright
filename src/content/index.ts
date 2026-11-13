// Foxwright content script: injected on demand into tabs the agent controls.
import { takeSnapshot, findElements, setRefPrefix, getRefPrefix } from './snapshot';
import * as input from './input';
import { pageText } from './text';
import { showActivity, hideActivity, dodgePill } from './overlay';
import { watchSecrets } from './secrets';

watchSecrets();
import { AGENT_WINDOW_MS, type Hooks } from './hooks';

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

function hooks(): Hooks {
  return g.__foxwrightHooks;
}

function consoleDump(clear: boolean) {
  const h = hooks();
  const out = h.console.slice(-1000);
  if (clear)
    h.console.length = 0;
  return out;
}

function dialogsDump() {
  return hooks().dialogs.splice(0).slice(-20).map(d => ({ type: d.type, message: d.message.slice(0, 500), answer: d.answer }));
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

/** Border boxes (this frame's viewport, CSS px) of the given child frames, also inside shadow roots. */
function frameRects(args: { frameIds: number[] }) {
  const want = new Set(args.frameIds);
  const out: Record<number, { x: number, y: number, w: number, h: number }> = {};
  const walk = (root: Document | ShadowRoot) => {
    for (const el of Array.from(root.querySelectorAll('*'))) {
      if (/^(iframe|frame|object|embed)$/i.test(el.localName)) {
        let id = -1;
        try {
          id = browser.runtime.getFrameId(el as any);
        } catch { /* ignore */ }
        if (want.has(id)) {
          const r = el.getBoundingClientRect();
          out[id] = { x: r.left, y: r.top, w: r.width, h: r.height };
        }
      }
      const sr = (el as any).openOrClosedShadowRoot ?? el.shadowRoot;
      if (sr)
        walk(sr);
    }
  };
  walk(document);
  return out;
}

const handlers: Record<string, (args: any) => any> = {
  ping: () => ({ pong: true, url: location.href, prefix: getRefPrefix() }),
  viewport: () => ({ width: innerWidth, height: innerHeight, dpr: devicePixelRatio, scrollX: scrollX, scrollY: scrollY }),
  snapshot: (a) => takeSnapshot(a),
  // The viewport comes along so the background doesn't need a second round trip to scale coordinates.
  find: (a) => ({ ...findElements(a.query), viewport: { width: innerWidth, height: innerHeight } }),
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
  frameRects: (a) => frameRects(a),
  dodgePill: (a) => dodgePill(a.x, a.y),
  pageText: (a) => pageText(a),
  console: (a) => consoleDump(!!a.clear),
  dialogs: () => dialogsDump(),
  dialogPolicy: (a) => {
    hooks().next = { accept: !!a.accept, text: typeof a.text === 'string' ? a.text : undefined };
    return true;
  },
  activity: (a) => {
    if (a.on === false)
      hideActivity();
    else
      showActivity(a.ms, typeof a.label === 'string' ? a.label : undefined);
    return true;
  },
};

if (!g.__foxwrightContent) {
  g.__foxwrightContent = true;
  browser.runtime.onMessage.addListener((msg: any) => {
    if (!msg || msg.foxwright !== true)
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
    // The agent is working in this tab: answer dialogs automatically until shortly after.
    const agentWork = msg.cmd !== 'ping' && msg.cmd !== 'activity';
    if (agentWork)
      hooks().agentUntil = Date.now() + AGENT_WINDOW_MS;
    return (async () => {
      try {
        return { ok: true, result: await h(msg.args || {}) };
      } catch (e: any) {
        return { ok: false, error: e?.message || String(e) };
      } finally {
        if (agentWork)
          hooks().agentUntil = Date.now() + AGENT_WINDOW_MS;
      }
    })();
  });
}
