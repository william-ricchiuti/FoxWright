// Tool implementations. Tool names and arguments mirror Claude in Chrome's so
// agents (and skills written for Chrome) work unchanged.
/* global browser */
import { state, publicStatus } from './state.js';
import { groupTabs, ensureGroup, createAgentTab, requireTab, ensurePermission, ensureOriginPermission, ensureFramePermission, isFrameAllowed, frameOriginOf, isAllowed, originOf, ensureContent, sendContent, frameForRef, frameIdFromPrefix, frameOrigin, showActivity, checkAccessible, addToGroup, injectPageHooks } from './tabs.js';
import { askUser } from './prompt.js';
import { netLog } from './netlog.js';

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- screenshot geometry ----------
// Screenshots are sized so Claude's vision model doesn't downscale them again
// (long edge <= 1568 px, <= ~1.15 megapixels). Coordinates the agent passes are in
// that screenshot's pixel grid; we convert them to CSS pixels with the same scale.
function scaleFor(w, h) {
  return Math.min(1, 1568 / Math.max(w, h), Math.sqrt(1150000 / (w * h)));
}

async function viewportOf(tab) {
  try {
    if (checkAccessible(tab) === 'ok') {
      await ensureContent(tab.id, 0);
      return await sendContent(tab.id, 0, 'viewport');
    }
  } catch { /* fall back to tab size */ }
  return { width: tab.width || 1280, height: tab.height || 800, dpr: 1 };
}

async function toCss(tab, coord) {
  const vp = await viewportOf(tab);
  const s = scaleFor(vp.width, vp.height);
  return { x: coord[0] / s, y: coord[1] / s, scale: s, vp };
}

async function capture(tab, opts) {
  try {
    return await browser.tabs.captureTab(tab.id, opts);
  } catch (e) {
    if (/Missing host permission/i.test(String(e?.message)))
      throw new Error(`Can't screenshot tab ${tab.id}: it is showing a Firefox error or internal page${tab.title ? ` ("${tab.title}")` : ''}.`);
    // Background tabs that Firefox hasn't rendered can't be captured; bring it forward.
    await browser.tabs.update(tab.id, { active: true });
    await sleep(250);
    return browser.tabs.captureTab(tab.id, opts);
  }
}

async function screenshot(tab) {
  const vp = await viewportOf(tab);
  const s = scaleFor(vp.width, vp.height);
  const dataUrl = await capture(tab, { format: 'jpeg', quality: 80, scale: s });
  const w = Math.round(vp.width * s), h = Math.round(vp.height * s);
  return {
    content: [
      { type: 'text', text: `Screenshot of tab ${tab.id} (${w}x${h}). Use coordinates in this image's pixel grid for clicks.` },
      { type: 'image', data: dataUrl.split(',')[1], mimeType: 'image/jpeg' },
    ],
  };
}

async function zoom(tab, region, scaleArg) {
  if (!Array.isArray(region) || region.length !== 4)
    throw new Error('zoom requires region: [x0, y0, x1, y1] in screenshot coordinates.');
  const vp = await viewportOf(tab);
  const s = scaleFor(vp.width, vp.height);
  const [x0, y0, x1, y1] = region.map(v => v / s);
  // captureTab's rect is relative to the document, not the viewport.
  const rect = { x: Math.min(x0, x1) + (vp.scrollX || 0), y: Math.min(y0, y1) + (vp.scrollY || 0), width: Math.abs(x1 - x0), height: Math.abs(y1 - y0) };
  if (rect.width < 1 || rect.height < 1)
    throw new Error('zoom region is empty.');
  const target = 1024 * (typeof scaleArg === 'number' ? Math.max(0.1, Math.min(1, scaleArg)) : 1);
  const z = Math.min((vp.dpr || 1) * 2, target / Math.max(rect.width, rect.height));
  const dataUrl = await capture(tab, { format: 'png', rect, scale: z });
  return {
    content: [
      { type: 'text', text: `Zoomed view of region (${region.join(', ')}). Keep using full-screenshot coordinates for clicks.` },
      { type: 'image', data: dataUrl.split(',')[1], mimeType: 'image/png' },
    ],
  };
}

// ---------- helpers ----------

function fmtResult(verb, r) {
  const lines = [];
  if (verb)
    lines.push(verb + (r?.target ? ` ${r.target}` : '') + '.');
  if (r?.value !== undefined)
    lines.push(`Value now: ${JSON.stringify(r.value)}`);
  if (r?.checked !== undefined)
    lines.push(`Checked: ${r.checked}`);
  if (r?.focused && !verb?.startsWith('Typed'))
    lines.push(`Focused: ${r.focused}`);
  for (const n of r?.notes || [])
    lines.push(n);
  return lines.join('\n');
}

// ---------- navigation tracking (event-driven) ----------
// Top-frame navigation milestones per tab, from webNavigation events. Waiting on these instead of
// polling tab.status returns as soon as the page is usable, and doesn't sleep on pages that never navigate.
const navState = new Map(); // tabId -> { start, commit, dcl, done, error, url } (timestamps)
const navWaiters = new Set(); // { tabId, check, resolve }

