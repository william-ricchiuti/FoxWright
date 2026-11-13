// Records network requests for tabs in the Zenko group (for read_network_requests).
/* global browser */
import { state } from './state.js';
import { originOf } from './tabs.js';

export const netLog = new Map(); // tabId -> [{url, method, type, status, error, time}]
export const docTypes = new Map(); // tabId -> content-type of the top-level document
const MAX = 500;
const topOrigins = new Map(); // tabId -> origin of the top-level document the log belongs to

function record(d, extra) {
  if (d.tabId < 0 || !state.groupTabIds.has(d.tabId))
    return;
  let list = netLog.get(d.tabId);
  if (d.type === 'main_frame' && list && list.length) {
    // New top-level document on a different site: start fresh, like DevTools does.
    try {
      const prev = list.findLast(r => r.type === 'main_frame');
      if (prev && new URL(prev.url).origin !== new URL(d.url).origin)
        list = [];
    } catch { /* ignore */ }
  }
  if (!list)
    list = [];
  list.push({ url: d.url, method: d.method, type: d.type, time: d.timeStamp, frameId: d.frameId, doc: d.documentUrl, ...extra });
  if (list.length > MAX)
    list.splice(0, list.length - MAX);
  netLog.set(d.tabId, list);
}

export function startNetLog() {
  const filter = { urls: ['<all_urls>'] };
  browser.webRequest.onCompleted.addListener(d => record(d, { status: d.statusCode }), filter);
  browser.webRequest.onHeadersReceived.addListener((d) => {
    if (d.type !== 'main_frame' || !state.groupTabIds.has(d.tabId))
      return;
    const ct = (d.responseHeaders || []).find(x => x.name.toLowerCase() === 'content-type')?.value || '';
    docTypes.set(d.tabId, { type: ct.toLowerCase(), method: d.method });
  }, { urls: ['<all_urls>'], types: ['main_frame'] }, ['responseHeaders']);
  browser.webRequest.onErrorOccurred.addListener(d => record(d, { error: d.error }), filter);
  // The log belongs to one site: when the tab's top-level document moves to another origin
  // (link, redirect, back/forward from the history cache), drop what was recorded before.
  // The request list alone can't tell: its main_frame entry may have been pushed out by the
  // 500-entry cap, and a page restored from the history cache makes no request at all.
  browser.webNavigation.onCommitted.addListener((d) => {
    if (d.frameId !== 0 || !state.groupTabIds.has(d.tabId))
      return;
    const o = originOf(d.url) || d.url;
    if (topOrigins.has(d.tabId) && topOrigins.get(d.tabId) !== o)
      netLog.set(d.tabId, (netLog.get(d.tabId) || []).filter(r => r.type === 'main_frame' && r.url === d.url));
    topOrigins.set(d.tabId, o);
  });
  browser.tabs.onRemoved.addListener((tabId) => {
    topOrigins.delete(tabId);
    netLog.delete(tabId);
    docTypes.delete(tabId);
  });
}
