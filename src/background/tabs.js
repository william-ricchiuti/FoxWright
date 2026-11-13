// Agent tab group, per-site permission, and messaging with content scripts.
/* global browser */
import { state, saveSettings, pruneTimed } from './state.js';
import { askSite } from './prompt.js';
import { docTypes } from './netlog.js';

const GROUP_TITLE = 'Foxwright';
const hasGroups = () => typeof browser.tabs.group === 'function' && !!browser.tabGroups;
const fallbackTabs = new Set(); // used only if the tab-group API is unavailable

// ---------- tab group ----------

async function validGroupId() {
  if (!hasGroups())
    return null;
  // A group in a private window is never the agent's (when Foxwright is allowed in private windows).
  const inPrivate = async (g) => {
    try {
      return (await browser.windows.get(g.windowId)).incognito;
    } catch {
      return false;
    }
  };
  if (state.groupId != null) {
    try {
      const g = await browser.tabGroups.get(state.groupId);
      if (!(await inPrivate(g)))
        return state.groupId;
    } catch { /* group gone (closed or restored with a new id) */ }
  }
  try {
    // The saved id is gone (e.g. after a browser restart restored the group with a new id).
    // Re-adopt a group only if it looks exactly like ours: title and orange color. A group the
    // user made for their own tabs is unlikely to match both, and its tabs would otherwise
    // become usable by the agent without anyone asking.
    let found = await browser.tabGroups.query({ title: GROUP_TITLE, color: 'orange' });
    // Also the titles from before the renames (Kitsune → Zenko in 0.6.0, Zenko → Foxwright in 0.7.0).
    for (const title of ['Foxwright ● working', 'Zenko', 'Zenko ● working', 'Kitsune', 'Kitsune ● working']) {
      if (!found.length)
        found = await browser.tabGroups.query({ title, color: 'orange' });
    }
    const usable = [];
    for (const g of found) {
      if (!(await inPrivate(g)))
        usable.push(g);
    }
    found = usable;
    if (found.length) {
      state.groupId = found[0].id;
      await saveSettings();
      return state.groupId;
    }
  } catch { /* ignore */ }
  state.groupId = null;
  return null;
}

export async function groupTabs() {
  if (!hasGroups()) {
    const out = [];
    for (const id of fallbackTabs) {
      try {
        out.push(await browser.tabs.get(id));
      } catch {
        fallbackTabs.delete(id);
      }
    }
    const usable = out.filter(t => !t.incognito);
    state.groupTabIds = new Set(usable.map(t => t.id));
    return usable;
  }
  const gid = await validGroupId();
  if (gid == null) {
    state.groupTabIds = new Set();
    return [];
  }
  const all = await browser.tabs.query({});
  const tabs = all.filter(t => t.groupId === gid && !t.incognito);
  state.groupTabIds = new Set(tabs.map(t => t.id));
  return tabs;
}

let groupLock = Promise.resolve();
export function addToGroup(tabId) {
  // Serialize: two concurrent calls must not each create a new group.
  const run = groupLock.then(() => addToGroupNow(tabId));
  groupLock = run.catch(() => {});
  return run;
}

async function addToGroupNow(tabId) {
  const tab = await browser.tabs.get(tabId);
  if (tab.incognito)
    throw privateTabError(tabId);
  if (!hasGroups()) {
    fallbackTabs.add(tabId);
    state.groupTabIds.add(tabId);
    return;
  }
  const gid = await validGroupId();
  if (gid != null) {
    await browser.tabs.group({ groupId: gid, tabIds: [tabId] });
  } else {
    // In the tab's own window: by default a new group goes to the focused window, which may be private.
    state.groupId = await browser.tabs.group({ tabIds: [tabId], createProperties: { windowId: tab.windowId } });
    try {
      await browser.tabGroups.update(state.groupId, { title: GROUP_TITLE, color: 'orange' });
    } catch { /* ignore */ }
    await saveSettings();
  }
  state.groupTabIds.add(tabId);
}

export async function createAgentTab(url = 'about:blank', active = true) {
  // Always in a normal window: if the person is in a private window (and allowed Foxwright there),
  // the agent's tab still goes to a normal one, or a new normal window.
  const windowId = await normalWindowId();
  let tab;
  if (windowId != null) {
    tab = await browser.tabs.create({ url, active, windowId });
  } else {
    const w = await browser.windows.create({ url, incognito: false });
    tab = w.tabs[0];
  }
  await addToGroup(tab.id);
  return browser.tabs.get(tab.id);
}

