/* global browser */
// First-run / setup-help page. Shows the setup command for this OS and a live connection status
// that flips to "Connected" by itself once `npx foxwright-firefox setup` has run.
const $ = (id) => document.getElementById(id);

const PLATFORM = {
  mac: {
    terminal: 'Open Terminal (Applications › Utilities) and run:',
    node: 'Get it from nodejs.org, or with Homebrew: brew install node.',
    stopKey: 'Option+Shift+K',
  },
  win: {
    terminal: 'Open PowerShell (Start menu, type “PowerShell”) and run:',
    node: 'Get it from nodejs.org, or run winget install OpenJS.NodeJS.LTS, then open a new PowerShell window.',
    stopKey: 'Alt+Shift+K',
  },
  linux: {
    terminal: 'Open a terminal and run:',
    node: 'Get it from nodejs.org or your distribution\'s packages.',
    stopKey: 'Alt+Shift+K',
    note: 'Firefox from a Snap (Ubuntu\'s default) or Flatpak runs in a sandbox that may stop it from starting the helper. If the status below stays at “Helper not found” after setup, install Firefox from Mozilla\'s .deb package or tarball (support.mozilla.org, “Install Firefox on Linux”).',
  },
};

async function applyPlatform() {
  let os = 'linux';
  try {
    os = (await browser.runtime.getPlatformInfo()).os;
  } catch { /* keep the default */ }
  const p = PLATFORM[os] || PLATFORM.linux;
  document.documentElement.dataset.os = os;
  $('terminal-hint').textContent = p.terminal;
  $('node-hint').textContent = p.node;
  $('stop-key').textContent = p.stopKey;
  $('linux-note').hidden = !p.note;
  if (p.note)
    $('linux-note').textContent = p.note;
}

$('copy').addEventListener('click', async () => {
  const text = $('cmd').textContent;
  let ok = false;
  try {
    await navigator.clipboard.writeText(text);
    ok = true;
  } catch {
    // Fall back to selecting the command so Ctrl/Cmd+C copies it.
    const r = document.createRange();
    r.selectNodeContents($('cmd'));
    const sel = getSelection();
    sel.removeAllRanges();
    sel.addRange(r);
  }
  $('copied').textContent = ok ? 'Copied. Paste it into the terminal and press Enter.' : 'Selected. Press Ctrl+C (Cmd+C on a Mac) to copy.';
  $('copy').textContent = ok ? 'Copied' : 'Copy';
  setTimeout(() => {
    $('copy').textContent = 'Copy';
  }, 2500);
});

$('open-log').addEventListener('click', (e) => {
  e.preventDefault();
  browser.runtime.sendMessage({ kind: 'open-page', page: 'log' });
});

let last = null;
function render(s) {
  last = s;
  const dot = $('dot');
  let live, diag = '';
  if (s.connected) {
    dot.className = 'dot ok';
    live = 'Connected';
    diag = s.helperVersion ? `Helper ${s.helperVersion} is running.` : 'The helper is running.';
    if (s.versionMismatch)
      diag += ` It doesn't match this extension (${s.version}): run npx foxwright-firefox@latest setup to update it.`;
    if (s.errorKind === 'helper-error' && s.lastError)
      diag += ` It reported a problem: ${s.lastError}`;
  } else if (s.errorKind === 'not-installed') {
    dot.className = 'dot bad';
    live = 'Helper not found';
    diag = 'Firefox can\'t find the Foxwright helper on this computer yet. Run the command above.';
  } else if (s.errorKind === 'exited') {
    dot.className = 'dot bad';
    live = 'Helper found, but it stopped';
    diag = `Firefox started the helper, but it exited${s.lastError ? ` (${s.lastError})` : ''}. Check that Node.js 20 or newer is installed, then run npx foxwright-firefox doctor in a terminal to see what's wrong.`;
  } else {
    dot.className = 'dot wait';
    live = 'Looking for the helper…';
  }
  if ($('live').textContent !== live)
    $('live').textContent = live;
  $('diag').textContent = diag;
  $('auto-note').hidden = !!s.connected;
  $('retry').hidden = !!s.connected;
  $('step-install').classList.toggle('done', !!s.connected);
  $('step-connect').classList.toggle('done', !!s.connected);
  $('step-connect').classList.toggle('current', !s.connected);
  $('step-use').classList.toggle('current', !!s.connected);
  $('build').textContent = `Foxwright ${s.version}`;
  if (s.connected)
    retryDelay = 2000;
}

async function refresh(initial = false) {
  try {
    render(await browser.runtime.sendMessage({ kind: 'status', initial }));
  } catch { /* background restarting */ }
}

// While not connected, ask the background to try the helper again: soon at first, then less often.
let retryDelay = 2000;
let retryTimer = null;
function scheduleRetry() {
  clearTimeout(retryTimer);
  retryTimer = setTimeout(async () => {
    if (!last?.connected) {
      try {
        render(await browser.runtime.sendMessage({ kind: 'reconnect' }));
      } catch { /* ignore */ }
      retryDelay = Math.min(Math.round(retryDelay * 1.5), 15000);
    }
    scheduleRetry();
  }, retryDelay);
}

$('retry').addEventListener('click', async () => {
  retryDelay = 2000;
  try {
    render(await browser.runtime.sendMessage({ kind: 'reconnect' }));
  } catch { /* ignore */ }
  scheduleRetry();
});
document.addEventListener('visibilitychange', () => {
  if (document.visibilityState === 'visible') {
    retryDelay = 2000;
    refresh();
    scheduleRetry();
  }
});

applyPlatform();
refresh(true);
setInterval(refresh, 1500);
scheduleRetry();
