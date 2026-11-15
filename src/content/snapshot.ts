// Page outline ("read_page") and element search ("find") for Foxwright.
// Uses Playwright's vendored aria-snapshot code to compute WAI-ARIA roles and
// accessible names in plain JavaScript (Firefox extensions have no CDP).

import { generateAriaTree, renderAriaTreeAsJSON } from '../../vendor/playwright/injected/ariaSnapshot';
import { renderAriaSnapshotAsYaml } from '../../vendor/playwright/isomorphic/ariaSnapshotRenderer';

declare const browser: any;

let refPrefix = '';
const refMap = new Map<string, WeakRef<Element>>();

export function setRefPrefix(prefix: string) {
  refPrefix = prefix;
}

export function getRefPrefix() {
  return refPrefix;
}

export function resolveRef(ref: string): Element {
  const el = refMap.get(ref)?.deref();
  if (!el)
    throw new Error(`Element ${ref} was not found. The page may have changed or navigated. Call read_page or find again to get fresh refs.`);
  if (!el.isConnected)
    throw new Error(`Element ${ref} is no longer on the page. Call read_page or find again to get fresh refs.`);
  return el;
}

/** Random id of this document, so the background can tell a new page from the one it read before. */
export const docId = Math.random().toString(36).slice(2, 10);

/** The element a ref points at, or null (unknown ref, or the element was removed). */
export function lookupRef(ref: string): Element | null {
  const el = refMap.get(ref)?.deref();
  return el && el.isConnected ? el : null;
}

// Playwright gives an element a new ref whenever its accessible name changes (a "Clicked 1 times"
// button becomes a new ref after every click). Keep the first ref an element got for as long as
// its role stays the same, so read_page diffs can show such an element as changed in place, and
// refs an agent already holds keep pointing at it.
const stableRefs = new WeakMap<Element, { role: string; ref: string }>();

function stabilize(snapshot: ReturnType<typeof generateAriaTree>) {
  const remap = new Map<string, string>();
  for (const [el, ref] of snapshot.refs) {
    const info = (el as any)._ariaRef as { role: string; name: string; ref: string } | undefined;
    const prev = stableRefs.get(el);
    if (prev && info && prev.role === info.role) {
      if (prev.ref !== ref) {
        remap.set(ref, prev.ref);
        info.ref = prev.ref; // Playwright reuses this until the name changes again
      }
    } else if (info) {
      stableRefs.set(el, { role: info.role, ref });
    }
  }
  if (!remap.size)
    return;
  const walk = (n: any) => {
    if (!n || typeof n === 'string')
      return;
    if (n.ref && remap.has(n.ref))
      n.ref = remap.get(n.ref);
    for (const c of n.children || [])
      walk(c);
  };
  walk(snapshot.root);
  for (const [el, ref] of [...snapshot.refs]) {
    const to = remap.get(ref);
    if (!to)
      continue;
    snapshot.refs.set(el, to);
    const info = snapshot.info.get(ref);
    snapshot.info.delete(ref);
    if (info)
      snapshot.info.set(to, info);
  }
  snapshot.iframeRefs = snapshot.iframeRefs.map(r => remap.get(r) || r);
}

function remember(snapshot: ReturnType<typeof generateAriaTree>) {
  stabilize(snapshot);
  for (const [el, ref] of snapshot.refs)
    refMap.set(ref, new WeakRef(el));
}

/** A ref for one element (e.g. the element that has focus after a click), or null if it can't take one. */
export function refFor(el: Element | null): string | null {
  if (!el || !el.isConnected)
    return null;
  try {
    const snapshot = generateAriaTree(el, { mode: 'ai', refPrefix, depth: 1 });
    remember(snapshot);
    return snapshot.refs.get(el) || null;
  } catch {
    return null;
  }
}

/** The rendered outline of the whole document as a JSON tree (for waiting on role + name). */
export function outlineJson(): any[] {
  const root = document.body || document.documentElement;
  const snapshot = generateAriaTree(root, { mode: 'ai', refPrefix });
  remember(snapshot);
  return renderAriaTreeAsJSON(snapshot, { mode: 'ai', refPrefix }).json;
}

function frameIdOf(el: Element): number {
  try {
    return browser.runtime.getFrameId(el);
  } catch {
    return -1;
  }
}

type SnapshotArgs = { filter?: 'all' | 'interactive'; depth?: number; ref_id?: string; visible_only?: boolean };

