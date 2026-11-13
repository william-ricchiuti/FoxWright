// Waiting for the page instead of sleeping: until some text appears or goes away, an element goes
// away, or the DOM stops changing. Also: what visibly changed after a click or key press (a dialog,
// menu or listbox opened or closed, focus moved), so the agent doesn't need a read_page to find out.
import { lookupRef, refFor, outlineJson } from './snapshot';
import { isFoxwrightUi } from './overlay';
import { describe, deepActiveElement, isCancelled } from './input';

// ---------- DOM activity ----------

let lastMutation = performance.now();
let observer: MutationObserver | null = null;
const wakers = new Set<() => void>();

function ownMutation(r: MutationRecord): boolean {
  if (isFoxwrightUi(r.target as Element))
    return true;
  if (r.type !== 'childList')
    return false;
  const nodes = [...Array.from(r.addedNodes), ...Array.from(r.removedNodes)];
  return nodes.length > 0 && nodes.every(n => isFoxwrightUi(n as Element));
}

function ensureObserver() {
  if (observer)
    return;
  lastMutation = performance.now();
  observer = new MutationObserver((records) => {
    if (records.every(ownMutation))
      return;
    lastMutation = performance.now();
    for (const w of [...wakers])
      w();
  });
  observer.observe(document, { subtree: true, childList: true, attributes: true, characterData: true });
}

/** Resolves on the next DOM change, or after ms. */
function nextChange(ms: number): Promise<void> {
  return new Promise((resolve) => {
    const done = () => {
      wakers.delete(done);
      clearTimeout(timer);
      resolve();
    };
    const timer = setTimeout(done, Math.max(0, ms));
    wakers.add(done);
  });
}

const sleep = (ms: number) => new Promise(r => setTimeout(r, ms));

// ---------- conditions ----------

const norm = (s: string) => s.toLowerCase().replace(/\s+/g, ' ').trim();

function isSecret(el: Element): boolean {
  return (el instanceof HTMLInputElement && el.type === 'password') || !!(globalThis as any).__foxwrightSecret?.(el);
}

/** Cheap check: rendered text, plus labels, placeholders and field values that innerText leaves out. */
function textFast(needle: string): boolean {
  const body = document.body;
  if (!body)
    return false;
  if (norm(body.innerText || '').includes(needle))
    return true;
  const els = document.querySelectorAll('input:not([type=hidden]), textarea, [aria-label], [placeholder], [title], img[alt]');
  for (let i = 0; i < els.length && i < 5000; i++) {
    const el = els[i];
    const vals = [el.getAttribute('aria-label'), el.getAttribute('placeholder'), el.getAttribute('title'), el.getAttribute('alt')];
    if ((el instanceof HTMLInputElement || el instanceof HTMLTextAreaElement) && !isSecret(el))
      vals.push(el.value);
    if (vals.some(v => v && norm(v).includes(needle)) && (el as any).checkVisibility?.() !== false)
      return true;
  }
  return false;
}

// The full outline also sees shadow DOM and names computed from labels; it's slower on big pages,
// so it runs at most every few hundred milliseconds (more rarely if it is slow).
type Slow = { due: number; value: boolean; key: string };
const slow: Slow = { due: 0, value: false, key: '' };

function outlineCheck(key: string, test: (nodes: any[]) => boolean): boolean {
  const now = performance.now();
  if (slow.key === key && now < slow.due)
    return slow.value;
  const t0 = now;
  let value = false;
  try {
    value = test(outlineJson());
  } catch { /* page mid-update */ }
  const cost = performance.now() - t0;
  Object.assign(slow, { key, value, due: performance.now() + Math.max(400, cost * 5) });
  return value;
}

function anyNode(nodes: any[], pred: (n: any) => boolean): boolean {
  for (const n of nodes) {
    if (typeof n === 'string') {
      if (pred(n))
        return true;
      continue;
    }
    if (pred(n) || (n.children && anyNode(n.children, pred)))
      return true;
  }
  return false;
}

function textPresent(needle: string): boolean {
  return textFast(needle) || outlineCheck(`t:${needle}`, nodes => anyNode(nodes, n => typeof n === 'string' ? norm(n).includes(needle) : [n.name, n.text, n.placeholder].some(v => typeof v === 'string' && norm(v).includes(needle))));
}

function rolePresent(role: string, name: string): boolean {
  return outlineCheck(`r:${role}:${name}`, nodes => anyNode(nodes, n => typeof n !== 'string' && n.role === role && (!name || norm(String(n.name || n.text || '')).includes(name))));
}

