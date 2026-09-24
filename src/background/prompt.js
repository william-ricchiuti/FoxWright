// Human confirmations shown in an extension-owned popup window (not in the web page),
// so pages can't hide, restyle, overlay or click-jack them.
/* global browser */
import { state } from './state.js';

const pending = new Map(); // id -> { req, resolve, windowId, timer }
const byKey = new Map(); // dedupe identical concurrent asks -> promise
const PROMPT_URL = () => browser.runtime.getURL('prompt/prompt.html');

export function isPromptSender(sender) {
  return !!sender?.url && sender.url.startsWith(PROMPT_URL());
}

/**
 * Ask the human. req = { type: 'site' | 'frame' | 'upload', origin, tabTitle?, files? }.
 * Resolves 'once' | 'always' | 'deny' | 'dismissed' | 'timeout'.
 */
export function askUser(req) {
  const key = req.type === 'upload' ? null : `${req.type}:${req.origin}`;
  if (key && byKey.has(key))
    return byKey.get(key);
  const id = Math.random().toString(36).slice(2) + Date.now().toString(36);
  const p = new Promise((resolve) => {
    const entry = { req, resolve, windowId: null, timer: null };
    pending.set(id, entry);
    entry.timer = setTimeout(() => finish(id, 'timeout'), state.promptTimeoutMs);
    browser.windows.create({ url: `${PROMPT_URL()}?id=${id}`, type: 'popup', width: 500, height: req.type === 'upload' ? 420 : 360, focused: true })
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

function finish(id, answer) {
  const e = pending.get(id);
  if (!e)
    return;
  pending.delete(id);
  clearTimeout(e.timer);
  if (e.windowId != null && answer === 'timeout')
    browser.windows.remove(e.windowId).catch(() => {});
  e.resolve(answer);
}

export function handlePromptMessage(msg, sender) {
  if (!isPromptSender(sender))
    return undefined;
  if (msg.kind === 'prompt-details') {
    const e = pending.get(msg.id);
    return Promise.resolve(e ? e.req : null);
  }
  if (msg.kind === 'prompt-answer') {
    const a = ['once', 'always', 'deny'].includes(msg.answer) ? msg.answer : 'deny';
    if (a === 'always' && pending.get(msg.id)?.req.type === 'upload')
      finish(msg.id, 'once');
    else
      finish(msg.id, a);
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

/** The user paused Kitsune: answer every open question with "deny" and close the windows. */
export function denyAllPrompts() {
  for (const [id, e] of [...pending]) {
    if (e.windowId != null)
      browser.windows.remove(e.windowId).catch(() => {});
    finish(id, 'deny');
  }
}
