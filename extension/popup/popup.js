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
  for (const r of document.querySelectorAll('input[name=mode]')) {
    r.checked = r.value === s.mode;
    r.disabled = !!s.managedMode;
  }
  $('input-mode').textContent = s.bidi ? 'Trusted (WebDriver BiDi)' : 'Synthetic events';
  $('input-mode').className = 'tag' + (s.bidi ? ' trusted' : '');
  $('tabs').textContent = String(s.groupTabs);
  $('pause').hidden = s.paused;
  $('build').textContent = `v${s.version}${s.full ? ' · full build' : ''}`;

  const ul = $('sites');
  ul.textContent = '';
  const entries = [
    ...(s.managedAllowed || []).map(o => [o, 'by policy']),
    ...s.allowed.map(o => [o, 'always']),
    ...s.sessionAllowed.filter(o => !s.allowed.includes(o)).map(o => [o, 'this session']),
  ];
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
    if (kind !== 'by policy') {
      const x = document.createElement('button');
      x.className = 'x';
      x.textContent = '✕';
      x.title = `Revoke ${origin}`;
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

act({ kind: 'status' });
setInterval(() => act({ kind: 'status' }), 1500);
