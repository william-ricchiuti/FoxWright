// Synthetic input for Kitsune.
//
// Firefox extensions cannot create trusted (isTrusted=true) mouse/keyboard events.
// This module dispatches the same event sequences a real browser would and then
// performs the browser's *default actions* itself (focus changes, text insertion,
// form submission, Tab navigation, scrolling...), because untrusted events never
// trigger those on their own. When Firefox runs with --remote-debugging-port,
// the MCP server uses WebDriver BiDi for real (trusted) input instead.

import { resolveRef, getRefPrefix } from './snapshot';
import { isKitsuneUi } from './overlay';

declare const browser: any;

export type Mods = { ctrl: boolean; shift: boolean; alt: boolean; meta: boolean };
const NO_MODS: Mods = { ctrl: false, shift: false, alt: false, meta: false };

export function parseModifiers(s?: string): Mods {
  const m = { ...NO_MODS };
  if (!s)
    return m;
  for (const part of s.toLowerCase().split('+').map(p => p.trim())) {
    if (part === 'ctrl' || part === 'control') m.ctrl = true;
    else if (part === 'shift') m.shift = true;
    else if (part === 'alt' || part === 'option' || part === 'opt') m.alt = true;
    else if (part === 'cmd' || part === 'meta' || part === 'command' || part === 'win' || part === 'windows' || part === 'super') m.meta = true;
  }
  return m;
}

const isMac = navigator.platform.toLowerCase().includes('mac');

// ---------- helpers ----------

export type Forward = { forward: { frameId: number; x?: number; y?: number; args?: any } };

function frameIdOf(el: Element): number {
  try {
    return browser.runtime.getFrameId(el);
  } catch {
    return -1;
  }
}

/** Topmost page element at a viewport point, piercing open shadow roots and skipping Kitsune's own UI. */
export function elementAt(x: number, y: number): Element | null {
  const all = document.elementsFromPoint(x, y).filter(e => !isKitsuneUi(e));
  let el: Element | null = all[0] || null;
  while (el && shadowOf(el)) {
    const inner = shadowOf(el)!.elementFromPoint(x, y);
    if (!inner || inner === el)
      break;
    el = inner;
  }
  return el;
}

/** If the point lands on an iframe, return a forward instruction with frame-local coordinates. */
function iframeForward(el: Element | null, x: number, y: number): Forward | null {
  if (!el || (el.tagName !== 'IFRAME' && el.tagName !== 'FRAME'))
    return null;
  const frameId = frameIdOf(el);
  if (frameId < 0)
    return null;
  const r = el.getBoundingClientRect();
  const cs = getComputedStyle(el);
  const ox = r.left + parseFloat(cs.borderLeftWidth) + parseFloat(cs.paddingLeft);
  const oy = r.top + parseFloat(cs.borderTopWidth) + parseFloat(cs.paddingTop);
  return { forward: { frameId, x: x - ox, y: y - oy } };
}

function deepActiveElement(): Element | null {
  let a: Element | null = document.activeElement;
  while (a && shadowOf(a)?.activeElement)
    a = shadowOf(a)!.activeElement;
  return a;
}

/** Open or closed shadow root (Firefox exposes closed ones to content scripts). */
export function shadowOf(el: Element): ShadowRoot | null {
  return (el as any).openOrClosedShadowRoot ?? el.shadowRoot;
}

export function describe(el: Element | null): string {
  if (!el)
    return 'nothing';
  const tag = el.tagName.toLowerCase();
  const id = el.id ? `#${el.id}` : '';
  const role = el.getAttribute('role');
  const isPassword = el instanceof HTMLInputElement && el.type === 'password';
  // textContent (not innerText): innerText forces layout of the whole subtree, and the focused element is often <body>.
  const text = tag === 'body' || tag === 'html' ? '' : (el.textContent || '').slice(0, 200);
  const value = isPassword ? '' : (el as HTMLInputElement).value;
  const label = (el.getAttribute('aria-label') || text.trim() || value || el.getAttribute('title') || el.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 60);
  return `<${tag}${id}${role ? ` role=${role}` : ''}>${label ? ` "${label}"` : ''}`;
}

const TEXT_INPUT_TYPES = new Set(['text', 'search', 'email', 'url', 'tel', 'password', 'number', '']);

function isTextField(el: Element | null): el is HTMLInputElement | HTMLTextAreaElement {
  if (!el)
    return false;
  if (el instanceof HTMLTextAreaElement)
    return true;
  return el instanceof HTMLInputElement && TEXT_INPUT_TYPES.has((el.getAttribute('type') || '').toLowerCase());
}

function isContentEditable(el: Element | null): el is HTMLElement {
  return !!el && (el as HTMLElement).isContentEditable;
}

function isEditable(el: Element | null) {
  return isTextField(el) || isContentEditable(el);
}

const FOCUSABLE = 'a[href], area[href], button, input, select, textarea, iframe, summary, [tabindex], [contenteditable]:not([contenteditable="false"]), audio[controls], video[controls]';

function focusableAncestor(el: Element | null): HTMLElement | null {
  let e: Element | null = el;
  while (e) {
    if (e.matches?.(FOCUSABLE) && !(e as any).disabled)
      return e as HTMLElement;
    e = e.parentElement || ((e.getRootNode() as ShadowRoot).host ?? null);
  }
  return null;
}

let lastHover: Element | null = null;

// Pointer-capture emulation (see page-hooks.ts): while a synthetic gesture runs, pointer
// events go to the element that "captured" the pointer, like the browser would do.
let captureTarget: Element | null = null;
document.addEventListener('kitsune:pointer-capture', (e) => {
  captureTarget = (e.composedPath()[0] as Element) || null;
  captureTarget?.dispatchEvent(new PointerEvent('gotpointercapture', { bubbles: true, composed: true, pointerId: 0, pointerType: 'mouse', isPrimary: true } as any));
}, true);
document.addEventListener('kitsune:pointer-release', () => {
  captureTarget = null;
}, true);

function gesture(on: boolean) {
  document.dispatchEvent(new CustomEvent('kitsune:synthetic-pointer', { detail: on ? 'on' : 'off' }));
  if (!on && captureTarget) {
    captureTarget.dispatchEvent(new PointerEvent('lostpointercapture', { bubbles: true, composed: true, pointerId: 0, pointerType: 'mouse', isPrimary: true } as any));
    captureTarget = null;
  }
}

/** Where a pointer event at this point goes: the capturing element if any, else `el`. */
function pointerTarget(el: Element): Element {
  return captureTarget && captureTarget.isConnected ? captureTarget : el;
}
let pointerDownAt: { x: number; y: number } | null = null;

function mouseInit(x: number, y: number, mods: Mods, button: number, buttons: number, detail: number): MouseEventInit & PointerEventInit {
  const sx = x + ((window as any).mozInnerScreenX ?? window.screenX);
  const sy = y + ((window as any).mozInnerScreenY ?? window.screenY);
  return {
    bubbles: true, cancelable: true, composed: true, view: window,
    clientX: x, clientY: y, screenX: sx, screenY: sy,
    ctrlKey: mods.ctrl, shiftKey: mods.shift, altKey: mods.alt, metaKey: mods.meta,
    button, buttons, detail,
    pointerId: 0, pointerType: 'mouse', isPrimary: true, width: 1, height: 1, pressure: buttons ? 0.5 : 0,
  };
}

function fire(target: EventTarget, ev: Event): boolean {
  return target.dispatchEvent(ev);
}

