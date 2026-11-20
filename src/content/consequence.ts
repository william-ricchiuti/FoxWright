// "Confirm before consequential actions" (opt-in): decide, from the real target element, whether a
// click or a key press would submit a form or press a button whose name sounds consequential.
// The agent's own description of the action is never used for this decision.
//
// What this is and isn't: a safety net for an agent's mistakes on ordinary sites. It works from
// what the page says about its controls (labels, roles, ids), so a page that wants to mislead
// can: by calling its "Pay" button "Next", by changing a label while it is being pressed, or by
// submitting from a script on any key. It errs on the side of asking.
import { getAriaRole, getElementAccessibleNameText } from '../../vendor/playwright/injected/roleUtils';

export type Consequence = { role: string; name: string; reason: string; origin: string };

// Whole words, with simple English endings ("Sending", "Deleted", "Orders" also match: an
// opt-in confirmation errs on the side of asking).
const WORDS = /(^|[^\p{L}\p{N}])(send|submit|post|publish|pay|buy|order|purchase|delete|remove|confirm|transfer|sign|checkout|check out)(s|es|ed|ing)?(?![\p{L}\p{N}])/iu;
// A text box whose Enter key sends what was typed (chat, comments, prompts, search).
const COMPOSER = /(^|[^\p{L}])(messages?|chat|reply|comment|send|post|tweet|prompt|ask|compose|search)(?![\p{L}])/iu;

const ACTIVATABLE = 'a[href], area[href], button, input[type=submit], input[type=image], input[type=button], input[type=reset], summary, [role=button], [role=link], [role=menuitem], [role=menuitemcheckbox], [role=menuitemradio], [role=option], [role=tab], [role=switch]';
const FIELD = 'input, select, textarea, option';
const LABEL_REASON = 'its label sounds like it sends, buys, deletes or confirms something';

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

