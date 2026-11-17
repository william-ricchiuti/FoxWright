/* global browser */
// First-run / setup-help page. Shows the setup command for this OS and a live connection status
// that flips to "Connected" by itself once `npx foxwright-firefox setup` has run.
const $ = (id) => document.getElementById(id);

const PLATFORM = {
  mac: {
    terminal: 'Open Terminal (press Cmd+Space, type Terminal, press Return), paste this command and press Return:',
    node: 'Download the “LTS” installer for macOS from nodejs.org and run it, then open a new Terminal window.',
    stopKey: 'Option+Shift+K',
    desktopRestart: 'When it finishes, quit Claude Desktop completely (Claude menu › Quit Claude, or Cmd+Q) and open it again. Closing its window is not enough.',
  },
  win: {
    terminal: 'Open Command Prompt (press the Windows key, type cmd, press Enter), paste this command and press Enter:',
    node: 'Download the “LTS” installer for Windows from nodejs.org (or run winget install OpenJS.NodeJS.LTS) and run it, then open a new Command Prompt window.',
    stopKey: 'Alt+Shift+K',
    desktopRestart: 'When it finishes, quit Claude Desktop completely (right-click its icon next to the clock and choose Quit) and open it again. Closing its window is not enough.',
  },
  linux: {
    terminal: 'Open a terminal and run:',
    node: 'Install it from nodejs.org or your distribution\'s packages (some distributions ship an older one).',
    stopKey: 'Alt+Shift+K',
    desktopRestart: 'When it finishes, quit Claude Desktop completely and open it again.',
    note: 'Using Ubuntu\'s built-in Firefox? It is a Snap. Snap and Flatpak Firefox run in a sandbox that often can\'t start the helper, so step 2 stays at “Helper not found”. Check with snap list firefox or flatpak list | grep -i firefox. If either lists Firefox, install Firefox from Mozilla\'s own .deb repository or tarball (search support.mozilla.org for “Install Firefox on Linux”) and add Foxwright to that Firefox. Firefox Sync can bring your bookmarks and passwords along.',
  },
};

// The setup command and what to do after it, per AI app.
const CLIENTS = {
  'claude-desktop': { flag: ' --claude-desktop', next: null, restart: 'Once Claude Desktop is open again, ask it:' },
  'claude-code': { flag: ' --claude-code', next: 'When it finishes, start a new Claude Code session. Typing /mcp there should list “foxwright”.', restart: 'Start a new Claude Code session, then ask it:' },
  other: { flag: '', next: 'When it finishes, setup prints the settings for Cursor, Codex, VS Code, Gemini CLI, Windsurf, Zed and other MCP apps. Copy the lines for your app into its MCP settings and restart the app. “Connect other AI apps” at the bottom of this page shows where each app keeps them.', restart: 'Restart your AI app so it loads Foxwright, then ask it:' },
};

let platform = PLATFORM.linux;
let isLinux = false; // until applyPlatform() knows
let connected = false;

function applyClient() {
  const choice = document.querySelector('input[name=client]:checked')?.value;
  const c = CLIENTS[choice] || CLIENTS['claude-code'];
  $('cmd').textContent = `npx foxwright-firefox setup${c.flag}`;
  $('client-next').textContent = c.next || platform.desktopRestart;
  $('restart-hint').textContent = c.restart;
}
for (const r of document.querySelectorAll('input[name=client]'))
  r.addEventListener('change', applyClient);

/** force: 'mac' | 'win' | 'linux' to preview another system's text (screenshots); else this one's. */
async function applyPlatform(force) {
  let os = force || 'linux';
  if (!force) {
    try {
      os = (await browser.runtime.getPlatformInfo()).os;
    } catch { /* keep the default */ }
  }
  const p = PLATFORM[os] || PLATFORM.linux;
  platform = p;
  isLinux = !!p.note;
  document.documentElement.dataset.os = os;
  $('terminal-hint').textContent = p.terminal;
  $('node-hint').textContent = p.node;
  $('stop-key').textContent = p.stopKey;
  $('win-ps-hint').hidden = os !== 'win';
  // Once connected, the sandbox warning no longer applies.
  $('linux-note').hidden = !p.note || connected;
  if (p.note)
    $('linux-note').textContent = p.note;
  applyClient();
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
  connected = !!s.connected;
  $('linux-note').hidden = !isLinux || connected;
  const dot = $('dot');
  let live, diag = '';
  if (s.connected) {
    dot.className = 'dot ok';
    live = 'Connected';
    diag = s.helperVersion ? `Helper ${s.helperVersion} is running.` : 'The helper is running.';
    for (const n of s.versionNotes || [])
      diag += ` ${n.text}${n.cmd ? ` ${n.cmd}` : ''}`;
    if (s.errorKind === 'helper-error' && s.lastError)
      diag += ` It reported a problem: ${s.lastError}`;
  } else if (s.errorKind === 'not-installed') {
    dot.className = 'dot bad';
    live = 'Helper not found';
    diag = 'Firefox can\'t find the Foxwright helper on this computer yet. Run the command in step 1.';
    if (isLinux)
      diag += ' Already ran it? Read the note about Snap and Flatpak Firefox at the top of this page.';
  } else if (s.errorKind === 'exited') {
    dot.className = 'dot bad';
    live = 'Helper found, but it stopped';
    diag = `Firefox started the helper, but it stopped${s.lastError ? ` (${s.lastError})` : ''}. The usual cause is a missing or old Node.js: install Node.js 20 or newer, run the command in step 1 again, then press Check again. For details, run npx foxwright-firefox doctor in a terminal.`;
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
