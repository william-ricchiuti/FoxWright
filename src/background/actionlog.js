// Persistent activity log: what the agent did and what the user decided, kept in storage.local
// so the user can review and export it later (the Activity page). Privacy rules, enforced here:
//   - a site is stored as its origin (scheme://host:port), never a full URL;
//   - no typed text, page content, form values or key sequences that could spell text;
//   - written in batches (a short timer), not on every action; at most MAX entries.
// Turning the log off (the Activity page) stops recording; the in-memory popup list stays.
/* global browser */
import { state, cleanSummary } from './state.js';

const KEY = 'activityLog';
const ENABLED_KEY = 'activityLogEnabled';
export const LOG_MAX = 500;
const FLUSH_MS = 2000;

const RESULTS = new Set(['allowed', 'denied', 'paused', 'failed', 'asked', 'once', 'always', 'timeout', 'dismissed']);
const KINDS = new Set(['action', 'site', 'frame', 'upload', 'pair']);

let entries = []; // oldest first, as stored
let loaded = false;
let enabled = true;
let pending = []; // logged before load or since the last flush
let flushTimer = null;
let dirty = false;

/** The part of a URL the log may keep: its origin for web pages, the scheme for local files. */
export function logOrigin(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:')
      return u.origin;
    if (u.protocol === 'file:')
      return 'file://';
    return null;
  } catch {
    return null;
  }
}

export async function loadLog() {
  try {
    const got = await browser.storage.local.get({ [KEY]: [], [ENABLED_KEY]: true });
    enabled = got[ENABLED_KEY] !== false;
    const stored = Array.isArray(got[KEY]) ? got[KEY].filter(e => e && typeof e.t === 'number') : [];
    // Entries logged while loading come after the stored ones.
    entries = stored.concat(entries);
  } catch { /* storage unavailable: keep memory only */ }
  loaded = true;
  if (entries.length > LOG_MAX)
    entries.splice(0, entries.length - LOG_MAX);
  if (pending.length)
    scheduleFlush();
}

export function logEnabled() {
  return enabled;
}

/**
 * Record one event. Callable from anywhere in the background (also before loadLog finishes).
 *   kind:   'action' (an agent tool call) | 'site' | 'frame' | 'upload' | 'pair' (a permission question)
 *   result: action → 'allowed' | 'denied' | 'paused' | 'failed';
 *           question → 'asked' | 'once' | 'always' | 'denied' | 'timeout' | 'dismissed' | 'paused'
 *   origin or url (reduced to its origin), tabId, text (one line, ≤120 chars), own (agent's words)
 */
export function logEvent({ kind = 'action', origin, url, tabId, text, own = false, result } = {}) {
  if (!enabled)
    return;
  const o = typeof origin === 'string' ? logOrigin(origin) : (typeof url === 'string' ? logOrigin(url) : null);
  const e = {
    t: Date.now(),
    k: KINDS.has(kind) ? kind : 'action',
    o: o || null,
    tab: typeof tabId === 'number' ? tabId : null,
    x: cleanSummary(text || ''),
    own: !!own,
    r: RESULTS.has(result) ? result : 'allowed',
  };
  if (!e.x && e.k === 'action')
    return;
  entries.push(e);
  if (entries.length > LOG_MAX)
    entries.splice(0, entries.length - LOG_MAX);
  pending.push(e);
  dirty = true;
  if (loaded)
    scheduleFlush();
}

function scheduleFlush() {
  if (flushTimer)
    return;
  flushTimer = setTimeout(flushLog, FLUSH_MS);
}

/** Write the log now (also called when the event page is about to unload). */
export async function flushLog() {
  clearTimeout(flushTimer);
  flushTimer = null;
  if (!loaded || !dirty)
    return;
  dirty = false;
  pending = [];
  try {
    await browser.storage.local.set({ [KEY]: entries });
  } catch { /* quota or shutdown: next flush retries with everything */
    dirty = true;
  }
}

/** Newest first, for the Activity page. */
export function readLog() {
  return { enabled, max: LOG_MAX, entries: entries.slice().reverse() };
}

export async function clearLog() {
  entries = [];
  pending = [];
  dirty = false;
  clearTimeout(flushTimer);
  flushTimer = null;
  await browser.storage.local.remove(KEY);
}

export async function setLogEnabled(on) {
  enabled = !!on;
  if (!enabled) {
    // Stop recording; what was saved stays until the user clears it. Unsaved entries are dropped.
    if (pending.length) {
      const drop = new Set(pending);
      entries = entries.filter(e => !drop.has(e));
      pending = [];
      dirty = false;
    }
  }
  await browser.storage.local.set({ [ENABLED_KEY]: enabled });
}