function refGone(ref: string): boolean {
  const el = lookupRef(ref);
  if (!el)
    return true;
  const r = el.getBoundingClientRect();
  return r.width === 0 && r.height === 0 || (el as any).checkVisibility?.({ visibilityProperty: true }) === false;
}

export type WaitArgs = {
  text?: string; // until this text is on the page
  text_gone?: string; // until this text is no longer on the page
  ref_gone?: string; // until this element is removed or hidden
  role?: string; name?: string; // until an element with this role (and name) is in the outline
  quietMs?: number; // until the DOM hasn't changed for this long
  sliceMs?: number; // give up (met: false) after this long; the background calls again
};

/**
 * Wait in the page until all given conditions hold or sliceMs passes. Returns how long the DOM has
 * been quiet, so the background can combine it with network activity for "idle".
 */
export async function waitCheck(a: WaitArgs): Promise<{ met: boolean; domQuietMs: number }> {
  ensureObserver();
  const end = performance.now() + Math.max(0, Math.min(a.sliceMs ?? 2000, 10000));
  const text = a.text ? norm(a.text) : '';
  const gone = a.text_gone ? norm(a.text_gone) : '';
  const role = a.role ? a.role.toLowerCase() : '';
  const name = a.name ? norm(a.name) : '';
  const cond = () => (!text || textPresent(text))
    && (!gone || !textPresent(gone))
    && (!a.ref_gone || refGone(a.ref_gone))
    && (!role || rolePresent(role, name))
    && (!a.quietMs || performance.now() - lastMutation >= a.quietMs);
  for (;;) {
    if (isCancelled())
      throw new Error('Stopped: the user paused Foxwright.');
    const t0 = performance.now();
    const ok = cond();
    const cost = performance.now() - t0;
    const quiet = Math.round(performance.now() - lastMutation);
    if (ok)
      return { met: true, domQuietMs: quiet };
    const left = end - performance.now();
    if (left <= 0)
      return { met: false, domQuietMs: quiet };
    const onlyIdle = !text && !gone && !a.ref_gone && !role;
    const wake = onlyIdle ? Math.max(10, a.quietMs! - quiet) : 250;
    await nextChange(Math.min(left, wake));
    // Pages that animate change the DOM constantly: don't re-check faster than the checks cost.
    if (!onlyIdle)
      await sleep(Math.min(Math.max(30, cost * 2), Math.max(0, end - performance.now())));
  }
}

// ---------- what changed after an action ----------

const OVERLAY_SEL = 'dialog[open], [role="dialog"], [role="alertdialog"], [role="listbox"], [role="menu"], [aria-modal="true"]';

function shown(el: Element): boolean {
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && (el as any).checkVisibility?.({ visibilityProperty: true }) !== false;
}

function openOverlays(): Element[] {
  let list = Array.from(document.querySelectorAll(OVERLAY_SEL)).slice(0, 200);
  try {
    list = list.concat(Array.from(document.querySelectorAll(':popover-open')).slice(0, 50));
  } catch { /* older Firefox */ }
  return list.filter(shown);
}

function overlayRole(el: Element): string {
  return el.getAttribute('role') || (el.localName === 'dialog' || el.getAttribute('aria-modal') === 'true' ? 'dialog' : 'popup');
}

function overlayName(el: Element): string {
  const label = el.getAttribute('aria-label');
  if (label)
    return label.trim().slice(0, 80);
  const ids = (el.getAttribute('aria-labelledby') || '').split(/\s+/).filter(Boolean);
  const byId = ids.map(id => document.getElementById(id)?.textContent || '').join(' ').replace(/\s+/g, ' ').trim();
  if (byId)
    return byId.slice(0, 80);
  const h = el.querySelector('h1, h2, h3, [role="heading"]');
  return (h?.textContent || '').replace(/\s+/g, ' ').trim().slice(0, 80);
}

function popupTrigger(target: Element | null): Element | null {
  return target?.closest?.('[aria-haspopup]:not([aria-haspopup="false"]), [aria-expanded]') || null;
}

export type UiBase = { overlays: Set<Element>; active: Element | null; trigger: Element | null; expanded: string | null; target: Element | null; at: number };

let lastAction = 0;
/** Time of the agent's last click or key press in this document. */
export function lastUiAction(): number {
  return lastAction;
}