const INTERACTIVE_ROLES = new Set(['button', 'link', 'textbox', 'searchbox', 'combobox', 'checkbox', 'radio', 'slider', 'spinbutton', 'switch', 'tab', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'option', 'listbox', 'treeitem', 'gridcell', 'columnheader', 'rowheader', 'iframe', 'scrollbar', 'textarea']);

function isInteractiveNode(n: any): boolean {
  if (INTERACTIVE_ROLES.has(n.role) || n.cursor === 'pointer')
    return true;
  const el = refMap.get(n.ref)?.deref() as HTMLElement | undefined;
  if (!el || el === document.body || el === document.documentElement)
    return false;
  if (el.isContentEditable && !el.parentElement?.isContentEditable)
    return true;
  const ti = el.getAttribute('tabindex');
  return ti !== null && parseInt(ti) >= 0;
}

/** Playwright omits text directly inside textboxes; show contenteditable editors' text like an input value. */
function enrichEditors(nodes: any[]) {
  for (const n of nodes) {
    if (typeof n === 'string')
      continue;
    if (n.role === 'combobox' && n.ref && !n.text && !(n.children || []).some((c: any) => typeof c === 'string' || c.ref)) {
      // e.g. a custom select whose aria-label is "Food" but which currently shows "Banana"
      const el = refMap.get(n.ref)?.deref() as HTMLElement | undefined;
      const shown = (el?.innerText || '').replace(/\s+/g, ' ').trim();
      if (el && !(el instanceof HTMLInputElement) && !(el instanceof HTMLSelectElement) && shown && shown !== n.name && shown.length < 120) {
        n.text = shown;
        delete n.children;
      }
    }
    if (n.role === 'textbox' && n.ref && !n.text && !(n.children || []).some((c: any) => typeof c !== 'string')) {
      const el = refMap.get(n.ref)?.deref() as HTMLElement | undefined;
      if (el?.isContentEditable) {
        const t = (el.innerText || '').replace(/\s+/g, ' ').trim();
        if (t)
          n.text = t.length > 500 ? t.slice(0, 500) + '…' : t;
        delete n.children;
      }
    }
    if (n.children)
      enrichEditors(n.children);
  }
}

function inViewport(ref: string): boolean {
  const el = refMap.get(ref)?.deref();
  if (!el)
    return false;
  const r = el.getBoundingClientRect();
  return r.width > 0 && r.height > 0 && r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
}

/** Keep only what's on screen (plus the ancestors that give it context). */
function pruneToViewport(nodes: any[]): boolean {
  let any = false;
  for (let i = nodes.length - 1; i >= 0; i--) {
    const n = nodes[i];
    if (typeof n === 'string')
      continue;
    const kids = n.children ? pruneToViewport(n.children) : false;
    const self = n.ref ? inViewport(n.ref) : false;
    if (!kids && !self) {
      nodes.splice(i, 1);
      continue;
    }
    if (!self && n.children)
      n.children = n.children.filter((c: any) => typeof c !== 'string'); // drop off-screen text of containers
    any = true;
  }
  return any;
}

const OVERLAY_ROLES = new Set(['dialog', 'alertdialog', 'listbox', 'menu', 'tooltip']);

/** Pull open popups out of the tree (leaving a pointer behind) so they can be rendered first. */
function hoistOverlays(nodes: any[]): any[] {
  const found: any[] = [];
  const walk = (list: any[]) => {
    for (let i = 0; i < list.length; i++) {
      const n = list[i];
      if (typeof n === 'string')
        continue;
      if (OVERLAY_ROLES.has(n.role) && n.children?.length) {
        const el = n.ref ? refMap.get(n.ref)?.deref() : undefined;
        const r = el?.getBoundingClientRect();
        const onScreen = !el || (r!.width > 0 && r!.height > 0 && r!.bottom > 0 && r!.top < innerHeight);
        if (onScreen) {
          found.push(n);
          list[i] = { role: n.role, name: n.name, ref: n.ref, text: '(open popup, shown at the top)' };
          continue;
        }
      }
      if (n.children)
        walk(n.children);
    }
  };
  walk(nodes);
  return found;
}

export type SnapshotResult = {
  yaml: string;
  // iframe ref -> frameId, so the background can stitch child-frame outlines in. `loads` is true
  // when the frame element points at a real page (src set, no srcdoc), so an about:blank document
  // in it is the placeholder before that page arrives, not the frame's content.
  iframes: { ref: string; frameId: number; loads?: boolean }[];
  title: string;
  url: string;
  readyState: DocumentReadyState;
  docId: string;
  viewport: { width: number; height: number; scrollX: number; scrollY: number; scrollHeight: number };
};