/**
 * Log a permission question and its answer (call from prompt.js): once when it is asked
 * (answer 'asked'), once when it is settled with askUser's answer ('once' | 'always' | 'deny' |
 * 'timeout' | 'dismissed'). A "deny" caused by pressing Stop is logged as 'paused'.
 * Uploads are logged by file count only, never file names or paths.
 */
export function logQuestion(req, answer) {
  if (!req)
    return;
  const result = answer === 'deny' ? (state.paused ? 'paused' : 'denied') : answer;
  const n = Array.isArray(req.files) ? req.files.length : 0;
  logEvent({
    kind: req.type,
    origin: req.origin,
    tabId: req.tabId,
    text: req.type === 'upload' ? `${n} file${n === 1 ? '' : 's'}` : '',
    result,
  });
}

// ---------- describing agent actions without leaking what they typed or read ----------

const MODIFIER = /^(ctrl|control|alt|option|shift|meta|cmd|command|super|win)$/i;
/** "Return", "ctrl+a", "shift+Tab" are fine to keep; "h e l l o" spells text, so it's counted instead. */
function describeKeys(text) {
  const combos = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  if (!combos.length)
    return 'Pressed a key';
  const safe = combos.every((c) => {
    const parts = c.split('+');
    const key = parts[parts.length - 1];
    return parts.length > 1 ? parts.slice(0, -1).every(p => MODIFIER.test(p)) : key.length > 1 && /^[A-Za-z][A-Za-z0-9_]*$/.test(key);
  });
  if (safe && combos.length <= 6)
    return `Pressed ${combos.join(' ').slice(0, 60)}`;
  return `Pressed ${combos.length} key${combos.length > 1 ? 's' : ''}`;
}

/** One line for the persistent log: like the popup's description, but never with typed text or a full URL. */
export function describeForLog(tool, a = {}) {
  const at = Array.isArray(a.coordinate) ? ` at ${a.coordinate.map(Math.round).join(', ')}` : (typeof a.ref === 'string' && /^[\w:-]{1,24}$/.test(a.ref)) ? ` on ${a.ref}` : '';
  switch (tool) {
    case 'computer':
      if (a.action === 'type')
        return `Typed ${String(a.text ?? '').length} characters`;
      if (a.action === 'key')
        return describeKeys(a.text);
      if (a.action === 'screenshot')
        return 'Took a screenshot';
      if (a.action === 'zoom')
        return 'Zoomed into the page';
      if (a.action === 'wait')
        return '';
      return `${String(a.action || 'acted').replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())}${at}`;
    case 'navigate':
      if (/^(back|forward)$/.test(a.url || ''))
        return `Went ${a.url}`;
      return `Opened ${logOrigin(a.url) || logOrigin('https://' + String(a.url || '')) || 'a page'}`;
    case 'form_input':
      return `Filled ${typeof a.ref === 'string' && /^[\w:-]{1,24}$/.test(a.ref) ? a.ref : 'a field'}`;
    case 'file_upload':
      return `Uploaded ${Array.isArray(a.paths) ? a.paths.length : Array.isArray(a.files) ? a.files.length : ''} file(s)`.replace('  ', ' ');
    case 'upload_image':
      return 'Uploaded a screenshot';
    case 'javascript_tool':
      return 'Ran JavaScript in the page';
    case 'read_page':
      return 'Read the page';
    case 'get_page_text':
      return 'Read the page text';
    case 'find':
      return 'Searched the page';
    case 'read_console_messages':
      return 'Read console messages';
    case 'read_network_requests':
      return 'Read network requests';
    case 'handle_dialog':
      return 'Set how to answer a page dialog';
    case 'resize_window':
      return 'Resized the window';
    case 'tabs_create_mcp':
      return 'Opened a new tab';
    case 'tabs_close_mcp':
      return 'Closed a tab';
    case 'gif_creator':
      return 'Recorded a GIF';
    default:
      return '';
  }
}

/** Sort a failed tool call into the log's result: stopped by pause, refused site, or other error. */
export function resultOfError(e) {
  const m = String(e?.message || e);
  if (/paused|Stopped: the user/i.test(m))
    return 'paused';
  if (/did not allow|not allowed to access|timed out/i.test(m) && /allow/i.test(m))
    return 'denied';
  return 'failed';
}