function hoverTo(target: Element, x: number, y: number, mods: Mods, buttons = 0) {
  if (lastHover !== target) {
    if (lastHover && lastHover.isConnected) {
      fire(lastHover, new PointerEvent('pointerout', { ...mouseInit(x, y, mods, 0, buttons, 0), relatedTarget: target } as any));
      fire(lastHover, new MouseEvent('mouseout', { ...mouseInit(x, y, mods, 0, buttons, 0), relatedTarget: target }));
      fire(lastHover, new PointerEvent('pointerleave', { ...mouseInit(x, y, mods, 0, buttons, 0), bubbles: false, relatedTarget: target } as any));
      fire(lastHover, new MouseEvent('mouseleave', { ...mouseInit(x, y, mods, 0, buttons, 0), bubbles: false, relatedTarget: target }));
    }
    fire(target, new PointerEvent('pointerover', { ...mouseInit(x, y, mods, 0, buttons, 0), relatedTarget: lastHover } as any));
    fire(target, new MouseEvent('mouseover', { ...mouseInit(x, y, mods, 0, buttons, 0), relatedTarget: lastHover }));
    fire(target, new PointerEvent('pointerenter', { ...mouseInit(x, y, mods, 0, buttons, 0), bubbles: false } as any));
    fire(target, new MouseEvent('mouseenter', { ...mouseInit(x, y, mods, 0, buttons, 0), bubbles: false }));
    lastHover = target;
  }
  fire(target, new PointerEvent('pointermove', mouseInit(x, y, mods, 0, buttons, 0) as any));
  fire(target, new MouseEvent('mousemove', mouseInit(x, y, mods, 0, buttons, 0)));
}

// ---------- element point resolution ----------

function isInViewport(r: DOMRect) {
  return r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
}

/** Scroll a ref'd element into view and pick a point on it that actually hits it. */
export function pointForRef(ref: string): { el: Element; x: number; y: number; covered: Element | null } {
  const el = resolveRef(ref);
  let r = el.getBoundingClientRect();
  if (!isInViewport(r) || r.top < 0 || r.bottom > innerHeight)
    el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
  const rects = Array.from(el.getClientRects()).filter(rc => rc.width > 0 && rc.height > 0);
  r = rects.find(isInViewport) || el.getBoundingClientRect();
  const candidates = [
    [r.left + r.width / 2, r.top + r.height / 2],
    [r.left + Math.min(8, r.width / 4), r.top + r.height / 2],
    [r.right - Math.min(8, r.width / 4), r.top + r.height / 2],
    [r.left + r.width / 2, r.top + Math.min(6, r.height / 4)],
    [r.left + r.width / 2, r.bottom - Math.min(6, r.height / 4)],
  ];
  let covered: Element | null = null;
  for (const [x, y] of candidates) {
    const hit = elementAt(x, y);
    if (hit && (hit === el || el.contains(hit) || (hit as any).getRootNode?.().host && el.contains((hit.getRootNode() as ShadowRoot).host)))
      return { el, x, y, covered: null };
    if (!covered)
      covered = hit;
  }
  return { el, x: candidates[0][0], y: candidates[0][1], covered };
}

// ---------- clicking ----------

/** Double-click selects a word, triple-click a paragraph/field: the browser does this natively, synthetic clicks don't. */
function selectAtPoint(target: Element, x: number, y: number, unit: 'word' | 'block') {
  const cp = (document as any).caretPositionFromPoint?.(x, y);
  if (isTextField(target)) {
    const v = target.value;
    if (unit === 'block') {
      target.select();
      return;
    }
    let pos = cp && cp.offsetNode === target ? cp.offset : v.length;
    const w = /[\p{L}\p{N}_]/u;
    let a = pos, b = pos;
    while (a > 0 && w.test(v[a - 1])) a--;
    while (b < v.length && w.test(v[b])) b++;
    try { target.setSelectionRange(a, b); } catch { /* ignore */ }
    return;
  }
  if (!cp || !cp.offsetNode)
    return;
  const sel = document.getSelection();
  if (!sel)
    return;
  const range = document.createRange();
  if (unit === 'block') {
    const start = cp.offsetNode.nodeType === Node.ELEMENT_NODE ? cp.offsetNode as Element : cp.offsetNode.parentElement;
    const block = start?.closest('p, li, h1, h2, h3, h4, h5, h6, td, th, blockquote, pre, div') || start;
    if (!block)
      return;
    range.selectNodeContents(block);
    sel.removeAllRanges();
    sel.addRange(range);
    return;
  }
  range.setStart(cp.offsetNode, cp.offset);
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
  const s2 = sel as any;
  if (typeof s2.modify === 'function') {
    s2.modify('move', 'backward', 'word');
    s2.modify('extend', 'forward', 'word');
    // Firefox may include the following space in the word; trim it like a double-click does.
    const t = sel.toString();
    if (/\s$/.test(t) && sel.focusNode && sel.focusOffset > 0)
      sel.extend(sel.focusNode, sel.focusOffset - (t.length - t.trimEnd().length));
  }
}

/** Put the caret where a real click at (x, y) would, inside a contenteditable. */
function placeCaretAt(editable: HTMLElement, x: number, y: number) {
  const sel = document.getSelection();
  if (!sel)
    return;
  const pos = (document as any).caretPositionFromPoint?.(x, y);
  const range = document.createRange();
  if (pos && pos.offsetNode && editable.contains(pos.offsetNode)) {
    range.setStart(pos.offsetNode, pos.offset);
  } else {
    range.selectNodeContents(editable);
    range.collapse(false);
  }
  range.collapse(true);
  sel.removeAllRanges();
  sel.addRange(range);
}

type ClickOpts = { button?: 'left' | 'right' | 'middle'; clickCount?: number; mods?: Mods };

function openInNewTabIntent(el: Element, mods: Mods, button: number): string | null {
  const a = el.closest?.('a[href], area[href]') as HTMLAnchorElement | null;
  if (!a)
    return null;
  const href = a.href;
  if (!href || href.startsWith('javascript:'))
    return null;
  const newTab = button === 1 || (a.target && a.target !== '_self' && a.target !== '_parent' && a.target !== '_top') || (isMac ? mods.meta : mods.ctrl);
  return newTab ? href : null;
}

