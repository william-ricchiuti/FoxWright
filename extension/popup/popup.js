/* global browser */
const $ = (id) => document.getElementById(id);

const setTextEl = (el, t) => {
  if (el.textContent !== t)
    el.textContent = t;
};
const setText = (id, t) => setTextEl($(id), t);
let wasPaused = null;
let recentKey = '';
let sitesKey = '';

/** What to tell the person when the helper isn't connected (see errorKind in native.js). */
function diagnosis(s) {
  if (s.errorKind === 'not-installed')
    return { text: "Firefox can't find Foxwright's helper program on this computer. Install it from a terminal:", cmd: true };
  if (s.errorKind === 'exited')
    return { text: 'Firefox started the helper, but it stopped. Node.js 20 or newer may be missing; run npx foxwright-firefox doctor in a terminal to check.', cmd: false };
  return { text: "Looking for Foxwright's helper program…", cmd: false };
}

function render(s) {
  const dot = $('dot');
  dot.className = 'dot ' + (s.paused ? 'bad' : s.connected ? 'ok' : 'bad');
  setText('status-text', s.paused ? 'Paused'
    : s.connected ? (s.clients ? `Connected · ${s.clients} agent${s.clients > 1 ? 's' : ''} attached` : 'Ready · waiting for an agent')
      : 'Helper not connected');
  $('paused').hidden = !s.paused;
  document.body.classList.toggle('is-paused', !!s.paused);
  // Move focus to Resume when the popup shows the paused state, so Enter/Space resumes.
  if (s.paused && wasPaused !== true)
    $('resume').focus();
  wasPaused = !!s.paused;
  $('setup').hidden = s.connected;
  if (!s.connected) {
    const d = diagnosis(s);
    setText('diag', d.text);
    $('setup-cmd').hidden = !d.cmd;
    setText('err', s.lastError && s.errorKind === 'exited' ? `Firefox said: ${s.lastError}` : '');
  }
  $('version-warn').hidden = !s.versionMismatch;
  if (s.versionMismatch)
    setText('version-text', `The helper (${s.helperVersion}) and this extension (${s.version}) are different versions. Some tools may misbehave.`);
  for (const r of document.querySelectorAll('input[name=mode]')) {
    r.checked = r.value === s.mode;
    r.disabled = !!s.managedMode;
  }
  setText('input-mode', s.bidi ? 'Real (remote debugging)' : 'Simulated');
  $('input-mode').title = s.bidi ? 'Clicks and keys go through Firefox\'s remote-debugging port, like a person\'s.' : 'Clicks and keys are simulated with page events. Start Firefox with --remote-debugging-port for real input.';
  $('input-mode').className = 'tag' + (s.bidi ? ' trusted' : '');
  setText('helper', s.connected ? (s.helperVersion ? `v${s.helperVersion}` : 'older version') : 'not connected');
  $('helper').className = 'tag' + (s.versionMismatch || (s.connected && !s.helperVersion) ? ' warn' : '');
  setText('tabs', String(s.groupTabs));
  $('pause').hidden = s.paused;
  if (document.activeElement !== $('bname'))
    $('bname').value = s.browserName || '';
  setText('build', `v${s.version}${s.full ? ' · full build' : ''}`);

  const recent = s.recentActions || [];
  $('recent-card').hidden = !recent.length;
  const rl = $('recent');
  // Rebuild lists only when they change, so keyboard focus isn't lost on every refresh.
  const rk = JSON.stringify(recent.map(r => [r.at, r.text]));
  if (rk !== recentKey) {
    recentKey = rk;
    rl.textContent = '';
    for (const r of recent) {
      const li = document.createElement('li');
      const t = document.createElement('time');
      t.dataset.at = String(r.at);
      const span = document.createElement('span');
      span.textContent = r.own ? `“${r.text}”` : r.text;
      span.title = span.textContent;
      li.append(t, span);
      rl.appendChild(li);
    }
  }
  for (const t of rl.querySelectorAll('time')) {
    const ago = Math.max(0, Math.round((Date.now() - Number(t.dataset.at)) / 1000));
    setTextEl(t, ago < 60 ? `${ago}s` : `${Math.round(ago / 60)}m`);
  }

  const ul = $('sites');
  // Each approval with its kind; "read only" and "until HH:MM" tags come from the permission levels.
  const ro = (list, o) => ((list || []).includes(o) ? ' · read only' : '');
  const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  $('confirm-actions').checked = !!s.confirmActions;
  $('confirm-actions').disabled = !!s.managedConfirm;
  const entries = [
    ...(s.managedAllowed || []).map(o => [o, 'by policy']),
    ...(s.managedReadOnly || []).map(o => [o, 'by policy · read only']),
    ...s.allowed.map(o => [o, 'always' + ro(s.readOnly, o)]),
    ...s.sessionAllowed.filter(o => !s.allowed.includes(o)).map(o => [o, 'this session' + ro(s.sessionReadOnly, o)]),
    ...(s.timed || []).filter(t => !s.allowed.includes(t.origin)).map(t => [t.origin, `until ${hhmm(t.until)}${t.level === 'read' ? ' · read only' : ''}`]),
  ];
  const sk = JSON.stringify([entries, s.mode]);
  if (sk === sitesKey)
    return;
  sitesKey = sk;
  // Keep keyboard focus on the list when a revoke button that had it is removed.
  const hadFocus = ul.contains(document.activeElement);
  ul.textContent = '';
  if (hadFocus)
    $('sites-title').closest('section').querySelector('input[name=mode]:checked, input[name=mode]')?.focus();
  if (!entries.length) {
    const li = document.createElement('li');
    li.className = 'empty';
    li.textContent = s.mode === 'all' ? 'All sites are allowed.' : 'No sites approved yet.';
    ul.appendChild(li);
  }
  for (const [origin, kind] of entries) {
    const li = document.createElement('li');
    const span = document.createElement('span');
    span.textContent = origin.replace(/^https:\/\//, '');
    const em = document.createElement('em');
    em.textContent = kind;
    span.appendChild(em);
    li.append(span);
    if (!kind.startsWith('by policy')) {
      const x = document.createElement('button');
      x.className = 'x';
      x.textContent = '✕';
      x.type = 'button';
      x.title = `Revoke ${origin}`;
      x.setAttribute('aria-label', `Revoke access to ${origin}`);
      x.addEventListener('click', () => act({ kind: 'removeSite', origin }));
      li.append(x);
    }
    ul.appendChild(li);
  }
}

async function act(msg) {
  render(await browser.runtime.sendMessage(msg));
}

$('resume').addEventListener('click', () => act({ kind: 'resume' }));
$('pause').addEventListener('click', () => act({ kind: 'pause' }));
$('retry').addEventListener('click', () => act({ kind: 'reconnect' }));
$('bname').addEventListener('change', () => act({ kind: 'setName', name: $('bname').value }));
$('bname').addEventListener('keydown', (e) => {
  if (e.key === 'Enter')
    $('bname').blur();
});
function openPage(page) {
  browser.runtime.sendMessage({ kind: 'open-page', page }).finally(() => window.close());
}
$('help').addEventListener('click', () => openPage('welcome'));
$('footer-help').addEventListener('click', () => openPage('welcome'));
$('open-log').addEventListener('click', () => openPage('log'));
$('footer-log').addEventListener('click', () => openPage('log'));
for (const r of document.querySelectorAll('input[name=mode]'))
  r.addEventListener('change', () => act({ kind: 'setMode', mode: r.value }));
$('confirm-actions').addEventListener('change', () => act({ kind: 'setConfirmActions', on: $('confirm-actions').checked }));

act({ kind: 'status', initial: true });
setInterval(() => act({ kind: 'status' }), 1500);