function navEvent(kind) {
  return (d) => {
    // A new tab's initial about:blank load can report its events after we start waiting for the
    // real page; it never counts as the navigation being waited for.
    if (d.frameId !== 0 || /^about:blank/.test(d.url || ''))
      return;
    const s = navState.get(d.tabId) || {};
    s[kind] = Date.now();
    if (kind === 'commit')
      s.url = d.url;
    navState.set(d.tabId, s);
    for (const w of [...navWaiters]) {
      if (w.tabId === d.tabId && w.check(s)) {
        navWaiters.delete(w);
        w.resolve(true);
      }
    }
  };
}
browser.webNavigation.onBeforeNavigate.addListener(navEvent('start'));
browser.webNavigation.onCommitted.addListener(navEvent('commit'));
browser.webNavigation.onDOMContentLoaded.addListener(navEvent('dcl'));
browser.webNavigation.onCompleted.addListener(navEvent('done'));
browser.webNavigation.onErrorOccurred.addListener(navEvent('error'));
browser.tabs.onRemoved.addListener((tabId) => navState.delete(tabId));

/** Resolve true as soon as check(navState) holds for the tab, or false after ms. */
function waitNav(tabId, check, ms) {
  if (check(navState.get(tabId) || {}))
    return Promise.resolve(true);
  return new Promise((resolve) => {
    const w = { tabId, check, resolve };
    navWaiters.add(w);
    setTimeout(() => {
      if (navWaiters.delete(w))
        resolve(false);
    }, Math.max(0, ms));
  });
}

/**
 * Wait until a page that started loading at or after `since` is usable: its DOM is parsed, plus up
 * to 1 s for the full load (images, ads and trackers can hold "load" back for many seconds).
 * Falls back to tab.status for loads without navigation events (e.g. the back/forward cache).
 */
async function waitForLoad(tabId, timeoutMs = 30000, since = Date.now() - 50) {
  const deadline = Date.now() + timeoutMs;
  const began = (s) => (s.start || 0) >= since;
  const parsed = (s) => began(s) && ((s.dcl || 0) >= s.start || (s.done || 0) >= s.start || (s.error || 0) >= s.start);
  const loaded = (s) => began(s) && ((s.done || 0) >= s.start || (s.error || 0) >= s.start);
  while (Date.now() < deadline) {
    if (await waitNav(tabId, parsed, Math.min(500, deadline - Date.now()))) {
      // An aborted load (NS_BINDING_ABORTED) is often immediately replaced by another one, e.g. when
      // a brand-new tab's own startup load collides with ours. Keep waiting if a new one begins.
      const s = navState.get(tabId) || {};
      const failed = (s.error || 0) >= s.start && !((s.dcl || 0) >= s.start);
      // (Or the error belonged to an earlier load and the current one is still going.)
      if (!failed || !(await waitNav(tabId, (x) => (x.start || 0) > s.error || (x.dcl || 0) >= x.start, 500)))
        break;
      continue;
    }
    const t = await browser.tabs.get(tabId);
    if (t.status === 'complete' && Date.now() - since > 500 && !began(navState.get(tabId) || {}))
      return t;
  }
  await waitNav(tabId, loaded, Math.min(1000, Math.max(0, deadline - Date.now())));
  // tabs.get() can lag behind webNavigation events: wait until it shows the committed URL.
  const committed = navState.get(tabId) || {};
  let t = await browser.tabs.get(tabId);
  for (let i = 0; i < 120 && committed.url && began(committed) && t.url !== committed.url; i++) {
    await sleep(25);
    t = await browser.tabs.get(tabId);
  }
  return t;
}

async function dialogNotes(tabId) {
  try {
    const list = await sendContent(tabId, 0, 'dialogs', {}, 3000);
    return list.map(d => `The page opened a JavaScript ${d.type}(${JSON.stringify(d.message)}); Kitsune answered: ${d.answer}.${d.type === 'confirm' && d.answer === 'Cancel' ? ' To answer OK instead, call handle_dialog {accept: true} and repeat the action.' : ''}`);
  } catch {
    return [];
  }
}