/** Dispatch a full click sequence on `target` at (x, y). */
export function clickTarget(target: Element, x: number, y: number, opts: ClickOpts = {}) {
  const mods = opts.mods || NO_MODS;
  const button = opts.button === 'right' ? 2 : opts.button === 'middle' ? 1 : 0;
  const buttonsMask = button === 2 ? 2 : button === 1 ? 4 : 1;
  const count = Math.max(1, Math.min(3, opts.clickCount || 1));
  const notes: string[] = [];
  let openUrl: string | null = null;
  let prevented = false;
  let submitEvent: Event | null = null;

  hoverTo(target, x, y, mods);
  gesture(true);
  try {
  for (let i = 1; i <= count; i++) {
    const downOk = fire(target, new PointerEvent('pointerdown', mouseInit(x, y, mods, button, buttonsMask, i) as any));
    let mdOk = true;
    if (downOk)
      mdOk = fire(target, new MouseEvent('mousedown', mouseInit(x, y, mods, button, buttonsMask, i)));
    if (mdOk && i === 1) {
      // Real browsers move focus on mousedown; synthetic events don't.
      const f = focusableAncestor(target);
      const active = deepActiveElement();
      // In a frame whose document isn't focused yet (an about:blank editor whose <body> is already
      // its activeElement), focus the frame's window too, so the parent's focus moves into it.
      if (f && (f !== active || !document.hasFocus())) {
        if (window !== window.top && !document.hasFocus()) {
          try {
            window.focus();
          } catch { /* ignore */ }
        }
        f.focus();
      }
      else if (!f && active && active !== document.body)
        (active as HTMLElement).blur?.();
      if (f && isTextField(f) && i === 1) {
        // put caret at end, like clicking into a field usually does
        try {
          const len = (f as HTMLInputElement).value.length;
          (f as HTMLInputElement).setSelectionRange(len, len);
        } catch { /* some input types don't support selection */ }
      } else if (f && f.isContentEditable) {
        placeCaretAt(f, x, y);
      }
    }
    if (mdOk && button === 0 && i >= 2)
      selectAtPoint(target, x, y, i === 2 ? 'word' : 'block'); // default action of double/triple click
    fire(pointerTarget(target), new PointerEvent('pointerup', mouseInit(x, y, mods, button, 0, i) as any));
    fire(pointerTarget(target), new MouseEvent('mouseup', mouseInit(x, y, mods, button, 0, i)));

    if (button === 0) {
      const intent = openInNewTabIntent(target, mods, button);
      let guard: ((e: Event) => void) | null = null;
      if (intent) {
        // Popups from untrusted clicks are blocked; open the tab ourselves instead
        // unless the page handles the click itself.
        guard = (e: Event) => {
          if (!e.defaultPrevented) {
            e.preventDefault();
            openUrl = intent;
          }
        };
        window.addEventListener('click', guard, { once: true });
      }
      // A click's default action may submit a form; watch for it to know whether a page load follows.
      const onSubmit = (e: Event) => { submitEvent = e; };
      window.addEventListener('submit', onSubmit, true);
      const clickOk = fire(target, new MouseEvent('click', mouseInit(x, y, mods, 0, 0, i)));
      window.removeEventListener('submit', onSubmit, true);
      if (guard)
        window.removeEventListener('click', guard);
      if (!clickOk && !openUrl)
        prevented = true;
      if (i === 2)
        fire(target, new MouseEvent('dblclick', mouseInit(x, y, mods, 0, 0, 2)));
    } else if (button === 1) {
      fire(target, new MouseEvent('auxclick', mouseInit(x, y, mods, 1, 0, i)));
      openUrl = openInNewTabIntent(target, mods, 1);
    } else if (button === 2) {
      fire(target, new MouseEvent('auxclick', mouseInit(x, y, mods, 2, 0, i)));
      const ok = fire(target, new MouseEvent('contextmenu', mouseInit(x, y, mods, 2, 0, i)));
      if (ok)
        notes.push('A synthetic right-click cannot open Firefox\'s native context menu; only the page\'s own custom menus respond.');
    }
  }
  } finally {
    gesture(false);
  }

  if (button === 0 && target instanceof HTMLInputElement && target.type === 'range' && !target.disabled) {
    // A real click on a slider track jumps the thumb to that position.
    const r = target.getBoundingClientRect();
    const min = parseFloat(target.min || '0'), max = parseFloat(target.max || '100');
    const step = parseFloat(target.step) || 1;
    const frac = Math.max(0, Math.min(1, (x - r.left) / Math.max(1, r.width)));
    const v = Math.round((min + frac * (max - min)) / step) * step;
    if (String(v) !== target.value)
      setValueDirect(target, String(v));
  }

  if (target instanceof HTMLSelectElement || target.closest('select')) {
    const sel = (target instanceof HTMLSelectElement ? target : target.closest('select')) as HTMLSelectElement;
    const opts = Array.from(sel.options).slice(0, 30).map(o => `"${o.text.trim()}"${o.selected ? ' (selected)' : ''}`).join(', ');
    notes.push(`This is a native <select>; its dropdown cannot be opened by synthetic clicks. Use form_input with this element's ref to choose one of: ${opts}`);
  }
  if (target instanceof HTMLInputElement && target.type === 'file')
    notes.push('This is a file input; use file_upload to attach files.');

  // Only actions on links, buttons and form controls normally start a navigation; the
  // background uses this to skip waiting for one after other clicks.
  // 'likely': this click's default action loads a page (a real link, or a form submission the page
  // didn't cancel). true: a page script might still navigate. false: nothing will.
  const link = target.closest('a[href], area[href]') as HTMLAnchorElement | null;
  const isSamePageLink = !!link && (() => {
    try {
      const u = new URL(link.href, location.href);
      return u.origin === location.origin && u.pathname === location.pathname && u.search === location.search && !!u.hash;
    } catch {
      return false;
    }
  })();
  const submitted = !!submitEvent && !(submitEvent as Event).defaultPrevented;
  const mayNavigate: boolean | 'likely' = (!prevented && link && !isSamePageLink && !openUrl) || submitted ? 'likely'
    : !!target.closest('a[href], area[href], button, input, [role="button"], [role="link"], [role="menuitem"], [role="option"], [role="tab"], form, [onclick]');
  return { target: describe(target), prevented, openUrl, notes, mayNavigate };
}

export function click(args: { x?: number; y?: number; ref?: string; button?: 'left' | 'right' | 'middle'; clickCount?: number; modifiers?: string }): any {
  const mods = parseModifiers(args.modifiers);
  let target: Element | null;
  let x: number, y: number;
  const notes: string[] = [];
  if (args.ref) {
    const p = pointForRef(args.ref);
    ({ x, y } = p);
    target = p.el;
    if (p.covered)
      notes.push(`Note: ${args.ref} appears covered by ${describe(p.covered)} at that spot; the click was dispatched to ${args.ref} directly.`);
  } else {
    x = args.x!;
    y = args.y!;
    target = elementAt(x, y);
    const fwd = iframeForward(target, x, y);
    if (fwd)
      return fwd;
  }
  if (!target)
    throw new Error(`There is no element at (${Math.round(x)}, ${Math.round(y)}).`);
  const res = clickTarget(target, x, y, { button: args.button, clickCount: args.clickCount, mods });
  res.notes.unshift(...notes);
  return res;
}

export function hover(args: { x?: number; y?: number; ref?: string }): any {
  let target: Element | null;
  let x: number, y: number;
  if (args.ref) {
    const p = pointForRef(args.ref);
    ({ x, y } = p);
    target = p.el;
  } else {
    x = args.x!;
    y = args.y!;
    target = elementAt(x, y);
    const fwd = iframeForward(target, x, y);
    if (fwd)
      return fwd;
  }
  if (!target)
    throw new Error(`There is no element at (${Math.round(x)}, ${Math.round(y)}).`);
  hoverTo(target, x, y, NO_MODS);
  return { target: describe(target), notes: ['Hover events were dispatched (mouseover/mouseenter/pointermove). CSS :hover styles cannot be triggered by synthetic events.'] };
}

// ---------- text entry ----------

function nativeValueSetter(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement) {
  const proto = el instanceof HTMLTextAreaElement ? HTMLTextAreaElement.prototype : el instanceof HTMLSelectElement ? HTMLSelectElement.prototype : HTMLInputElement.prototype;
  return Object.getOwnPropertyDescriptor(proto, 'value')!.set!;
}

export function setValueDirect(el: HTMLInputElement | HTMLTextAreaElement | HTMLSelectElement, value: string) {
  nativeValueSetter(el).call(el, value);
  el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertReplacementText', data: value } as any));
  el.dispatchEvent(new Event('change', { bubbles: true }));
}