export function takeSnapshot(args: SnapshotArgs): SnapshotResult | { frameRedirect: number } {
  const root = args.ref_id ? resolveRef(args.ref_id) : (document.body || document.documentElement);
  if (root.tagName === 'IFRAME' || root.tagName === 'FRAME')
    return { frameRedirect: frameIdOf(root) };
  const depth = args.depth ?? 25;
  const snapshot = generateAriaTree(root, { mode: 'ai', refPrefix, depth });
  remember(snapshot);
  const { json } = renderAriaTreeAsJSON(snapshot, { mode: 'ai', refPrefix, depth });
  enrichEditors(json);
  if (args.visible_only)
    pruneToViewport(json);

  // Popups (menus, listboxes, dialogs) are usually portals at the end of <body>, so on a
  // long page they'd be cut off by max_chars exactly when they matter. Show them first.
  const overlays = args.ref_id ? [] : hoistOverlays(json);

  let yaml: string;
  if (args.filter === 'interactive') {
    const flat: any[] = [];
    const walk = (nodes: any[]) => {
      for (const n of nodes) {
        if (typeof n === 'string')
          continue;
        if (n.ref && isInteractiveNode(n)) {
          const copy = { ...n };
          delete copy.children;
          flat.push(copy);
        }
        if (n.children)
          walk(n.children);
      }
    };
    walk(json);
    yaml = flat.length ? renderAriaSnapshotAsYaml(flat) : '(no interactive elements found)';
  } else {
    yaml = renderAriaSnapshotAsYaml(json);
  }

  if (overlays.length) {
    const top = args.filter === 'interactive' ? overlays.map(o => ({ ...o, children: (o.children || []).filter((c: any) => typeof c !== 'string') })) : overlays;
    yaml = `- note: open popups/dialogs are listed first; the rest of the page follows\n${renderAriaSnapshotAsYaml(top)}\n${yaml}`;
  }

  const iframes: { ref: string; frameId: number; loads?: boolean }[] = [];
  for (const ref of snapshot.iframeRefs) {
    const el = snapshot.info.get(ref)?.element;
    if (el) {
      const src = (el.getAttribute('src') || '').trim();
      const loads = !!src && !el.hasAttribute('srcdoc') && !/^(about|javascript):/i.test(src);
      iframes.push({ ref, frameId: frameIdOf(el), ...(loads ? { loads } : {}) });
    }
  }

  const se = document.scrollingElement || document.documentElement;
  return {
    yaml,
    iframes,
    title: document.title,
    url: location.href,
    readyState: document.readyState,
    docId,
    viewport: {
      width: window.innerWidth,
      height: window.innerHeight,
      scrollX: Math.round(window.scrollX),
      scrollY: Math.round(window.scrollY),
      scrollHeight: se ? se.scrollHeight : 0,
    },
  };
}

// ---------- find ----------

const ROLE_SYNONYMS: Record<string, string[]> = {
  button: ['button', 'btn'],
  link: ['link', 'anchor', 'href'],
  textbox: ['textbox', 'input', 'field', 'box', 'text', 'bar', 'entry', 'textarea'],
  searchbox: ['search', 'searchbox', 'input', 'field', 'box', 'bar'],
  combobox: ['combobox', 'dropdown', 'select', 'picker', 'input', 'field', 'autocomplete'],
  checkbox: ['checkbox', 'check', 'tick', 'toggle'],
  switch: ['switch', 'toggle'],
  radio: ['radio', 'option'],
  tab: ['tab'],
  menuitem: ['menu', 'item', 'option'],
  option: ['option', 'item', 'choice'],
  heading: ['heading', 'title', 'header', 'headline'],
  img: ['image', 'img', 'picture', 'photo', 'icon', 'logo'],
  navigation: ['nav', 'navigation', 'menu'],
  dialog: ['dialog', 'modal', 'popup'],
  slider: ['slider', 'range'],
};

const CONTAINER_ROLES = new Set(['generic', 'group', 'form', 'region', 'list', 'listitem', 'main', 'navigation', 'table', 'grid', 'treegrid', 'rowgroup', 'row', 'article', 'section', 'banner', 'contentinfo', 'complementary', 'document', 'application', 'toolbar', 'menubar', 'tablist', 'tabpanel', 'dialog', 'figure', 'blockquote', 'paragraph', 'status', 'alert', 'log']);

const STOP = new Set(['the', 'a', 'an', 'to', 'of', 'for', 'on', 'in', 'with', 'that', 'this', 'and', 'or', 'containing', 'called', 'named', 'labeled', 'labelled']);