export async function ensureGroup(createIfEmpty) {
  let tabs = await groupTabs();
  if (!tabs.length && createIfEmpty) {
    await createAgentTab();
    tabs = await groupTabs();
  }
  return tabs;
}

export async function requireTab(tabId) {
  if (typeof tabId !== 'number')
    throw new Error('tabId is required. Call tabs_context_mcp first to get the IDs of tabs in the Foxwright group.');
  let tab;
  try {
    tab = await browser.tabs.get(tabId);
  } catch {
    throw new Error(`Tab ${tabId} does not exist. Call tabs_context_mcp to get current tab IDs.`);
  }
  if (tab.incognito)
    throw privateTabError(tabId);
  // Always re-read the group: a tab the user just dragged out must lose access at once.
  await groupTabs();
  if (!state.groupTabIds.has(tabId))
    throw new Error(`Tab ${tabId} is not in the Foxwright tab group, so the agent may not use it. Use tabs_context_mcp / tabs_create_mcp, or ask the user to drag the tab into the orange "Foxwright" group.`);
  return tab;
}

// ---------- permissions ----------

const RESTRICTED_HOSTS = ['addons.mozilla.org', 'accounts-static.cdn.mozilla.net', 'accounts.firefox.com', 'content.cdn.mozilla.net', 'discovery.addons.mozilla.org', 'install.mozilla.org', 'oauth.accounts.firefox.com', 'profile.accounts.firefox.com', 'support.mozilla.org', 'sync.services.mozilla.com'];

export function originOf(url) {
  try {
    const u = new URL(url);
    if (u.protocol === 'http:' || u.protocol === 'https:')
      return u.origin;
    if (u.protocol === 'file:')
      return 'file://' + u.pathname.replace(/[^/]*$/, ''); // approval is per local folder
    if (u.protocol === 'blob:')
      return originOf(u.pathname);
    return null;
  } catch {
    return null;
  }
}

export function checkAccessible(tab) {
  const url = tab.url || '';
  if (url === 'about:blank' || url === '' || url === 'about:newtab' || url === 'about:home')
    return 'blank';
  let u;
  try {
    u = new URL(url);
  } catch {
    throw new Error(`Cannot access ${url}.`);
  }
  if (u.protocol === 'about:' || u.protocol === 'moz-extension:' || u.protocol === 'view-source:' || u.protocol === 'chrome:' || u.protocol === 'resource:')
    throw new Error(`Firefox does not let extensions read or control ${url}. Navigate to a regular web page.`);
  if (RESTRICTED_HOSTS.includes(u.hostname))
    throw new Error(`Firefox blocks all extensions on ${u.hostname} for security, so Foxwright cannot access it.`);
  return 'ok';
}

// Access levels. "read": the agent may look (read_page, find, get_page_text, screenshots, console and
// network logs), scroll, hover, press reading keys and navigate. "full": it may also click, type,
// drag, fill forms, upload files, accept dialogs and run JavaScript. The level of an origin is the
// highest of its approvals: "Allow all sites" and the policy's "allowed" list are full access.
export const LEVELS = { read: 1, full: 2 };

export function levelOf(origin) {
  if (!origin)
    return null;
  if (state.mode === 'all' || state.managedAllowed.includes(origin))
    return 'full';
  let best = null;
  const take = (lv) => {
    if (!best || LEVELS[lv] > LEVELS[best])
      best = lv;
  };
  if (state.allowed.includes(origin))
    take(state.readOnly.includes(origin) ? 'read' : 'full');
  if (state.sessionAllowed.includes(origin))
    take(state.sessionReadOnly.includes(origin) ? 'read' : 'full');
  const t = state.timed[origin];
  if (t) {
    if (t.until > Date.now())
      take(t.level);
    else
      expireSoon();
  }
  if (state.managedReadOnly.includes(origin))
    take('read');
  return best;
}

let expireTimer = null;
function expireSoon() {
  // An "Allow for 1 hour" approval ran out: forget it (and save) outside the current check.
  if (!expireTimer) {
    expireTimer = setTimeout(() => {
      expireTimer = null;
      if (pruneTimed())
        saveSettings().catch(() => {});
    }, 0);
  }
}

export function isAllowed(origin) {
  return levelOf(origin) !== null;
}

const HOUR_MS = 60 * 60 * 1000;
// Sites where the person turned down "let the agent click and type here": asked once, not again
// until they change the site's approval (popup) or grant it anew.
const upgradeDenied = new Set();