/** Insert text at the caret of the focused editable, like typing/pasting does. */
function insertText(el: Element, text: string): boolean {
  if (isTextField(el)) {
    const before = el.value;
    let ok = false;
    try {
      ok = document.execCommand('insertText', false, text);
    } catch { ok = false; }
    if (ok && el.value !== before)
      return true;
    // Fallback: splice value at the selection and notify frameworks.
    let start = before.length, end = before.length;
    try {
      start = el.selectionStart ?? before.length;
      end = el.selectionEnd ?? before.length;
    } catch { /* number inputs have no selection */ }
    const next = before.slice(0, start) + text + before.slice(end);
    el.dispatchEvent(new InputEvent('beforeinput', { bubbles: true, cancelable: true, composed: true, inputType: 'insertText', data: text } as any));
    nativeValueSetter(el).call(el, next);
    try {
      el.setSelectionRange(start + text.length, start + text.length);
    } catch { /* ignore */ }
    el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text } as any));
    return true;
  }
  if (isContentEditable(el)) {
    const sel = document.getSelection();
    if (sel && (sel.rangeCount === 0 || !el.contains(sel.anchorNode))) {
      const range = document.createRange();
      range.selectNodeContents(el);
      range.collapse(false);
      sel.removeAllRanges();
      sel.addRange(range);
    }
    const before = el.innerText;
    let ok = false;
    try {
      ok = document.execCommand('insertText', false, text);
    } catch { ok = false; }
    if (ok && el.innerText !== before)
      return true;
    // Fallback: a synthetic paste, which ProseMirror/Lexical/Slate/Draft all handle.
    const dt = new DataTransfer();
    dt.setData('text/plain', text);
    const pasteOk = el.dispatchEvent(new ClipboardEvent('paste', { bubbles: true, cancelable: true, composed: true, clipboardData: dt } as any));
    if (!pasteOk || el.innerText !== before)
      return true;
    const r = sel && sel.rangeCount ? sel.getRangeAt(0) : null;
    if (r) {
      r.deleteContents();
      r.insertNode(document.createTextNode(text));
      r.collapse(false);
      el.dispatchEvent(new InputEvent('input', { bubbles: true, composed: true, inputType: 'insertText', data: text } as any));
      return true;
    }
  }
  return false;
}

// Key metadata: key -> [code, keyCode]
const KEYS: Record<string, [string, number]> = {
  Enter: ['Enter', 13], Tab: ['Tab', 9], Escape: ['Escape', 27], Backspace: ['Backspace', 8], Delete: ['Delete', 46],
  ArrowUp: ['ArrowUp', 38], ArrowDown: ['ArrowDown', 40], ArrowLeft: ['ArrowLeft', 37], ArrowRight: ['ArrowRight', 39],
  Home: ['Home', 36], End: ['End', 35], PageUp: ['PageUp', 33], PageDown: ['PageDown', 34], ' ': ['Space', 32],
  Insert: ['Insert', 45], Shift: ['ShiftLeft', 16], Control: ['ControlLeft', 17], Alt: ['AltLeft', 18], Meta: ['MetaLeft', 91],
  CapsLock: ['CapsLock', 20], ContextMenu: ['ContextMenu', 93],
};
for (let i = 1; i <= 12; i++) KEYS['F' + i] = ['F' + i, 111 + i];

const KEY_ALIASES: Record<string, string> = {
  enter: 'Enter', return: 'Enter', tab: 'Tab', escape: 'Escape', esc: 'Escape', backspace: 'Backspace', delete: 'Delete', del: 'Delete',
  up: 'ArrowUp', down: 'ArrowDown', left: 'ArrowLeft', right: 'ArrowRight', arrowup: 'ArrowUp', arrowdown: 'ArrowDown', arrowleft: 'ArrowLeft', arrowright: 'ArrowRight',
  home: 'Home', end: 'End', pageup: 'PageUp', pagedown: 'PageDown', page_up: 'PageUp', page_down: 'PageDown', space: ' ', spacebar: ' ', insert: 'Insert',
  shift: 'Shift', ctrl: 'Control', control: 'Control', alt: 'Alt', option: 'Alt', cmd: 'Meta', meta: 'Meta', command: 'Meta', super: 'Meta', win: 'Meta',
  capslock: 'CapsLock', menu: 'ContextMenu',
};

export function normalizeKey(k: string): string {
  if (k.length === 1)
    return k;
  const a = KEY_ALIASES[k.toLowerCase()];
  if (a)
    return a;
  if (/^f\d{1,2}$/i.test(k))
    return k.toUpperCase();
  return k;
}

function keyInfo(key: string): { code: string; keyCode: number } {
  if (KEYS[key])
    return { code: KEYS[key][0], keyCode: KEYS[key][1] };
  if (key.length === 1) {
    const up = key.toUpperCase();
    if (/[A-Z]/.test(up))
      return { code: 'Key' + up, keyCode: up.charCodeAt(0) };
    if (/[0-9]/.test(key))
      return { code: 'Digit' + key, keyCode: key.charCodeAt(0) };
    return { code: '', keyCode: 0 };
  }
  return { code: key, keyCode: 0 };
}

function keyEvent(type: string, key: string, mods: Mods, repeat = false) {
  const { code, keyCode } = keyInfo(key);
  const printable = key.length === 1;
  const charCode = type === 'keypress' && printable ? key.charCodeAt(0) : (type === 'keypress' && key === 'Enter' ? 13 : 0);
  const init: any = {
    key, code, bubbles: true, cancelable: true, composed: true, view: window, repeat,
    ctrlKey: mods.ctrl, shiftKey: mods.shift, altKey: mods.alt, metaKey: mods.meta,
    keyCode: type === 'keypress' ? charCode : keyCode, charCode, which: type === 'keypress' ? charCode : keyCode,
  };
  return new KeyboardEvent(type, init);
}

function tabbables(): HTMLElement[] {
  const all = Array.from(document.querySelectorAll<HTMLElement>(FOCUSABLE)).filter(el => {
    const ti = el.getAttribute('tabindex');
    if (ti !== null && parseInt(ti) < 0)
      return false;
    if ((el as any).disabled || el.getAttribute('aria-hidden') === 'true')
      return false;
    if (el instanceof HTMLInputElement && el.type === 'hidden')
      return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0)
      return false;
    const cs = getComputedStyle(el);
    return cs.visibility !== 'hidden' && cs.display !== 'none';
  });
  const positive = all.filter(e => (e.tabIndex || 0) > 0).sort((a, b) => a.tabIndex - b.tabIndex);
  const zero = all.filter(e => !((e.tabIndex || 0) > 0));
  return [...positive, ...zero];
}

function scrollTargetFor(el: Element | null): Element {
  let e: Element | null = el;
  while (e && e !== document.body && e !== document.documentElement) {
    const cs = getComputedStyle(e);
    if (/(auto|scroll|overlay)/.test(cs.overflowY + cs.overflowX) && (e.scrollHeight > e.clientHeight + 1 || e.scrollWidth > e.clientWidth + 1))
      return e;
    e = e.parentElement || ((e.getRootNode() as ShadowRoot).host ?? null);
  }
  return document.scrollingElement || document.documentElement;
}

