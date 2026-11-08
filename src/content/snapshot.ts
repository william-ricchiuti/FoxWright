// Page outline ("read_page") and element search ("find") for Kitsune.
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

function remember(snapshot: ReturnType<typeof generateAriaTree>) {
  for (const [el, ref] of snapshot.refs)
    refMap.set(ref, new WeakRef(el));
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

export function findElements(query: string) {
  const root = document.body || document.documentElement;
  const snapshot = generateAriaTree(root, { mode: 'ai', refPrefix });
  remember(snapshot);
  const { json } = renderAriaTreeAsJSON(snapshot, { mode: 'ai', refPrefix });
  const q = tokens(query);
  const qFull = query.toLowerCase().trim();
  const scored: { score: number; node: any }[] = [];

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
        const hayTokens = new Set(tokens(hay));
        const roleWords = new Set([n.role, ...(ROLE_SYNONYMS[n.role] || [])]);
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
        const nm = String(n.name || n.text || '').toLowerCase().trim();
        if (qFull && nm === qFull)
          score += 6; // exact name match beats everything
        else if (nm.length > 80)
          score *= 0.7; // long text blobs are rarely what's wanted
        if (isContainer && !isInteractiveNode(n))
          score *= 0.5;
        if (score > 0)
          scored.push({ score, node: n });
      }
      if (n.children)
        walk(n.children, (ancestorsText + ' ' + (n.role === 'generic' ? '' : (n.name || ''))).toLowerCase().slice(-300));
    }
  };
  walk(json, '');
  scored.sort((a, b) => b.score - a.score);
  const best = scored.length ? scored[0].score : 0;
  const top = scored.filter(s => s.score >= Math.max(1, best * 0.5)).slice(0, 20);

  const items = top.map(({ node }) => {
    const el = refMap.get(node.ref)?.deref();
    let center: { x: number; y: number; inView: boolean } | null = null;
    if (el) {
      const r = el.getBoundingClientRect();
      const inView = r.bottom > 0 && r.right > 0 && r.top < innerHeight && r.left < innerWidth;
      center = { x: r.left + r.width / 2, y: r.top + r.height / 2, inView };
    }
    const name = node.name ? ` ${JSON.stringify(String(node.name))}` : (node.text ? ` ${JSON.stringify(String(node.text).slice(0, 80))}` : '');
    const extra = [node.placeholder ? `placeholder=${JSON.stringify(String(node.placeholder))}` : '', node.url ? `url=${JSON.stringify(String(node.url))}` : '', node.checked ? '[checked]' : '', node.disabled ? '[disabled]' : ''].filter(Boolean).join(' ');
    return { line: `- ${node.role}${name} [ref=${node.ref}]${extra ? ' ' + extra : ''}`, center };
  });
  return { items, total: scored.length };
}