export function uiBaseline(target: Element | null): UiBase {
  lastAction = Date.now();
  const trigger = popupTrigger(target);
  return { overlays: new Set(openOverlays()), active: deepActiveElement(), trigger, expanded: trigger?.getAttribute('aria-expanded') ?? null, target, at: Date.now() };
}

/**
 * Give the page a moment to react before reporting what changed. Clicking a menu/popup button
 * (aria-haspopup, aria-expanded) waits up to ~1 s for the popup, so the next call sees it opened;
 * other clicks only let already-queued page work run.
 */
export async function uiSettle(base: UiBase) {
  ensureObserver();
  await sleep(0);
  if (!base.trigger)
    return;
  const end = performance.now() + 1000;
  const changed = () => base.trigger!.getAttribute('aria-expanded') !== base.expanded || openOverlays().some(o => !base.overlays.has(o));
  while (!changed() && performance.now() < end && !isCancelled())
    await nextChange(end - performance.now());
  // Let the popup finish rendering its content (bounded).
  const settleEnd = Math.min(end + 300, performance.now() + 300);
  while (performance.now() - lastMutation < 50 && performance.now() < settleEnd)
    await nextChange(50);
}

function refText(el: Element): string {
  const ref = refFor(el);
  return ref ? ` [ref=${ref}]` : '';
}

/** Notes on popups that opened or closed and on where focus went. */
export function uiNotes(base: UiBase): string[] {
  const notes: string[] = [];
  const now = openOverlays();
  const added = now.filter(o => !base.overlays.has(o));
  // Report the outermost new popup only (a listbox inside a new dialog is part of that dialog).
  for (const o of added.filter(o => !added.some(p => p !== o && p.contains(o))).slice(0, 3)) {
    const nm = overlayName(o);
    notes.push(`Opened: ${overlayRole(o)}${nm ? ` ${JSON.stringify(nm)}` : ''}${refText(o)} (read_page lists open popups first).`);
  }
  for (const o of [...base.overlays].filter(o => !o.isConnected || !shown(o)).slice(0, 3)) {
    const nm = overlayName(o);
    notes.push(`Closed: ${overlayRole(o)}${nm ? ` ${JSON.stringify(nm)}` : ''}.`);
  }
  if (base.trigger && !added.length) {
    const ex = base.trigger.getAttribute('aria-expanded');
    if (ex !== base.expanded && ex !== null)
      notes.push(`${describe(base.trigger)} is now ${ex === 'true' ? 'expanded' : 'collapsed'}.`);
  }
  const active = deepActiveElement();
  const tgt = base.target;
  if (active && active !== base.active && active !== document.body && active !== document.documentElement && !(tgt && (active === tgt || active.contains(tgt) || tgt.contains(active))))
    notes.push(`Focus is now on ${describe(active)}${refText(active)}.`);
  return notes;
}

// ---------- trusted (WebDriver BiDi) input ----------
// Real input bypasses the content script: the background asks for the target's point first
// (refPoint/locate/focusInfo), which records a baseline here, and calls uiAfter once the input is done.
let pending: UiBase | null = null;

export function rememberBaseline(target: Element | null) {
  pending = uiBaseline(target);
}

export async function uiAfter(): Promise<string[]> {
  const base = pending;
  pending = null;
  if (!base || Date.now() - base.at > 15000)
    return [];
  await uiSettle(base);
  return uiNotes(base);
}

/**
 * Typing right after a click that opens a dialog: the dialog (and its focused field) may arrive a
 * moment later, e.g. when its code is loaded on demand. Wait up to `ms` for focus to land in an
 * editable element; returns how long that took, or -1.
 */
export async function waitForEditableFocus(isEditable: (el: Element | null) => boolean, ms: number): Promise<number> {
  ensureObserver();
  const t0 = performance.now();
  const end = t0 + ms;
  const focusEditable = () => {
    const a = deepActiveElement();
    return isEditable(a) || (!!a && /^(IFRAME|FRAME)$/.test(a.tagName));
  };
  return new Promise((resolve) => {
    const finish = (v: number) => {
      document.removeEventListener('focusin', onFocus, true);
      clearInterval(iv);
      resolve(v);
    };
    const check = () => {
      if (focusEditable())
        finish(Math.round(performance.now() - t0));
      else if (performance.now() >= end || isCancelled())
        finish(-1);
    };
    const onFocus = () => setTimeout(check, 0);
    document.addEventListener('focusin', onFocus, true);
    const iv = setInterval(check, 50);
    check();
  });
}