function implicitSubmit(field: HTMLElement): string {
  const form = (field as HTMLInputElement).form;
  if (!form)
    return 'Enter pressed (no form to submit).';
  const submitter = form.querySelector<HTMLElement>('button:not([type]), button[type=submit], input[type=submit], input[type=image]');
  if (submitter && !(submitter as any).disabled) {
    const r = submitter.getBoundingClientRect();
    clickTarget(submitter, r.left + r.width / 2, r.top + r.height / 2);
    return `Enter pressed; form submitted via ${describe(submitter)}.`;
  }
  if (submitter)
    return 'Enter pressed; the form\'s submit button is disabled, so nothing was submitted.';
  try {
    form.requestSubmit();
    return 'Enter pressed; form submitted.';
  } catch (e: any) {
    return 'Enter pressed; form submit failed: ' + e.message;
  }
}

/** Emulate the browser default action for a key the page did not preventDefault. */
function defaultAction(key: string, mods: Mods, target: Element | null): string | null {
  const primary = isMac ? mods.meta : mods.ctrl;
  const t = target as HTMLElement | null;
  if (primary && key.toLowerCase() === 'a' && !mods.alt) {
    if (isTextField(t))
      t.select();
    else
      document.execCommand('selectAll');
    return null;
  }
  if (primary && ['c', 'x', 'v', 'z', 'y'].includes(key.toLowerCase())) {
    const cmd = { c: 'copy', x: 'cut', v: 'paste', z: mods.shift ? 'redo' : 'undo', y: 'redo' }[key.toLowerCase()]!;
    let ok = false;
    try {
      ok = document.execCommand(cmd);
    } catch { ok = false; }
    return ok ? null : `${cmd} could not be performed by synthetic input (browser clipboard/undo access is restricted).`;
  }
  if (mods.ctrl || mods.meta || mods.alt) {
    return null;
  }
  if (key.length === 1) {
    if (t && isEditable(t))
      insertText(t, key);
    else if (key === ' ')
      window.scrollBy(0, innerHeight * 0.8 * (mods.shift ? -1 : 1));
    return null;
  }
  switch (key) {
    case 'Enter':
      if (t instanceof HTMLTextAreaElement) {
        insertText(t, '\n');
        return null;
      }
      if (t && isContentEditable(t)) {
        if (!document.execCommand(mods.shift ? 'insertLineBreak' : 'insertParagraph'))
          insertText(t, '\n');
        return null;
      }
      if (t instanceof HTMLInputElement && isTextField(t))
        return implicitSubmit(t);
      if (t instanceof HTMLInputElement && ['checkbox', 'radio', 'date', 'time', 'color', 'range'].includes(t.type))
        return (t.form ? implicitSubmit(t) : null);
      if (t && (t.matches('a[href], button, input[type=submit], input[type=button], input[type=reset], summary, [role=button], [role=link], [role=menuitem], [role=tab], [role=option]'))) {
        const r = t.getBoundingClientRect();
        clickTarget(t, r.left + r.width / 2, r.top + r.height / 2);
      }
      return null;
    case 'Tab': {
      const list = tabbables();
      const cur = deepActiveElement();
      let idx = cur ? list.indexOf(cur as HTMLElement) : -1;
      idx = mods.shift ? (idx <= 0 ? list.length - 1 : idx - 1) : (idx + 1) % Math.max(1, list.length);
      const next = list[idx];
      if (next) {
        next.focus();
        if (isTextField(next) && !(next instanceof HTMLTextAreaElement))
          try { next.select(); } catch { /* ignore */ }
        return `Focus moved to ${describe(next)}.`;
      }
      return null;
    }
    case 'Backspace':
    case 'Delete':
      if (t && isEditable(t)) {
        const ok = document.execCommand(key === 'Backspace' ? 'delete' : 'forwardDelete');
        if (!ok && isTextField(t)) {
          const v = t.value;
          const s = t.selectionStart ?? v.length, e = t.selectionEnd ?? v.length;
          let next: string, caret: number;
          if (s !== e) {
            next = v.slice(0, s) + v.slice(e); caret = s;
          } else if (key === 'Backspace') {
            next = v.slice(0, Math.max(0, s - 1)) + v.slice(s); caret = Math.max(0, s - 1);
          } else {
            next = v.slice(0, s) + v.slice(s + 1); caret = s;
          }
          nativeValueSetter(t).call(t, next);
          try { t.setSelectionRange(caret, caret); } catch { /* ignore */ }
          t.dispatchEvent(new InputEvent('input', { bubbles: true, inputType: key === 'Backspace' ? 'deleteContentBackward' : 'deleteContentForward' } as any));
        }
      }
      return null;
    case 'ArrowLeft':
    case 'ArrowRight':
    case 'ArrowUp':
    case 'ArrowDown':
    case 'Home':
    case 'End':
      if (isTextField(t)) {
        try {
          const len = t.value.length;
          let pos = key === 'Home' || key === 'ArrowUp' && !(t instanceof HTMLTextAreaElement) ? 0
            : key === 'End' || key === 'ArrowDown' && !(t instanceof HTMLTextAreaElement) ? len
              : key === 'ArrowLeft' ? Math.max(0, (t.selectionStart ?? 0) - 1)
                : key === 'ArrowRight' ? Math.min(len, (t.selectionEnd ?? len) + 1)
                  : (t.selectionStart ?? 0);
          if (mods.shift)
            t.setSelectionRange(Math.min(pos, t.selectionStart ?? pos), Math.max(pos, t.selectionEnd ?? pos));
          else
            t.setSelectionRange(pos, pos);
        } catch { /* ignore */ }
        return null;
      }
      if (t && isContentEditable(t)) {
        const sel = document.getSelection() as any;
        if (sel?.modify) {
          const dir = key === 'ArrowLeft' || key === 'ArrowUp' || key === 'Home' ? 'backward' : 'forward';
          const unit = key === 'ArrowUp' || key === 'ArrowDown' ? 'line' : key === 'Home' || key === 'End' ? 'lineboundary' : 'character';
          sel.modify(mods.shift ? 'extend' : 'move', dir, unit);
        }
        return null;
      }
      if (t instanceof HTMLSelectElement && (key === 'ArrowUp' || key === 'ArrowDown')) {
        const i = Math.max(0, Math.min(t.options.length - 1, t.selectedIndex + (key === 'ArrowDown' ? 1 : -1)));
        if (i !== t.selectedIndex) {
          t.selectedIndex = i;
          t.dispatchEvent(new Event('input', { bubbles: true }));
          t.dispatchEvent(new Event('change', { bubbles: true }));
        }
        return null;
      }
      if (t instanceof HTMLInputElement && t.type === 'range') {
        const step = parseFloat(t.step) || 1;
        const dir = key === 'ArrowUp' || key === 'ArrowRight' ? 1 : -1;
        setValueDirect(t, String(parseFloat(t.value) + dir * step));
        return null;
      }
      {
        const s = scrollTargetFor(t);
        const dy = key === 'ArrowDown' ? 40 : key === 'ArrowUp' ? -40 : 0;
        const dx = key === 'ArrowRight' ? 40 : key === 'ArrowLeft' ? -40 : 0;
        if (key === 'Home')
          s.scrollTo({ top: 0 });
        else if (key === 'End')
          s.scrollTo({ top: s.scrollHeight });
        else
          s.scrollBy(dx, dy);
      }
      return null;
    case 'PageUp':
    case 'PageDown': {
      const s = scrollTargetFor(t);
      s.scrollBy(0, (key === 'PageDown' ? 1 : -1) * Math.max(40, s.clientHeight * 0.85));
      return null;
    }
  }
  return null;
}

