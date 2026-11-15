/* global browser */
// Activity page: the persistent log kept by src/background/actionlog.js.
const $ = (id) => document.getElementById(id);

const ACTION_RESULTS = { allowed: 'Done', denied: 'Site not allowed', paused: 'Stopped (paused)', failed: 'Failed' };
const ANSWER_RESULTS = { asked: 'Asked you', once: 'Allowed (session)', always: 'Allowed (always)', denied: 'Denied', timeout: 'No answer (timed out)', dismissed: 'Window closed', paused: 'Denied (paused)' };
const KIND_LABEL = { site: 'Site access', frame: 'Embedded site', upload: 'File upload', pair: 'Use this Firefox' };

let data = { enabled: true, entries: [] };
let shownKey = '';

const pad = n => String(n).padStart(2, '0');
function stamp(t) {
  const d = new Date(t);
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}:${pad(d.getSeconds())}`;
}
const siteLabel = o => (o ? o.replace(/^https:\/\//, '') : '—');
const UPLOAD_RESULTS = { ...ANSWER_RESULTS, once: 'Approved', denied: 'Refused' };
function resultLabel(e) {
  return (e.k === 'action' ? ACTION_RESULTS : e.k === 'upload' ? UPLOAD_RESULTS : ANSWER_RESULTS)[e.r] || e.r;
}
function describe(e) {
  if (e.k === 'action')
    return e.own ? `“${e.x}”` : e.x;
  return e.x ? `${KIND_LABEL[e.k] || 'Question'}: ${e.x}` : (KIND_LABEL[e.k] || 'Question');
}

function render() {
  const sel = $('site');
  const sites = [...new Set(data.entries.map(e => e.o).filter(Boolean))].sort();
  const want = sel.value;
  const optKey = sites.join('\n');
  if (sel.dataset.key !== optKey) {
    sel.dataset.key = optKey;
    sel.textContent = '';
    const all = document.createElement('option');
    all.value = '';
    all.textContent = 'All sites';
    sel.append(all);
    for (const s of sites) {
      const o = document.createElement('option');
      o.value = s;
      o.textContent = siteLabel(s);
      sel.append(o);
    }
    sel.value = sites.includes(want) ? want : '';
  }
  const filter = sel.value;
  const rows = filter ? data.entries.filter(e => e.o === filter) : data.entries;

  $('enabled').checked = data.enabled;
  $('off-note').hidden = data.enabled;
  $('empty').hidden = data.entries.length > 0;
  $('export').disabled = !data.entries.length;
  $('count').textContent = data.entries.length ? `${rows.length} of ${data.entries.length} entries${filter ? ` (${siteLabel(filter)})` : ''}` : '';

  // Rebuild only when something changed, so keyboard focus and scrolling stay put.
  const key = filter + '|' + rows.length + '|' + (rows[0]?.t || 0) + '|' + (rows[rows.length - 1]?.t || 0);
  if (key === shownKey)
    return;
  shownKey = key;
  const ol = $('log');
  ol.textContent = '';
  for (const e of rows) {
    const li = document.createElement('li');
    const time = document.createElement('time');
    time.dateTime = new Date(e.t).toISOString();
    time.textContent = stamp(e.t);
    const site = document.createElement('span');
    site.className = 'site';
    site.textContent = siteLabel(e.o);
    site.title = e.o || '';
    const what = document.createElement('span');
    what.className = 'what';
    what.textContent = describe(e);
    if (e.tab != null) {
      const small = document.createElement('small');
      small.textContent = `tab ${e.tab}`;
      what.append(small);
    }
    const res = document.createElement('span');
    res.className = `res ${e.r}`;
    res.textContent = resultLabel(e);
    li.append(time, site, what, res);
    ol.append(li);
  }
}

async function load() {
  try {
    data = await browser.runtime.sendMessage({ kind: 'log-read' });
  } catch { /* background restarting */ }
  render();
}

/** The JSON a person gets from "Export as JSON". */
function exportJson() {
  const filter = $('site').value;
  const rows = filter ? data.entries.filter(e => e.o === filter) : data.entries;
  return JSON.stringify({
    app: 'Foxwright',
    exportedAt: new Date().toISOString(),
    site: filter || null,
    entries: rows.map(e => ({
      time: new Date(e.t).toISOString(),
      kind: e.k,
      site: e.o,
      tabId: e.tab,
      description: e.x,
      agentWords: e.own,
      result: e.r,
    })),
  }, null, 2);
}

$('export').addEventListener('click', () => {
  const blob = new Blob([exportJson()], { type: 'application/json' });
  const url = URL.createObjectURL(blob);
  const a = document.createElement('a');
  a.href = url;
  a.download = `foxwright-activity-${stamp(Date.now()).slice(0, 10)}.json`;
  document.body.append(a);
  a.click();
  a.remove();
  setTimeout(() => URL.revokeObjectURL(url), 60000);
});

// Clearing can't be undone: the first press asks, a second press within a few seconds clears.
let armed = null;
$('clear').addEventListener('click', async () => {
  if (!armed) {
    $('clear').textContent = 'Press again to clear';
    armed = setTimeout(() => {
      armed = null;
      $('clear').textContent = 'Clear log';
    }, 4000);
    return;
  }
  clearTimeout(armed);
  armed = null;
  $('clear').textContent = 'Clear log';
  data = await browser.runtime.sendMessage({ kind: 'log-clear' });
  render();
});

$('enabled').addEventListener('change', async () => {
  data = await browser.runtime.sendMessage({ kind: 'log-enable', enabled: $('enabled').checked });
  render();
});
$('site').addEventListener('change', render);
$('open-help').addEventListener('click', (e) => {
  e.preventDefault();
  browser.runtime.sendMessage({ kind: 'open-page', page: 'welcome' });
});

load();
setInterval(load, 2000);
