// Tool implementations. Tool names and arguments mirror Claude in Chrome's so
// agents (and skills written for Chrome) work unchanged.
/* global browser */
import { state, publicStatus, cleanSummary } from './state.js';
import { groupTabs, ensureGroup, createAgentTab, requireTab, ensurePermission, ensureOriginPermission, ensureFramePermission, isFrameAllowed, frameOriginOf, isAllowed, originOf, ensureContent, sendContent, frameForRef, frameIdFromPrefix, frameOrigin, showActivity, checkAccessible, addToGroup, injectPageHooks, ensureFrameLevel, isReadingKeys, hostAccessRevoked, hostAccessError } from './tabs.js';
import { askUser, cancelPairPrompts } from './prompt.js';
import { netLog, docTypes } from './netlog.js';
import { extractPdfText, PdfError } from './pdftext.js';

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const sleep = (ms) => new Promise(r => setTimeout(r, ms));

// ---------- waiting for the page ----------

// fetch()/XHR requests the page has in flight, per tab (webRequest reports fetch as "xmlhttprequest").
// Used by computer {action: "wait", until: "idle"}.
const inflight = new Map(); // tabId -> Map(requestId -> start time)
const netActivity = new Map(); // tabId -> time a request last started or ended
const LONG_POLL_MS = 5000; // requests open longer than this (long polling, streams) don't block "idle"

function noteRequest(d, done) {
  if (d.tabId < 0 || !state.groupTabIds.has(d.tabId))
    return;
  let m = inflight.get(d.tabId);
  if (!m)
    inflight.set(d.tabId, (m = new Map()));
  if (done)
    m.delete(d.requestId);
  else
    m.set(d.requestId, Date.now());
  netActivity.set(d.tabId, Date.now());
}
try {
  const xhr = { urls: ['<all_urls>'], types: ['xmlhttprequest'] };
  browser.webRequest.onBeforeRequest.addListener(d => noteRequest(d, false), xhr);
  browser.webRequest.onCompleted.addListener(d => noteRequest(d, true), xhr);
  browser.webRequest.onErrorOccurred.addListener(d => noteRequest(d, true), xhr);
} catch { /* no webRequest: idle then means DOM-quiet only */ }
browser.tabs.onRemoved.addListener((tabId) => {
  inflight.delete(tabId);
  netActivity.delete(tabId);
});

/** Requests still open (ignoring long polls), and ms since the network was last active. */
function netState(tabId) {
  const now = Date.now();
  const open = [...(inflight.get(tabId) || new Map()).values()].filter(t => now - t < LONG_POLL_MS).length;
  return { open, quietMs: now - (netActivity.get(tabId) || 0) };
}

/** Seconds (default 5, max 30). Values over 100 are taken as milliseconds, a common slip. */
function waitTimeoutMs(v, dflt = 5) {
  let s = Number(v);
  if (!isFinite(s) || s < 0)
    s = dflt;
  if (s > 100)
    s /= 1000;
  return Math.round(Math.min(30, s) * 1000);
}

const ROLE_WORDS = new Set(['alert', 'alertdialog', 'button', 'cell', 'checkbox', 'columnheader', 'combobox', 'dialog', 'grid', 'gridcell', 'heading', 'img', 'link', 'list', 'listbox', 'listitem', 'menu', 'menubar', 'menuitem', 'menuitemcheckbox', 'menuitemradio', 'navigation', 'option', 'progressbar', 'radio', 'region', 'row', 'searchbox', 'slider', 'spinbutton', 'status', 'switch', 'tab', 'table', 'tablist', 'tabpanel', 'textbox', 'tooltip', 'tree', 'treeitem']);

/** wait_for: plain text, or role + name like `button "Save"` / `dialog` (as read_page prints them). */
function parseWaitFor(s) {
  const str = String(s || '').trim();
  const m = /^([a-z]+)(?:\s+"((?:[^"\\]|\\.)*)"|\s+'([^']*)')?\s*(?:\[.*\])?$/i.exec(str);
  if (m && ROLE_WORDS.has(m[1].toLowerCase()))
    return { role: m[1].toLowerCase(), name: (m[2] ?? m[3] ?? '').replace(/\\"/g, '"'), label: str };
  return { text: str, label: JSON.stringify(str) };
}

function describeCond(c) {
  const parts = [];
  if (c.role)
    parts.push(`${c.role}${c.name ? ` "${c.name}"` : ''} to appear`);
  if (c.text)
    parts.push(`"${c.text}" to appear`);
  if (c.text_gone)
    parts.push(`"${c.text_gone}" to go away`);
  if (c.ref_gone)
    parts.push(`${c.ref_gone} to go away`);
  if (c.idle)
    parts.push('the page to settle (no DOM changes or fetch/XHR requests for 300 ms)');
  return parts.join(' and ');
}

/** A short view of what's on screen, for timeout messages. */
async function onScreenNow(tab) {
  try {
    const r = await sendContent(tab.id, 0, 'snapshot', { visible_only: true }, 5000);
    const y = r.yaml.length > 1500 ? r.yaml.slice(0, r.yaml.lastIndexOf('\n', 1500)) + '\n…' : r.yaml;
    return `\nOn screen now (${r.url}):\n${y}`;
  } catch {
    return '';
  }
}

/**
 * Wait until the page (top frame) meets a condition: text present or gone, an element gone, a
 * role+name in the outline, and/or idle (no DOM mutations and no fetch/XHR for 300 ms). Survives
 * navigations in between (the content script is re-injected). Throws a clear error on timeout.
 */
async function waitFor(tab, cond, timeoutMs) {
  const t0 = Date.now();
  const deadline = t0 + timeoutMs;
  const quietMs = cond.idle ? 300 : 0;
  let lastErr = '';
  for (;;) {
    if (state.paused)
      throw new Error('Foxwright is paused: the user pressed Stop.');
    const left = deadline - Date.now();
    try {
      await ensureContent(tab.id, 0);
      const r = await sendContent(tab.id, 0, 'waitCheck', { text: cond.text, text_gone: cond.text_gone, ref_gone: cond.ref_gone, role: cond.role, name: cond.name, quietMs, sliceMs: Math.max(0, Math.min(2000, left)) }, Math.max(0, Math.min(2000, left)) + 5000);
      if (r.met) {
        if (!cond.idle)
          return Date.now() - t0;
        const t = await browser.tabs.get(tab.id);
        const net = netState(tab.id);
        if (t.status !== 'loading' && net.open === 0 && net.quietMs >= quietMs)
          return Date.now() - t0;
        if (Date.now() >= deadline)
          throw Object.assign(new Error(`page still busy: ${t.status === 'loading' ? 'it is still loading' : `${net.open} fetch/XHR request${net.open === 1 ? '' : 's'} in flight`}`), { timeout: true });
        await sleep(Math.min(100, Math.max(0, deadline - Date.now())));
        continue;
      }
      lastErr = '';
    } catch (e) {
      if (e.timeout)
        lastErr = e.message;
      else if (/not allowed to access|did not allow|paused|Firefox does not let|blocks all extensions/i.test(String(e?.message)))
        throw e;
      else
        lastErr = String(e?.message || e); // page navigating or not ready: try again
      if (Date.now() < deadline)
        await sleep(150);
    }
    if (Date.now() >= deadline) {
      const secs = (timeoutMs / 1000).toFixed(1).replace(/\.0$/, '');
      throw new Error(`Timed out after ${secs} s waiting for ${describeCond(cond)}${lastErr ? ` (${lastErr.slice(0, 200)})` : ''}.${await onScreenNow(tab)}`);
    }
  }
}

// ---------- read_page diffs ----------

// The last outline read_page returned, per tab, frame and options; read_page {diff: true} compares to it.
const lastOutlines = new Map(); // tabId -> Map(key -> { url, docId, yaml })
browser.tabs.onRemoved.addListener(tabId => lastOutlines.delete(tabId));

/**
 * Line diff (Myers' O(ND) algorithm) after trimming the common start and end. Returns a list of
 * ['=', i, j] / ['-', i] / ['+', j] or null when the lists differ in more than maxD lines.
 */
export function diffLines(a, b, maxD = 1500) {
  let s = 0;
  while (s < a.length && s < b.length && a[s] === b[s])
    s++;
  let ea = a.length, eb = b.length;
  while (ea > s && eb > s && a[ea - 1] === b[eb - 1]) {
    ea--;
    eb--;
  }
  const A = a.slice(s, ea), B = b.slice(s, eb);
  const N = A.length, M = B.length;
  const ops = [];
  const trace = [];
  const off = Math.min(N + M, maxD) + 1;
  const v = new Int32Array(2 * off + 2);
  let found = N === 0 && M === 0;
  for (let d = 0; !found && d <= N + M; d++) {
    if (d > maxD)
      return null;
    for (let k = -d; k <= d; k += 2) {
      let x = k === -d || (k !== d && v[off + k - 1] < v[off + k + 1]) ? v[off + k + 1] : v[off + k - 1] + 1;
      let y = x - k;
      while (x < N && y < M && A[x] === B[y]) {
        x++;
        y++;
      }
      v[off + k] = x;
      if (x >= N && y >= M) {
        found = true;
        break;
      }
    }
    trace.push(v.slice(off - d - 1, off + d + 2)); // index k + d + 1
  }
  let x = N, y = M;
  for (let d = trace.length - 1; d > 0; d--) {
    const prev = trace[d - 1]; // k index: k + (d - 1) + 1 = k + d
    const k = x - y;
    const get = (kk) => prev[kk + d];
    const prevK = k === -d || (k !== d && get(k - 1) < get(k + 1)) ? k + 1 : k - 1;
    const px = get(prevK), py = px - prevK;
    while (x > px && y > py) {
      ops.push(['=', s + x - 1, s + y - 1]);
      x--;
      y--;
    }
    if (x === px)
      ops.push(['+', s + y - 1]);
    else
      ops.push(['-', s + x - 1]);
    x = px;
    y = py;
  }
  while (x > 0 && y > 0) {
    ops.push(['=', s + x - 1, s + y - 1]);
    x--;
    y--;
  }
  ops.reverse();
  const head = [];
  for (let i = 0; i < s; i++)
    head.push(['=', i, i]);
  const tail = [];
  for (let i = 0; i < a.length - ea; i++)
    tail.push(['=', ea + i, eb + i]);
  return [...head, ...ops, ...tail];
}

const indentOf = (l) => l.length - l.trimStart().length;
const refOfLine = (l) => /\[ref=([^\]]+)\]/.exec(l)?.[1];