function pressOne(combo: string): string | null {
  // combo like "ctrl+shift+a" or "Enter"
  const parts = combo.split('+').filter(p => p !== '');
  if (combo.endsWith('++'))
    parts.push('+');
  const mods = { ...NO_MODS };
  const modKeys: string[] = [];
  let key = '';
  for (const raw of parts) {
    const k = normalizeKey(raw);
    if (k === 'Control') { mods.ctrl = true; modKeys.push(k); } else if (k === 'Shift' && parts.length > 1) { mods.shift = true; modKeys.push(k); } else if (k === 'Alt') { mods.alt = true; modKeys.push(k); } else if (k === 'Meta') { mods.meta = true; modKeys.push(k); } else key = k;
  }
  if (!key && modKeys.length)
    key = modKeys.pop()!;
  if (key.length === 1 && mods.shift)
    key = key.toUpperCase();
  const target = deepActiveElement() || document.body;
  const held = { ...NO_MODS };
  for (const m of modKeys) {
    if (m === 'Control') held.ctrl = true;
    if (m === 'Shift') held.shift = true;
    if (m === 'Alt') held.alt = true;
    if (m === 'Meta') held.meta = true;
    fire(target, keyEvent('keydown', m, held));
  }
  const downOk = fire(target, keyEvent('keydown', key, mods));
  let note: string | null = null;
  if (downOk) {
    const producesChar = (key.length === 1 || key === 'Enter') && !mods.ctrl && !mods.meta;
    let pressOk = true;
    if (producesChar)
      pressOk = fire(target, keyEvent('keypress', key, mods));
    if (pressOk)
      note = defaultAction(key, mods, target);
  }
  fire(deepActiveElement() || document.body, keyEvent('keyup', key, mods));
  for (const m of modKeys.reverse()) {
    if (m === 'Control') held.ctrl = false;
    if (m === 'Shift') held.shift = false;
    if (m === 'Alt') held.alt = false;
    if (m === 'Meta') held.meta = false;
    fire(target, keyEvent('keyup', m, held));
  }
  return note;
}

function focusedFrameForward(): Forward | null {
  const a = document.activeElement;
  if (a && (a.tagName === 'IFRAME' || a.tagName === 'FRAME')) {
    const frameId = frameIdOf(a);
    if (frameId >= 0)
      return { forward: { frameId } };
  }
  return null;
}

// Set by the user's Stop/Pause (via the background); checked between keystrokes and gesture steps
// so long typing or drags stop promptly instead of running to the end.
let cancelled = false;
export function setCancelled(v: boolean) {
  cancelled = v;
}

/** Let the page's microtasks/timers run between keystrokes. Editors like Lexical and
 * ProseMirror update their model asynchronously; typing a whole string inside one task
 * would feed them stale selections. Throws once the user has pressed Stop. */
const tick = () => new Promise<void>((resolve, reject) => setTimeout(() => cancelled ? reject(new Error('Stopped: the user paused Kitsune.')) : resolve(), 0));

export async function pressKeys(args: { text: string; repeat?: number }): Promise<any> {
  const fwd = focusedFrameForward();
  if (fwd)
    return fwd;
  const combos = args.text.trim().split(/\s+/).filter(Boolean);
  const repeat = Math.max(1, Math.min(100, args.repeat || 1));
  const notes: string[] = [];
  for (let r = 0; r < repeat; r++) {
    for (const c of combos) {
      const n = pressOne(c);
      if (n && !notes.includes(n))
        notes.push(n);
      await tick();
    }
  }
  const a = deepActiveElement();
  // Only these keys load pages by default (submit, activate a link/button, history, reload).
  const mayNavigate = combos.some(c => /^(enter|return|space|\s|f5)$|^(alt|meta|cmd)\+(left|right|arrowleft|arrowright|\[|\])$|^(ctrl|cmd|meta)\+r$/i.test(c)) ? undefined : false;
  return { focused: describe(a), value: valueOf(a), notes, mayNavigate };
}

function valueOf(el: Element | null): string | undefined {
  if (!el)
    return undefined;
  if (isTextField(el) || el instanceof HTMLSelectElement)
    return (el as any).type === 'password' ? '(password field)' : String((el as any).value).slice(0, 500);
  if (isContentEditable(el))
    return el.innerText.slice(0, 500);
  return undefined;
}

export async function typeText(args: { text: string }): Promise<any> {
  const fwd = focusedFrameForward();
  if (fwd)
    return fwd;
  const target = deepActiveElement();
  const text = args.text;
  const notes: string[] = [];
  if (target && isEditable(target)) {
    if ((target as any).readOnly || (target as any).disabled)
      throw new Error(`The focused element ${describe(target)} is read-only or disabled.`);
    const perChar = text.length <= 300;
    const chunks = perChar ? Array.from(text) : [text];
    for (const ch of chunks) {
      if (ch === '\n' || ch === '\r') {
        if (ch === '\r')
          continue;
        const n = pressOne('Enter');
        if (n)
          notes.push(n);
        await tick();
        continue;
      }
      // The editor may have re-rendered; keep typing into whatever now has focus.
      const t = (deepActiveElement() && isEditable(deepActiveElement())) ? deepActiveElement()! : target;
      const k = ch.length === 1 ? ch : ch[ch.length - 1];
      const down = fire(t, keyEvent('keydown', k, NO_MODS));
      if (down && fire(t, keyEvent('keypress', k, NO_MODS)))
        insertText(t, ch);
      fire(t, keyEvent('keyup', k, NO_MODS));
      if (perChar)
        await tick();
    }
  } else {
    // Nothing editable focused: send key events only (games, shortcut-driven apps).
    for (const ch of Array.from(text)) {
      const t = deepActiveElement() || document.body;
      const k = ch === '\n' ? 'Enter' : ch;
      if (fire(t, keyEvent('keydown', k, NO_MODS)))
        fire(t, keyEvent('keypress', k, NO_MODS));
      fire(t, keyEvent('keyup', k, NO_MODS));
    }
    notes.push(`No text field was focused (focus is on ${describe(target)}), so only key events were sent. Click the field first.`);
  }
  const a = deepActiveElement();
  // Typing into a field doesn't load pages unless it includes Enter.
  return { focused: describe(a), value: valueOf(a), notes, mayNavigate: target && isEditable(target) && !/[\r\n]/.test(text) ? false : undefined };
}

// ---------- scrolling & dragging ----------

export function scroll(args: { x?: number; y?: number; ref?: string; direction: 'up' | 'down' | 'left' | 'right'; amount?: number }): any {
  let x = args.x ?? innerWidth / 2, y = args.y ?? innerHeight / 2;
  let target: Element | null;
  if (args.ref) {
    const p = pointForRef(args.ref);
    ({ x, y } = p);
    target = p.el;
  } else {
    target = elementAt(x, y);
    const fwd = iframeForward(target, x, y);
    if (fwd)
      return fwd;
  }
  const ticks = Math.max(1, Math.min(30, args.amount ?? 3));
  const px = ticks * 100;
  const dx = args.direction === 'left' ? -px : args.direction === 'right' ? px : 0;
  const dy = args.direction === 'up' ? -px : args.direction === 'down' ? px : 0;
  const t = target || document.body;
  const wheelOk = t.dispatchEvent(new WheelEvent('wheel', { ...mouseInit(x, y, NO_MODS, 0, 0, 0), deltaX: dx, deltaY: dy, deltaMode: 0 }));
  const s = scrollTargetFor(t);
  const before = [s.scrollLeft, s.scrollTop];
  if (wheelOk)
    s.scrollBy({ left: dx, top: dy, behavior: 'instant' as ScrollBehavior });
  const moved = s.scrollLeft !== before[0] || s.scrollTop !== before[1];
  const notes: string[] = [];
  if (!wheelOk)
    notes.push('The page handled the wheel event itself (it called preventDefault), so no native scroll was applied.');
  else if (!moved)
    notes.push('Nothing scrolled: already at the edge in that direction.');
  const isDoc = s === document.scrollingElement || s === document.documentElement;
  return {
    target: isDoc ? 'page' : describe(s),
    scrollX: Math.round(isDoc ? window.scrollX : s.scrollLeft),
    scrollY: Math.round(isDoc ? window.scrollY : s.scrollTop),
    scrollHeight: s.scrollHeight,
    viewportHeight: isDoc ? innerHeight : s.clientHeight,
    notes,
  };
}