/** Revoke every approval of an origin (popup ✕). */
export function forgetSite(origin) {
  state.allowed = state.allowed.filter(o => o !== origin);
  state.sessionAllowed = state.sessionAllowed.filter(o => o !== origin);
  state.readOnly = state.readOnly.filter(o => o !== origin);
  state.sessionReadOnly = state.sessionReadOnly.filter(o => o !== origin);
  delete state.timed[origin];
  upgradeDenied.delete(origin);
}

/** Record the person's answer: 'once' (this session), 'always' or 'hour', at level 'read' or 'full'. */
function grant(origin, answer, level) {
  const read = level === 'read';
  const put = (list, on) => (on ? (list.includes(origin) ? list : [...list, origin]) : list.filter(o => o !== origin));
  if (answer === 'always') {
    state.allowed = put(state.allowed, true);
    state.readOnly = put(state.readOnly, read);
  } else if (answer === 'once') {
    state.sessionAllowed = put(state.sessionAllowed, true);
    state.sessionReadOnly = put(state.sessionReadOnly, read);
  } else if (answer === 'hour') {
    state.timed[origin] = { until: Date.now() + HOUR_MS, level: read ? 'read' : 'full' };
  }
  if (!read)
    upgradeDenied.delete(origin);
}

export function readOnlyError(origin, declined) {
  return new Error(`${origin} is approved for reading only, so Foxwright won't click, type, fill in forms, upload files or run scripts there${declined ? ' (the user declined to allow it)' : ''}. You can still read it: read_page, find, get_page_text, screenshots, scrolling and navigation work. If you need to act on this site, ask the user; they can change its access in the Foxwright toolbar popup.`);
}

function notAllowedError(origin, answer) {
  if (answer === 'deny' || answer === 'dismissed')
    return new Error(`The user did not allow Foxwright to access ${origin}. Do not retry on this site unless the user asks you to.`);
  return new Error(`Waiting for the user to allow ${origin} timed out. Ask the user to answer the Foxwright permission window, then try again.`);
}

/**
 * Make sure `origin` is approved at least at level `need` ('read' | 'full'), asking the person if not.
 * A site they approve as read-only while the agent is trying to act is refused straight away
 * (they just answered that question); a site that was already read-only asks once to upgrade.
 */
async function askForOrigin(origin, type, tabTitle, need = 'read') {
  const lv = levelOf(origin);
  if (!lv) {
    const { answer, level } = await askSite({ type, origin, tabTitle, wants: need });
    if (!['once', 'always', 'hour'].includes(answer))
      throw notAllowedError(origin, answer);
    grant(origin, answer, level);
    await saveSettings();
    if (need === 'full' && level === 'read')
      throw readOnlyError(origin, true);
    return;
  }
  if (need === 'full' && lv === 'read')
    await upgradeOrigin(origin, tabTitle);
}

async function upgradeOrigin(origin, tabTitle) {
  if (upgradeDenied.has(origin))
    throw readOnlyError(origin, true);
  const { answer } = await askSite({ type: 'upgrade', origin, tabTitle });
  if (['once', 'always', 'hour'].includes(answer)) {
    grant(origin, answer, 'full');
    await saveSettings();
    return;
  }
  if (answer === 'deny' || answer === 'dismissed') {
    upgradeDenied.add(origin);
    throw readOnlyError(origin, true);
  }
  throw new Error(`${origin} is approved for reading only, and waiting for the user to allow clicking and typing there timed out. Ask the user to answer the Foxwright window, then try again.`);
}

/** The tab's site must be approved at level `need` ('read' by default). */
export async function ensurePermission(tab, need = 'read') {
  if (checkAccessible(tab) === 'blank')
    return;
  const origin = originOf(tab.url);
  if (!origin)
    throw new Error(`Cannot access ${tab.url}.`);
  await askForOrigin(origin, 'site', tab.title, need);
}

export async function ensureOriginPermission(url, tabTitle, need = 'read') {
  const origin = originOf(url);
  if (origin)
    await askForOrigin(origin, 'site', tabTitle, need);
}

/** Origin of a frame's document; about:blank/srcdoc frames inherit from their parent. */
export async function frameOriginOf(tabId, frameId) {
  let cur = frameId;
  for (let i = 0; i < 10; i++) {
    const f = await browser.webNavigation.getFrame({ tabId, frameId: cur });
    if (!f)
      return null;
    const o = originOf(f.url);
    if (o)
      return o;
    if (cur === 0 || f.parentFrameId < 0)
      return null;
    cur = f.parentFrameId;
  }
  return null;
}