async function afterAction(tab, before, r) {
  const extra = [];
  const t0 = before.t0 || Date.now() - 50;
  const started = (s) => (s.start || 0) >= t0;
  // Navigations an action starts (link clicks, form submits, script redirects) begin asynchronously.
  // Wait for one only as long as this action could plausibly have started it.
  const budget = r?.mayNavigate === 'likely' ? 400 : r?.mayNavigate === false ? 0 : 100;
  await waitNav(tab.id, started, budget);
  if (r?.openUrl) {
    // The URL comes from the page's link: same checks as navigate (http(s) only, approved site).
    try {
      const url = normalizeUrl(r.openUrl);
      await ensureOriginPermission(url);
      const nt = await createAgentTab(url, false);
      extra.push(`The link opens in a new tab: created tab ${nt.id} (${url}) in the Kitsune group.`);
    } catch (e) {
      extra.push(`The link wanted to open ${String(r.openUrl).slice(0, 200)} in a new tab, but Kitsune didn't: ${e.message}`);
    }
  }
  const navigated = started(navState.get(tab.id) || {});
  const now = await browser.tabs.get(tab.id);
  if (now.url === before.url && now.status !== 'loading' && !navigated)
    extra.push(...await dialogNotes(tab.id));
  if (now.url !== before.url || now.status === 'loading' || navigated) {
    const done = await waitForLoad(tab.id, 15000, t0);
    const o = originOf(done.url);
    if (o && !isAllowed(o))
      extra.push(`The page navigated to ${o}, a site the user hasn't approved yet; the next tool call on it will ask them.`);
    else
      extra.push(`The page navigated to ${done.url}${done.title ? ` ("${done.title}")` : ''}.`);
  }
  return extra;
}

function normalizeUrl(url) {
  const u = url.trim();
  if (/^about:blank$/i.test(u))
    return 'about:blank';
  const scheme = /^([a-z][a-z0-9+.-]*):\/\//i.exec(u);
  if (scheme) {
    if (!/^https?$/i.test(scheme[1]))
      throw new Error(`Kitsune only navigates to http(s) pages (not ${scheme[1]}:).`);
    return u;
  }
  if (/^(javascript|data|file|about|moz-extension|chrome|resource|view-source|blob):/i.test(u))
    throw new Error(`Kitsune won't navigate to ${u.split(':')[0]}: URLs.`);
  // "localhost:3000", "127.0.0.1:8080/x", "example.com/path"
  const host = u.split(/[/?#]/)[0].replace(/:\d+$/, '');
  const local = host === 'localhost' || /^127\.|^\[?::1\]?$|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|\.local$|\.localhost$/.test(host);
  return (local ? 'http://' : 'https://') + u;
}

async function tabForPageTool(args) {
  const tab = await requireTab(args.tabId);
  await ensurePermission(tab);
  if (checkAccessible(tab) === 'blank')
    return tab;
  await ensureContent(tab.id, 0);
  showActivity(tab.id);
  return tab;
}

function indentBlock(textBlock, indent) {
  return textBlock.split('\n').map(l => ' '.repeat(indent) + l).join('\n');
}

/**
 * Splice the outlines of child frames under their <iframe> lines. Frames are fetched in parallel
 * (each with its own timeout), then inserted in one pass over the parent's lines.
 */
async function stitchFrames(tabId, res, args, depthLeft) {
  const yaml = res.yaml;
  const frames = (res.iframes || []).filter(f => f.frameId >= 0);
  if (depthLeft <= 0 || !frames.length)
    return yaml;
  const inserts = new Map(); // ref -> text to insert under it
  await Promise.all(frames.map(async ({ ref, frameId }) => {
    if (!(await isFrameAllowed(tabId, frameId))) {
      const o = await frameOriginOf(tabId, frameId).catch(() => null);
      inserts.set(ref, `- note: embedded content from ${o || 'another site'} is hidden until the user approves it (read_page with ref_id ${ref} asks them)`);
      return;
    }
    try {
      await ensureContent(tabId, frameId);
      const child = await sendContent(tabId, frameId, 'snapshot', { filter: args.filter, depth: args.depth, visible_only: args.visible_only }, 10000);
      inserts.set(ref, await stitchFrames(tabId, child, args, depthLeft - 1));
    } catch { /* cross-origin frame we can't reach, or it navigated away */ }
  }));
  if (!inserts.size)
    return yaml;
  const out = [];
  for (const line of yaml.split('\n')) {
    const m = /\[ref=([^\]]+)\]/.exec(line);
    const add = m ? inserts.get(m[1]) : undefined;
    if (!add) {
      out.push(line);
      continue;
    }
    const indent = line.match(/^\s*/)[0].length;
    out.push(line.trimEnd().endsWith(':') ? line : line.trimEnd() + ':');
    out.push(indentBlock(add, indent + 2));
  }
  return out.join('\n');
}

function truncateLines(s, max) {
  if (s.length <= max)
    return s;
  const cut = s.lastIndexOf('\n', max);
  const kept = s.slice(0, cut > 0 ? cut : max);
  return `${kept}\n… [truncated: output is ${s.length} chars, showing ${kept.length}. Use visible_only: true for just what's on screen, ref_id for one part of the page, filter: "interactive", a smaller depth, or a larger max_chars.]`;
}

// ---------- JavaScript tool (full build only) ----------

function runUserCode(code, expectOrigin) {
  // Runs in the page's MAIN world. Page CSP may forbid eval; we report that clearly.
  // Refuse if the tab navigated to another site since the permission check.
  if (expectOrigin && location.origin !== expectOrigin)
    return Promise.resolve({ ok: false, error: `The tab is now showing ${location.origin}, not ${expectOrigin} (it navigated). Call the tool again.` });
  const AsyncFunction = (async () => {}).constructor;
  const ser = (v) => {
    if (v === undefined)
      return 'undefined';
    if (typeof v === 'function')
      return v.toString().slice(0, 2000);
    if (v instanceof Element)
      return v.outerHTML.length > 5000 ? v.outerHTML.slice(0, 5000) + '…' : v.outerHTML;
    if (v instanceof NodeList || v instanceof HTMLCollection)
      return JSON.stringify(Array.from(v).map(n => n.outerHTML ? n.outerHTML.slice(0, 300) : String(n)), null, 2);
    try {
      const s = JSON.stringify(v, null, 2);
      return s === undefined ? String(v) : s;
    } catch {
      return String(v);
    }
  };
  // REPL semantics: return the value of the last top-level statement if it's an expression.
  const lastTopLevelSplit = (src) => {
    let depth = 0, quote = null, last = -1;
    for (let i = 0; i < src.length; i++) {
      const ch = src[i];
      if (quote) {
        if (ch === '\\') i++;
        else if (ch === quote) quote = null;
        continue;
      }
      if (ch === '"' || ch === "'" || ch === '`') quote = ch;
      else if (ch === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); if (nl < 0) break; i = nl; if (depth === 0) last = i; }
      else if ('([{'.includes(ch)) depth++;
      else if (')]}'.includes(ch)) { depth--; if (depth === 0 && ch === '}') last = i; }
      else if ((ch === ';' || ch === '\n') && depth === 0) last = i;
    }
    return last;
  };
  const attempts = [];
  const trimmed = code.trim().replace(/;+\s*$/, '');
  attempts.push(`return (${trimmed}\n);`);
  const cut = lastTopLevelSplit(trimmed);
  if (cut > 0 && trimmed.slice(cut + 1).trim())
    attempts.push(`${trimmed.slice(0, cut + 1)}\nreturn (${trimmed.slice(cut + 1)}\n);`);
  attempts.push(code);
  let fn = null, lastErr = null;
  for (const body of attempts) {
    try {
      fn = new AsyncFunction(body);
      break;
    } catch (e) {
      lastErr = e;
      if (!(e instanceof SyntaxError))
        break;
    }
  }
  if (!fn)
    return Promise.resolve({ ok: false, error: String(lastErr) + (/Content Security Policy|call to Function\(\)|eval/i.test(String(lastErr)) ? '\nThis page\'s Content-Security-Policy forbids evaluating code strings, so javascript_tool cannot run here. Use read_page / get_page_text / computer instead.' : '') });
  return Promise.resolve().then(() => fn()).then(v => ({ ok: true, value: ser(v) }), e => ({ ok: false, error: e && typeof e === 'object' && 'message' in e ? `${e.name || 'Error'}: ${e.message}${e.stack ? '\n' + String(e.stack).split('\n').slice(0, 3).join('\n') : ''}`.slice(0, 3000) : String(e) }));
}