export function scrollTo(args: { ref: string }): any {
  const el = resolveRef(args.ref);
  el.scrollIntoView({ block: 'center', inline: 'center', behavior: 'instant' as ScrollBehavior });
  const r = el.getBoundingClientRect();
  return { target: describe(el), x: Math.round(r.left + r.width / 2), y: Math.round(r.top + r.height / 2) };
}

export async function drag(args: { startX: number; startY: number; x: number; y: number }): Promise<any> {
  const { startX, startY, x, y } = args;
  const src = elementAt(startX, startY);
  // A drag inside an iframe is performed by that frame's content script.
  const fwd = iframeForward(src, startX, startY);
  if (fwd) {
    const dx = startX - fwd.forward.x!, dy = startY - fwd.forward.y!;
    return { forward: { frameId: fwd.forward.frameId, args: { startX: startX - dx, startY: startY - dy, x: x - dx, y: y - dy } } };
  }
  if (!src)
    throw new Error(`There is no element at the drag start (${startX}, ${startY}).`);
  const notes: string[] = [];

  // Native range sliders: set the value from the end position.
  if (src instanceof HTMLInputElement && src.type === 'range') {
    const r = src.getBoundingClientRect();
    const min = parseFloat(src.min || '0'), max = parseFloat(src.max || '100');
    const frac = Math.max(0, Math.min(1, (x - r.left) / r.width));
    setValueDirect(src, String(min + frac * (max - min)));
    return { target: describe(src), value: src.value, notes: ['Range input set directly from the drag end position.'] };
  }

  hoverTo(src, startX, startY, NO_MODS);
  let end: Element = src;
  gesture(true);
  try {
  fire(src, new PointerEvent('pointerdown', mouseInit(startX, startY, NO_MODS, 0, 1, 1) as any));
  const mdOk = fire(src, new MouseEvent('mousedown', mouseInit(startX, startY, NO_MODS, 0, 1, 1)));
  const draggable = src.closest('[draggable="true"], a[href], img') as HTMLElement | null;
  const html5 = !!draggable && (draggable.getAttribute('draggable') === 'true' || draggable.draggable);
  let dt: DataTransfer | null = null;
  if (html5 && mdOk) {
    dt = new DataTransfer();
    const ok = fire(draggable!, new DragEvent('dragstart', { ...mouseInit(startX, startY, NO_MODS, 0, 1, 0), dataTransfer: dt }));
    if (!ok)
      dt = null;
  }
  const steps = 12;
  let over: Element | null = src;
  for (let i = 1; i <= steps; i++) {
    const cx = startX + (x - startX) * i / steps, cy = startY + (y - startY) * i / steps;
    const el = elementAt(cx, cy) || document.body;
    fire(pointerTarget(el), new PointerEvent('pointermove', mouseInit(cx, cy, NO_MODS, 0, 1, 0) as any));
    fire(pointerTarget(el), new MouseEvent('mousemove', mouseInit(cx, cy, NO_MODS, 0, 1, 0)));
    if (dt) {
      if (el !== over) {
        fire(el, new DragEvent('dragenter', { ...mouseInit(cx, cy, NO_MODS, 0, 1, 0), dataTransfer: dt }));
        if (over)
          fire(over, new DragEvent('dragleave', { ...mouseInit(cx, cy, NO_MODS, 0, 1, 0), dataTransfer: dt }));
        over = el;
      }
      fire(el, new DragEvent('dragover', { ...mouseInit(cx, cy, NO_MODS, 0, 1, 0), dataTransfer: dt }));
      fire(draggable!, new DragEvent('drag', { ...mouseInit(cx, cy, NO_MODS, 0, 1, 0), dataTransfer: dt }));
    }
    await new Promise(r => setTimeout(r, 16));
  }
  end = elementAt(x, y) || document.body;
  if (dt) {
    fire(end, new DragEvent('drop', { ...mouseInit(x, y, NO_MODS, 0, 0, 0), dataTransfer: dt }));
    fire(draggable!, new DragEvent('dragend', { ...mouseInit(x, y, NO_MODS, 0, 0, 0), dataTransfer: dt }));
    notes.push('Performed an HTML5 drag-and-drop sequence (dragstart/dragover/drop).');
  }
  fire(pointerTarget(end), new PointerEvent('pointerup', mouseInit(x, y, NO_MODS, 0, 0, 1) as any));
  fire(pointerTarget(end), new MouseEvent('mouseup', mouseInit(x, y, NO_MODS, 0, 0, 1)));
  } finally {
    gesture(false);
  }
  pointerDownAt = null;
  return { from: describe(src), to: describe(end), notes };
}

// ---------- form_input ----------

function visibleOptions(): HTMLElement[] {
  return Array.from(document.querySelectorAll<HTMLElement>('[role="option"], [role="menuitem"], [role="menuitemradio"]')).filter(o => {
    const r = o.getBoundingClientRect();
    return r.width > 0 && r.height > 0 && getComputedStyle(o).visibility !== 'hidden' && o.getAttribute('aria-disabled') !== 'true';
  });
}

function optionText(o: HTMLElement) {
  return (o.getAttribute('aria-label') || o.innerText || o.textContent || '').replace(/\s+/g, ' ').trim();
}

async function pickOption(value: string, timeoutMs = 2500): Promise<HTMLElement | null> {
  const want = value.trim().toLowerCase();
  const end = Date.now() + timeoutMs;
  while (Date.now() < end) {
    const opts = visibleOptions();
    const exact = opts.find(o => optionText(o).toLowerCase() === want);
    const prefix = opts.find(o => optionText(o).toLowerCase().startsWith(want));
    const contains = opts.find(o => optionText(o).toLowerCase().includes(want));
    const hit = exact || prefix || contains;
    if (hit)
      return hit;
    await new Promise(r => setTimeout(r, 100));
  }
  return null;
}

function clickCenter(el: Element) {
  el.scrollIntoView({ block: 'nearest', behavior: 'instant' as ScrollBehavior });
  const r = el.getBoundingClientRect();
  clickTarget(el, r.left + r.width / 2, r.top + r.height / 2);
}

/** Custom comboboxes (MUI, react-select, Radix, Headless UI...): open, type, and click the matching option. */
async function setCombobox(el: HTMLElement, value: string): Promise<any> {
  const notes: string[] = [];
  clickCenter(el);
  await tick();
  if (isTextField(el)) {
    el.focus();
    try { el.select(); } catch { /* ignore */ }
    document.execCommand('delete');
    await typeText({ text: value });
  }
  const opt = await pickOption(value);
  if (opt) {
    const label = optionText(opt);
    clickCenter(opt);
    await tick();
    notes.push(`Chose "${label}" from the list.`);
  } else {
    notes.push(`No list option matching "${value}" appeared${isTextField(el) ? '; the text was typed into the box' : ''}. Take a screenshot or read_page to see what the widget offers.`);
  }
  return { target: describe(el), value: isTextField(el) ? el.value : optionText(el) || undefined, notes };
}