/** Changed lines of an outline, each with the ancestor lines (by indentation) that place it. */
function outlineDiff(oldYaml, newYaml) {
  const a = oldYaml.split('\n'), b = newYaml.split('\n');
  const ops = diffLines(a, b);
  if (!ops)
    return null;
  // Pair removals and additions of the same ref: that element changed in place.
  const removedByRef = new Map();
  for (const op of ops) {
    if (op[0] === '-') {
      const r = refOfLine(a[op[1]]);
      if (r)
        removedByRef.set(r, op);
    }
  }
  const changedOld = new Map(); // new line index -> old line text
  const paired = new Set();
  for (const op of ops) {
    if (op[0] === '+') {
      const r = refOfLine(b[op[1]]);
      const rem = r && removedByRef.get(r);
      if (rem && !paired.has(rem)) {
        paired.add(rem);
        changedOld.set(op[1], a[rem[1]]);
      }
    }
  }
  // Old indexes of unchanged lines -> new indexes, so a parent shown as context once isn't repeated.
  const oldToNew = new Map();
  for (const op of ops)
    if (op[0] === '=')
      oldToNew.set(op[1], op[2]);
  const out = [];
  const shown = new Set(); // context lines already printed, by "side:index"
  let added = 0, removed = 0, changed = 0;
  const context = (lines, idx, side) => {
    const chain = [];
    let ind = indentOf(lines[idx]);
    for (let i = idx - 1; i >= 0 && ind > 0; i--) {
      const li = indentOf(lines[i]);
      if (li < ind) {
        chain.push(i);
        ind = li;
      }
    }
    for (const i of chain.reverse()) {
      const key = side === 'a' && oldToNew.has(i) ? `b:${oldToNew.get(i)}` : `${side}:${i}`;
      if (!shown.has(key)) {
        shown.add(key);
        out.push(`  ${lines[i]}`);
      }
    }
  };
  for (const op of ops) {
    if (op[0] === '=')
      continue;
    if (op[0] === '-') {
      if (paired.has(op))
        continue;
      removed++;
      context(a, op[1], 'a');
      out.push(`- ${a[op[1]]}`);
    } else {
      const old = changedOld.get(op[1]);
      context(b, op[1], 'b');
      shown.add(`b:${op[1]}`); // it is printed itself: never repeat it as a child's context
      if (old !== undefined) {
        changed++;
        out.push(`~ ${b[op[1]]}`);
        out.push(`  ${' '.repeat(indentOf(b[op[1]]))}(was: ${old.trim()})`);
      } else {
        added++;
        out.push(`+ ${b[op[1]]}`);
      }
    }
  }
  return { lines: out, added, removed, changed, total: b.length };
}

// ---------- reading viewer pages (PDF) ----------

/**
 * Download the document a tab shows again, for Firefox viewer pages that extensions can't read.
 * GET only, http(s) only, the tab's site already approved by the caller, the user's cookies
 * included (default cookie jar: a tab in a Firefox container gets the default container's cookies).
 * Another lane tightens the JSON viewer re-fetch in get_page_text; keep the two in step.
 */
async function refetchTabDocument(tab, maxBytes) {
  const u = new URL(tab.url);
  if (u.protocol !== 'https:' && u.protocol !== 'http:')
    throw new Error(`Foxwright can only re-download http(s) documents, not ${u.protocol} ones.`);
  const o = originOf(tab.url);
  if (!o || !isAllowed(o))
    throw new Error(`Foxwright is not allowed to access ${o || tab.url}.`);
  // Same rules as the JSON re-fetch: the background page only has the default cookie jar, so a
  // container or private tab would be read as a different identity; and a redirect could lead to
  // a site the user hasn't approved.
  if (tab.incognito || (tab.cookieStoreId && tab.cookieStoreId !== 'firefox-default'))
    throw new Error('This tab is in a Firefox container, and Foxwright can only download a document again with the default container\'s cookies, which could show a different account.');
  const doc = docTypes.get(tab.id);
  if (doc && doc.method && doc.method !== 'GET')
    throw new Error(`The document was the answer to a ${doc.method} request, so Foxwright can't download it again.`);
  // force-cache: the copy Firefox just showed is usually still in its cache, so no new download.
  let r;
  try {
    // redirect: 'error' stops at a redirect without requesting its target.
    r = await fetch(tab.url, { credentials: 'include', cache: 'force-cache', redirect: 'error' });
  } catch (e) {
    throw new Error(`Downloading it again failed (${e?.message || e}); if the address now redirects elsewhere, Foxwright does not follow it.`);
  }
  if (!r.ok)
    throw new Error(`Downloading it again returned HTTP ${r.status}.`);
  const len = Number(r.headers.get('content-length') || 0);
  if (len > maxBytes)
    throw new Error(`It is ${Math.round(len / 1048576)} MB, more than Foxwright reads (${Math.round(maxBytes / 1048576)} MB).`);
  const buf = new Uint8Array(await r.arrayBuffer());
  if (buf.length > maxBytes)
    throw new Error(`It is ${Math.round(buf.length / 1048576)} MB, more than Foxwright reads (${Math.round(maxBytes / 1048576)} MB).`);
  return { bytes: buf, contentType: (r.headers.get('content-type') || '').toLowerCase(), container: tab.cookieStoreId && tab.cookieStoreId !== 'firefox-default' && !tab.incognito };
}

async function pdfText(tab) {
  let got;
  try {
    got = await refetchTabDocument(tab, 60 * 1048576);
  } catch (e) {
    throw new Error(`Tab ${tab.id} shows a PDF in Firefox's PDF viewer, which extensions can't read directly, and Foxwright couldn't download the PDF to read it: ${e.message}`);
  }
  try {
    const r = await extractPdfText(got.bytes);
    const notes = [];
    if (r.undecoded)
      notes.push(`${r.undecoded} of ${r.glyphs} characters couldn't be decoded (fonts without a Unicode map) and are left out.`);
    if (r.truncated)
      notes.push('The PDF has more text than Foxwright reads (5,000,000 characters); the rest is left out.');
    if (got.container)
      notes.push('This tab is in a Firefox container, but the PDF was downloaded with the default container\'s cookies.');
    const body = r.pages.map((p, i) => `[Page ${i + 1}]\n${p}`).join('\n\n');
    return { text: body, source: `PDF, ${r.pageCount} page${r.pageCount === 1 ? '' : 's'} (text extracted by Foxwright from the PDF file; layout is approximate)`, notes };
  } catch (e) {
    if (e instanceof PdfError)
      throw new Error(`Tab ${tab.id} shows a PDF that Foxwright can't turn into text: ${e.message}`);
    throw new Error(`Tab ${tab.id} shows a PDF that Foxwright couldn't read (${e.message}). Take screenshots of the PDF viewer instead.`);
  }
}

