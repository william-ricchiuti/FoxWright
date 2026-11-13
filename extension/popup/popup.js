/* global browser */
const $ = (id) => document.getElementById(id);

function render(s) {
  const dot = $('dot');
  dot.className = 'dot ' + (s.paused ? 'bad' : s.connected ? 'ok' : 'bad');
  $('status-text').textContent = s.paused ? 'Paused'
    : s.connected ? (s.clients ? `Connected · ${s.clients} agent${s.clients > 1 ? 's' : ''} attached` : 'Ready · waiting for an agent')
      : 'Helper not connected';
  $('paused').hidden = !s.paused;
  $('setup').hidden = s.connected;
  $('err').textContent = s.lastError ? `(${s.lastError})` : '';
  $('bname').addEventListener('change', () => act({ kind: 'setName', name: $('bname').value }));
$('bname').addEventListener('keydown', (e) => {
  if (e.key === 'Enter')
    $('bname').blur();
});
for (const r of document.querySelectorAll('input[name=mode]')) {
    r.checked = r.value === s.mode;
    r.disabled = !!s.managedMode;
  }
  $('input-mode').textContent = s.bidi ? 'Trusted (WebDriver BiDi)' : 'Synthetic events';
  $('input-mode').className = 'tag' + (s.bidi ? ' trusted' : '');
  $('tabs').textContent = String(s.groupTabs);
  $('pause').hidden = s.paused;
  if (document.activeElement !== $('bname'))
    $('bname').value = s.browserName || '';
  $('build').textContent = `v${s.version}${s.full ? ' · full build' : ''}`;

  const recent = s.recentActions || [];
  $('recent-card').hidden = !recent.length;
  const rl = $('recent');
  rl.textContent = '';
  for (const r of recent) {
    const li = document.createElement('li');
    const t = document.createElement('time');
    const ago = Math.max(0, Math.round((Date.now() - r.at) / 1000));
    t.textContent = ago < 60 ? `${ago}s` : `${Math.round(ago / 60)}m`;
    const span = document.createElement('span');
    span.textContent = r.own ? `“${r.text}”` : r.text;
    span.title = span.textContent;
    li.append(t, span);
    rl.appendChild(li);
  }

  const ul = $('sites');
  ul.textContent = '';
  // Each approval with its kind; "read only" and "until HH:MM" tags come from the permission levels.
  const ro = (list, o) => ((list || []).includes(o) ? ' · read only' : '');
  const hhmm = (t) => new Date(t).toLocaleTimeString([], { hour: '2-digit', minute: '2-digit' });
  const entries = [
    ...(s.managedAllowed || []).map(o => [o, 'by policy']),
    ...(s.managedReadOnly || []).map(o => [o, 'by policy · read only']),
    ...s.allowed.map(o => [o, 'always' + ro(s.readOnly, o)]),
    ...s.sessionAllowed.filter(o => !s.allowed.includes(o)).map(o => [o, 'this session' + ro(s.sessionReadOnly, o)]),
    ...(s.timed || []).filter(t => !s.allowed.includes(t.origin)).map(t => [t.origin, `until ${hhmm(t.until)}${t.level === 'read' ? ' · read only' : ''}`]),
  ];
  $('confirm-actions').checked = !!s.confirmActions;
  $('confirm-actions').disabled = !!s.managedConfirm;
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
for (const r of document.querySelectorAll('input[name=mode]'))
  r.addEventListener('change', () => act({ kind: 'setMode', mode: r.value }));
$('confirm-actions').addEventListener('change', () => act({ kind: 'setConfirmActions', on: $('confirm-actions').checked }));

act({ kind: 'status', initial: true });
setInterval(() => act({ kind: 'status' }), 1500);