/** A frame whose site can't be determined (it vanished, or its address isn't a web page) is not allowed. */
export async function isFrameAllowed(tabId, frameId) {
  const o = await frameOriginOf(tabId, frameId).catch(() => null);
  return !!o && isAllowed(o);
}

function unknownFrameError(tabId, frameId) {
  return new Error(`Foxwright can't tell which site ${frameId === 0 ? `tab ${tabId}` : 'that embedded frame'} is showing (it may be navigating or gone), so it won't touch it. Call read_page again and retry.`);
}

export async function ensureFramePermission(tab, frameId, need = 'read') {
  if (frameId === 0)
    return ensurePermission(tab, need);
  const o = await frameOriginOf(tab.id, frameId).catch(() => null);
  if (!o)
    throw unknownFrameError(tab.id, frameId);
  await askForOrigin(o, 'frame', tab.title, need);
}

/** Make sure the site of a frame is approved at level `need`, asking to upgrade a read-only one. */
export async function ensureFrameLevel(tabId, frameId, need) {
  const o = await frameOriginOf(tabId, frameId).catch(() => null);
  if (!o)
    throw unknownFrameError(tabId, frameId);
  const t = await browser.tabs.get(tabId).catch(() => ({}));
  await askForOrigin(o, frameId === 0 ? 'site' : 'frame', t.title, need);
  return o;
}

// ---------- what each action needs ----------

// Keys that only move around the page: allowed on read-only sites unless focus is on a form
// control (where arrows, Home/End and PageUp/Down change values or move the caret).
const READ_KEYS = new Set(['pageup', 'pagedown', 'page_up', 'page_down', 'home', 'end', 'up', 'down', 'left', 'right', 'arrowup', 'arrowdown', 'arrowleft', 'arrowright', 'escape', 'esc']);
export function isReadingKeys(text) {
  const combos = String(text || '').trim().split(/\s+/).filter(Boolean);
  return combos.length > 0 && combos.every(c => READ_KEYS.has(c.toLowerCase()));
}

/** Content-script commands that change the page need full access; 'keys' = reading keys (see above). */
function commandNeed(cmd, args) {
  if (['click', 'type', 'drag', 'formInput', 'upload'].includes(cmd))
    return 'full';
  if (cmd === 'dialogPolicy')
    return args.accept ? 'full' : 'read';
  if (cmd === 'key')
    return isReadingKeys(args.text) ? 'keys' : 'full';
  return 'read';
}

// ---------- private windows ----------

/** A normal (non-private) browser window for new agent tabs; null if there is none. */
async function normalWindowId() {
  try {
    const w = await browser.windows.getLastFocused({ windowTypes: ['normal'] });
    if (w && !w.incognito)
      return w.id;
  } catch { /* no focused window */ }
  const all = await browser.windows.getAll({ windowTypes: ['normal'] }).catch(() => []);
  const w = all.find(x => !x.incognito);
  return w ? w.id : null;
}

export function privateTabError(tabId) {
  return new Error(`Tab ${tabId} is in a private window. Foxwright never lets the agent use private windows; use tabs_create_mcp to get a tab in a normal window.`);
}

// ---------- host permission revoked in Firefox's add-on settings ----------

/** True if the person turned off Foxwright's access to this site in about:addons. */
export async function hostAccessRevoked(url) {
  const o = originOf(url);
  if (!o || !/^https?:/.test(o))
    return false;
  try {
    return !(await browser.permissions.contains({ origins: [`${o}/*`] }));
  } catch {
    return false;
  }
}

export function hostAccessError(url) {
  const o = originOf(url) || url;
  return new Error(`Firefox's add-on settings block Foxwright on ${o}: its permission to access websites was turned off (about:addons → Foxwright → Permissions). This is not an error page or a problem with the site. Ask the user to turn the website access permission back on for Foxwright, then try again.`);
}

// ---------- content-script messaging ----------

// Firefox frame IDs are huge numbers; refs use short per-tab aliases instead (f1e3, f2e7...).
const frameAliases = new Map(); // tabId -> { toAlias: Map<frameId, n>, toFrame: Map<n, frameId> }

function aliasesFor(tabId) {
  let a = frameAliases.get(tabId);
  if (!a) {
    a = { toAlias: new Map(), toFrame: new Map() };
    frameAliases.set(tabId, a);
  }
  return a;
}