function tokens(s: string): string[] {
  return s.toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(t => t && !STOP.has(t));
}

/** Accessible-ish name of an element we have no outline node for (hidden content, expanders). */
function plainName(el: Element): string {
  const h = el as HTMLElement;
  const n = el.getAttribute('aria-label') || (h instanceof HTMLInputElement ? (h.labels?.[0]?.textContent || h.placeholder || h.value) : '') || h.textContent || el.getAttribute('title') || '';
  return n.replace(/\s+/g, ' ').trim().slice(0, 100);
}

function plainRole(el: Element): string {
  const r = el.getAttribute('role');
  if (r)
    return r.split(/\s+/)[0];
  const t = el.localName;
  if (t === 'a')
    return 'link';
  if (/^h[1-6]$/.test(t))
    return 'heading';
  if (t === 'input') {
    const ty = (el as HTMLInputElement).type;
    return ty === 'checkbox' || ty === 'radio' ? ty : ty === 'submit' || ty === 'button' ? 'button' : ty === 'search' ? 'searchbox' : 'textbox';
  }
  const map: Record<string, string> = { button: 'button', select: 'combobox', textarea: 'textbox', summary: 'button', label: 'label' };
  return map[t] || t;
}

/** The control that expands a collapsed container (accordion header, <summary>, menu button). */
function expanderFor(container: Element): Element | null {
  for (let a: Element | null = container, i = 0; a && a !== document.body && i < 12; a = a.parentElement, i++) {
    if (a.id) {
      const t = document.querySelector(`[aria-controls~="${CSS.escape(a.id)}"]`);
      if (t)
        return t;
    }
    if (a instanceof HTMLDetailsElement && !a.open)
      return a.querySelector(':scope > summary');
    const prev = a.previousElementSibling;
    if (prev) {
      if (prev.getAttribute('aria-expanded') === 'false')
        return prev;
      const inner = prev.querySelector(':scope > [aria-expanded="false"]');
      if (inner)
        return inner;
    }
  }
  return null;
}

function expanderText(container: Element): string {
  const t = expanderFor(container);
  if (!t)
    return '';
  const ref = refFor(t);
  return `; expand it first with ${plainRole(t)} ${JSON.stringify(plainName(t))}${ref ? ` [ref=${ref}]` : ''}`;
}

/** A note when a matched element sits in a collapsed (zero-size or clipped) part of the page. */
function collapsedNote(el: Element): string {
  const r = el.getBoundingClientRect();
  let clipper: Element | null = null;
  for (let a = el.parentElement, i = 0; a && a !== document.body && i < 25; a = a.parentElement, i++) {
    const ar = a.getBoundingClientRect();
    if (ar.height < 1 || ar.width < 1) {
      const cs = getComputedStyle(a);
      if (cs.overflowX !== 'visible' || cs.overflowY !== 'visible') {
        clipper = a;
        break;
      }
    }
  }
  if (!clipper && (r.width > 0 && r.height > 0 || !expanderFor(el)))
    return '';
  return `(inside a collapsed section${expanderText(clipper || el)})`;
}

/** Score how well an element matches a find query (word overlap, role words, exact name). */
function scorer(query: string) {
  const q = tokens(query);
  const qFull = query.toLowerCase().trim();
  return (hay: string, role: string, ancestorsText: string, nameText: string, containerish: boolean) => {
    const hayTokens = new Set(tokens(hay));
    const roleWords = new Set([role, ...(ROLE_SYNONYMS[role] || [])]);
    let score = 0;
    for (const t of q) {
      if (hayTokens.has(t))
        score += 3;
      else if (t.length > 2 && hay.includes(t))
        score += 2;
      else if (roleWords.has(t))
        score += 1.5;
      else if (ancestorsText.includes(t))
        score += 0.5;
    }
    if (qFull && hay.includes(qFull))
      score += 4;
    const nm = nameText.toLowerCase().trim();
    if (qFull && nm === qFull)
      score += 6; // exact name match beats everything
    else if (nm.length > 80)
      score *= 0.7; // long text blobs are rarely what's wanted
    if (containerish)
      score *= 0.5;
    return score;
  };
}

/**
 * Content of collapsed sections (closed <details>, accordion panels and menus whose trigger says
 * aria-expanded="false", hidden="until-found") isn't in the outline at all. Search it too, so the
 * agent learns that what it's looking for exists but has to be expanded first.
 */
