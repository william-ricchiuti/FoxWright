// Kitsune background (event page).
/* global browser */
import { state, loadSettings, saveSettings, publicStatus, updateBadge } from './state.js';
import { connect, reconnectNow, onRequest, send } from './native.js';
import { tools, adoptOpenedTab } from './tools.js';
import { groupTabs, isAllowed, originOf, injectPageHooks } from './tabs.js';
import { handlePromptMessage } from './prompt.js';
import { startNetLog } from './netlog.js';

const PUBLIC_TOOLS = new Set(['tabs_context_mcp', 'tabs_create_mcp', 'tabs_close_mcp', 'navigate', 'read_page', 'find', 'form_input', 'get_page_text', 'computer', 'javascript_tool', 'read_console_messages', 'read_network_requests', 'handle_dialog', 'resize_window', 'file_upload']);

// Everything waits for settings to load, so an early message can't act on (or save) defaults.
let markReady;
const ready = new Promise(r => { markReady = r; });

onRequest(async (tool, args) => {
  await ready;
  const fn = tools[tool];
  if (!fn || (!PUBLIC_TOOLS.has(tool) && !tool.startsWith('_')))
    throw new Error(`Unknown tool ${tool}`);
  if (state.paused && tool !== '_status')
    throw new Error('Kitsune is paused: the user pressed Stop. Do not continue browser actions. Ask the user to click Resume in the Kitsune toolbar popup if they want you to carry on.');
  return fn(args);
});

// ---------- messages from the popup and in-page UI ----------
async function pauseAgent() {
  state.paused = true;
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
  // Everything else must come from our own popup page, not from content scripts.
  if (sender.tab)
    return undefined;
  switch (msg.kind) {
    case 'status':
      if (!state.connected)
        reconnectNow();
      await groupTabs();
      return publicStatus();
    case 'pause':
      state.paused = true;
      break;
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
      return publicStatus();
    default:
      return undefined;
  }
  await saveSettings();
  await updateBadge();
  return publicStatus();
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
browser.alarms.create('kitsune-reconnect', { periodInMinutes: 1 });
browser.alarms.onAlarm.addListener((a) => {
  if (a.name === 'kitsune-reconnect' && !state.connected)
    reconnectNow();
});

browser.runtime.onStartup.addListener(() => {});
browser.runtime.onInstalled.addListener(() => {});

(async () => {
  await loadSettings();
  markReady();
  await groupTabs().catch(() => {});
  await updateBadge();
  connect();
})();