export function framePrefix(tabId, frameId) {
  if (frameId === 0)
    return '';
  const a = aliasesFor(tabId);
  let n = a.toAlias.get(frameId);
  if (!n) {
    n = a.toAlias.size + 1;
    a.toAlias.set(frameId, n);
    a.toFrame.set(n, frameId);
  }
  return `f${n}`;
}

export function frameForRef(tabId, ref) {
  const m = /^f(\d+)e\d+$/.exec(ref || '');
  if (!m)
    return 0;
  const frameId = frameAliases.get(tabId)?.toFrame.get(parseInt(m[1], 10));
  if (frameId === undefined)
    throw new Error(`Ref ${ref} belongs to a frame that is no longer known. Call read_page again.`);
  return frameId;
}

export function frameIdFromPrefix(tabId, prefix) {
  if (!prefix)
    return 0;
  const n = parseInt(prefix.slice(1), 10);
  return frameAliases.get(tabId)?.toFrame.get(n) ?? 0;
}

browser.tabs.onRemoved.addListener((tabId) => frameAliases.delete(tabId));

function withTimeout(p, ms, what) {
  return Promise.race([p, new Promise((_, rej) => setTimeout(() => rej(new Error(`${what} timed out after ${Math.round(ms / 1000)}s`)), ms))]);
}

// Tabs the agent acted in recently: a page that loads right after an agent action (a click that
// navigates, navigate itself) still gets its dialogs answered automatically.
const agentActivity = new Map(); // tabId -> time of the last agent command
export function noteAgentActivity(tabId) {
  if (typeof tabId === 'number')
    agentActivity.set(tabId, Date.now());
}
browser.tabs.onRemoved.addListener((tabId) => {
  agentActivity.delete(tabId);
  state.labels.delete(tabId);
});

/**
 * Console capture + non-blocking dialogs (isolated world, src/content/hooks.ts) and pointer-capture
 * emulation (page world, src/content/page-hooks.ts), injected as early as possible.
 */
export async function injectPageHooks(tabId, frameId = 0) {
  const target = { tabId, frameIds: [frameId] };
  const recent = Date.now() - (agentActivity.get(tabId) || 0) < 15000;
  try {
    // Start both injections at once: every round trip here lets more of the page's own
    // scripts run before console capture starts.
    await Promise.all([
      browser.scripting.executeScript({ target, files: ['content/hooks.js'], injectImmediately: true }),
      browser.scripting.executeScript({ target, files: ['content/page-hooks.js'], world: 'MAIN', injectImmediately: true }),
    ]);
    if (recent) {
      await browser.scripting.executeScript({
        target,
        func: (ms) => {
          const h = globalThis.__foxwrightHooks;
          if (h)
            h.agentUntil = Math.max(h.agentUntil, Date.now() + ms);
        },
        args: [8000],
        injectImmediately: true,
      });
    }
    return true;
  } catch {
    return false;
  }
}

