// Kitsune's in-page activity indicator: a glow around the tab plus a "Stop" pill.
// Lives in a closed shadow root and only reacts to trusted (human) clicks.
// It is a convenience only: a hostile page could hide or imitate it, so the
// authoritative controls are extension-owned (toolbar popup, Alt+Shift+K,
// the tab-group title, and the permission window).

declare const browser: any;

const HOST_TAG = 'kitsune-ui';
let host: HTMLElement | null = null;
let root: ShadowRoot | null = null;
let hideTimer: any = null;

export function isKitsuneUi(el: Element | null): boolean {
  return !!el && (el === host || el.tagName?.toLowerCase() === HOST_TAG);
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
  z-index: 2147483647; pointer-events: auto; opacity: 0; transition: opacity .2s, transform .2s;
  display: flex; align-items: center; gap: 10px; padding: 7px 8px 7px 12px;
  background: #1b1714; color: #f6efe3; border-radius: 999px;
  font: 500 13px/1.2 ui-sans-serif, -apple-system, "Segoe UI", system-ui, sans-serif;
  box-shadow: 0 6px 24px rgba(0,0,0,.35), 0 0 0 1px rgba(255,255,255,.06);
}
.pill.on { opacity: 1; transform: translateX(-50%) translateY(0); }
.pill .mark { width: 18px; height: 18px; flex: none; }
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
  svg.setAttribute('viewBox', '0 0 32 32');
  svg.setAttribute('aria-hidden', 'true');
  const face = document.createElementNS(NS, 'path');
  face.setAttribute('fill', '#f6efe3');
  face.setAttribute('d', 'M4 3l7 7h10l7-7v12c0 7-5.4 13-12 13S4 22 4 15z');
  const marks = document.createElementNS(NS, 'path');
  marks.setAttribute('fill', '#d64024');
  marks.setAttribute('d', 'M9 14l5 3-5 1zM23 14l-5 3 5 1zM16 22l-2.4-2h4.8z');
  svg.append(face, marks);
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

/** Show the glow + Stop pill; auto-hides after `ms` of no agent activity. */
export function showActivity(ms = 6000) {
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
    pill = el('div', 'pill', undefined, [foxMark(), el('span', '', 'Kitsune is driving this tab')]);
    const stop = el('button', '', 'Stop');
    stop.title = 'Pause Kitsune. The AI can\'t act again until you resume it from the toolbar button.';
    stop.addEventListener('click', (e) => {
      if (!e.isTrusted)
        return;
      browser.runtime.sendMessage({ kind: 'user-stop' });
      hideActivity();
    });
    pill.appendChild(stop);
    r.appendChild(pill);
  }
  requestAnimationFrame(() => {
    glow!.classList.add('on');
    pill!.classList.add('on');
  });
  clearTimeout(hideTimer);
  hideTimer = setTimeout(hideActivity, ms);
}

export function hideActivity() {
  if (!root)
    return;
  root.querySelector('.glow')?.classList.remove('on');
  root.querySelector('.pill')?.classList.remove('on');
}
