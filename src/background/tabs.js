// Agent tab group, per-site permission, and messaging with content scripts.
/* global browser */
import { state, saveSettings } from './state.js';
import { askUser } from './prompt.js';
import { docTypes } from './netlog.js';

const GROUP_TITLE = 'Kitsune';
const hasGroups = () => typeof browser.tabs.group === 'function' && !!browser.tabGroups;
const fallbackTabs = new Set(); // used only if the tab-group API is unavailable

// ---------- tab group ----------

async function validGroupId() {
  if (!hasGroups())
    return null;
  if (state.groupId != null) {
    try {
      await browser.tabGroups.get(state.groupId);
      return state.groupId;
    } catch { /* group gone (closed or restored with a new id) */ }
  }
  try {
    let found = await browser.tabGroups.query({ title: GROUP_TITLE });
    if (!found.length)
      found = await browser.tabGroups.query({ title: 'Kitsune ● working' });
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
    state.groupTabIds = new Set(out.map(t => t.id));
    return out;
  }
  const gid = await validGroupId();
  if (gid == null) {
    state.groupTabIds = new Set();
    return [];
  }
  const all = await browser.tabs.query({});
  const tabs = all.filter(t => t.groupId === gid);
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
  if (!hasGroups()) {
    fallbackTabs.add(tabId);
    state.groupTabIds.add(tabId);
    return;
  }
  const gid = await validGroupId();
  if (gid != null) {
    await browser.tabs.group({ groupId: gid, tabIds: [tabId] });
  } else {
    state.groupId = await browser.tabs.group({ tabIds: [tabId] });
    try {
      await browser.tabGroups.update(state.groupId, { title: GROUP_TITLE, color: 'orange' });
    } catch { /* ignore */ }
    await saveSettings();
  }
  state.groupTabIds.add(tabId);
}

export async function createAgentTab(url = 'about:blank', active = true) {
  const tab = await browser.tabs.create({ url, active });
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
    throw new Error('tabId is required. Call tabs_context_mcp first to get the IDs of tabs in the Kitsune group.');
  let tab;
  try {
    tab = await browser.tabs.get(tabId);
  } catch {
    throw new Error(`Tab ${tabId} does not exist. Call tabs_context_mcp to get current tab IDs.`);
  }
  if (!state.groupTabIds.has(tabId))
    await groupTabs();
  if (!state.groupTabIds.has(tabId))
    throw new Error(`Tab ${tabId} is not in the Kitsune tab group, so the agent may not use it. Use tabs_context_mcp / tabs_create_mcp, or ask the user to drag the tab into the orange "Kitsune" group.`);
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
    throw new Error(`Firefox blocks all extensions on ${u.hostname} for security, so Kitsune cannot access it.`);
  return 'ok';
}

export function isAllowed(origin) {
  return state.mode === 'all' || state.allowed.includes(origin) || state.sessionAllowed.includes(origin) || state.managedAllowed.includes(origin);
}

async function askForOrigin(origin, type, tabTitle) {
  if (isAllowed(origin))
    return;
  const answer = await askUser({ type, origin, tabTitle });
  if (answer === 'always') {
    if (!state.allowed.includes(origin))
      state.allowed.push(origin);
  } else if (answer === 'once') {
    if (!state.sessionAllowed.includes(origin))
      state.sessionAllowed.push(origin);
  } else if (answer === 'deny' || answer === 'dismissed') {
    throw new Error(`The user did not allow Kitsune to access ${origin}. Do not retry on this site unless the user asks you to.`);
  } else {
    throw new Error(`Waiting for the user to allow ${origin} timed out. Ask the user to answer the Kitsune permission window, then try again.`);
  }
  await saveSettings();
}

export async function ensurePermission(tab) {
  if (checkAccessible(tab) === 'blank')
    return;
  const origin = originOf(tab.url);
  if (!origin)
    throw new Error(`Cannot access ${tab.url}.`);
  await askForOrigin(origin, 'site', tab.title);
}

export async function ensureOriginPermission(url, tabTitle) {
  const origin = originOf(url);
  if (origin)
    await askForOrigin(origin, 'site', tabTitle);
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

export async function isFrameAllowed(tabId, frameId) {
  const o = await frameOriginOf(tabId, frameId);
  return !o || isAllowed(o);
}

export async function ensureFramePermission(tab, frameId) {
  if (frameId === 0)
    return ensurePermission(tab);
  const o = await frameOriginOf(tab.id, frameId);
  if (o)
    await askForOrigin(o, 'frame', tab.title);
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

/** MAIN-world hooks: console capture + non-blocking dialogs (see src/content/page-hooks.ts). */
export async function injectPageHooks(tabId, frameId = 0) {
  try {
    await browser.scripting.executeScript({ target: { tabId, frameIds: [frameId] }, files: ['content/page-hooks.js'], world: 'MAIN', injectImmediately: true });
    return true;
  } catch {
    return false;
  }
}

export async function ensureContent(tabId, frameId = 0) {
  try {
    const r = await withTimeout(browser.tabs.sendMessage(tabId, { kitsune: true, cmd: 'ping', prefix: framePrefix(tabId, frameId) }, { frameId }), 1500, 'ping');
    if (r && r.ok)
      return;
  } catch { /* not injected yet */ }
  // One frame at a time: embedded frames (ads, payment and login widgets) only get Kitsune's scripts
  // when a tool actually reaches into them, after their own site has been approved.
  const target = { tabId, frameIds: [frameId] };
  await injectPageHooks(tabId, frameId);
  try {
    await browser.scripting.executeScript({ target, files: ['content/content.js'] });
  } catch (e) {
    if (/Missing host permission/i.test(String(e?.message)) && frameId === 0) {
      const t = await browser.tabs.get(tabId);
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
  if (expectOrigin && !isAllowed(expectOrigin))
    throw new Error(`Kitsune is not allowed to access ${expectOrigin}.`);
  const msg = { kitsune: true, cmd, args, prefix, expectOrigin };
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
    setGroupTitle('Kitsune ● working');
  clearTimeout(activityTimer);
  activityTimer = setTimeout(() => {
    activityTimer = null;
    setGroupTitle(GROUP_TITLE);
  }, 6000);
  try {
    await browser.tabs.sendMessage(tabId, { kitsune: true, cmd: 'activity', args: { ms: 6000 } }, { frameId: 0 });
  } catch { /* page may not have the content script (e.g. about:blank) */ }
}