export async function ensureContent(tabId, frameId = 0) {
  try {
    const r = await withTimeout(browser.tabs.sendMessage(tabId, { foxwright: true, cmd: 'ping', prefix: framePrefix(tabId, frameId) }, { frameId }), 1500, 'ping');
    if (r && r.ok)
      return;
  } catch { /* not injected yet */ }
  // One frame at a time: embedded frames (ads, payment and login widgets) only get Foxwright's scripts
  // when a tool actually reaches into them, after their own site has been approved.
  const target = { tabId, frameIds: [frameId] };
  await injectPageHooks(tabId, frameId);
  try {
    await browser.scripting.executeScript({ target, files: ['content/content.js'] });
  } catch (e) {
    if (/Missing host permission/i.test(String(e?.message)) && frameId === 0) {
      const t = await browser.tabs.get(tabId);
      if (await hostAccessRevoked(t.url))
        throw hostAccessError(t.url);
      const doc = docTypes.get(tabId) || { type: '', method: 'GET' };
      const ct = doc.type;
      if (/json/.test(ct))
        throw Object.assign(new Error(`Tab ${tabId} shows a JSON response in Firefox's built-in JSON viewer, which extensions can't read or screenshot. ${doc.method === 'GET' ? 'get_page_text can re-fetch it.' : `It was the answer to a ${doc.method} request, so it can't be re-fetched.`} To read JSON pages directly, the user can set devtools.jsonview.enabled = false in about:config.`), { jsonViewer: doc.method === 'GET' });
      if (/pdf/.test(ct))
        throw new Error(`Tab ${tabId} shows a PDF in Firefox's built-in PDF viewer, which extensions can't read or screenshot.`);
      throw new Error(`Tab ${tabId} is showing a Firefox error or internal page${t.title ? ` ("${t.title}")` : ''} for ${t.url}, which extensions can't read. The site may be down or unreachable; check the URL or try navigating again.`);
    }
    throw e;
  }
}

export async function sendContent(tabId, frameId, cmd, args = {}, timeoutMs = 30000, hops = 0) {
  const prefix = framePrefix(tabId, frameId);
  // Bind the command to the site that was approved: if the frame navigated to another
  // origin since the permission check, the content script refuses it.
  const expectOrigin = await frameOriginOf(tabId, frameId).catch(() => null);
  // Fail closed: a frame whose site can't be determined gets no commands at all.
  if (!expectOrigin)
    throw unknownFrameError(tabId, frameId);
  if (!isAllowed(expectOrigin))
    throw new Error(`Foxwright is not allowed to access ${expectOrigin}.`);
  // Commands that change the page need full access to the frame's site; a read-only site asks
  // the person once to allow it (frames from other sites are covered by their own approval).
  const need = commandNeed(cmd, args);
  if (need === 'full' && levelOf(expectOrigin) !== 'full')
    await ensureFrameLevel(tabId, frameId, 'full');
  else if (need === 'keys' && levelOf(expectOrigin) !== 'full') {
    // Reading keys scroll the page, but on a focused form control they change its value.
    const f = await sendContent(tabId, frameId, 'focusInfo', {}, 5000, hops);
    if (f?.control)
      await ensureFrameLevel(tabId, frameIdFromPrefix(tabId, f.prefix), 'full');
  }
  const msg = { foxwright: true, cmd, args, prefix, expectOrigin };
  let r;
  try {
    r = await withTimeout(browser.tabs.sendMessage(tabId, msg, { frameId }), timeoutMs, cmd);
  } catch (e) {
    const m = String(e?.message || e);
    if (/Receiving end does not exist|Could not establish connection/i.test(m)) {
      await ensureContent(tabId, frameId);
      r = await withTimeout(browser.tabs.sendMessage(tabId, msg, { frameId }), timeoutMs, cmd);
    } else {
      throw e;
    }
  }
  if (!r)
    throw new Error(`No response from the page for ${cmd}. The page may be navigating; try again.`);
  if (!r.ok)
    throw new Error(r.error);
  const res = r.result;
  if (res && res.forward && hops < 5) {
    const f = res.forward;
    // Acting inside an embedded frame from another site needs that site's approval too.
    await ensureFramePermission(await browser.tabs.get(tabId), f.frameId);
    await ensureContent(tabId, f.frameId);
    const next = { ...args, ...(f.args || {}) };
    if (f.x !== undefined) {
      next.x = f.x;
      next.y = f.y;
    }
    return sendContent(tabId, f.frameId, cmd, next, timeoutMs, hops + 1);
  }
  return res;
}

// ---------- activity indicator (extension-owned: tab group title + badge) ----------
let activityTimer = null;
async function setGroupTitle(title) {
  if (!hasGroups() || state.groupId == null)
    return;
  try {
    await browser.tabGroups.update(state.groupId, { title });
  } catch { /* ignore */ }
}

/** Offset of a frame's viewport inside the top-level viewport, in CSS px. */
export async function frameOrigin(tabId, frameId) {
  let x = 0, y = 0;
  let cur = frameId;
  for (let i = 0; i < 8 && cur !== 0; i++) {
    const info = await browser.webNavigation.getFrame({ tabId, frameId: cur });
    if (!info)
      return null;
    const off = await sendContent(tabId, info.parentFrameId, 'frameOffset', { frameId: cur }, 5000);
    if (!off)
      return null;
    x += off.x;
    y += off.y;
    cur = info.parentFrameId;
  }
  return { x, y };
}

export async function showActivity(tabId) {
  state.lastActivity = Date.now();
  if (!activityTimer)
    setGroupTitle('Foxwright ● working');
  clearTimeout(activityTimer);
  activityTimer = setTimeout(() => {
    activityTimer = null;
    setGroupTitle(GROUP_TITLE);
  }, 6000);
  try {
    const l = state.labels.get(tabId);
    const label = l && Date.now() - l.at < 10000 ? l.text : undefined;
    await browser.tabs.sendMessage(tabId, { foxwright: true, cmd: 'activity', args: { ms: 6000, label } }, { frameId: 0 });
  } catch { /* page may not have the content script (e.g. about:blank) */ }
}
