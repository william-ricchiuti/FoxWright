// "Confirm before consequential actions" (opt-in): decide, from the real target element, whether a
// click or a key press would submit a form or press a button whose name sounds consequential.
// The agent's own description of the action is never used for this decision.
import { getAriaRole, getElementAccessibleNameText } from '../../vendor/playwright/injected/roleUtils';

export type Consequence = { role: string; name: string; reason: string; origin: string };

// Whole words, with simple English endings ("Sending", "Deleted", "Orders" also match: an
// opt-in confirmation errs on the side of asking).
const WORDS = /(^|[^\p{L}\p{N}])(send|submit|post|publish|pay|buy|order|purchase|delete|remove|confirm|transfer|sign|checkout|check out)(s|es|ed|ing)?(?![\p{L}\p{N}])/iu;

const ACTIVATABLE = 'a[href], area[href], button, input[type=submit], input[type=image], input[type=button], input[type=reset], summary, [role=button], [role=link], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=option], [role=tab], [role=switch]';

function closestDeep(el: Element | null, sel: string): Element | null {
  let e: Element | null = el;
  while (e) {
    if (e.matches?.(sel))
      return e;
    e = e.parentElement || ((e.getRootNode() as ShadowRoot).host ?? null);
  }
  return null;
}

function clean(s: string): string {
  return (s || '').replace(/\s+/g, ' ').trim().slice(0, 120);
}

function nameOf(el: Element): string {
  let n = '';
  try {
    n = getElementAccessibleNameText(el, false);
  } catch { /* fall back below */ }
  if (!n && el instanceof HTMLInputElement)
    n = el.value;
  return clean(n || el.textContent || '');
}

function roleOf(el: Element): string {
  try {
    return getAriaRole(el) || el.localName;
  } catch {
    return el.localName;
  }
}

function submitsForm(t: Element): boolean {
  if (t instanceof HTMLButtonElement)
    return t.type === 'submit' && !!t.form && !t.disabled;
  if (t instanceof HTMLInputElement)
    return (t.type === 'submit' || t.type === 'image') && !!t.form && !t.disabled;
  return false;
}

/** What clicking `el` would set off, if it's consequential; null otherwise. */
export function clickConsequence(el: Element | null, origin: string): Consequence | null {
  const t = closestDeep(el, ACTIVATABLE);
  if (!t)
    return null;
  const name = nameOf(t);
  const role = roleOf(t);
  if (submitsForm(t))
    return { role, name, reason: 'submits a form', origin };
  if (WORDS.test(name))
    return { role, name, reason: 'its label sounds like it sends, buys, deletes or confirms something', origin };
  return null;
}

/** What pressing Enter (or Space) with focus on `el` would set off, if it's consequential. */
export function enterConsequence(el: Element | null, origin: string, key: 'Enter' | ' '): Consequence | null {
  if (!el)
    return null;
  // Enter in a single-line field (or on a checkbox/radio) inside a form submits it (implicit submission).
  if (key === 'Enter' && el instanceof HTMLInputElement && el.form && !['button', 'reset', 'file', 'hidden', 'submit', 'image'].includes(el.type))
    return { role: roleOf(el), name: nameOf(el), reason: 'pressing Enter in this field submits its form', origin };
  // Enter and Space activate buttons and (Enter) links.
  return clickConsequence(el, origin);
}

const isEnter = (c: string) => /^(enter|return)$/i.test(c);
const isSpace = (c: string) => /^(space|spacebar| )$/i.test(c);
const movesFocus = (c: string) => /(^|\+)tab$/i.test(c);

/**
 * For a key sequence ("Tab Tab Enter"), the consequence of its Enter/Space presses with focus on
 * `focused`. If focus may move first (Tab), Foxwright can't know what will be activated: ask.
 */
export function keysConsequence(text: string, repeat: number, focused: Element | null, origin: string): Consequence | null {
  const combos = String(text || '').trim().split(/\s+/).filter(Boolean);
  let moved = false;
  for (let r = 0; r < Math.max(1, repeat || 1); r++) {
    for (const c of combos) {
      if (movesFocus(c))
        moved = true;
      else if (isEnter(c) || isSpace(c)) {
        if (moved)
          return { role: 'key', name: c, reason: 'it presses Enter or Space after moving focus, so Foxwright can\'t tell in advance what it will activate', origin };
        const k = enterConsequence(focused, origin, isEnter(c) ? 'Enter' : ' ');
        if (k)
          return k;
      }
    }
  }
  return null;
}

/** For typed text: a line break works like Enter in the focused field. */
export function typeConsequence(text: string, focused: Element | null, origin: string): Consequence | null {
  return /[\r\n]/.test(String(text || '')) ? enterConsequence(focused, origin, 'Enter') : null;
}

/** Same element as the one the person approved (role, name and reason unchanged)? */
export function sameConsequence(a: Consequence | null, b: any): boolean {
  return !!a && !!b && a.role === b.role && a.name === b.name && a.reason === b.reason;
}