/** Words from a control's id, class, address and the like, for controls that show only an icon. */
function hintsOf(t: Element): string {
  const parts: string[] = [];
  for (const a of ['id', 'name', 'class', 'data-testid', 'data-test', 'data-action', 'formaction', 'value'])
    parts.push(t.getAttribute(a) || '');
  const href = t.getAttribute('href');
  if (href && !/^(#|javascript:)/i.test(href))
    parts.push(href.split(/[?#]/)[0].split('/').slice(-2).join(' '));
  for (const img of Array.from(t.querySelectorAll('img[src], use[href], svg[class], i[class], span[class]')).slice(0, 4))
    parts.push((img.getAttribute('src') || img.getAttribute('href') || img.getAttribute('class') || '').split(/[?#]/)[0].split('/').pop() || '');
  // "deleteBtn", "btn_delete-item" -> separate words
  return clean(parts.join(' ').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[^\p{L}\p{N}]+/gu, ' '));
}

/** Something that isn't a button or link by its markup but is made to be clicked: its own short text counts. */
function clickableText(el: Element | null): Element | null {
  let e: Element | null = el;
  for (let i = 0; e && i < 4; i++) {
    if (e === document.body || e === document.documentElement || e.matches?.(FIELD) || e.localName === 'label')
      return null;
    let pointer = false;
    try {
      pointer = getComputedStyle(e).cursor === 'pointer';
    } catch { /* detached */ }
    if (pointer || e.hasAttribute('onclick') || (e.hasAttribute('tabindex') && e.getAttribute('tabindex') !== '-1'))
      return (e.textContent || '').trim().length <= 60 ? e : null;
    e = e.parentElement || ((e.getRootNode() as ShadowRoot).host ?? null);
  }
  return null;
}

/** What clicking `el` would set off, if it's consequential; null otherwise. */
export function clickConsequence(el: Element | null, origin: string): Consequence | null {
  let t = closestDeep(el, ACTIVATABLE);
  if (!t) {
    // A click on a <label> goes to its control: for a button, that presses it.
    const control = (closestDeep(el, 'label') as HTMLLabelElement | null)?.control;
    if (control?.matches?.(ACTIVATABLE))
      t = control;
  }
  if (!t) {
    const c = clickableText(el);
    const name = c ? nameOf(c) : '';
    return c && WORDS.test(name) ? { role: 'element', name, reason: LABEL_REASON, origin } : null;
  }
  const name = nameOf(t);
  const role = roleOf(t);
  if (submitsForm(t))
    return { role, name, reason: 'submits a form', origin };
  if (WORDS.test(name))
    return { role, name, reason: LABEL_REASON, origin };
  if (!name) {
    const hints = hintsOf(t);
    if (WORDS.test(hints))
      return { role, name: `(no label; its id or address reads: ${hints.slice(0, 60)})`, reason: 'it has no readable label, and its id, class or address sounds like it sends, buys, deletes or confirms something', origin };
  }
  return null;
}

type Mods = { command?: boolean; shift?: boolean };

/** A field text is typed into: 'line' (single-line input), 'area' (textarea, rich editor) or null. */
function textEntry(el: Element): 'line' | 'area' | null {
  if (el instanceof HTMLInputElement)
    return ['button', 'reset', 'file', 'hidden', 'submit', 'image', 'checkbox', 'radio', 'range', 'color'].includes(el.type) ? null : 'line';
  if (el instanceof HTMLTextAreaElement || (el as HTMLElement).isContentEditable)
    return 'area';
  const role = el.getAttribute('role');
  return role === 'textbox' || role === 'searchbox' || role === 'combobox' ? (el.getAttribute('aria-multiline') === 'true' ? 'area' : 'line') : null;
}

/** Does this multi-line box look like one where Enter sends (a chat, comment or prompt box)? */
function looksLikeComposer(el: Element): boolean {
  const hint = (el.getAttribute('enterkeyhint') || '').toLowerCase();
  if (['send', 'go', 'search', 'done'].includes(hint))
    return true;
  const words = [nameOf(el).slice(0, 80), el.getAttribute('placeholder'), el.getAttribute('aria-placeholder'), el.getAttribute('data-placeholder'), el.getAttribute('title'), (el.getAttribute('name') || '').replace(/[^\p{L}]+/gu, ' '), (el.id || '').replace(/([a-z])([A-Z])/g, '$1 $2').replace(/[^\p{L}]+/gu, ' ')];
  // The accessible name of a rich editor is its own text when it has no label: leave that out.
  if ((el as HTMLElement).isContentEditable && !el.getAttribute('aria-label') && !el.getAttribute('aria-labelledby'))
    words[0] = '';
  return COMPOSER.test(words.filter(Boolean).join(' | '));
}

/** The option a list, menu or combo box points at while focus stays on the box itself. */
function activeDescendant(el: Element): Element | null {
  const id = el.getAttribute('aria-activedescendant');
  if (!id)
    return null;
  try {
    return (el.getRootNode() as Document | ShadowRoot).getElementById(id);
  } catch {
    return null;
  }
}

/** What pressing Enter (or Space) with focus on `el` would set off, if it's consequential. */
export function enterConsequence(el: Element | null, origin: string, key: 'Enter' | ' ', mods: Mods = {}): Consequence | null {
  if (!el)
    return null;
  // A list, menu or combo box with a highlighted option: Enter picks that option.
  const active = activeDescendant(el);
  const picked = active && clickConsequence(active, origin);
  if (picked)
    return picked;
  if (key === 'Enter') {
    const kind = textEntry(el);
    // Enter in a single-line field (or on a checkbox/radio) inside a form submits it (implicit submission).
    if (el instanceof HTMLInputElement && el.form && !['button', 'reset', 'file', 'hidden', 'submit', 'image'].includes(el.type))
      return { role: roleOf(el), name: nameOf(el), reason: 'pressing Enter in this field submits its form', origin };
    // Ctrl+Enter / Cmd+Enter is the usual "send" or "submit" shortcut in mail, comment and chat boxes.
    if (kind && mods.command)
      return { role: roleOf(el), name: nameOf(el).slice(0, 80), reason: 'pressing Ctrl+Enter or Cmd+Enter in a text box usually sends or submits what was typed', origin };
    // A single-line field outside a form only reacts to Enter through the page's script: search, add, send.
    if (kind === 'line')
      return { role: roleOf(el), name: nameOf(el).slice(0, 80), reason: 'pressing Enter in this field may send or submit what was typed (the page\'s script decides)', origin };
    // A message, comment or prompt box: Enter sends (Shift+Enter is the line break there).
    if (kind === 'area' && !mods.shift && looksLikeComposer(el))
      return { role: roleOf(el), name: (el.getAttribute('aria-label') || el.getAttribute('placeholder') || el.getAttribute('data-placeholder') || nameOf(el)).slice(0, 80), reason: 'pressing Enter in a message, comment or search box usually sends what was typed', origin };
    if (kind)
      return null;
  }
  // Enter and Space activate buttons and (Enter) links.
  return clickConsequence(el, origin);
}

const COMMAND = /^(ctrl|control|cmd|command|meta|super|win)$/i;
/** "ctrl+shift+Enter" -> its key and modifiers ("+" alone is the plus key). */
function parseCombo(c: string): { key: string; mods: Mods } {
  const parts = c === '+' ? ['+'] : c.split('+').filter(Boolean);
  const key = parts.length ? parts[parts.length - 1] : c;
  const m = parts.slice(0, -1);
  return { key, mods: { command: m.some(p => COMMAND.test(p)), shift: m.some(p => /^shift$/i.test(p)) } };
}
const isEnter = (k: string) => /^(enter|return|numpadenter)$/i.test(k);
const isSpace = (k: string) => /^(space|spacebar| )$/i.test(k);
const isTab = (k: string) => /^tab$/i.test(k);
const isArrow = (k: string) => /^(up|down|left|right|arrowup|arrowdown|arrowleft|arrowright|home|end|pageup|pagedown|page_up|page_down)$/i.test(k);

/** Do the arrow keys move a highlight here (menus, lists, tabs, combo boxes), rather than a text cursor or the page? */
function arrowsMoveHere(el: Element | null): boolean {
  if (!el || el === document.body || el === document.documentElement)
    return false;
  if (!textEntry(el))
    return true;
  return el.getAttribute('role') === 'combobox' || el.hasAttribute('aria-activedescendant') || el.hasAttribute('aria-controls') || el.hasAttribute('aria-autocomplete') || el.hasAttribute('list');
}

/**
 * For a key sequence ("Tab Tab Enter"), the consequence of its Enter/Space presses with focus on
 * `focused`. If focus or a highlight may move first (Tab, arrow keys in a menu or list), Foxwright
 * can't know what will be activated: ask.
 */
export function keysConsequence(text: string, repeat: number, focused: Element | null, origin: string): Consequence | null {
  const combos = String(text || '').trim().split(/\s+/).filter(Boolean);
  let moved = false;
  const reps = Math.min(Math.max(1, repeat || 1), 2); // a second round sees what the first one moved
  for (let r = 0; r < reps; r++) {
    for (const c of combos) {
      const { key, mods } = parseCombo(c);
      if (isTab(key) || (isArrow(key) && arrowsMoveHere(focused)))
        moved = true;
      else if (isEnter(key) || isSpace(key)) {
        if (moved)
          return { role: 'key', name: c.slice(0, 40), reason: 'it presses Enter or Space after moving focus, so Foxwright can\'t tell in advance what it will activate', origin };
        const k = enterConsequence(focused, origin, isEnter(key) ? 'Enter' : ' ', mods);
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

/** Choosing `value` from a custom list (form_input on a combobox) presses an option named that. */
export function optionConsequence(value: string, origin: string): Consequence | null {
  const name = clean(String(value ?? ''));
  return WORDS.test(name) ? { role: 'option', name, reason: LABEL_REASON, origin } : null;
}

/** Same element as the one the person approved (role, name and reason unchanged)? */
export function sameConsequence(a: Consequence | null, b: any): boolean {
  return !!a && !!b && a.role === b.role && a.name === b.name && a.reason === b.reason;
}
