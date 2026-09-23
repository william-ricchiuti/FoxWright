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

function consoleDump(clear: boolean): Promise<any[]> {
  return new Promise(resolve => {
    let done = false;
    const onDump = (e: Event) => {
      done = true;
      document.removeEventListener('kitsune:console-dump', onDump);
      try {
        // The page can forge this event, so validate the shape.
        const raw = JSON.parse(String((e as CustomEvent).detail));
        resolve(Array.isArray(raw) ? raw.slice(-1000).map((x: any) => ({
          level: String(x?.level ?? 'log').slice(0, 20),
          text: String(x?.text ?? '').slice(0, 4000),
          time: Number.isFinite(x?.time) ? x.time : Date.now(),
        })) : []);
      } catch {
        resolve([]);
      }
    };
    document.addEventListener('kitsune:console-dump', onDump);
    document.dispatchEvent(new CustomEvent('kitsune:console-request', { detail: clear ? 'clear' : '' }));
    setTimeout(() => {
      if (!done) {
        document.removeEventListener('kitsune:console-dump', onDump);
        resolve([]);
      }
    }, 300);
  });
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
  pageText: (a) => pageText(a),
  console: async (a) => consoleDump(!!a.clear),
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
    if (msg.expectOrigin && originOf(location.href) !== msg.expectOrigin)
      return Promise.resolve({ ok: false, error: `This frame is now showing ${originOf(location.href) || location.href}, not ${msg.expectOrigin} (it navigated). Call the tool again.` });
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
