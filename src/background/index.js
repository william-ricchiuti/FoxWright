// Foxwright background (event page).
/* global browser */
import { state, loadSettings, saveSettings, publicStatus, updateBadge, cleanSummary, noteAction, cleanName } from './state.js';
import { connect, reconnectNow, onRequest, send } from './native.js';
import { tools, adoptOpenedTab } from './tools.js';
import { groupTabs, isAllowed, originOf, injectPageHooks, noteAgentActivity } from './tabs.js';
import { handlePromptMessage, denyAllPrompts } from './prompt.js';
import { startNetLog } from './netlog.js';
import { loadLog, flushLog, logEvent, describeForLog, resultOfError, logOrigin, readLog, clearLog, setLogEnabled, logEnabled } from './actionlog.js';

const PUBLIC_TOOLS = new Set(['tabs_context_mcp', 'tabs_create_mcp', 'tabs_close_mcp', 'navigate', 'read_page', 'find', 'form_input', 'get_page_text', 'computer', 'javascript_tool', 'read_console_messages', 'read_network_requests', 'handle_dialog', 'resize_window', 'file_upload']);

// Everything waits for settings to load, so an early message can't act on (or save) defaults.
let markReady;
const ready = new Promise(r => { markReady = r; });

onRequest(async (tool, args) => {
  await ready;
  const fn = tools[tool];
  if (!fn || (!PUBLIC_TOOLS.has(tool) && !tool.startsWith('_')))
    throw new Error(`Unknown tool ${tool}`);
  const logged = !tool.startsWith('_');
  // Where the action happens, for the activity log (origin only), read before the action runs.
  const where = logged && logEnabled() ? siteForLog(tool, args) : null;
  if (state.paused && tool !== '_status' && tool !== '_pair_cancel') {
    if (logged)
      logAction(tool, args, where, 'paused');
    throw new Error(PAUSED_MSG);
  }
  if (logged) {
    noteAgentActivity(args?.tabId);
    const own = cleanSummary(args?.action_summary);
    noteAction(args?.tabId, own || describeAction(tool, args), !!own);
  }
  let result;
  try {
    // One command at a time per tab: two agents (or parallel tool calls) acting on the same tab
    // would otherwise interleave focus, typing and refs.
    result = await inTabQueue(tool, args?.tabId, () => {
      // Stop may have been pressed while this command waited behind another one.
      if (state.paused && tool !== '_status' && tool !== '_pair_cancel')
        throw new Error(PAUSED_MSG);
      return fn(args);
    });
  } catch (e) {
    if (logged)
      logAction(tool, args, where, state.paused ? 'paused' : resultOfError(e));
    throw friendlyTabError(e, args?.tabId);
  } finally {
    if (!tool.startsWith('_'))
      noteAgentActivity(args?.tabId);
  }
  // Stop pressed while this command ran: don't report success for an interrupted action.
  if (state.paused && !tool.startsWith('_')) {
    logAction(tool, args, where, 'paused');
    throw new Error(PAUSED_MSG);
  }
  if (logged)
    logAction(tool, args, where, 'allowed');
  return result;
});

/** The site an agent action is about (a promise of an origin or null), for the activity log. */
function siteForLog(tool, args = {}) {
  if (tool === 'navigate' && typeof args.url === 'string' && !/^(back|forward)$/.test(args.url))
    return Promise.resolve(logOrigin(args.url) || logOrigin('https://' + args.url));
  if (typeof args.tabId !== 'number')
    return Promise.resolve(null);
  return browser.tabs.get(args.tabId).then(t => logOrigin(t.url || ''), () => null);
}

function logAction(tool, args = {}, where, result) {
  const own = cleanSummary(args.action_summary);
  const text = own || describeForLog(tool, args);
  if (!text)
    return;
  Promise.resolve(where).then((origin) => {
    logEvent({ kind: 'action', origin: origin || undefined, tabId: args.tabId, text, own: !!own, result });
  }, () => {});
}

/** Status for our own pages: the shared public status plus the activity-log setting. */
function pageStatus() {
  return { ...publicStatus(), logEnabled: logEnabled() };
}

