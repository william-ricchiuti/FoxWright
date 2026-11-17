// Human confirmations shown in an extension-owned popup window (not in the web page),
// so pages can't hide, restyle, overlay or click-jack them.
/* global browser */
import { state } from './state.js';
import { logQuestion } from './actionlog.js';

const pending = new Map(); // id -> { req, resolve, windowId, timer }
const byKey = new Map(); // dedupe identical concurrent asks -> promise
const PROMPT_URL = () => browser.runtime.getURL('prompt/prompt.html');

export function isPromptSender(sender) {
  return !!sender?.url && sender.url.startsWith(PROMPT_URL());
}

// Site approvals (and upgrades from read-only) can be answered with an access level and a duration.
const LEVEL_TYPES = new Set(['site', 'frame', 'upgrade']);

/**
 * Ask the human. req = { type: 'site' | 'frame' | 'upgrade' | 'upload' | 'pair' | 'action', origin, tabTitle?, files?, element?, summary? }.
 * Resolves 'once' | 'always' | 'deny' | 'dismissed' | 'timeout' (plus 'hour' for site/frame/upgrade).
 * Use askSite() to also get the access level the person chose.
 */
export function askUser(req) {
  return ask(req).then(r => r.answer);
}

/** Site, frame or upgrade question: resolves { answer, level: 'read' | 'full' }. */
export function askSite(req) {
  return ask(req);
}

/**
 * Text in a question that a web page or the agent chose (page title, element name, file names, the
 * agent's summary): one line, no control or text-direction characters, no quotation marks (the
 * window puts its own around it, and text that closes them could pass itself off as Foxwright's
 * words), and a bounded length. The window cleans up again when it shows it.
 */
function shown(s, max) {
  const t = String(s ?? '').replace(/[\u0000-\u001f\u007f-\u009f\u00ad\u061c\u200b-\u200f\u2028-\u202e\u2060-\u206f\ufeff]/g, ' ').replace(/["\u201c\u201d\u201e\u201f\u00ab\u00bb\u2033\u301d\u301e\uff02]/g, '\'').replace(/\s+/g, ' ').trim();
  return t.length > max ? t.slice(0, max - 1) + '…' : t;
}
const MAX_FILES_SHOWN = 40;

function tidyRequest(req) {
  const out = { ...req };
  if (req.tabTitle !== undefined)
    out.tabTitle = shown(req.tabTitle, 120);
  if (req.summary !== undefined)
    out.summary = shown(req.summary, 120);
  if (req.element)
    out.element = { role: shown(req.element.role, 30), name: shown(req.element.name, 80), reason: shown(req.element.reason, 160) };
  if (Array.isArray(req.files)) {
    // File names are kept whole where possible (the end matters most: it is the name and type).
    const one = (f) => {
      const t = shown(f, 100000);
      return t.length > 260 ? '…' + t.slice(-259) : t;
    };
    out.files = req.files.slice(0, MAX_FILES_SHOWN).map(one);
    if (req.files.length > MAX_FILES_SHOWN)
      out.files.push(`…and ${req.files.length - MAX_FILES_SHOWN} more files (${req.files.length} in all)`);
  }
  return out;
}

function ask(req) {
  req = tidyRequest(req);
  // Consequential-action confirmations are about one element, never shared between calls.
  const key = req.type === 'upload' || req.type === 'action' ? null : `${req.type}:${req.origin}`;
  if (key && byKey.has(key))
    return byKey.get(key);
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  logQuestion(req, 'asked');
  const p = new Promise((resolve) => {
    const entry = { req, resolve, windowId: null, timer: null };
    pending.set(id, entry);
    entry.timer = setTimeout(() => finish(id, 'timeout'), state.promptTimeoutMs);
    const height = { upload: 420, pair: 330, action: 440, upgrade: 380 }[req.type] || 410;
    browser.windows.create({ url: `${PROMPT_URL()}?id=${id}`, type: 'popup', width: 520, height, focused: true })
      .then((w) => {
        entry.windowId = w.id;
        if (!pending.has(id))
          browser.windows.remove(w.id).catch(() => {});
      })
      .catch(() => finish(id, 'dismissed'));
  });
  if (key) {
    byKey.set(key, p);
    p.finally(() => byKey.delete(key));
  }
  return p;
}

function finish(id, answer, level = 'full') {
  const e = pending.get(id);
  if (!e)
    return;
  pending.delete(id);
  clearTimeout(e.timer);
  if (e.windowId != null && answer === 'timeout')
    browser.windows.remove(e.windowId).catch(() => {});
  e.resolve({ answer, level });
  logQuestion(e.req, answer, level);
}

export function handlePromptMessage(msg, sender) {
  if (!isPromptSender(sender))
    return undefined;
  if (msg.kind === 'prompt-details') {
    const e = pending.get(msg.id);
    return Promise.resolve(e ? e.req : null);
  }
  if (msg.kind === 'prompt-answer') {
    const type = pending.get(msg.id)?.req.type;
    let a = ['once', 'always', 'hour', 'deny'].includes(msg.answer) ? msg.answer : 'deny';
    // Only site questions have "always" and "for 1 hour"; uploads and action confirmations are one-off.
    if ((a === 'always' || a === 'hour') && !LEVEL_TYPES.has(type))
      a = type === 'pair' ? 'deny' : 'once';
    // "Read only" is offered for new site and frame approvals; an upgrade is always to full access.
    const level = (type === 'site' || type === 'frame') && msg.readOnly === true ? 'read' : 'full';
    finish(msg.id, a, level);
    return Promise.resolve(true);
  }
  return undefined;
}

browser.windows.onRemoved.addListener((windowId) => {
  for (const [id, e] of pending) {
    if (e.windowId === windowId)
      finish(id, 'dismissed');
  }
});

/** The user paused Foxwright: answer every open question with "deny" and close the windows. */
export function denyAllPrompts() {
  for (const [id, e] of [...pending]) {
    if (e.windowId != null)
      browser.windows.remove(e.windowId).catch(() => {});
    finish(id, 'deny');
  }
}

/** Another browser was chosen (or the agent gave up): close this browser's "use this Firefox?" windows. */
export function cancelPairPrompts() {
  for (const [id, e] of [...pending]) {
    if (e.req.type !== 'pair')
      continue;
    if (e.windowId != null)
      browser.windows.remove(e.windowId).catch(() => {});
    finish(id, 'dismissed');
  }
}