const PAGE_TEXT_MAX = 5000000; // characters of page text get_page_text can page through

/** Page through text, or return just the passages matching a query (get_page_text). */
function pagedText(head, full, args, { preformatted = false, notes = [] } = {}) {
  const max = Math.max(1000, Math.min(100000, Number(args.max_chars) || 20000));
  const noteText = notes.length ? notes.join('\n') + '\n' : '';
  if (args.query) {
    // Return only the passages that mention the query words (cheap way to answer a question about a long page).
    const words = String(args.query).toLowerCase().split(/[^\p{L}\p{N}]+/u).filter(w => w.length > 2);
    const paras = full.split(/\n+/).map(p => (preformatted ? p.replace(/\s+$/, '') : p.trim())).filter(p => p.trim());
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
    return text(`${head}\n${noteText}Passages matching "${args.query}" (${scored.length} matching ${preformatted ? 'lines' : 'paragraphs'} of ${paras.length}):\n\n${out || '(no matches; try other words or read the page without a query)'}`);
  }
  const offset = Math.max(0, Number(args.offset) || 0);
  const chunk = full.slice(offset, offset + max);
  const more = offset + max < full.length;
  return text(`${head}\n${noteText}${offset || more ? `Showing characters ${offset}–${offset + chunk.length} of ${full.length}.${more ? ` Call again with offset: ${offset + chunk.length} for more, or pass query to get just the relevant passages.` : ''}\n` : ''}\n${chunk}`);
}

// ---------- javascript_tool: scripts that don't finish ----------

// Tabs whose page is still running a javascript_tool script that timed out (probably an endless
// loop). Their main thread is blocked, so anything that needs the page would hang: fail fast instead.
const jsBusy = new Map(); // tabId -> { since }
browser.tabs.onRemoved.addListener(tabId => jsBusy.delete(tabId));
browser.webNavigation.onCommitted.addListener((d) => {
  if (d.frameId === 0)
    jsBusy.delete(d.tabId); // a new document: the old script is gone with the old one
});

/** True if the page's content script answers within ms (false: its main thread is blocked). */
async function pageResponds(tabId, ms = 1500) {
  let timer;
  try {
    await Promise.race([
      browser.tabs.sendMessage(tabId, { foxwright: true, cmd: 'ping' }, { frameId: 0 }),
      new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('ping timeout')), ms); }),
    ]);
    return true;
  } catch (e) {
    return !/ping timeout/.test(String(e?.message)); // "no content script yet" still means it answered
  } finally {
    clearTimeout(timer);
  }
}

async function checkNotBusy(tabId) {
  const b = jsBusy.get(tabId);
  if (!b)
    return;
  if (await pageResponds(tabId)) {
    jsBusy.delete(tabId);
    return;
  }
  throw new Error(`Tab ${tabId} is still running a javascript_tool script that started ${Math.round((Date.now() - b.since) / 1000)} s ago, so its page can't respond. Foxwright can't interrupt it. Use navigate on this tab (loading a page ends the script) or close it with tabs_close_mcp; other tabs are not affected.`);
}

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
    if (/Missing host permission/i.test(String(e?.message))) {
      if (await hostAccessRevoked(tab.url))
        throw hostAccessError(tab.url);
      throw new Error(`Can't screenshot tab ${tab.id}: it is showing a Firefox error or internal page${tab.title ? ` ("${tab.title}")` : ''}.`);
    }
    // Background tabs that Firefox hasn't rendered can't be captured; bring it forward.
    await browser.tabs.update(tab.id, { active: true });
    await sleep(250);
    return browser.tabs.captureTab(tab.id, opts);
  }
}

/**
 * Embedded frames from sites the user hasn't approved, as rectangles in the top-level viewport
 * (CSS px). read_page leaves such frames out; screenshots must not show them either.
 */
async function unapprovedFrameRects(tab) {
  if (state.mode === 'all' || checkAccessible(tab) !== 'ok')
    return { rects: [], origins: [] };
  const frames = ((await browser.webNavigation.getAllFrames({ tabId: tab.id })) || []).filter(f => f.frameId !== 0);
  if (!frames.length)
    return { rects: [], origins: [] };
  const hidden = new Map(); // frameId -> origin (null: couldn't tell which site, so hidden too)
  for (const f of frames) {
    const o = await frameOriginOf(tab.id, f.frameId).catch(() => null);
    if (!o || !isAllowed(o))
      hidden.set(f.frameId, o);
  }
  if (!hidden.size)
    return { rects: [], origins: [] };
  const parentOf = new Map(frames.map(f => [f.frameId, f.parentFrameId]));
  const underHidden = (id) => {
    for (let cur = parentOf.get(id), i = 0; cur && i < 10; cur = parentOf.get(cur), i++) {
      if (hidden.has(cur))
        return true;
    }
    return false;
  };
  const byParent = new Map(); // parentFrameId -> [frameId]; frames inside a hidden frame are covered by it
  for (const id of hidden.keys()) {
    if (!underHidden(id))
      byParent.set(parentOf.get(id), [...(byParent.get(parentOf.get(id)) || []), id]);
  }
  const rects = [];
  for (const [parent, ids] of byParent) {
    await ensureContent(tab.id, parent);
    const base = await frameOrigin(tab.id, parent);
    const found = await sendContent(tab.id, parent, 'frameRects', { frameIds: ids }, 5000);
    for (const id of ids) {
      const r = found?.[id];
      // A frame of unknown origin that isn't in its parent's document any more isn't on screen.
      if (!r && hidden.get(id) === null && base)
        continue;
      // Can't tell where an unapproved frame is: refuse rather than risk showing it.
      if (!r || !base)
        throw new Error(`Can't take a screenshot of tab ${tab.id} right now: it embeds a frame from ${hidden.get(id) || 'an unknown site'}, which the user hasn't approved, and Foxwright couldn't work out where that frame is on the page. Use read_page instead.`);
      if (r.w > 0 && r.h > 0)
        rects.push({ x: base.x + r.x, y: base.y + r.y, w: r.w, h: r.h });
    }
  }
  return { rects, origins: [...new Set([...hidden.values()].map(o => o || 'unknown sites'))] };
}

/** Grey out rectangles (image pixels) in a captured image. */
async function maskImage(dataUrl, rects, mime, quality) {
  if (!rects.length)
    return dataUrl;
  const raw = atob(dataUrl.slice(dataUrl.indexOf(',') + 1));
  const buf = new Uint8Array(raw.length);
  for (let i = 0; i < raw.length; i++)
    buf[i] = raw.charCodeAt(i);
  const bmp = await createImageBitmap(new Blob([buf], { type: dataUrl.slice(5, dataUrl.indexOf(';')) }));
  const canvas = new OffscreenCanvas(bmp.width, bmp.height);
  const g = canvas.getContext('2d');
  g.drawImage(bmp, 0, 0);
  for (const r of rects) {
    const x = Math.floor(r.x) - 1, y = Math.floor(r.y) - 1, w = Math.ceil(r.w) + 2, h = Math.ceil(r.h) + 2;
    g.save();
    g.beginPath();
    g.rect(x, y, w, h);
    g.clip();
    g.fillStyle = '#8a8580';
    g.fillRect(x, y, w, h);
    g.strokeStyle = '#5c5753';
    g.lineWidth = 2;
    g.beginPath();
    for (let d = -h; d < w; d += 16) {
      g.moveTo(x + d, y + h);
      g.lineTo(x + d + h, y);
    }
    g.stroke();
    g.restore();
  }
  const blob = await canvas.convertToBlob({ type: mime, quality });
  const bytes = new Uint8Array(await blob.arrayBuffer());
  let bin = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    bin += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return `data:${mime};base64,${btoa(bin)}`;
}

function hiddenNote(origins) {
  return origins.length ? ` Greyed-out areas are embedded frames from sites the user hasn't approved (${origins.join(', ')}); acting on one asks the user.` : '';
}