/** Foxwright's own one-line description of an agent action, for the popup when the agent gave none. */
function describeAction(tool, a = {}) {
  const at = Array.isArray(a.coordinate) ? ` at ${a.coordinate.map(Math.round).join(', ')}` : a.ref ? ` on ${a.ref}` : '';
  if (tool === 'computer') {
    if (a.action === 'type')
      return `Typed ${String(a.text ?? '').length} characters`;
    if (a.action === 'key')
      return `Pressed ${String(a.text ?? '').slice(0, 40)}`;
    if (['screenshot', 'zoom', 'wait', 'scroll_to'].includes(a.action))
      return '';
    return `${String(a.action || '').replace(/_/g, ' ')}${at}`;
  }
  if (tool === 'navigate')
    return /^(back|forward)$/.test(a.url || '') ? `Went ${a.url}` : `Opened ${String(a.url || '').replace(/^https?:\/\//, '').slice(0, 80)}`;
  if (tool === 'form_input')
    return `Filled ${a.ref || 'a field'}`;
  if (tool === 'file_upload')
    return `Uploaded ${Array.isArray(a.files) ? a.files.length : ''} file(s)`;
  if (tool === 'javascript_tool')
    return 'Ran JavaScript in the page';
  return '';
}

const tabQueues = new Map(); // tabId -> promise of the last queued command
// Read-only status probes don't need to wait behind a long action.
const UNQUEUED = new Set(['_status', 'tabs_context_mcp', 'tabs_create_mcp', 'read_console_messages', 'read_network_requests']);

function inTabQueue(tool, tabId, run) {
  if (typeof tabId !== 'number' || UNQUEUED.has(tool))
    return run();
  const prev = tabQueues.get(tabId) || Promise.resolve();
  const next = prev.catch(() => {}).then(run);
  const tail = next.catch(() => {});
  tabQueues.set(tabId, tail);
  tail.then(() => {
    if (tabQueues.get(tabId) === tail)
      tabQueues.delete(tabId);
  });
  return next;
}

function friendlyTabError(e, tabId) {
  const m = String(e?.message || e);
  if (/Invalid tab ID|No tab with id|tab.*(closed|removed)/i.test(m) && !/^Tab \d+ /.test(m))
    return new Error(`Tab ${tabId ?? ''} was closed (by the user or the page) while Foxwright was using it. Call tabs_context_mcp to see the open tabs.`.replace('Tab  ', 'The tab '));
  return e;
}

const PAUSED_MSG = 'Foxwright is paused: the user pressed Stop. Do not continue browser actions. Ask the user to click Resume in the Foxwright toolbar popup if they want you to carry on.';

// ---------- messages from the popup and in-page UI ----------
const OWN_PAGES = ['popup/', 'welcome/', 'log/'];
function isOwnPage(sender) {
  return sender?.id === browser.runtime.id && typeof sender.url === 'string' && OWN_PAGES.some(p => sender.url.startsWith(browser.runtime.getURL(p)));
}

async function pauseAgent() {
  state.paused = true;
  // Stop work already in progress, not just new commands: open permission windows are denied
  // and content scripts abandon typing/drag loops at their next step.
  denyAllPrompts();
  for (const id of state.groupTabIds)
    browser.tabs.sendMessage(id, { foxwright: true, cmd: 'cancel' }).catch(() => {});
  await saveSettings();
  await updateBadge();
  send({ type: 'event', event: 'paused' });
}