export async function formInput(args: { ref: string; value: string | boolean | number }): Promise<any> {
  const el = resolveRef(args.ref) as HTMLElement;
  const v = args.value;
  el.scrollIntoView({ block: 'center', behavior: 'instant' as ScrollBehavior });

  const roleAttr = el.getAttribute('role');
  const isCustomCombo = roleAttr === 'combobox' && !(el instanceof HTMLSelectElement)
    || (el instanceof HTMLInputElement && (el.getAttribute('aria-autocomplete') === 'list' || el.getAttribute('aria-haspopup') === 'listbox'))
    || (el instanceof HTMLButtonElement && el.getAttribute('aria-haspopup') === 'listbox');
  if (isCustomCombo && typeof v !== 'boolean')
    return setCombobox(el, String(v));

  if (el instanceof HTMLSelectElement) {
    const wanted = Array.isArray(v) ? v.map(String) : [String(v)];
    const opts = Array.from(el.options);
    const pick = (w: string) => opts.find(o => o.value === w) || opts.find(o => o.text.trim() === w) || opts.find(o => o.text.trim().toLowerCase() === w.toLowerCase()) || opts.find(o => o.text.toLowerCase().includes(w.toLowerCase()));
    const chosen = wanted.map(pick);
    if (chosen.some(c => !c))
      throw new Error(`No option matching "${wanted.join(', ')}". Options: ${opts.slice(0, 40).map(o => `"${o.text.trim()}" (value=${o.value})`).join(', ')}`);
    el.focus();
    if (el.multiple)
      for (const o of opts) o.selected = chosen.includes(o);
    else
      nativeValueSetter(el).call(el, chosen[0]!.value);
    el.dispatchEvent(new Event('input', { bubbles: true }));
    el.dispatchEvent(new Event('change', { bubbles: true }));
    return { target: describe(el), value: Array.from(el.selectedOptions).map(o => o.text.trim()).join(', ') };
  }

  const role = el.getAttribute('role');
  const isToggle = (el instanceof HTMLInputElement && (el.type === 'checkbox' || el.type === 'radio')) || role === 'checkbox' || role === 'switch' || role === 'radio' || role === 'menuitemcheckbox';
  if (isToggle) {
    const want = typeof v === 'boolean' ? v : !['false', '0', 'off', 'no', 'unchecked'].includes(String(v).toLowerCase());
    const current = () => el instanceof HTMLInputElement ? el.checked : el.getAttribute('aria-checked') === 'true';
    if (current() !== want) {
      const r = el.getBoundingClientRect();
      const target = (el instanceof HTMLInputElement && (r.width === 0 || getComputedStyle(el).opacity === '0') && el.labels?.[0]) || el;
      const tr = target.getBoundingClientRect();
      clickTarget(target, tr.left + tr.width / 2, tr.top + tr.height / 2);
    }
    if (current() !== want && el instanceof HTMLInputElement) {
      // Last resort for inputs whose click handlers swallow the toggle.
      el.checked = want;
      el.dispatchEvent(new Event('input', { bubbles: true }));
      el.dispatchEvent(new Event('change', { bubbles: true }));
    }
    return { target: describe(el), checked: current() };
  }

  if (el instanceof HTMLInputElement && el.type === 'file')
    throw new Error('This is a file input; use the file_upload tool instead.');

  if (el instanceof HTMLInputElement && !isTextField(el)) {
    // date, time, color, range, datetime-local, month, week...
    el.focus();
    setValueDirect(el, String(v));
    return { target: describe(el), value: el.value };
  }

  if (isTextField(el) || isContentEditable(el)) {
    if ((el as any).readOnly || (el as any).disabled)
      throw new Error(`${describe(el)} is read-only or disabled.`);
    el.focus();
    const text = String(v);
    if (isTextField(el)) {
      try { el.select(); } catch { /* ignore */ }
      let ok = false;
      if (text === '')
        ok = document.execCommand('delete');
      else
        try { ok = document.execCommand('insertText', false, text); } catch { ok = false; }
      if (!ok || el.value !== text)
        setValueDirect(el, text);
      else
        el.dispatchEvent(new Event('change', { bubbles: true }));
    } else {
      const sel = document.getSelection()!;
      const range = document.createRange();
      range.selectNodeContents(el);
      sel.removeAllRanges();
      sel.addRange(range);
      if (text === '')
        document.execCommand('delete');
      else
        insertText(el, text);
    }
    return { target: describe(el), value: valueOf(el) };
  }

  throw new Error(`${describe(el)} is not a form field. For custom widgets (dropdowns, listboxes), click them with the computer tool instead.`);
}

// ---------- file upload ----------

export function uploadFiles(args: { ref?: string; x?: number; y?: number; files: { name: string; type: string; base64: string }[] }): any {
  let el: Element | null = args.ref ? resolveRef(args.ref) : elementAt(args.x!, args.y!);
  if (!el)
    throw new Error('No element found for file_upload.');
  const dt = new DataTransfer();
  for (const f of args.files) {
    const bin = atob(f.base64);
    const bytes = new Uint8Array(bin.length);
    for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
    dt.items.add(new File([bytes], f.name, { type: f.type || 'application/octet-stream' }));
  }
  const input = (el instanceof HTMLInputElement && el.type === 'file') ? el : (el.querySelector?.('input[type=file]') as HTMLInputElement | null) || ((el as HTMLLabelElement).control as HTMLInputElement | null);
  if (input && input.type === 'file') {
    input.files = dt.files;
    input.dispatchEvent(new Event('input', { bubbles: true }));
    input.dispatchEvent(new Event('change', { bubbles: true }));
    return { target: describe(input), files: Array.from(input.files || []).map(f => `${f.name} (${f.size} bytes)`) };
  }
  // Drop zone
  const r = el.getBoundingClientRect();
  const cx = r.left + r.width / 2, cy = r.top + r.height / 2;
  for (const type of ['dragenter', 'dragover', 'drop'])
    el.dispatchEvent(new DragEvent(type, { ...mouseInit(cx, cy, NO_MODS, 0, 0, 0), dataTransfer: dt }));
  return { target: describe(el), files: args.files.map(f => f.name), notes: ['No <input type=file> found there, so the files were dropped onto the element as a drag-and-drop.'] };
}

function isHtml5Draggable(el: Element | null) {
  const d = el?.closest?.('[draggable="true"]') as HTMLElement | null;
  return !!d;
}

/** Viewport point of a ref, in this frame's CSS pixels (used by trusted/BiDi input). */
export function refPoint(args: { ref: string }) {
  const p = pointForRef(args.ref);
  return { x: p.x, y: p.y, target: describe(p.el), prefix: getRefPrefix(), draggable: isHtml5Draggable(p.el) };
}

/** Which frame currently has keyboard focus (forwards into focused iframes). */
export function focusInfo(): any {
  const fwd = focusedFrameForward();
  if (fwd)
    return fwd;
  return { prefix: getRefPrefix(), target: describe(deepActiveElement()) };
}

/** Which frame and element a viewport point lands on (forwards into iframes). */
export function locate(args: { x: number; y: number }): any {
  const el = elementAt(args.x, args.y);
  const fwd = iframeForward(el, args.x, args.y);
  if (fwd)
    return fwd;
  return { x: args.x, y: args.y, target: describe(el), prefix: getRefPrefix(), draggable: isHtml5Draggable(el) };
}

void pointerDownAt;