function hiddenMatches(score: ReturnType<typeof scorer>) {
  const containers = new Set<Element>();
  for (const d of Array.from(document.querySelectorAll('details:not([open]), [hidden="until-found"]')).slice(0, 100))
    containers.add(d);
  for (const t of Array.from(document.querySelectorAll('[aria-expanded="false"][aria-controls]')).slice(0, 100)) {
    for (const id of (t.getAttribute('aria-controls') || '').split(/\s+/)) {
      const c = id ? document.getElementById(id) : null;
      if (c)
        containers.add(c);
    }
  }
  const out: { score: number; node: any; hidden: Element }[] = [];
  const seen = new Set<Element>();
  for (const c of containers) {
    const summary = c instanceof HTMLDetailsElement ? c.querySelector(':scope > summary') : null;
    for (const el of Array.from(c.querySelectorAll('a[href], button, input:not([type=hidden]), select, textarea, [role], h1, h2, h3, h4, h5, h6, label')).slice(0, 300)) {
      if (seen.has(el) || (summary && summary.contains(el)) || (el as any).checkVisibility?.() !== false)
        continue;
      seen.add(el);
      const role = plainRole(el);
      const name = plainName(el);
      if (!name)
        continue;
      const extra = [(el as HTMLInputElement).placeholder, el.getAttribute('href')].filter(Boolean).join(' ');
      const s = score(`${name} ${extra}`.toLowerCase(), role, '', name, false);
      if (s > 0)
        out.push({ score: s, node: { role, name }, hidden: c });
    }
  }
  return out;
}

export function findElements(query: string) {
  const root = document.body || document.documentElement;
  const snapshot = generateAriaTree(root, { mode: 'ai', refPrefix });
  remember(snapshot);
  const { json } = renderAriaTreeAsJSON(snapshot, { mode: 'ai', refPrefix });
  const scoreOf = scorer(query);
  const scored: { score: number; node: any; hidden?: Element }[] = [];

  const textOf = (n: any): string => {
    if (typeof n === 'string')
      return n;
    let s = n.name || '';
    if (n.text)
      s += ' ' + n.text;
    if (n.children)
      for (const c of n.children) s += ' ' + textOf(c);
    return s;
  };

  const walk = (nodes: any[], ancestorsText: string) => {
    for (const n of nodes) {
      if (typeof n === 'string')
        continue;
      const own = [n.name, n.text, n.placeholder, n.url].filter(Boolean).join(' ');
      const isContainer = CONTAINER_ROLES.has(n.role);
      if (n.ref && !(isContainer && !isInteractiveNode(n) && n.children?.some((c: any) => typeof c !== 'string'))) {
        const directText = (n.children || []).filter((c: any) => typeof c === 'string').join(' ');
        const hay = (own + ' ' + (n.name ? '' : (isContainer ? directText : textOf(n)))).toLowerCase();
        const score = scoreOf(hay, n.role, ancestorsText, String(n.name || n.text || ''), isContainer && !isInteractiveNode(n));
        if (score > 0)
          scored.push({ score, node: n });
      }
      if (n.children)
        walk(n.children, (ancestorsText + ' ' + (n.role === 'generic' ? '' : (n.name || ''))).toLowerCase().slice(-300));
    }
  };
  walk(json, '');
  scored.push(...hiddenMatches(scoreOf));
  scored.sort((a, b) => b.score - a.score);
  const best = scored.length ? scored[0].score : 0;
  const top = scored.filter(s => s.score >= Math.max(1, best * 0.5)).slice(0, 20);

  const items = top.map(({ node, hidden }) => {
    const name = node.name ? ` ${JSON.stringify(String(node.name))}` : (node.text ? ` ${JSON.stringify(String(node.text).slice(0, 80))}` : '');
    if (hidden)
      return { line: `- ${node.role}${name} (hidden: inside a collapsed section${expanderText(hidden)})`, center: null };
    const el = refMap.get(node.ref)?.deref();
    let center: { x: number; y: number; inView: boolean } | null = null;
    let note = '';
    if (el) {
      const r = el.getBoundingClientRect();
      const inView = r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
      center = { x: r.left + r.width / 2, y: r.top + r.height / 2, inView };
      note = collapsedNote(el);
    }
    const extra = [node.placeholder ? `placeholder=${JSON.stringify(String(node.placeholder))}` : '', node.url ? `url=${JSON.stringify(String(node.url))}` : '', node.checked ? '[checked]' : '', node.disabled ? '[disabled]' : ''].filter(Boolean).join(' ');
    return { line: `- ${node.role}${name} [ref=${node.ref}]${extra ? ' ' + extra : ''}`, center, ...(note ? { note } : {}) };
  });
  return { items, total: scored.length };
}
