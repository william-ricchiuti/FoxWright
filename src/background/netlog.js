// Records network requests for tabs in the Kitsune group (for read_network_requests).
/* global browser */
import { state } from './state.js';

export const netLog = new Map(); // tabId -> [{url, method, type, status, error, time}]
export const docTypes = new Map(); // tabId -> content-type of the top-level document
const MAX = 500;

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
  list.push({ url: d.url, method: d.method, type: d.type, time: d.timeStamp, ...extra });
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
  browser.tabs.onRemoved.addListener((tabId) => {
    netLog.delete(tabId);
    docTypes.delete(tabId);
  });
}
