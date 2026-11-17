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

const RESULTS = new Set(['allowed', 'denied', 'paused', 'failed', 'asked', 'once', 'always', 'hour', 'timeout', 'dismissed']);
// 'upgrade': a read-only site asked to allow clicking and typing. 'confirm': the question before a
// consequential action ("Confirm before sending, buying or deleting").
const KINDS = new Set(['action', 'site', 'frame', 'upgrade', 'upload', 'pair', 'confirm']);

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
export function logEvent({ kind = 'action', origin, url, tabId, text, own = false, result, level } = {}) {
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
  if (level === 'read' || level === 'full')
    e.lv = level; // the access a permission answer gave: read only, or clicking and typing too
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
export function logQuestion(req, answer, level) {
  if (!req)
    return;
  const result = answer === 'deny' ? (state.paused ? 'paused' : 'denied') : answer;
  const n = Array.isArray(req.files) ? req.files.length : 0;
  const granted = ['once', 'always', 'hour'].includes(answer);
  // Fixed wording only: the element's name comes from the page and the summary from the agent,
  // and neither belongs in the log.
  let text = '';
  if (req.type === 'upload')
    text = `${n} file${n === 1 ? '' : 's'}`;
  else if (req.type === 'action')
    text = 'Confirm an action that may send, buy, delete or submit';
  else if (req.type === 'upgrade')
    text = 'Allow clicking and typing on a read-only site';
  else if ((req.type === 'site' || req.type === 'frame') && granted)
    text = level === 'read' ? 'Read only' : 'Reading, clicking and typing';
  logEvent({
    kind: req.type === 'action' ? 'confirm' : req.type,
    origin: req.origin,
    tabId: req.tabId,
    text,
    result,
    level: granted && ['site', 'frame', 'upgrade'].includes(req.type) ? (level === 'read' ? 'read' : 'full') : undefined,
  });
}

// ---------- the agent's own summaries: keep the words, drop what the log must never hold ----------

const URL_RE = /\b(?:https?|ftp|file|wss?):\/\/[^\s"'<>)\]]+/gi;
const HOST_PATH_RE = /\b((?:[a-z0-9-]+\.)+[a-z]{2,})(?::\d+)?[/?#][^\s"'<>)\]]*/gi;
const PATH_RE = /(?<![\w.:/])(?:~|\.{1,2})?\/(?:[^\s/"']+\/)+[^\s"']*|(?<![\w])[A-Za-z]:\\[^\s"']+|(?<![\w.:/])~\/[^\s"']+/g;

/** Strings the agent passed to a tool that must not be repeated in the log: typed text, values, file paths. */
function secretsOf(tool, a = {}) {
  const out = [];
  const add = (v) => {
    if (typeof v === 'string' && v.trim().length >= 3)
      out.push(v.trim().toLowerCase());
    else if (typeof v === 'number')
      out.push(String(v));
  };
  if (tool === 'computer' && (a.action === 'type' || a.action === 'key'))
    add(a.text);
  if (tool === 'form_input')
    (Array.isArray(a.value) ? a.value : [a.value]).forEach(add);
  if (tool === 'javascript_tool')
    add(a.text);
  if (tool === 'handle_dialog')
    add(a.prompt_text);
  if (tool === 'file_upload') {
    for (const p of [...(Array.isArray(a.paths) ? a.paths : []), ...(Array.isArray(a.files) ? a.files.map(f => f?.name) : [])]) {
      add(p);
      if (typeof p === 'string')
        add(p.split(/[\\/]/).pop().replace(/ \(.*$/, ''));
    }
  }
  return out.filter(s => s.length >= 3);
}

/**
 * The agent's action_summary as the log may keep it: full addresses become their site, file
 * paths become "[file]", and a summary that repeats what the agent typed, a field value or a file
 * name is dropped altogether (returns ''; Foxwright's own description is logged instead).
 */
export function summaryForLog(tool, a = {}) {
  let s = cleanSummary(a?.action_summary);
  if (!s)
    return '';
  const lower = s.toLowerCase();
  if (secretsOf(tool, a).some(x => lower.includes(x)))
    return '';
  s = s.replace(URL_RE, u => logOrigin(u) || '[link]')
    .replace(HOST_PATH_RE, (m, host) => host)
    .replace(PATH_RE, '[file]');
  return cleanSummary(s);
}

// ---------- describing agent actions without leaking what they typed or read ----------

const MODIFIER = /^(ctrl|control|alt|option|shift|meta|cmd|command|super|win)$/i;
const COMMAND_MODIFIER = /^(ctrl|control|alt|option|meta|cmd|command|super|win)$/i; // shift+letter is just a capital letter
const KEY_NAME = /^(enter|return|numpadenter|tab|escape|esc|backspace|delete|del|insert|space|spacebar|home|end|pageup|pagedown|page_up|page_down|up|down|left|right|arrowup|arrowdown|arrowleft|arrowright|f[1-9]|f1[0-9]|f2[0-4]|capslock|numlock|scrolllock|contextmenu|printscreen|pause)$/i;
const LOGGED_ACTIONS = new Set(['left_click', 'right_click', 'double_click', 'triple_click', 'hover', 'scroll', 'scroll_to', 'left_click_drag']);
/** "Return", "ctrl+a", "shift+Tab" are fine to keep; "h e l l o" spells text, so it's counted instead. */
function describeKeys(text) {
  const combos = String(text ?? '').trim().split(/\s+/).filter(Boolean);
  if (!combos.length)
    return 'Pressed a key';
  const safe = combos.every((c) => {
    const parts = c.split('+');
    const key = parts[parts.length - 1];
    if (!parts.slice(0, -1).every(p => MODIFIER.test(p)))
      return false;
    // Only names of keys, never arbitrary words ("hunter2" is not a key). A single character is a
    // shortcut only with Ctrl/Alt/Cmd; alone or with Shift it is typing.
    return KEY_NAME.test(key) || (key.length === 1 && parts.slice(0, -1).some(p => COMMAND_MODIFIER.test(p)));
  });
  if (safe && combos.length <= 6)
    return `Pressed ${combos.join(' ').slice(0, 60)}`;
  return `Pressed ${combos.length} key${combos.length > 1 ? 's' : ''}`;
}

/** One line for the persistent log: like the popup's description, but never with typed text or a full URL. */
export function describeForLog(tool, a = {}) {
  const at = Array.isArray(a.coordinate) && a.coordinate.length === 2 && a.coordinate.every(v => typeof v === 'number' && isFinite(v)) ? ` at ${a.coordinate.map(Math.round).join(', ')}` : (typeof a.ref === 'string' && /^f?\d{0,4}e\d{1,7}$/.test(a.ref)) ? ` on ${a.ref}` : '';
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
      if (!LOGGED_ACTIONS.has(a.action))
        return 'Tried an action Foxwright does not know'; // never the name itself: it is whatever the agent sent
      return `${a.action.replace(/_/g, ' ').replace(/^./, c => c.toUpperCase())}${at}`;
    case 'navigate':
      if (/^(back|forward)$/.test(a.url || ''))
        return `Went ${a.url}`;
      return `Opened ${logOrigin(a.url) || logOrigin('https://' + String(a.url || '')) || 'a page'}`;
    case 'form_input':
      return `Filled ${typeof a.ref === 'string' && /^f?\d{0,4}e\d{1,7}$/.test(a.ref) ? a.ref : 'a field'}`;
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