// ---------- tools ----------

export const tools = {
  async tabs_context_mcp(args) {
    const tabs = await ensureGroup(!!args.createIfEmpty);
    if (!tabs.length)
      return text('The Kitsune tab group is empty. Call tabs_context_mcp with createIfEmpty: true, or tabs_create_mcp, to get a tab.');
    const lines = tabs.map(t => `- tabId ${t.id}: ${JSON.stringify(t.title || '')} ${t.url}${t.active ? ' (active in its window)' : ''}`);
    return text(`Kitsune tab group (${tabs.length} tab${tabs.length > 1 ? 's' : ''}):\n${lines.join('\n')}\n\nOnly tabs in this group can be used. The user can share an existing tab by dragging it into the orange "Kitsune" group.`);
  },

  async tabs_create_mcp() {
    const tab = await createAgentTab('about:blank', true);
    return text(`Created tab ${tab.id} in the Kitsune group.`);
  },

  async tabs_close_mcp(args) {
    const tab = await requireTab(args.tabId);
    await browser.tabs.remove(tab.id);
    await groupTabs();
    return text(`Closed tab ${tab.id}.`);
  },

  async navigate(args) {
    let tabId = args.tabId;
    let prefix = '';
    if (typeof tabId !== 'number') {
      if (args.url === 'back' || args.url === 'forward')
        throw new Error('tabId is required for back/forward.');
      const tabs = await ensureGroup(true);
      tabId = tabs[0].id;
      prefix = `(Using tab ${tabId} from the Kitsune group.)\n`;
    }
    const tab = await requireTab(tabId);
    const navSince = Date.now();
    if (args.url === 'back') {
      await browser.tabs.goBack(tab.id);
    } else if (args.url === 'forward') {
      await browser.tabs.goForward(tab.id);
    } else {
      const url = normalizeUrl(args.url);
      await ensureOriginPermission(url); // ask before sending the user's cookies anywhere new (no tab title: it's the page being left, not the site asked about)
      await browser.tabs.update(tab.id, { url });
    }
    const done = await waitForLoad(tab.id, 30000, navSince);
    const all = await groupTabs();
    const ctx = all.length > 1 ? `\nTabs in group: ${all.map(t => t.id).join(', ')}` : '';
    const o = originOf(done.url);
    if (o && !isAllowed(o))
      return text(`${prefix}Tab ${tab.id} ended up on ${o} (redirect or history), which the user hasn't approved yet. The next tool call on this tab will ask them.${ctx}`);
    // Firefox error pages ("Problem loading page", certificate warnings) keep the requested URL.
    if (o) {
      try {
        await ensureContent(tab.id, 0);
      } catch (e) {
        throw new Error(`${prefix}Navigation to ${done.url} failed: ${String(e.message).replace(/^Tab \d+ is showing/, 'Firefox is showing')}`);
      }
    }
    showActivity(tab.id);
    return text(`${prefix}Navigated tab ${tab.id} to ${done.url}\nTitle: ${done.title || '(none)'}${done.status !== 'complete' ? '\n(The page is still loading.)' : ''}${ctx}`);
  },

  async read_page(args) {
    const tab = await tabForPageTool(args);
    if (checkAccessible(tab) === 'blank')
      return text(`Tab ${tab.id} is blank (${tab.url || 'about:blank'}). Navigate somewhere first.`);
    const frameId = args.ref_id ? frameForRef(tab.id, args.ref_id) : 0;
    if (frameId !== 0)
      await ensureContent(tab.id, frameId);
    let res = await sendContent(tab.id, frameId, 'snapshot', { filter: args.filter, depth: args.depth, ref_id: args.ref_id, visible_only: args.visible_only });
    if (res && res.frameRedirect !== undefined) {
      // ref_id pointed at an <iframe>: show that frame's document (asking for its site if needed).
      if (res.frameRedirect < 0)
        throw new Error(`Can't read inside ${args.ref_id}; the frame is not accessible.`);
      await ensureFramePermission(tab, res.frameRedirect);
      await ensureContent(tab.id, res.frameRedirect);
      res = await sendContent(tab.id, res.frameRedirect, 'snapshot', { filter: args.filter, depth: args.depth });
    }
    const yaml = await stitchFrames(tab.id, res, args, 3);
    const vp = res.viewport;
    const header = `Page: ${res.title || '(untitled)'}\nURL: ${res.url}\nViewport: ${vp.width}x${vp.height} CSS px, scrolled to y=${vp.scrollY} of ${vp.scrollHeight}\n`;
    const body = args.ref_id ? `Subtree of ${args.ref_id}:\n${yaml}` : yaml;
    return text(truncateLines(header + body, args.max_chars || 20000));
  },

  async find(args) {
    const tab = await tabForPageTool(args);
    if (!args.query)
      throw new Error('query is required.');
    const top = await sendContent(tab.id, 0, 'find', { query: args.query });
    const vp = top.viewport || await viewportOf(tab);
    const s = scaleFor(vp.width, vp.height);
    const lines = top.items.map(i => i.line + (i.center ? ` at (${Math.round(i.center.x * s)}, ${Math.round(i.center.y * s)})${i.center.inView ? '' : ' (off-screen)'}` : ''));
    let total = top.total;
    try {
      // Search approved frames in parallel; keep results in frame order.
      const frames = ((await browser.webNavigation.getAllFrames({ tabId: tab.id })) || []).filter(f => f.frameId !== 0);
      const perFrame = await Promise.all(frames.map(async (f) => {
        try {
          if (!(await isFrameAllowed(tab.id, f.frameId)))
            return null;
          await ensureContent(tab.id, f.frameId);
          const r = await sendContent(tab.id, f.frameId, 'find', { query: args.query }, 5000);
          const o = r.items.length ? await frameOrigin(tab.id, f.frameId).catch(() => null) : null;
          return { r, o };
        } catch {
          return null; // unreachable frame
        }
      }));
      for (const x of perFrame) {
        if (!x)
          continue;
        total += x.r.total;
        for (const i of x.r.items) {
          if (lines.length >= 20)
            break;
          const where = x.o && i.center ? ` at (${Math.round((i.center.x + x.o.x) * s)}, ${Math.round((i.center.y + x.o.y) * s)})${i.center.inView ? '' : ' (off-screen)'}` : '';
          lines.push(i.line + where + ' (inside an iframe)');
        }
      }
    } catch { /* ignore */ }
    if (!lines.length)
      return text(`No elements matched "${args.query}". Try read_page (filter: "interactive") or a screenshot.`);
    return text(`${lines.length} match${lines.length > 1 ? 'es' : ''} for "${args.query}"${total > lines.length ? ` (of ${total} candidates; be more specific to narrow)` : ''}:\n${lines.join('\n')}`);
  },

  async form_input(args) {
    const tab = await tabForPageTool(args);
    const frameId = frameForRef(tab.id, args.ref);
    const r = await sendContent(tab.id, frameId, 'formInput', { ref: args.ref, value: args.value });
    return text([fmtResult('Set', r), ...await dialogNotes(tab.id)].join('\n'));
  },

  async get_page_text(args) {
    let tab;
    try {
      tab = await tabForPageTool(args);
    } catch (e) {
      if (!e.jsonViewer)
        throw e;
      // Firefox's JSON viewer hides the document from extensions; fetch the JSON again (GET).
      const t = await browser.tabs.get(args.tabId);
      const r = await fetch(t.url, { credentials: 'include' });
      let body = await r.text();
      try {
        body = JSON.stringify(JSON.parse(body), null, 2);
      } catch { /* not JSON after all */ }
      return text(`URL: ${t.url}\n(Shown in Firefox's JSON viewer, which extensions can't read, so Kitsune fetched the URL again with a GET request; status ${r.status}.)\n\n${body.length > 100000 ? body.slice(0, 100000) + '\n… [truncated]' : body}`);
    }
    if (checkAccessible(tab) === 'blank')
      return text(`Tab ${tab.id} is blank.`);
    const r = await sendContent(tab.id, 0, 'pageText', { maxChars: 1000000 });
    const max = Math.max(1000, Math.min(100000, Number(args.max_chars) || 20000));
    const head = `Title: ${r.title}\nURL: ${r.url}\nSource: ${r.source}`;
    const full = r.text;
    if (args.query) {
      // Return only the passages that mention the query words (cheap way to answer a question about a long page).
      const words = String(args.query).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 2);
      const paras = full.split(/\n+/).map(p => p.trim()).filter(Boolean);
      const scored = paras.map((p, i) => ({ i, p, s: words.reduce((n, w) => n + (p.toLowerCase().includes(w) ? 1 : 0), 0) })).filter(x => x.s > 0);
      scored.sort((a, b) => b.s - a.s || a.i - b.i);
      const picked = new Set();
      for (const x of scored.slice(0, 12))
        for (const j of [x.i - 1, x.i, x.i + 1])
          if (j >= 0 && j < paras.length)
            picked.add(j);
      let out = [...picked].sort((a, b) => a - b).map(j => paras[j]).join('\n');
      if (out.length > max)
        out = out.slice(0, max) + '…';
      return text(`${head}\nPassages matching "${args.query}" (${scored.length} matching paragraphs of ${paras.length}):\n\n${out || '(no matches; try other words or read the page without a query)'}`);
    }
    const offset = Math.max(0, Number(args.offset) || 0);
    const chunk = full.slice(offset, offset + max);
    const more = offset + max < full.length;
    return text(`${head}\n${offset || more ? `Showing characters ${offset}–${offset + chunk.length} of ${full.length}.${more ? ` Call again with offset: ${offset + chunk.length} for more, or pass query to get just the relevant passages.` : ''}\n` : ''}\n${chunk}`);
  },

  async computer(args) {
    const action = args.action;
    const tab = await requireTab(args.tabId);
    if (action === 'wait') {
      const secs = Math.max(0, Math.min(10, Number(args.duration ?? 1)));
      await sleep(secs * 1000);
      return text(`Waited ${secs}s.`);
    }
    await ensurePermission(tab);
    const blank = checkAccessible(tab) === 'blank';
    if (!blank) {
      await ensureContent(tab.id, 0);
      showActivity(tab.id);
    }
    if (action === 'screenshot')
      return screenshot(tab);
    if (action === 'zoom')
      return zoom(tab, args.region, args.scale);
    if (blank)
      throw new Error(`Tab ${tab.id} is blank; navigate to a page first.`);

    const before = { ...(await browser.tabs.get(tab.id)), t0: Date.now() };
    const refFrame = args.ref ? frameForRef(tab.id, args.ref) : 0;
    let pt = null;
    if (Array.isArray(args.coordinate))
      pt = await toCss(tab, args.coordinate);

    let r, verb;
    switch (action) {
      case 'left_click':
      case 'right_click':
      case 'double_click':
      case 'triple_click': {
        if (!pt && !args.ref)
          throw new Error(`${action} needs coordinate or ref.`);
        const button = action === 'right_click' ? 'right' : 'left';
        const clickCount = action === 'double_click' ? 2 : action === 'triple_click' ? 3 : 1;
        r = await sendContent(tab.id, refFrame, 'click', { ref: args.ref, x: pt?.x, y: pt?.y, button, clickCount, modifiers: args.modifiers });
        verb = { left_click: 'Clicked', right_click: 'Right-clicked', double_click: 'Double-clicked', triple_click: 'Triple-clicked' }[action];
        break;
      }
      case 'hover':
        if (!pt && !args.ref)
          throw new Error('hover needs coordinate or ref.');
        r = await sendContent(tab.id, refFrame, 'hover', { ref: args.ref, x: pt?.x, y: pt?.y });
        verb = 'Hovered';
        break;
      case 'type':
        if (typeof args.text !== 'string')
          throw new Error('type needs text.');
        r = await sendContent(tab.id, 0, 'type', { text: args.text });
        verb = `Typed ${args.text.length} character${args.text.length === 1 ? '' : 's'} into`;
        r.target = r.focused;
        break;
      case 'key':
        if (typeof args.text !== 'string')
          throw new Error('key needs text, e.g. "Enter" or "ctrl+a".');
        if (/^(cmd|ctrl|meta)\+(=|-|\+|0)$/i.test(args.text.trim()))
          throw new Error('Page zoom shortcuts are not supported; use the zoom action to magnify a region instead.');
        r = await sendContent(tab.id, 0, 'key', { text: args.text, repeat: args.repeat });
        verb = `Pressed ${args.text}${args.repeat > 1 ? ` x${args.repeat}` : ''}; focus on`;
        r.target = r.focused;
        break;
      case 'scroll':
        r = await sendContent(tab.id, refFrame, 'scroll', { ref: args.ref, x: pt?.x, y: pt?.y, direction: args.scroll_direction || 'down', amount: args.scroll_amount });
        verb = `Scrolled ${args.scroll_direction || 'down'}`;
        r.notes = [`Position: x=${r.scrollX}, y=${r.scrollY} (content height ${r.scrollHeight}, visible ${r.viewportHeight}) in ${r.target}.`, ...(r.notes || [])];
        r.target = undefined;
        break;
      case 'scroll_to':
        if (!args.ref)
          throw new Error('scroll_to needs ref.');
        r = await sendContent(tab.id, refFrame, 'scrollTo', { ref: args.ref });
        verb = 'Scrolled into view';
        break;
      case 'left_click_drag': {
        if (!Array.isArray(args.start_coordinate) || !pt)
          throw new Error('left_click_drag needs start_coordinate and coordinate.');
        const st = await toCss(tab, args.start_coordinate);
        r = await sendContent(tab.id, 0, 'drag', { startX: st.x, startY: st.y, x: pt.x, y: pt.y });
        verb = 'Dragged';
        r.target = `from ${r.from} to ${r.to}`;
        break;
      }
      default:
        throw new Error(`Unknown computer action "${action}".`);
    }
    const extra = await afterAction(tab, before, r);
    return text([fmtResult(verb, r), ...extra].filter(Boolean).join('\n'));
  },

  async javascript_tool(args) {
    // eslint-disable-next-line no-undef
    if (__KITSUNE_FULL__) {
      const tab = await tabForPageTool(args);
      if (typeof args.text !== 'string' || !args.text.trim())
        throw new Error('text (the JavaScript to run) is required.');
      const expectOrigin = await frameOriginOf(tab.id, 0).catch(() => null);
      if (expectOrigin && !isAllowed(expectOrigin))
        throw new Error(`Kitsune is not allowed to access ${expectOrigin}.`);
      const [res] = await browser.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, world: 'MAIN', func: runUserCode, args: [args.text, expectOrigin && /^https?:/.test(expectOrigin) ? expectOrigin : null] });
      if (res?.error)
        throw new Error(String(res.error.message || res.error));
      const out = res?.result;
      if (!out)
        return text('undefined');
      if (!out.ok)
        throw new Error(out.error);
      return text(out.value.length > 50000 ? out.value.slice(0, 50000) + '\n… [truncated]' : out.value);
    }
    throw new Error('javascript_tool is not available in the Firefox Add-ons store edition of Kitsune (Mozilla policy forbids running code strings from outside the add-on). Install the "Kitsune (Full)" build to enable it, or use read_page / find / get_page_text / computer instead.');
  },

  async read_console_messages(args) {
    const tab = await tabForPageTool(args);
    const hooked = await ensureConsoleHook(tab.id);
    const entries = await sendContent(tab.id, 0, 'console', { clear: !!args.clear });
    let list = entries;
    if (args.onlyErrors)
      list = list.filter(e => e.level === 'error' || e.level === 'exception');
    if (args.pattern) {
      let re;
      try {
        re = new RegExp(args.pattern, 'i');
      } catch {
        throw new Error(`Invalid pattern regex: ${args.pattern}`);
      }
      list = list.filter(e => re.test(e.text));
    }
    const limit = args.limit || 100;
    list = list.slice(-limit);
    const note = hooked !== 'existing' ? '\n(Console capture just started for this page; messages logged earlier are not available. Reload the page to capture everything.)' : '';
    if (!list.length)
      return text(`No console messages${args.pattern ? ` matching /${args.pattern}/` : ''}.${note}`);
    return text(list.map(e => `[${new Date(e.time).toISOString().slice(11, 23)}] ${e.level.toUpperCase()}: ${e.text}`).join('\n') + note);
  },

  async handle_dialog(args) {
    const tab = await tabForPageTool(args);
    await sendContent(tab.id, 0, 'dialogPolicy', { accept: !!args.accept, text: args.prompt_text });
    return text(`The next JavaScript dialog in tab ${tab.id} will be answered ${args.accept ? `OK${args.prompt_text !== undefined ? ` with ${JSON.stringify(args.prompt_text)}` : ''}` : 'Cancel'}. Now perform the action that opens it.`);
  },

  async read_network_requests(args) {
    const tab = await requireTab(args.tabId);
    await ensurePermission(tab);
    let list = netLog.get(tab.id) || [];
    if (args.urlPattern)
      list = list.filter(r => r.url.includes(args.urlPattern));
    const limit = args.limit || 100;
    const shown = list.slice(-limit);
    if (args.clear)
      netLog.set(tab.id, []);
    if (!shown.length)
      return text('No network requests recorded for this tab yet. Requests are recorded only while the tab is in the Kitsune group.');
    return text(shown.map(r => `${r.method} ${r.status ?? r.error ?? '…'} ${r.type} ${r.url}`).join('\n'));
  },

  async resize_window(args) {
    const tab = await requireTab(args.tabId);
    const width = Math.round(args.width), height = Math.round(args.height);
    if (!(width > 100 && height > 100))
      throw new Error('width and height must be positive pixel sizes.');
    const w = await browser.windows.update(tab.windowId, { width, height, state: 'normal' });
    return text(`Resized window to ${w.width}x${w.height}.`);
  },

  async file_upload(args) {
    const tab = await tabForPageTool(args);
    const frameId = args.ref ? frameForRef(tab.id, args.ref) : 0;
    let x, y;
    if (!args.ref && Array.isArray(args.coordinate)) {
      const p = await toCss(tab, args.coordinate);
      x = p.x;
      y = p.y;
    }
    if (!Array.isArray(args.files) || !args.files.length)
      throw new Error('No files to upload.');
    const origin = (await frameOriginOf(tab.id, frameId)) || originOf(tab.url) || tab.url;
    const names = args.files.map(f => `${f.name} (${Math.round((f.base64.length * 3) / 4 / 1024)} KB)`);
    const ok = state.confirmUploads ? await askUser({ type: 'upload', origin, tabTitle: tab.title, files: args.paths || names }) : 'once';
    if (ok !== 'once')
      throw new Error('The user did not approve uploading these files.');
    const r = await sendContent(tab.id, frameId, 'upload', { ref: args.ref, x, y, files: args.files });
    return text(`Attached ${r.files.join(', ')} to ${r.target}.${(r.notes || []).map(n => '\n' + n).join('')}`);
  },

  // ----- internal tools used by the MCP server's trusted-input (WebDriver BiDi) mode -----

  async _status() {
    const tabs = await groupTabs();
    return { data: { ...publicStatus(), groupTabIds: tabs.map(t => t.id) } };
  },

  async _point(args) {
    // Resolve a ref or screenshot coordinate to CSS pixels in the viewport of the frame it lands in.
    const tab = await tabForPageTool(args);
    let p = null;
    if (args.ref) {
      const frameId = frameForRef(tab.id, args.ref);
      p = await sendContent(tab.id, frameId, 'refPoint', { ref: args.ref });
    } else if (Array.isArray(args.coordinate)) {
      const c = await toCss(tab, args.coordinate);
      p = await sendContent(tab.id, 0, 'locate', { x: c.x, y: c.y });
    }
    if (!p)
      return { data: null };
    return { data: { x: p.x, y: p.y, target: p.target, draggable: !!p.draggable, frameId: frameIdFromPrefix(tab.id, p.prefix) } };
  },

  async _focus(args) {
    // Which frame has keyboard focus (so trusted key input can target its BiDi context).
    const tab = await tabForPageTool(args);
    if (checkAccessible(tab) === 'blank')
      return { data: { frameId: 0 } };
    const f = await sendContent(tab.id, 0, 'focusInfo', {});
    return { data: { frameId: frameIdFromPrefix(tab.id, f.prefix), target: f.target } };
  },

  async _mark(args) {
    // Tag a document so the BiDi side can find the matching browsing context.
    const tab = await requireTab(args.tabId);
    await ensurePermission(tab);
    await browser.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [args.frameId || 0] },
      func: (token) => { document.documentElement.setAttribute('data-kitsune-probe', token); },
      args: [String(args.token)],
    });
    return { data: true };
  },

  async _unmark(args) {
    await requireTab(args.tabId);
    try {
      await browser.scripting.executeScript({ target: { tabId: args.tabId, frameIds: [args.frameId || 0] }, func: () => { document.documentElement.removeAttribute('data-kitsune-probe'); } });
    } catch { /* ignore */ }
    return { data: true };
  },

  async _after(args) {
    // Called after a trusted action so the agent learns about navigation / new tabs.
    const tab = await requireTab(args.tabId);
    showActivity(tab.id);
    const extra = await afterAction(tab, { url: args.beforeUrl, t0: typeof args.t0 === 'number' ? args.t0 : undefined }, {});
    return { data: extra };
  },
};

export async function adoptOpenedTab(tabId) {
  // Tabs opened *by* an agent tab (e.g. target=_blank under trusted input) join the group.
  await addToGroup(tabId);
}

async function ensureConsoleHook(tabId) {
  try {
    const [r] = await browser.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: () => (globalThis.__kitsuneHooks ? (globalThis.__kitsuneHooks.early ? 'existing' : 'late') : '') });
    if (r?.result)
      return r.result;
  } catch { /* ignore */ }
  await injectPageHooks(tabId, 0);
  return 'new';
}


