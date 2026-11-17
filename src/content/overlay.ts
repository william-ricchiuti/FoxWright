// Foxwright's in-page activity indicator: a glow around the tab plus a "Stop" pill.
// Lives in a closed shadow root and only reacts to trusted (human) clicks.
// It is a convenience only: a hostile page could hide or imitate it, so the
// authoritative controls are extension-owned (toolbar popup, Alt+Shift+K,
// the tab-group title, and the permission window).

declare const browser: any;

const HOST_TAG = 'foxwright-ui';
let host: HTMLElement | null = null;
let root: ShadowRoot | null = null;
let hideTimer: any = null;

export function isFoxwrightUi(el: Element | null): boolean {
  // Identity only: a page could name its own elements <foxwright-ui> to be skipped as decoys.
  return !!el && el === host;
}

const CSS = `
:host { all: initial; }
.glow {
  position: fixed; inset: 0; pointer-events: none; z-index: 2147483646;
  box-shadow: inset 0 0 0 2px rgba(214, 64, 36, .85), inset 0 0 28px 6px rgba(240, 120, 40, .35);
  opacity: 0; transition: opacity .25s ease;
}
.glow.on { opacity: 1; animation: breathe 2.8s ease-in-out infinite; }
@keyframes breathe { 50% { box-shadow: inset 0 0 0 2px rgba(214, 64, 36, .95), inset 0 0 40px 10px rgba(240, 120, 40, .45); } }
.pill {
  position: fixed; left: 50%; bottom: 14px; transform: translateX(-50%) translateY(8px);
  z-index: 2147483647; pointer-events: none; opacity: 0; transition: opacity .2s, transform .2s;
  display: flex; align-items: center; gap: 10px; padding: 7px 8px 7px 12px;
  background: #1b1714; color: #f6efe3; border-radius: 999px;
  font: 500 13px/1.2 ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
  box-shadow: 0 6px 24px rgba(0,0,0,.35), 0 0 0 1px rgba(255,255,255,.06);
}
.pill.on { opacity: 1; transform: translateX(-50%) translateY(0); pointer-events: auto; }
.pill.top { bottom: auto; top: 14px; }
.pill .mark { width: 20px; height: 20px; flex: none; }
.pill .what { max-width: min(60vw, 520px); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.pill .what b { font-weight: 600; }
.pill button {
  all: unset; cursor: pointer; padding: 5px 12px; border-radius: 999px;
  background: #d64024; color: #fff; font-weight: 600; font-size: 12px; letter-spacing: .02em;
}
.pill button:hover { background: #ec5534; }
`;

function foxMark(): SVGSVGElement {
  const NS = 'http://www.w3.org/2000/svg';
  const svg = document.createElementNS(NS, 'svg');
  svg.setAttribute('class', 'mark');
  // The same drawing as extension/icons/foxwright.svg (the toolbar and store icon).
  svg.setAttribute('viewBox', '4 4 56 56');
  svg.setAttribute('aria-hidden', 'true');
  const tile = document.createElementNS(NS, 'rect');
  for (const [k, v] of Object.entries({ x: '4', y: '4', width: '56', height: '56', rx: '13', fill: '#c8321b' }))
    tile.setAttribute(k, v);
  const path = (fill: string, d: string, opacity?: string) => {
    const p = document.createElementNS(NS, 'path');
    p.setAttribute('fill', fill);
    p.setAttribute('d', d);
    if (opacity)
      p.setAttribute('opacity', opacity);
    return p;
  };
  svg.append(tile,
    path('#fbeee0', 'M12 12l13 13h14l13-13v21c0 12.2-9 22-20 22S12 45.2 12 33z'),
    path('#c8321b', 'M20 31l9 5-9 2zM44 31l-9 5 9 2zM32 46l-4-3.4h8z'),
    path('#1b1714', 'M17 17l6 6-5 1zM47 17l-6 6 5 1z', '.85'));
  return svg;
}

function ensureRoot(): ShadowRoot {
  if (host && host.isConnected && root)
    return root;
  host = document.createElement(HOST_TAG);
  host.style.cssText = 'all: initial; position: fixed; inset: 0; pointer-events: none; z-index: 2147483647;';
  root = host.attachShadow({ mode: 'closed' });
  const style = document.createElement('style');
  style.textContent = CSS;
  root.appendChild(style);
  // Appended to <html>, outside <body>, so the page outline (rooted at <body>) never includes it.
  (document.documentElement || document.body).appendChild(host);
  return root;
}

function el<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, text?: string, children: Node[] = []) {
  const e = document.createElement(tag);
  if (cls)
    e.className = cls;
  if (text !== undefined)
    e.textContent = text;
  e.append(...children);
  return e;
}

/** Show the glow + Stop pill; auto-hides after `ms` of no agent activity. `label` is the agent's
 *  description of its latest action (its own words: a convenience, not something to rely on). */
export function showActivity(ms = 6000, label?: string) {
  if (window.top !== window)
    return; // only in the top frame
  const r = ensureRoot();
  let glow = r.querySelector('.glow') as HTMLElement | null;
  let pill = r.querySelector('.pill') as HTMLElement | null;
  if (!glow) {
    glow = el('div', 'glow');
    r.appendChild(glow);
  }
  if (!pill) {
    pill = el('div', 'pill', undefined, [foxMark(), el('span', 'what', 'Foxwright is driving this tab')]);
    const stop = el('button', '', 'Stop');
    stop.title = 'Pause Foxwright. The AI can\'t act again until you resume it from the toolbar button.';
    stop.addEventListener('click', (e) => {
      if (!e.isTrusted)
        return;
      browser.runtime.sendMessage({ kind: 'user-stop' });
      hideActivity();
    });
    pill.appendChild(stop);
    r.appendChild(pill);
  }
  const what = pill.querySelector('.what') as HTMLElement;
  what.textContent = '';
  if (label) {
    what.append(el('b', '', 'Foxwright: '), document.createTextNode(label));
    what.title = label;
  } else {
    what.textContent = 'Foxwright is driving this tab';
    what.removeAttribute('title');
  }
  requestAnimationFrame(() => {
    glow!.classList.add('on');
    pill!.classList.add('on');
  });
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hideActivity, ms);
}

/**
 * A real (trusted-input) click by the agent is about to land at this viewport point. If the
 * pill is in the way, move it to the other edge so the click reaches the page, not the pill.
 */
export function dodgePill(x: number, y: number) {
  const pill = root?.querySelector('.pill') as HTMLElement | null;
  if (!pill)
    return false;
  const r = pill.getBoundingClientRect();
  const m = 12;
  if (x < r.left - m || x > r.right + m || y < r.top - m || y > r.bottom + m)
    return false;
  pill.classList.toggle('top');
  return true;
}

export function hideActivity() {
  if (!root)
    return;
  root.querySelector('.glow')?.classList.remove('on');
  root.querySelector('.pill')?.classList.remove('on');
}