async function screenshot(tab) {
  const vp = await viewportOf(tab);
  const s = scaleFor(vp.width, vp.height);
  const hide = await unapprovedFrameRects(tab);
  const dataUrl = await maskImage(await capture(tab, { format: 'jpeg', quality: 80, scale: s }), hide.rects.map(r => ({ x: r.x * s, y: r.y * s, w: r.w * s, h: r.h * s })), 'image/jpeg', 0.8);
  const w = Math.round(vp.width * s), h = Math.round(vp.height * s);
  return {
    content: [
      { type: 'text', text: `Screenshot of tab ${tab.id} (${w}x${h}). Use coordinates in this image's pixel grid for clicks.${hiddenNote(hide.origins)}` },
      { type: 'image', data: dataUrl.split(',')[1], mimeType: 'image/jpeg' },
    ],
    site: originOf(tab.url) || '',
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
  const hide = await unapprovedFrameRects(tab);
  // Frame rectangles are in viewport pixels; the captured region starts at rect.x/y in the document.
  const dataUrl = await maskImage(await capture(tab, { format: 'png', rect, scale: z }), hide.rects.map(r => ({ x: (r.x + (vp.scrollX || 0) - rect.x) * z, y: (r.y + (vp.scrollY || 0) - rect.y) * z, w: r.w * z, h: r.h * z })), 'image/png');
  return {
    content: [
      { type: 'text', text: `Zoomed view of region (${region.join(', ')}). Keep using full-screenshot coordinates for clicks.${hiddenNote(hide.origins)}` },
      { type: 'image', data: dataUrl.split(',')[1], mimeType: 'image/png' },
    ],
    site: originOf(tab.url) || '',
  };
}

// ---------- helpers ----------

/** True for patterns like (a+)+ or (a|aa)*: a repeated group containing a repeat or alternatives,
 *  which can freeze the extension for minutes on the wrong input. */
function slowRegex(src) {
  let s = src.replace(/\\./g, 'x').replace(/\[[^\]]*\]/g, 'x');
  for (let i = 0; i < 100; i++) {
    const m = /\(([^()]*)\)([+*]|\{\d*,?\d*\})?/.exec(s);
    if (!m)
      break;
    const inner = /[+*|§]|\{\d*,\d*\}/.test(m[1]);
    if (inner && m[2])
      return true;
    s = s.slice(0, m.index) + (inner ? '§' : 'x') + s.slice(m.index + m[0].length);
  }
  return false;
}

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
    return list.map(d => `The page opened a JavaScript ${d.type}(${JSON.stringify(d.message)}); Foxwright answered: ${d.answer}.${d.type === 'confirm' && d.answer === 'Cancel' ? ' To answer OK instead, call handle_dialog {accept: true} and repeat the action.' : ''}`);
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
      extra.push(`The link opens in a new tab: created tab ${nt.id} (${url}) in the Foxwright group.`);
    } catch (e) {
      extra.push(`The link wanted to open ${String(r.openUrl).slice(0, 200)} in a new tab, but Foxwright didn't: ${e.message}`);
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
      throw new Error(`Foxwright only navigates to http(s) pages (not ${scheme[1]}:).`);
    return u;
  }
  if (/^(javascript|data|file|about|moz-extension|chrome|resource|view-source|blob):/i.test(u))
    throw new Error(`Foxwright won't navigate to ${u.split(':')[0]}: URLs.`);
  // "localhost:3000", "127.0.0.1:8080/x", "example.com/path"
  const host = u.split(/[/?#]/)[0].replace(/:\d+$/, '');
  const local = host === 'localhost' || /^127\.|^\[?::1\]?$|^10\.|^192\.168\.|^172\.(1[6-9]|2\d|3[01])\.|\.local$|\.localhost$/.test(host);
  return (local ? 'http://' : 'https://') + u;
}

/** need: 'read' for tools that only look, 'full' for tools that change the page (see tabs.js levelOf). */
async function tabForPageTool(args, need = 'read') {
  const tab = await requireTab(args.tabId);
  await ensurePermission(tab, need);
  if (checkAccessible(tab) === 'blank')
    return tab;
  await checkNotBusy(tab.id);
  await ensureContent(tab.id, 0);
  showActivity(tab.id);
  return tab;
}

function indentBlock(textBlock, indent) {
  return textBlock.split('\n').map(l => ' '.repeat(indent) + l).join('\n');
}

const FRAME_LOAD_WAIT_MS = 3000; // how long read_page waits for a frame that is still loading

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
  await Promise.all(frames.map(async ({ ref, frameId, loads }) => {
    if (!(await isFrameAllowed(tabId, frameId))) {
      const o = await frameOriginOf(tabId, frameId).catch(() => null);
      inserts.set(ref, `- note: embedded content from ${o || 'another site'} is hidden until the user approves it (read_page with ref_id ${ref} asks them)`);
      return;
    }
    try {
      const snap = async () => {
        await ensureContent(tabId, frameId);
        return sendContent(tabId, frameId, 'snapshot', { filter: args.filter, depth: args.depth, visible_only: args.visible_only }, 10000);
      };
      // navigate returns once the top page is parsed, so a frame may still hold its initial
      // about:blank placeholder (or be mid-parse). Give it a moment to load its real page; a
      // snapshot request that lands while the frame swaps documents can fail, so retry those too.
      const until = Date.now() + FRAME_LOAD_WAIT_MS;
      let child;
      for (;;) {
        try {
          child = await snap();
        } catch (e) {
          if (!loads || Date.now() >= until)
            throw e;
          await sleep(150);
          continue;
        }
        if (!loads || (child.url !== 'about:blank' && child.readyState !== 'loading') || Date.now() >= until)
          break;
        await sleep(150);
      }
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

// ---------- confirm before consequential actions (opt-in) ----------

const CONFIRM_CLICKS = new Set(['left_click', 'double_click', 'triple_click']);

function conseqText(c) {
  return `${c.role || 'element'} "${String(c.name || '').slice(0, 80)}", which ${c.reason}`;
}

/**
 * Ask the person to confirm an action on an element the content script found consequential (a form
 * submission, or a button/link named "Send", "Buy", "Delete"...). The element's role and name come
 * from the page, the summary from the agent: the window labels both as such.
 */
async function confirmAction(tab, c, summary) {
  const a = await askUser({ type: 'action', origin: c.origin, tabTitle: tab.title, element: { role: c.role, name: c.name, reason: c.reason }, summary: cleanSummary(summary) });
  if (a === 'once')
    return;
  if (a === 'timeout')
    throw new Error(`Waiting for the user to confirm this action on ${c.origin} (${conseqText(c)}) timed out. Ask the user to answer the Foxwright window, then try again.`);
  throw new Error(`The user did not allow this action on ${c.origin}: ${conseqText(c)}. Foxwright asks before consequential actions because the user turned that on. Do not retry it unless the user asks you to.`);
}

/** sendContent for click/type/key, asking the person first when the target is consequential. */
async function sendGuarded(tab, frameId, cmd, args, summary) {
  if (!state.confirmActions)
    return sendContent(tab.id, frameId, cmd, args);
  let r = await sendContent(tab.id, frameId, cmd, { ...args, guard: true });
  if (r?.needsConfirm) {
    const c = r.needsConfirm;
    await confirmAction(tab, c, summary);
    r = await sendContent(tab.id, frameId, cmd, { ...args, guard: true, approved: c });
    if (r?.needsConfirm)
      throw new Error(`The page changed after the user confirmed the action (now: ${conseqText(r.needsConfirm)}), so Foxwright didn't do it. Check the page and try again.`);
  }
  return r;
}

// ---------- tools ----------

export const tools = {
  async tabs_context_mcp(args) {
    const tabs = await ensureGroup(!!args.createIfEmpty);
    if (!tabs.length)
      return text('The Foxwright tab group is empty. Call tabs_context_mcp with createIfEmpty: true, or tabs_create_mcp, to get a tab.');
    // A tab on a site the user hasn't approved (e.g. a sign-in popup the page opened) shows only
    // its site: the full address can carry tokens, and the title is whatever the page chose.
    const lines = tabs.map((t) => {
      const o = originOf(t.url);
      const what = o && !isAllowed(o) ? `${o} (site not approved yet: title and full address hidden)` : `${JSON.stringify(t.title || '')} ${t.url}`;
      return `- tabId ${t.id}: ${what}${t.active ? ' (active in its window)' : ''}`;
    });
    return text(`Foxwright tab group (${tabs.length} tab${tabs.length > 1 ? 's' : ''}):\n${lines.join('\n')}\n\nOnly tabs in this group can be used. The user can share an existing tab by dragging it into the orange "Foxwright" group.`);
  },

  async tabs_create_mcp() {
    const tab = await createAgentTab('about:blank', true);
    return text(`Created tab ${tab.id} in the Foxwright group.`);
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
      prefix = `(Using tab ${tabId} from the Foxwright group.)\n`;
    }
    const tab = await requireTab(tabId);
    let navSince = Date.now();
    let requested = null;
    if (args.url === 'back' || args.url === 'forward') {
      const go = dir => (dir === 'back' ? browser.tabs.goBack(tab.id) : browser.tabs.goForward(tab.id));
      const other = args.url === 'back' ? 'forward' : 'back';
      await go(args.url);
      // An extension can't see where history leads before going there. If it leads to a site
      // the user hasn't approved, step straight back out, ask, and only then go again.
      const landed = await waitForLoad(tab.id, 30000, navSince);
      const lo = originOf(landed.url);
      if (lo && !isAllowed(lo) && landed.url !== tab.url) {
        const t1 = Date.now();
        await go(other);
        await waitForLoad(tab.id, 30000, t1);
        await ensureOriginPermission(landed.url);
        navSince = Date.now();
        await go(args.url);
      }
    } else {
      const url = normalizeUrl(args.url);
      await ensureOriginPermission(url); // ask before sending the user's cookies anywhere new (no tab title: it's the page being left, not the site asked about)
      await browser.tabs.update(tab.id, { url });
      requested = url;
    }
    const done = await waitForLoad(tab.id, 30000, navSince);
    // No page load began and the tab still shows the old page: Firefox is most likely asking
    // "Leave page?" (the page set a beforeunload handler), which only the user can answer.
    if (requested && done.url === tab.url && requested.split('#')[0] !== tab.url.split('#')[0] && ((navState.get(tab.id) || {}).start || 0) < navSince)
      throw new Error(`${prefix}Tab ${tab.id} did not leave ${tab.url}. The page is probably showing a "Leave page?" confirmation, which only the user can answer. Ask them to choose, then check the tab again.`);
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
        if (/built-in PDF viewer/.test(String(e?.message)))
          return text(`${prefix}Navigated tab ${tab.id} to ${done.url}\nTitle: ${done.title || '(none)'}\nThe tab shows a PDF in Firefox's PDF viewer. Read it with get_page_text (it supports query and offset); the other page tools don't work in the viewer.${ctx}`);
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
    let waited = '';
    if (args.wait_for) {
      const c = parseWaitFor(args.wait_for);
      const ms = await waitFor(tab, c, waitTimeoutMs(args.timeout));
      waited = `(Waited ${(ms / 1000).toFixed(1)} s for ${c.label}.)\n`;
    }
    const frameId = args.ref_id ? frameForRef(tab.id, args.ref_id) : 0;
    if (frameId !== 0)
      await ensureContent(tab.id, frameId);
    let res = await sendContent(tab.id, frameId, 'snapshot', { filter: args.filter, depth: args.depth, ref_id: args.ref_id, visible_only: args.visible_only });
    let readFrame = frameId;
    if (res && res.frameRedirect !== undefined) {
      // ref_id pointed at an <iframe>: show that frame's document (asking for its site if needed).
      if (res.frameRedirect < 0)
        throw new Error(`Can't read inside ${args.ref_id}; the frame is not accessible.`);
      readFrame = res.frameRedirect;
      await ensureFramePermission(tab, readFrame);
      await ensureContent(tab.id, readFrame);
      res = await sendContent(tab.id, readFrame, 'snapshot', { filter: args.filter, depth: args.depth });
    }
    const yaml = await stitchFrames(tab.id, res, args, 3);
    const vp = res.viewport;
    const header = `${waited}Page: ${res.title || '(untitled)'}\nURL: ${res.url}\nViewport: ${vp.width}x${vp.height} CSS px, scrolled to y=${vp.scrollY} of ${vp.scrollHeight}\n`;
    const body = args.ref_id ? `Subtree of ${args.ref_id}:\n${yaml}` : yaml;
    const max = args.max_chars || 20000;

    // Remember this outline; with diff: true, return only what changed since the last one.
    const key = [readFrame, args.ref_id || '', args.filter || 'all', args.visible_only ? 1 : 0, args.depth || ''].join('|');
    let perTab = lastOutlines.get(tab.id);
    if (!perTab)
      lastOutlines.set(tab.id, (perTab = new Map()));
    const prev = perTab.get(key);
    perTab.set(key, { url: res.url, docId: res.docId, yaml: body });
    if (perTab.size > 12)
      perTab.delete(perTab.keys().next().value);
    if (args.diff) {
      let why = '';
      if (!prev)
        why = 'there is no earlier read_page of this tab with the same options to compare with';
      else if (prev.url !== res.url || prev.docId !== res.docId)
        why = 'the page navigated since the last read_page';
      else {
        const d = outlineDiff(prev.yaml, body);
        if (!d)
          why = 'too much changed for a useful diff';
        else if (!d.lines.length)
          return text(`${header}No changes since the previous read_page (${d.total} lines). Refs from it are still valid.`);
        else {
          const summary = `Changes since the previous read_page: ${d.added} added, ${d.removed} removed, ${d.changed} changed; the other ${d.total - d.added - d.changed} of ${d.total} lines are unchanged and omitted. "+" added, "-" removed, "~" changed (old version below it), indented lines without a mark are parents for context. Refs from earlier reads stay valid.\n`;
          const diffText = summary + d.lines.join('\n');
          if (diffText.length < body.length)
            return text(truncateLines(header + diffText, max));
          why = 'the diff would be longer than the outline';
        }
      }
      return text(truncateLines(`${header}(Full outline: ${why}.)\n${body}`, max));
    }
    return text(truncateLines(header + body, max));
  },

  async find(args) {
    const tab = await tabForPageTool(args);
    if (!args.query)
      throw new Error('query is required.');
    let waited = '';
    if (args.wait_for) {
      const c = parseWaitFor(args.wait_for);
      const ms = await waitFor(tab, c, waitTimeoutMs(args.timeout));
      waited = ` (after waiting ${(ms / 1000).toFixed(1)} s for ${c.label})`;
    }
    const top = await sendContent(tab.id, 0, 'find', { query: args.query });
    const vp = top.viewport || await viewportOf(tab);
    const s = scaleFor(vp.width, vp.height);
    const lines = top.items.map(i => i.line + (i.center ? ` at (${Math.round(i.center.x * s)}, ${Math.round(i.center.y * s)})${i.center.inView ? '' : ' (off-screen)'}` : '') + (i.note ? ` ${i.note}` : ''));
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
      return text(`No elements matched "${args.query}"${waited}. Try read_page (filter: "interactive") or a screenshot.`);
    return text(`${lines.length} match${lines.length > 1 ? 'es' : ''} for "${args.query}"${waited}${total > lines.length ? ` (of ${total} candidates; be more specific to narrow)` : ''}:\n${lines.join('\n')}`);
  },

  async form_input(args) {
    const tab = await tabForPageTool(args, 'full');
    const frameId = frameForRef(tab.id, args.ref);
    const r = await sendContent(tab.id, frameId, 'formInput', { ref: args.ref, value: args.value });
    return text([fmtResult('Set', r), ...await dialogNotes(tab.id)].join('\n'));
  },

  async get_page_text(args) {
    let tab;
    try {
      tab = await tabForPageTool(args);
    } catch (e) {
      // Firefox's PDF viewer: the site was approved above (the error comes after the permission
      // check), so download the PDF and extract its text.
      if (/built-in PDF viewer/.test(String(e?.message)) && typeof args.tabId === 'number') {
        const t = await browser.tabs.get(args.tabId);
        const p = await pdfText(t);
        return pagedText(`Title: ${t.title || '(untitled)'}\nURL: ${t.url}\nSource: ${p.source}`, p.text, args, { notes: p.notes });
      }
      if (!e.jsonViewer)
        throw e;
      // Firefox's JSON viewer hides the document from extensions; fetch the JSON again (GET).
      const t = await browser.tabs.get(args.tabId);
      const viewerNote = e.message.replace(/ get_page_text can re-fetch it\./, '');
      // The background page's fetch uses the default cookie jar: for a tab in a container (or a
      // private window) it would read the JSON as a different identity. Don't.
      if (t.cookieStoreId && t.cookieStoreId !== 'firefox-default')
        throw new Error(`${viewerNote}\nFoxwright won't re-fetch it: the tab is in a container, and a re-fetch would use the default cookies instead of the container's. Take a screenshot to see what's on screen, or ask the user to open it in a normal tab.`);
      // Never follow a redirect: it could lead to a site the user hasn't approved, with their cookies.
      let r;
      try {
        r = await fetch(t.url, { credentials: 'include', redirect: 'error' });
      } catch (fe) {
        // redirect: 'error' stops at a redirect without requesting its target (a network error).
        throw new Error(`${viewerNote}\nFoxwright couldn't re-fetch it (${fe.message}); the address may now redirect, and Foxwright doesn't follow redirects when re-fetching. Navigate the tab to the final address and try again.`);
      }
      if (r.type === 'opaqueredirect' || (r.status >= 300 && r.status < 400))
        throw new Error(`${viewerNote}\nThe address now redirects, and Foxwright doesn't follow redirects when re-fetching (they could lead to a site the user hasn't approved). Navigate the tab to the final address and try again.`);
      let body = await r.text();
      try {
        body = JSON.stringify(JSON.parse(body), null, 2);
      } catch { /* not JSON after all */ }
      return text(`URL: ${t.url}\n(Shown in Firefox's JSON viewer, which extensions can't read, so Foxwright fetched the URL again with a GET request; status ${r.status}.)\n\n${body.length > 100000 ? body.slice(0, 100000) + '\n… [truncated]' : body}`);
    }
    if (checkAccessible(tab) === 'blank')
      return text(`Tab ${tab.id} is blank.`);
    const r = await sendContent(tab.id, 0, 'pageText', { maxChars: PAGE_TEXT_MAX });
    const notes = r.truncated ? [`(The page has ${r.totalChars} characters of text; only the first ${PAGE_TEXT_MAX} can be read.)`] : [];
    return pagedText(`Title: ${r.title}\nURL: ${r.url}\nSource: ${r.source}`, r.text, args, { preformatted: !!r.preformatted, notes });
  },

  async computer(args) {
    const action = args.action;
    const tab = await requireTab(args.tabId);
    if (action === 'wait') {
      const cond = { text: args.text || undefined, text_gone: args.text_gone || undefined, ref_gone: args.ref_gone || undefined, idle: args.until === 'idle' };
      if (!cond.text && !cond.text_gone && !cond.ref_gone && !cond.idle) {
        const secs = Math.max(0, Math.min(10, Number(args.duration ?? 1)));
        await sleep(secs * 1000);
        return text(`Waited ${secs}s.`);
      }
      await ensurePermission(tab);
      if (checkAccessible(tab) === 'blank')
        throw new Error(`Tab ${tab.id} is blank; navigate to a page first.`);
      await checkNotBusy(tab.id);
      const ms = await waitFor(tab, cond, waitTimeoutMs(args.timeout));
      return text(`Waited ${(ms / 1000).toFixed(1)} s for ${describeCond(cond)}.`);
    }
    // Looking, scrolling, hovering and reading keys need read access; anything else full access.
    const reading = ['screenshot', 'zoom', 'scroll', 'scroll_to', 'hover'].includes(action) || (action === 'key' && isReadingKeys(args.text));
    await ensurePermission(tab, reading ? 'read' : 'full');
    if (checkAccessible(tab) !== 'blank')
      await checkNotBusy(tab.id);
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
        const clickArgs = { ref: args.ref, x: pt?.x, y: pt?.y, button, clickCount, modifiers: args.modifiers };
        r = CONFIRM_CLICKS.has(action) ? await sendGuarded(tab, refFrame, 'click', clickArgs, args.action_summary) : await sendContent(tab.id, refFrame, 'click', clickArgs);
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
        r = await sendGuarded(tab, 0, 'type', { text: args.text }, args.action_summary);
        verb = `Typed ${args.text.length} character${args.text.length === 1 ? '' : 's'} into`;
        r.target = r.focused;
        break;
      case 'key':
        if (typeof args.text !== 'string')
          throw new Error('key needs text, e.g. "Enter" or "ctrl+a".');
        if (/^(cmd|ctrl|meta)\+(=|-|\+|0)$/i.test(args.text.trim()))
          throw new Error('Page zoom shortcuts are not supported; use the zoom action to magnify a region instead.');
        r = isReadingKeys(args.text) ? await sendContent(tab.id, 0, 'key', { text: args.text, repeat: args.repeat }) : await sendGuarded(tab, 0, 'key', { text: args.text, repeat: args.repeat }, args.action_summary);
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
    if (__FOXWRIGHT_FULL__) {
      const tab = await tabForPageTool(args, 'full');
      if (typeof args.text !== 'string' || !args.text.trim())
        throw new Error('text (the JavaScript to run) is required.');
      const expectOrigin = await frameOriginOf(tab.id, 0).catch(() => null);
      if (!expectOrigin)
        throw new Error(`Foxwright can't tell which site tab ${tab.id} is showing right now, so it won't run code there. Try again in a moment.`);
      await ensureFrameLevel(tab.id, 0, 'full');
      // A script that never finishes (an endless loop) would otherwise hold this call, and every
      // later call on the tab, forever. Give up waiting after the timeout; the page keeps running it.
      const secs = Math.max(1, Math.min(60, Number(args.timeout) > 0 ? (Number(args.timeout) > 1000 ? Number(args.timeout) / 1000 : Number(args.timeout)) : 10));
      const exec = browser.scripting.executeScript({ target: { tabId: tab.id, frameIds: [0] }, world: 'MAIN', func: runUserCode, args: [args.text, expectOrigin && /^https?:/.test(expectOrigin) ? expectOrigin : null] });
      const entry = { since: Date.now() };
      exec.catch(() => {}).finally(() => {
        if (jsBusy.get(tab.id) === entry)
          jsBusy.delete(tab.id);
        entry.done = true;
      });
      let timer;
      const raced = await Promise.race([exec.then(v => ({ v }), e => ({ e })), new Promise((r) => { timer = setTimeout(() => r(null), secs * 1000); })]);
      clearTimeout(timer);
      if (!raced) {
        if (!entry.done && await pageResponds(tab.id))
          throw new Error(`The script didn't finish within ${secs} s (it is still waiting, e.g. on a network request or a timer), so its result is lost; the page itself is responsive. Pass a larger timeout (up to 60 s) if it needs longer.`);
        if (!entry.done)
          jsBusy.set(tab.id, entry);
        throw new Error(`The script is still running after ${secs} s and the page is not responding (probably an endless loop). Foxwright can't stop a running script. Until it ends, other calls on tab ${tab.id} fail fast; use navigate on this tab to load a page (that ends the script) or tabs_close_mcp to close it. Other tabs are not affected.`);
      }
      if (raced.e)
        throw raced.e;
      const [res] = raced.v;
      if (res?.error)
        throw new Error(String(res.error.message || res.error));
      const out = res?.result;
      if (!out)
        return text('undefined');
      if (!out.ok)
        throw new Error(out.error);
      return text(out.value.length > 50000 ? out.value.slice(0, 50000) + '\n… [truncated]' : out.value);
    }
    throw new Error('javascript_tool is not available in the Firefox Add-ons store edition of Foxwright (Mozilla policy forbids running code strings from outside the add-on). Install the "Foxwright (Full)" build to enable it, or use read_page / find / get_page_text / computer instead.');
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
      if (String(args.pattern).length > 300 || slowRegex(String(args.pattern)))
        throw new Error('That pattern could take very long to evaluate (a repeated group that itself contains a repeat or alternatives). Use a simpler pattern, e.g. plain words.');
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
    // Answering OK to a confirm() acts on the page; choosing Cancel only reads.
    const tab = await tabForPageTool(args, args.accept ? 'full' : 'read');
    await sendContent(tab.id, 0, 'dialogPolicy', { accept: !!args.accept, text: args.prompt_text });
    return text(`The next JavaScript dialog in tab ${tab.id} will be answered ${args.accept ? `OK${args.prompt_text !== undefined ? ` with ${JSON.stringify(args.prompt_text)}` : ''}` : 'Cancel'}. Now perform the action that opens it.`);
  },

  async read_network_requests(args) {
    const tab = await requireTab(args.tabId);
    await ensurePermission(tab);
    let list = netLog.get(tab.id) || [];
    // Embedded frames from sites the user hasn't approved stay hidden here too: neither the
    // frame's own address nor what it loads is listed.
    const total = list.length;
    list = list.filter((r) => {
      if (r.type === 'sub_frame') {
        const o = originOf(r.url);
        return !!o && isAllowed(o);
      }
      if (r.frameId) {
        const o = originOf(r.doc || '');
        return !!o && isAllowed(o);
      }
      return true;
    });
    const hiddenCount = total - list.length;
    const hiddenLine = hiddenCount ? `\n(${hiddenCount} request${hiddenCount > 1 ? 's' : ''} from embedded frames the user hasn't approved ${hiddenCount > 1 ? 'are' : 'is'} not shown.)` : '';
    if (args.urlPattern)
      list = list.filter(r => r.url.includes(args.urlPattern));
    const limit = args.limit || 100;
    const shown = list.slice(-limit);
    if (args.clear)
      netLog.set(tab.id, []);
    if (!shown.length)
      return text('No network requests recorded for this tab yet. Requests are recorded only while the tab is in the Foxwright group.' + hiddenLine);
    return text(shown.map(r => `${r.method} ${r.status ?? r.error ?? '…'} ${r.type} ${r.url}`).join('\n') + hiddenLine);
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
    const tab = await tabForPageTool(args, 'full');
    const frameId = args.ref ? frameForRef(tab.id, args.ref) : 0;
    if (frameId)
      await ensureFrameLevel(tab.id, frameId, 'full'); // before the upload window, not after it
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
    // args.action: the trusted action about to be sent there. Hover and scroll only need read access;
    // 'locate' is a lookup (GIF markers); anything else, or none, needs full access to that frame's site.
    const act = !['hover', 'scroll', 'locate'].includes(args.action);
    const guard = state.confirmActions && CONFIRM_CLICKS.has(args.action);
    const tab = await tabForPageTool(args, act ? 'full' : 'read');
    let p = null;
    if (args.ref) {
      const frameId = frameForRef(tab.id, args.ref);
      p = await sendContent(tab.id, frameId, 'refPoint', { ref: args.ref, guard });
    } else if (Array.isArray(args.coordinate)) {
      const c = await toCss(tab, args.coordinate);
      p = await sendContent(tab.id, 0, 'locate', { x: c.x, y: c.y, guard });
    }
    if (!p)
      return { data: null };
    const frameId = frameIdFromPrefix(tab.id, p.prefix);
    if (act)
      await ensureFrameLevel(tab.id, frameId, 'full');
    // Same check as a synthetic click, made on the element the trusted click will land on.
    if (p.conseq)
      await confirmAction(tab, p.conseq, args.action_summary);
    // Also in screenshot pixels (top-level viewport), e.g. to mark a ref click in a GIF frame.
    let shot;
    try {
      const o = frameId ? await frameOrigin(tab.id, frameId) : { x: 0, y: 0 };
      // The Stop pill sits on top of the page: get it out of the way of a real click aimed under it.
      if (o)
        await sendContent(tab.id, 0, 'dodgePill', { x: p.x + o.x, y: p.y + o.y }, 3000).catch(() => {});
      const vp = await viewportOf(tab);
      const s = scaleFor(vp.width, vp.height);
      if (o)
        shot = [Math.round((p.x + o.x) * s), Math.round((p.y + o.y) * s)];
    } catch { /* not needed for input */ }
    return { data: { x: p.x, y: p.y, target: p.target, draggable: !!p.draggable, frameId, shot } };
  },

  async _tab(args) {
    await requireTab(args.tabId);
    return { data: true };
  },

  async _focus(args) {
    // Which frame has keyboard focus (so trusted key input can target its BiDi context).
    // args.action/text/repeat: the trusted 'type' or 'key' about to be sent. Reading keys need read
    // access unless focus is on a form control; everything else (or no action given) full access.
    const reading = args.action === 'key' && isReadingKeys(args.text);
    const tab = await tabForPageTool(args, reading ? 'read' : 'full');
    if (checkAccessible(tab) === 'blank')
      return { data: { frameId: 0 } };
    const guard = state.confirmActions && !reading && (args.action === 'type' || args.action === 'key') ? { action: args.action, text: String(args.text ?? ''), repeat: args.repeat } : undefined;
    const f = await sendContent(tab.id, 0, 'focusInfo', { guard, waitEditable: !!args.forType });
    const frameId = frameIdFromPrefix(tab.id, f.prefix);
    if (!reading || f.control)
      await ensureFrameLevel(tab.id, frameId, 'full');
    if (f.conseq)
      await confirmAction(tab, f.conseq, args.action_summary);
    return { data: { frameId, target: f.target, editable: f.editable, waited: f.waited } };
  },

  async _mark(args) {
    // Tag a document so the BiDi side can find the matching browsing context.
    const tab = await requireTab(args.tabId);
    await ensurePermission(tab);
    await browser.scripting.executeScript({
      target: { tabId: tab.id, frameIds: [args.frameId || 0] },
      func: (token) => { document.documentElement.setAttribute('data-foxwright-probe', token); },
      args: [String(args.token)],
    });
    return { data: true };
  },

  async _unmark(args) {
    await requireTab(args.tabId);
    try {
      await browser.scripting.executeScript({ target: { tabId: args.tabId, frameIds: [args.frameId || 0] }, func: () => { document.documentElement.removeAttribute('data-foxwright-probe'); } });
    } catch { /* ignore */ }
    return { data: true };
  },

  /**
   * Draw a GIF frame's overlays with a canvas (real fonts, any language): click ring, drag arrow,
   * action label, progress bar, watermark. In: a recorded JPEG frame (base64) and what to draw, in
   * the frame's own pixels. Out: a JPEG scaled to `width`. Used by gif_creator export.
   */
  async _annotate_frame(args) {
    const bytes = Uint8Array.from(atob(String(args.jpeg || '')), c => c.charCodeAt(0));
    const bmp = await createImageBitmap(new Blob([bytes], { type: 'image/jpeg' }));
    const s = Math.min(1, (Number(args.width) || 800) / bmp.width);
    const w = Math.round(bmp.width * s), h = Math.round(bmp.height * s);
    const c = new OffscreenCanvas(w, h);
    const g = c.getContext('2d');
    g.drawImage(bmp, 0, 0, w, h);
    bmp.close?.();
    const RED = '#d64024';
    if (Array.isArray(args.drag) && args.drag.length === 4) {
      const [x0, y0, x1, y1] = args.drag.map(v => v * s);
      g.strokeStyle = RED;
      g.fillStyle = RED;
      g.lineWidth = 3;
      g.lineCap = 'round';
      g.beginPath();
      g.moveTo(x0, y0);
      g.lineTo(x1, y1);
      g.stroke();
      const a = Math.atan2(y1 - y0, x1 - x0), len = 12;
      g.beginPath();
      g.moveTo(x1, y1);
      g.lineTo(x1 - len * Math.cos(a - 0.45), y1 - len * Math.sin(a - 0.45));
      g.lineTo(x1 - len * Math.cos(a + 0.45), y1 - len * Math.sin(a + 0.45));
      g.closePath();
      g.fill();
    }
    if (Array.isArray(args.click) && args.click.length === 2) {
      const [x, y] = args.click.map(v => v * s);
      g.lineWidth = 3;
      g.strokeStyle = '#fff';
      g.beginPath();
      g.arc(x, y, 13, 0, Math.PI * 2);
      g.stroke();
      g.strokeStyle = RED;
      g.beginPath();
      g.arc(x, y, 11, 0, Math.PI * 2);
      g.stroke();
      g.fillStyle = RED;
      g.beginPath();
      g.arc(x, y, 2.5, 0, Math.PI * 2);
      g.fill();
    }
    const font = '600 13px ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif';
    if (typeof args.label === 'string' && args.label.trim()) {
      g.font = font;
      const max = w - 24;
      let t = args.label.trim();
      while (t.length > 1 && g.measureText(t).width > max - 16)
        t = t.slice(0, -2) + '…';
      const tw = g.measureText(t).width;
      g.fillStyle = 'rgba(20, 16, 14, 0.82)';
      g.beginPath();
      if (g.roundRect)
        g.roundRect(10, 10, tw + 16, 24, 6);
      else
        g.rect(10, 10, tw + 16, 24);
      g.fill();
      g.fillStyle = '#fff';
      g.textBaseline = 'middle';
      g.fillText(t, 18, 22);
    }
    if (typeof args.progress === 'number') {
      g.fillStyle = 'rgba(0, 0, 0, 0.25)';
      g.fillRect(0, h - 4, w, 4);
      g.fillStyle = RED;
      g.fillRect(0, h - 4, Math.round(w * Math.min(1, Math.max(0, args.progress))), 4);
    }
    if (args.watermark) {
      g.font = '600 11px ui-sans-serif, system-ui, sans-serif';
      const t = '狐 Foxwright';
      const tw = g.measureText(t).width;
      g.fillStyle = 'rgba(20, 16, 14, 0.55)';
      g.fillRect(w - tw - 18, h - 26, tw + 12, 18);
      g.fillStyle = '#fff';
      g.textBaseline = 'middle';
      g.fillText(t, w - tw - 12, h - 17);
    }
    const blob = await c.convertToBlob({ type: 'image/jpeg', quality: 0.92 });
    const buf = new Uint8Array(await blob.arrayBuffer());
    let bin = '';
    for (let i = 0; i < buf.length; i += 0x8000)
      bin += String.fromCharCode(...buf.subarray(i, i + 0x8000));
    return { data: btoa(bin) };
  },

  /** switch_browser: ask the user whether the agent should use this Firefox. */
  async _pair() {
    const a = await askUser({ type: 'pair', origin: state.browserName });
    return { data: a === 'once' };
  },

  async _pair_cancel() {
    cancelPairPrompts();
    return { data: true };
  },

  async _after(args) {
    // Called after a trusted action so the agent learns about navigation / new tabs.
    const tab = await requireTab(args.tabId);
    showActivity(tab.id);
    const extra = await afterAction(tab, { url: args.beforeUrl, t0: typeof args.t0 === 'number' ? args.t0 : undefined }, {});
    // No navigation: report popups that opened or closed and where focus went (top frame).
    if (!extra.some(l => /^The page navigated/.test(l)) && checkAccessible(await browser.tabs.get(tab.id)) === 'ok') {
      const ui = await sendContent(tab.id, 0, 'uiAfter', {}, 3000).catch(() => []);
      extra.unshift(...(Array.isArray(ui) ? ui : []));
    }
    return { data: extra };
  },

  // ----- added in 0.8 for the MCP server's trusted input and file_upload (older MCP servers don't call them) -----

  /** Before a trusted click: note what the next real pointerdown in this frame lands on (see _click_check). */
  async _click_arm(args) {
    const tab = await requireTab(args.tabId);
    await browser.scripting.executeScript({ target: { tabId: tab.id, frameIds: [args.frameId || 0] }, func: armClickProbe });
    return { data: true };
  },

  /** After a trusted click: descriptions of the element the click landed on and its ancestors (approved sites only). */
  async _click_check(args) {
    const tab = await requireTab(args.tabId);
    const [r] = await browser.scripting.executeScript({ target: { tabId: tab.id, frameIds: [args.frameId || 0] }, func: readClickProbe });
    const out = r?.result;
    return { data: out && out.hit && isAllowed(out.origin) ? { hit: out.hit } : null };
  },

  /** file_upload step 1: the user approves the paths (shown with sizes) before the MCP server reads any file. */
  async _upload_ask(args) {
    const tab = await tabForPageTool(args);
    const frameId = args.ref ? frameForRef(tab.id, args.ref) : 0;
    let x, y;
    if (!args.ref && Array.isArray(args.coordinate)) {
      const p = await toCss(tab, args.coordinate);
      x = p.x;
      y = p.y;
    }
    if (!Array.isArray(args.paths) || !args.paths.length)
      throw new Error('No files to upload.');
    const origin = (await frameOriginOf(tab.id, frameId)) || originOf(tab.url) || tab.url;
    const ok = state.confirmUploads ? await askUser({ type: 'upload', origin, tabTitle: tab.title, files: args.paths }) : 'once';
    if (ok !== 'once')
      throw new Error('The user did not approve uploading these files.');
    const token = crypto.randomUUID();
    approvedUploads.set(token, { tabId: tab.id, frameId, origin, ref: args.ref, x, y, count: args.paths.length, at: Date.now() });
    return { data: { token } };
  },

  /** file_upload step 2: the contents, for an approval from _upload_ask (single use, 2 minutes, same page). */
  async _upload_send(args) {
    const u = approvedUploads.get(args.token);
    approvedUploads.delete(args.token);
    if (!u || Date.now() - u.at > 120000 || u.tabId !== args.tabId)
      throw new Error('This upload\'s approval is missing or expired. Call file_upload again.');
    if (!Array.isArray(args.files) || args.files.length !== u.count)
      throw new Error('The files don\'t match what the user approved. Call file_upload again.');
    const tab = await tabForPageTool({ tabId: u.tabId });
    const now = (await frameOriginOf(tab.id, u.frameId)) || originOf(tab.url) || tab.url;
    if (now !== u.origin)
      throw new Error(`The page changed to ${now} after the user approved the upload to ${u.origin}. Nothing was uploaded.`);
    const r = await sendContent(tab.id, u.frameId, 'upload', { ref: u.ref, x: u.x, y: u.y, files: args.files });
    return text(`Attached ${r.files.join(', ')} to ${r.target}.${(r.notes || []).map(n => '\n' + n).join('')}`);
  },
};

const approvedUploads = new Map(); // token -> what the user approved in _upload_ask

/* Injected (isolated world) by _click_arm / _click_check; self-contained. Descriptions follow the
   content script's describe(): `<tag#id role=x> "label"`, without the values of password fields. */
function armClickProbe() {
  const g = globalThis;
  if (g.__foxwrightClickProbe)
    for (const t of ['pointerdown', 'mousedown']) removeEventListener(t, g.__foxwrightClickProbe.fn, true);
  const describe = (el) => {
    const tag = el.tagName.toLowerCase();
    const role = el.getAttribute('role');
    const secret = tag === 'input' && (el.type === 'password' || /cc-|password/.test(el.getAttribute('autocomplete') || ''));
    const text = tag === 'body' || tag === 'html' ? '' : (el.textContent || '').slice(0, 200);
    const label = (el.getAttribute('aria-label') || text.trim() || (secret ? '' : el.value) || el.getAttribute('title') || el.getAttribute('placeholder') || '').trim().replace(/\s+/g, ' ').slice(0, 60);
    return `<${tag}${el.id ? `#${el.id}` : ''}${role ? ` role=${role}` : ''}>${label ? ` "${label}"` : ''}`;
  };
  const probe = { hit: null, at: Date.now() };
  probe.fn = (e) => {
    if (!e.isTrusted || probe.hit || Date.now() - probe.at > 10000)
      return;
    // A closed shadow root retargets the event to its host here: look inside, as the content script's elementAt does.
    let start = e.composedPath()[0];
    for (let i = 0; i < 10 && start?.openOrClosedShadowRoot; i++) {
      const inner = start.openOrClosedShadowRoot.elementFromPoint(e.clientX, e.clientY);
      if (!inner || inner === start)
        break;
      start = inner;
    }
    const chain = [];
    for (let el = start; el && el.nodeType === 1 && chain.length < 12; el = el.parentElement || el.getRootNode()?.host)
      chain.push(describe(el));
    probe.hit = chain;
  };
  for (const t of ['pointerdown', 'mousedown']) addEventListener(t, probe.fn, true);
  g.__foxwrightClickProbe = probe;
  return true;
}

function readClickProbe() {
  const probe = globalThis.__foxwrightClickProbe;
  if (!probe)
    return null;
  for (const t of ['pointerdown', 'mousedown']) removeEventListener(t, probe.fn, true);
  delete globalThis.__foxwrightClickProbe;
  return { hit: probe.hit, origin: location.origin };
}

export async function adoptOpenedTab(tabId) {
  // Tabs opened *by* an agent tab (e.g. target=_blank under trusted input) join the group.
  await addToGroup(tabId);
}

async function ensureConsoleHook(tabId) {
  try {
    const [r] = await browser.scripting.executeScript({ target: { tabId, frameIds: [0] }, func: () => (globalThis.__foxwrightHooks ? (globalThis.__foxwrightHooks.early ? 'existing' : 'late') : '') });
    if (r?.result)
      return r.result;
  } catch { /* ignore */ }
  await injectPageHooks(tabId, 0);
  return 'new';
}


