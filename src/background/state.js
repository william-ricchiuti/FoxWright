// Shared background state + settings persistence.
/* global browser */

export const FULL = typeof __KITSUNE_FULL__ !== 'undefined' ? __KITSUNE_FULL__ : false;
export const VERSION = typeof __KITSUNE_VERSION__ !== 'undefined' ? __KITSUNE_VERSION__ : '0.0.0';

export const state = {
  // native connection
  connected: false,
  connecting: false,
  lastError: null,
  clients: 0,
  bidi: false,
  // user controls
  paused: false,
  mode: 'ask', // 'ask' = ask per site, 'all' = allow all sites
  allowed: [], // origins allowed forever
  sessionAllowed: [], // origins allowed until Firefox restarts
  // agent tab group
  groupId: null,
  groupTabIds: new Set(),
  lastActivity: 0,
  managedMode: false,
  managedAllowed: [],
  promptTimeoutMs: 120000,
  confirmUploads: true,
  // what the agent did lately (shown in the popup and the in-page pill); memory only
  recentActions: [], // [{ at, tabId, text, own }] newest first, at most 12
  labels: new Map(), // tabId -> { text, at }: the latest action summary, for the in-page pill
};

const RECENT_MAX = 12;
/** Clean up an agent-written summary: one line, no control characters, at most 120 characters. */
export function cleanSummary(s) {
  if (typeof s !== 'string')
    return '';
  const t = s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim();
  return t.length > 120 ? t.slice(0, 119) + '…' : t;
}

/** Note an agent action. `own` = the agent's own words (action_summary), else Kitsune's description. */
export function noteAction(tabId, text, own) {
  if (!text)
    return;
  state.recentActions.unshift({ at: Date.now(), tabId: typeof tabId === 'number' ? tabId : null, text, own: !!own });
  state.recentActions.length = Math.min(state.recentActions.length, RECENT_MAX);
  if (typeof tabId === 'number')
    state.labels.set(tabId, { text, at: Date.now() });
}

export async function loadSettings() {
  const local = await browser.storage.local.get({ mode: 'ask', allowed: [] });
  state.mode = local.mode === 'all' ? 'all' : 'ask';
  state.allowed = Array.isArray(local.allowed) ? local.allowed : [];
  // Administrators (and test profiles) can preset site access with an enterprise policy:
  // policies.json → "3rdparty": { "Extensions": { "<extension id>": { "mode": "all", "allowed": [...] } } }
  try {
    const managed = await browser.storage.managed.get(['mode', 'allowed', 'promptTimeoutSec', 'confirmUploads']);
    if (managed.mode === 'all' || managed.mode === 'ask') {
      state.mode = managed.mode;
      state.managedMode = true;
    }
    if (managed.confirmUploads === false)
      state.confirmUploads = false;
    if (typeof managed.promptTimeoutSec === 'number' && managed.promptTimeoutSec > 0)
      state.promptTimeoutMs = Math.min(150, managed.promptTimeoutSec) * 1000; // stays under the MCP call timeout
    if (Array.isArray(managed.allowed))
      state.managedAllowed = managed.allowed.filter(o => typeof o === 'string');
  } catch { /* no policy set */ }
  try {
    const sess = await browser.storage.session.get({ sessionAllowed: [], paused: false, groupId: null });
    state.sessionAllowed = sess.sessionAllowed || [];
    state.paused = !!sess.paused;
    state.groupId = sess.groupId ?? null;
  } catch { /* storage.session unavailable */ }
}

export async function saveSettings() {
  await browser.storage.local.set({ mode: state.mode, allowed: state.allowed });
  try {
    await browser.storage.session.set({ sessionAllowed: state.sessionAllowed, paused: state.paused, groupId: state.groupId });
  } catch { /* ignore */ }
}

export function publicStatus() {
  return {
    version: VERSION,
    full: FULL,
    connected: state.connected,
    lastError: state.lastError,
    clients: state.clients,
    bidi: state.bidi,
    paused: state.paused,
    mode: state.mode,
    managedMode: state.managedMode,
    managedAllowed: [...state.managedAllowed].sort(),
    allowed: [...state.allowed].sort(),
    sessionAllowed: [...state.sessionAllowed].sort(),
    groupTabs: state.groupTabIds.size,
    lastActivity: state.lastActivity,
    recentActions: state.recentActions.slice(0, 8),
  };
}

export async function updateBadge() {
  const a = browser.action;
  if (state.paused) {
    await a.setBadgeText({ text: '❚❚' });
    await a.setBadgeBackgroundColor({ color: '#c8321b' });
    await a.setTitle({ title: 'Kitsune: paused (click to resume)' });
  } else if (!state.connected) {
    await a.setBadgeText({ text: '!' });
    await a.setBadgeBackgroundColor({ color: '#7a6b5d' });
    await a.setTitle({ title: 'Kitsune: helper not connected (click for setup)' });
  } else {
    await a.setBadgeText({ text: '' });
    await a.setTitle({ title: `Kitsune: ready${state.clients ? ` (${state.clients} agent${state.clients > 1 ? 's' : ''} connected)` : ''}` });
  }
}