browser.runtime.onMessage.addListener(async (msg, sender) => {
  if (!msg || typeof msg.kind !== 'string')
    return undefined;
  await ready;
  if (msg.kind === 'prompt-details' || msg.kind === 'prompt-answer')
    return handlePromptMessage(msg, sender);
  // In-page Stop button (only its trusted clicks send this).
  if (msg.kind === 'user-stop' && sender.tab) {
    await pauseAgent();
    return true;
  }
  // Everything else must come from one of our own pages (the toolbar popup, also when opened in
  // a tab), never from a content script: those report the web page's URL as sender.url.
  if (!isOwnPage(sender))
    return undefined;
  switch (msg.kind) {
    case 'status':
      if (!state.connected && msg.initial)
        reconnectNow(); // only when the popup opens: its 1.5 s refresh must not reset the reconnect backoff
      await groupTabs();
      return pageStatus();
    case 'pause':
      await pauseAgent();
      return pageStatus();
    case 'resume':
      state.paused = false;
      break;
    case 'setMode':
      if (!state.managedMode)
        state.mode = msg.mode === 'all' ? 'all' : 'ask';
      break;
    case 'removeSite':
      state.allowed = state.allowed.filter(o => o !== msg.origin);
      state.sessionAllowed = state.sessionAllowed.filter(o => o !== msg.origin);
      break;
    case 'reconnect':
      reconnectNow();
      return pageStatus();
    case 'log-read':
      await flushLog();
      return readLog();
    case 'log-clear':
      await clearLog();
      return readLog();
    case 'log-enable':
      await setLogEnabled(!!msg.enabled);
      return readLog();
    case 'open-page':
      if (msg.page === 'welcome' || msg.page === 'log')
        await openOwnPage(msg.page);
      return true;
    case 'setName':
      state.browserName = cleanName(msg.name) || 'Firefox';
      send({ type: 'name', name: state.browserName });
      break;
    default:
      return undefined;
  }
  await saveSettings();
  await updateBadge();
  return pageStatus();
});

// ---------- keep group bookkeeping fresh ----------
let refreshTimer = null;
function refreshSoon() {
  clearTimeout(refreshTimer);
  refreshTimer = setTimeout(() => groupTabs().catch(() => {}), 200);
}
browser.tabs.onUpdated.addListener((tabId, info) => {
  if ('groupId' in info || 'status' in info)
    refreshSoon();
});
browser.tabs.onRemoved.addListener(refreshSoon);
browser.tabs.onCreated.addListener(async (tab) => {
  // Pages opened from an agent tab (popups, target=_blank) join the agent's group.
  if (tab.openerTabId != null && state.groupTabIds.has(tab.openerTabId) && tab.groupId !== state.groupId) {
    try {
      await adoptOpenedTab(tab.id);
    } catch { /* ignore */ }
  }
  refreshSoon();
});

// Capture console output from the very start of page loads in agent tabs, on approved sites only.
browser.webNavigation.onCommitted.addListener((d) => {
  const o = originOf(d.url);
  if (state.groupTabIds.has(d.tabId) && o && isAllowed(o))
    injectPageHooks(d.tabId, d.frameId);
});

// Keyboard shortcut (Alt+Shift+K by default): pause the agent. Extension-owned, so pages can't block it.
browser.commands.onCommand.addListener(async (command) => {
  await ready;
  if (command === 'pause-agent')
    await pauseAgent();
});

startNetLog();

// Wake up periodically so a missing/crashed helper is retried even after idle unload.
browser.alarms.create('foxwright-reconnect', { periodInMinutes: 1 });
browser.alarms.onAlarm.addListener((a) => {
  if (a.name === 'foxwright-reconnect' && !state.connected)
    reconnectNow();
});

/** Open (or focus) one of our pages in a tab: 'welcome' (setup help) or 'log' (activity). */
export async function openOwnPage(page) {
  const url = browser.runtime.getURL(`${page}/${page}.html`);
  const open = (await browser.tabs.query({}).catch(() => [])).find(t => t.url === url || t.url?.startsWith(url + '#'));
  if (open) {
    await browser.tabs.update(open.id, { active: true });
    await browser.windows.update(open.windowId, { focused: true }).catch(() => {});
    return;
  }
  await browser.tabs.create({ url });
}

browser.runtime.onStartup.addListener(() => {});
// First install only (not updates): show the setup page, once per profile.
browser.runtime.onInstalled.addListener(async ({ reason }) => {
  if (reason !== 'install')
    return;
  const { welcomeShown } = await browser.storage.local.get({ welcomeShown: false });
  if (welcomeShown)
    return;
  await browser.storage.local.set({ welcomeShown: true });
  await openOwnPage('welcome').catch(() => {});
});
// Write any batched log entries before the event page unloads.
browser.runtime.onSuspend?.addListener(() => {
  flushLog();
});

(async () => {
  await loadSettings();
  await loadLog();
  markReady();
  await groupTabs().catch(() => {});
  await updateBadge();
  connect();
})();
