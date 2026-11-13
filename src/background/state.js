// Shared background state + settings persistence.
/* global browser */

export const FULL = typeof __FOXWRIGHT_FULL__ !== 'undefined' ? __FOXWRIGHT_FULL__ : false;
export const VERSION = typeof __FOXWRIGHT_VERSION__ !== 'undefined' ? __FOXWRIGHT_VERSION__ : '0.0.0';

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
  // per-site access levels, time-limited approvals and action confirmation (see tabs.js levelOf)
  readOnly: [], // origins in `allowed` approved for reading only
  sessionReadOnly: [], // origins in `sessionAllowed` approved for reading only
  timed: {}, // origin -> { until (ms since epoch), level: 'read' | 'full' }: "Allow for 1 hour"
  managedReadOnly: [], // policy "allowedReadOnly": preset read-only approvals
  confirmActions: false, // ask before the agent submits a form or presses a consequential button
  managedConfirm: false, // confirmActions is set by policy (the popup can't change it)
  // which Firefox this is, when several are connected to Foxwright (stored per profile)
  browserId: '',
  browserName: 'Firefox',
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

/** Note an agent action. `own` = the agent's own words (action_summary), else Foxwright's description. */
export function noteAction(tabId, text, own) {
  if (!text)
    return;
  state.recentActions.unshift({ at: Date.now(), tabId: typeof tabId === 'number' ? tabId : null, text, own: !!own });
  state.recentActions.length = Math.min(state.recentActions.length, RECENT_MAX);
  if (typeof tabId === 'number')
    state.labels.set(tabId, { text, at: Date.now() });
}

export async function loadSettings() {
  const local = await browser.storage.local.get({ mode: 'ask', allowed: [], browserId: '', browserName: '', paused: false, readOnly: [], timed: {}, confirmActions: false });
  state.browserId = /^[a-f0-9]{12}$/.test(local.browserId) ? local.browserId : [...crypto.getRandomValues(new Uint8Array(6))].map(b => b.toString(16).padStart(2, '0')).join('');
  state.browserName = cleanName(local.browserName) || 'Firefox';
  if (state.browserId !== local.browserId)
    await browser.storage.local.set({ browserId: state.browserId });
  state.mode = local.mode === 'all' ? 'all' : 'ask';
  state.allowed = Array.isArray(local.allowed) ? local.allowed : [];
  state.readOnly = Array.isArray(local.readOnly) ? local.readOnly.filter(o => typeof o === 'string') : [];
  state.timed = cleanTimed(local.timed);
  state.confirmActions = local.confirmActions === true;
  // Stop stays in force across a Firefox restart or an extension update, until the user resumes.
  state.paused = !!local.paused;
  // Administrators (and test profiles) can preset site access with an enterprise policy:
  // policies.json → "3rdparty": { "Extensions": { "<extension id>": { "mode": "all", "allowed": [...] } } }
  try {
    const managed = await browser.storage.managed.get(['mode', 'allowed', 'promptTimeoutSec', 'confirmUploads', 'allowedReadOnly', 'confirmActions']);
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
    if (Array.isArray(managed.allowedReadOnly))
      state.managedReadOnly = managed.allowedReadOnly.filter(o => typeof o === 'string');
    if (typeof managed.confirmActions === 'boolean') {
      state.confirmActions = managed.confirmActions;
      state.managedConfirm = true;
    }
  } catch { /* no policy set */ }
  try {
    const sess = await browser.storage.session.get({ sessionAllowed: [], groupId: null, sessionReadOnly: [] });
    state.sessionAllowed = sess.sessionAllowed || [];
    state.sessionReadOnly = Array.isArray(sess.sessionReadOnly) ? sess.sessionReadOnly : [];
    state.groupId = sess.groupId ?? null;
  } catch { /* storage.session unavailable */ }
}

/** A browser name as the user typed it: one line, at most 40 characters. */
export function cleanName(s) {
  return typeof s === 'string' ? s.replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u2028-\u202e\u2066-\u2069]/g, ' ').replace(/\s+/g, ' ').trim().slice(0, 40) : '';
}

export async function saveSettings() {
  pruneTimed();
  await browser.storage.local.set({ mode: state.mode, allowed: state.allowed, browserName: state.browserName, paused: state.paused, readOnly: state.readOnly, timed: state.timed, confirmActions: state.confirmActions });
  try {
    await browser.storage.session.set({ sessionAllowed: state.sessionAllowed, groupId: state.groupId, sessionReadOnly: state.sessionReadOnly });
  } catch { /* ignore */ }
}

/** Time-limited approvals as stored: only well-formed entries that haven't expired. */
function cleanTimed(t) {
  const out = {};
  if (t && typeof t === 'object') {
    for (const [o, v] of Object.entries(t)) {
      if (v && typeof v.until === 'number' && v.until > Date.now())
        out[o] = { until: v.until, level: v.level === 'read' ? 'read' : 'full' };
    }
  }
  return out;
}

/** Drop expired "Allow for 1 hour" approvals. Returns true if any were removed. */
export function pruneTimed() {
  let changed = false;
  for (const [o, v] of Object.entries(state.timed)) {
    if (!(v.until > Date.now())) {
      delete state.timed[o];
      changed = true;
    }
  }
  return changed;
}

export function publicStatus() {
  pruneTimed();
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
    readOnly: [...state.readOnly],
    sessionReadOnly: [...state.sessionReadOnly],
    managedReadOnly: [...state.managedReadOnly].sort(),
    timed: Object.entries(state.timed).map(([origin, v]) => ({ origin, until: v.until, level: v.level })).sort((a, b) => a.origin.localeCompare(b.origin)),
    confirmActions: state.confirmActions,
    managedConfirm: state.managedConfirm,
    groupTabs: state.groupTabIds.size,
    lastActivity: state.lastActivity,
    recentActions: state.recentActions.slice(0, 8),
    browserId: state.browserId,
    browserName: state.browserName,
  };
}

export async function updateBadge() {
  const a = browser.action;
  if (state.paused) {
    await a.setBadgeText({ text: '❚❚' });
    await a.setBadgeBackgroundColor({ color: '#c8321b' });
    await a.setTitle({ title: 'Foxwright: paused (click to resume)' });
  } else if (!state.connected) {
    await a.setBadgeText({ text: '!' });
    await a.setBadgeBackgroundColor({ color: '#7a6b5d' });
    await a.setTitle({ title: 'Foxwright: helper not connected (click for setup)' });
  } else {
    await a.setBadgeText({ text: '' });
    await a.setTitle({ title: `Foxwright: ready${state.clients ? ` (${state.clients} agent${state.clients > 1 ? 's' : ''} connected)` : ''}` });
  }
}
