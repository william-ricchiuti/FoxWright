// `zenko setup`, `zenko doctor`, `zenko uninstall`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import net from 'node:net';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EXTENSION_IDS, HOST_NAME, zenkoDir, nativeManifestDir, socketPath, logPath } from './paths.js';

const isWin = process.platform === 'win32';
const REG_KEY = `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${HOST_NAME}`;
const c = {
  ok: (s) => `\x1b[32m✓\x1b[0m ${s}`,
  bad: (s) => `\x1b[31m✗\x1b[0m ${s}`,
  warn: (s) => `\x1b[33m!\x1b[0m ${s}`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
};

function appDir() {
  return path.join(zenkoDir(), 'app');
}
function appScript() {
  return path.join(appDir(), 'zenko.mjs');
}
function wrapperPath() {
  return path.join(zenkoDir(), isWin ? 'zenko-host.bat' : 'zenko-host');
}
/**
 * Native-messaging manifest folders of Firefox-based browsers that are installed besides Firefox
 * itself (they accept the same extension IDs). Only folders whose browser appears to be present.
 */
function extraManifestDirs() {
  if (process.env.ZENKO_NATIVE_MANIFEST_DIR || isWin)
    return [];
  const home = os.homedir();
  const mac = process.platform === 'darwin';
  const candidates = mac
    ? [['LibreWolf', path.join(home, 'Library', 'Application Support', 'LibreWolf')], ['Waterfox', path.join(home, 'Library', 'Application Support', 'Waterfox')]]
    : [
      ['Flatpak Firefox', path.join(home, '.var', 'app', 'org.mozilla.firefox', '.mozilla')],
      ['LibreWolf', path.join(home, '.librewolf')],
      ['Waterfox', path.join(home, '.waterfox')],
      ['Floorp', path.join(home, '.floorp')],
    ];
  return candidates.filter(([, base]) => fs.existsSync(base))
    .map(([name, base]) => [name, path.join(base, mac ? 'NativeMessagingHosts' : 'native-messaging-hosts')]);
}

function manifestFile() {
  return path.join(nativeManifestDir(), `${HOST_NAME}.json`);
}

export function mcpCommand() {
  return { command: process.execPath, args: [appScript(), 'mcp'] };
}

function shellQuote(s) {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}

function claudeDesktopConfigPath() {
  const home = os.homedir();
  if (process.platform === 'darwin')
    return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (isWin)
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  return path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
}

function which(cmd) {
  try {
    return execFileSync(isWin ? 'where' : 'which', [cmd], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).split(/\r?\n/)[0].trim() || null;
  } catch {
    return null;
  }
}

/**
 * Zenko was called Kitsune before 0.6.0. Remove that install: its Firefox registration, its
 * Claude entries and its files in ~/.kitsune. Carefully, because an unrelated project (also named
 * Kitsune: github.com/junyeong-nero/kitsune) uses ~/.kitsune and the Claude name "kitsune" too:
 * only things that are provably ours (our extension ids, our helper path) are removed.
 */
export function removeOldKitsune({ quiet = false } = {}) {
  const say = (m) => !quiet && console.log(c.ok(m));
  const home = os.homedir();
  const oldDir = path.join(home, '.kitsune');
  const oldApp = path.join(oldDir, 'app', 'kitsune.mjs');
  const ours = (text) => typeof text === 'string' && EXTENSION_IDS.some(id => text.includes(id));
  // Firefox native-messaging registrations named "kitsune" that list our extension ids.
  const dirs = [nativeManifestDir(), ...extraManifestDirs().map(([, d]) => d)];
  for (const d of dirs) {
    const f = path.join(d, 'kitsune.json');
    try {
      if (ours(fs.readFileSync(f, 'utf8'))) {
        fs.rmSync(f, { force: true });
        say(`Removed the old Kitsune registration ${f}`);
      }
    } catch { /* none */ }
  }
  if (isWin) {
    try {
      const out = execFileSync('reg', ['query', 'HKCU\\Software\\Mozilla\\NativeMessagingHosts\\kitsune', '/ve'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const m = /REG_SZ\s+(.+)/.exec(out);
      if (m && ours(fs.readFileSync(m[1].trim(), 'utf8'))) {
        execFileSync('reg', ['delete', 'HKCU\\Software\\Mozilla\\NativeMessagingHosts\\kitsune', '/f'], { stdio: 'ignore' });
        say('Removed the old Kitsune registry entry.');
      }
    } catch { /* none */ }
  }
  // Claude Code / Desktop entries named "kitsune" that run our old helper.
  const claude = which('claude');
  if (claude) {
    try {
      const out = execFileSync(claude, ['mcp', 'get', 'kitsune'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      if (/[\\/]\.kitsune[\\/]app[\\/]kitsune\.mjs/.test(out)) {
        execFileSync(claude, ['mcp', 'remove', '--scope', 'user', 'kitsune'], { stdio: 'ignore' });
        say('Removed the old "kitsune" entry from Claude Code.');
      }
    } catch { /* not registered */ }
  }
  const cfgPath = claudeDesktopConfigPath();
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const e = cfg.mcpServers?.kitsune;
    if (e && JSON.stringify(e.args || []).match(/[\\/]\.kitsune[\\/]app[\\/]kitsune\.mjs/)) {
      delete cfg.mcpServers.kitsune;
      fs.copyFileSync(cfgPath, cfgPath + '.bak');
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
      say(`Removed the old "kitsune" entry from Claude Desktop (${cfgPath}).`);
    }
  } catch { /* no config */ }
  // Our files in ~/.kitsune, then the folder only if nothing else is left in it.
  if (fs.existsSync(oldApp) || fs.existsSync(path.join(oldDir, isWin ? 'kitsune-host.bat' : 'kitsune-host'))) {
    for (const n of ['app/kitsune.mjs', 'app', 'kitsune-host', 'kitsune-host.bat', 'kitsune.sock', 'pipe-id', 'helper.log', 'helper.log.1', 'browsers']) {
      try {
        fs.rmSync(path.join(oldDir, n), { recursive: n === 'browsers' || n === 'app', force: true });
      } catch { /* in use or not there */ }
    }
    try {
      fs.rmdirSync(oldDir); // fails, harmlessly, if another program keeps files there
      say(`Removed ${oldDir}`);
    } catch {
      say(`Removed the old Kitsune files from ${oldDir} (other files there were left alone).`);
    }
  }
}

export async function setup(flags) {
  const self = fileURLToPath(import.meta.url);
  if (!/\.mjs$/.test(self) || typeof __ZENKO_BUNDLED__ === 'undefined') {
    console.error('Run setup from the bundled CLI (npx zenko-firefox setup, or `npm run build` in host/ and then `node host/dist/zenko.mjs setup`).');
    process.exit(1);
  }
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < 20) {
    console.error(`Zenko needs Node.js 20 or newer (found ${process.versions.node}).`);
    process.exit(1);
  }

  // 0. Zenko used to be called Kitsune: remove that install so the two don't run side by side.
  removeOldKitsune();

  // 1. Copy this single-file CLI somewhere stable (npx caches get cleaned).
  fs.mkdirSync(appDir(), { recursive: true, mode: 0o700 });
  if (!isWin)
    fs.chmodSync(zenkoDir(), 0o700);
  fs.copyFileSync(self, appScript());
  console.log(c.ok(`Installed helper to ${appScript()}`));

  // 2. Wrapper Firefox can execute (it can't pass interpreter args itself).
  if (isWin) {
    fs.writeFileSync(wrapperPath(), `@echo off\r\n"${process.execPath}" "${appScript()}" host %*\r\n`);
  } else {
    fs.writeFileSync(wrapperPath(), `#!/bin/sh\nexec ${shellQuote(process.execPath)} ${shellQuote(appScript())} host "$@"\n`, { mode: 0o755 });
    fs.chmodSync(wrapperPath(), 0o755);
  }
  console.log(c.ok(`Wrote launcher ${wrapperPath()} (uses Node at ${process.execPath})`));

  // 3. Native messaging manifest.
  fs.mkdirSync(nativeManifestDir(), { recursive: true });
  const manifest = {
    name: HOST_NAME,
    description: 'Zenko helper: connects the Zenko Firefox extension to local AI agents (MCP).',
    path: wrapperPath(),
    type: 'stdio',
    allowed_extensions: EXTENSION_IDS,
  };
  fs.writeFileSync(manifestFile(), JSON.stringify(manifest, null, 2) + '\n');
  if (isWin)
    execFileSync('reg', ['add', REG_KEY, '/ve', '/t', 'REG_SZ', '/d', manifestFile(), '/f'], { stdio: 'ignore' });
  console.log(c.ok(`Registered with Firefox: ${manifestFile()}${isWin ? ` (+ registry ${REG_KEY})` : ''}`));
  for (const [name, dir] of extraManifestDirs()) {
    try {
      fs.mkdirSync(dir, { recursive: true });
      fs.writeFileSync(path.join(dir, `${HOST_NAME}.json`), JSON.stringify(manifest, null, 2) + '\n');
      console.log(c.ok(`Also registered with ${name}: ${dir}`));
    } catch (e) {
      console.log(c.warn(`Couldn't register with ${name} (${e.message}).`));
    }
  }

  if (process.platform === 'linux') {
    if (fs.existsSync('/snap/bin/firefox') || which('flatpak') && fs.existsSync(path.join(os.homedir(), '.var/app/org.mozilla.firefox')))
      console.log(c.warn('Snap/Flatpak Firefox is sandboxed and may not be able to start the helper (Ubuntu ships the Snap by default). If the toolbar fox keeps its "!" badge, install Firefox from Mozilla\'s .deb repository or tarball: https://support.mozilla.org/kb/install-firefox-linux'));
  }

  // 4. Hook up AI clients.
  const { command, args } = mcpCommand();
  const cmdline = [command, ...args].map(shellQuote).join(' ');
  if (flags.includes('--claude-code') || flags.includes('--all')) {
    const claude = which('claude');
    if (claude) {
      try {
        execFileSync(claude, ['mcp', 'remove', '--scope', 'user', 'zenko'], { stdio: 'ignore' });
      } catch { /* not there yet */ }
      execFileSync(claude, ['mcp', 'add', '--scope', 'user', 'zenko', '--', command, ...args], { stdio: 'inherit' });
      console.log(c.ok('Added Zenko to Claude Code (user scope).'));
    } else {
      console.log(c.warn('`claude` CLI not found; skipping Claude Code.'));
    }
  }
  if (flags.includes('--claude-desktop') || flags.includes('--all')) {
    const cfgPath = claudeDesktopConfigPath();
    let cfg = {};
    try {
      cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    } catch { /* new file */ }
    cfg.mcpServers = cfg.mcpServers || {};
    cfg.mcpServers.zenko = { command, args };
    fs.mkdirSync(path.dirname(cfgPath), { recursive: true });
    if (fs.existsSync(cfgPath))
      fs.copyFileSync(cfgPath, cfgPath + '.bak');
    fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
    console.log(c.ok(`Added Zenko to Claude Desktop (${cfgPath}). Restart Claude Desktop to load it.`));
  }

  console.log(`
${c.b('Next steps')}
  1. Install the Zenko extension in Firefox (152+), then restart Firefox or toggle the extension off/on.
     The toolbar fox should lose its "!" badge once it finds this helper.
  2. Connect your AI client:
     ${c.b('Claude Code:')}   claude mcp add --scope user zenko -- ${cmdline}
     ${c.b('Claude Desktop / Cowork:')} add to claude_desktop_config.json → "mcpServers":
       "zenko": ${JSON.stringify({ command, args })}
     ${c.dim('(or re-run setup with --claude-code / --claude-desktop / --all to do this for you)')}
  3. Optional, real (trusted) clicks and typing: start Firefox with
       ${process.platform === 'darwin' ? '/Applications/Firefox.app/Contents/MacOS/firefox' : 'firefox'} --remote-debugging-port=9222
     Zenko detects it automatically. See README for trade-offs.

  Check everything with: ${c.b(`${shellQuote(process.execPath)} ${shellQuote(appScript())} doctor`)}
`);
}

function probeSocket() {
  return new Promise((resolve) => {
    const s = net.connect(socketPath());
    s.once('connect', () => {
      s.write(JSON.stringify({ type: 'status', id: 1 }) + '\n');
    });
    let buf = '';
    s.on('data', (d) => {
      buf += d;
      if (buf.includes('\n')) {
        s.destroy();
        try {
          resolve(JSON.parse(buf.split('\n')[0]));
        } catch {
          resolve({ error: 'bad reply' });
        }
      }
    });
    s.on('error', (e) => resolve({ error: e.code || e.message }));
    setTimeout(() => {
      s.destroy();
      resolve({ error: 'timeout' });
    }, 2000);
  });
}

async function probeBidi() {
  const { Bidi } = await import('./bidi.js');
  const b = new Bidi();
  if (!(await b.available())) {
    // Firefox allows one WebDriver session: a running Zenko MCP server may already hold it.
    if (/session not created|maximum|already/i.test(b.lastError || ''))
      return `WebDriver BiDi at ${b.url} (in use, probably by a running Zenko MCP server)`;
    return null;
  }
  try {
    await b.cmd('session.end', {});
  } catch { /* ignore */ }
  b.ws?.close();
  return `WebDriver BiDi at ${b.url}`;
}

export async function doctor() {
  let problems = 0;
  const line = (ok, s) => {
    console.log(ok ? c.ok(s) : c.bad(s));
    if (!ok)
      problems++;
  };
  console.log(c.b('Zenko doctor\n'));
  line(parseInt(process.versions.node) >= 20, `Node.js ${process.versions.node} (${process.execPath})`);
  line(fs.existsSync(appScript()), `Helper installed at ${appScript()}`);
  let manifest = null;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile(), 'utf8'));
  } catch { /* missing */ }
  line(!!manifest, `Native messaging manifest ${manifestFile()}`);
  if (manifest) {
    line(fs.existsSync(manifest.path), `Launcher exists: ${manifest.path}`);
    if (!isWin && fs.existsSync(manifest.path)) {
      const script = fs.readFileSync(manifest.path, 'utf8');
      const m = /exec '?([^' ]+)'?/.exec(script);
      if (m)
        line(fs.existsSync(m[1]), `Launcher's Node binary exists: ${m[1]}`);
    }
    line(EXTENSION_IDS.every(id => manifest.allowed_extensions?.includes(id)), 'Manifest allows the Zenko extension IDs');
  }
  if (isWin) {
    try {
      execFileSync('reg', ['query', REG_KEY], { stdio: 'ignore' });
      line(true, `Registry key ${REG_KEY}`);
    } catch {
      line(false, `Registry key ${REG_KEY}`);
    }
  }
  const st = await probeSocket();
  if (st.error) {
    line(false, `Firefox connection (${socketPath()}): ${st.error === 'ENOENT' || st.error === 'ECONNREFUSED' ? 'Firefox is not running, or the Zenko extension is not installed/enabled' : st.error}`);
  } else {
    line(!!st.extension, `Firefox connected: extension v${st.extension?.version || '?'}${st.extension?.full ? ' (full build)' : ''}, helper pid ${st.pid}`);
  }
  const bidi = await probeBidi();
  console.log(bidi ? c.ok(`Trusted input available: ${bidi}`) : c.dim('  Trusted input: off (optional; start Firefox with --remote-debugging-port=9222)'));
  console.log(c.dim(`  Helper log: ${logPath()}`));
  console.log(problems ? `\n${problems} problem(s) found. Re-run \`npx zenko-firefox setup\` to repair the installation.` : '\nAll good.');
  process.exit(problems ? 1 : 0);
}

export async function uninstall() {
  const files = [manifestFile(), ...extraManifestDirs().map(([, d]) => path.join(d, `${HOST_NAME}.json`)), wrapperPath(), appScript()];
  for (const p of files) {
    if (!fs.existsSync(p))
      continue;
    try {
      fs.rmSync(p, { force: true });
      console.log(c.ok(`Removed ${p}`));
    } catch { /* ignore */ }
  }
  if (isWin) {
    try {
      execFileSync('reg', ['delete', REG_KEY, '/f'], { stdio: 'ignore' });
    } catch { /* ignore */ }
  }
  // AI client registrations made by `setup --claude-code / --claude-desktop`.
  const claude = which('claude');
  if (claude) {
    try {
      execFileSync(claude, ['mcp', 'remove', '--scope', 'user', 'zenko'], { stdio: 'ignore' });
      console.log(c.ok('Removed Zenko from Claude Code.'));
    } catch { /* wasn't registered */ }
  }
  const cfgPath = claudeDesktopConfigPath();
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (cfg.mcpServers?.zenko) {
      delete cfg.mcpServers.zenko;
      fs.copyFileSync(cfgPath, cfgPath + '.bak');
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
      console.log(c.ok(`Removed Zenko from Claude Desktop (${cfgPath}).`));
    }
  } catch { /* no config */ }
  // The rest of ~/.zenko: socket, pipe id, logs.
  // Only a folder that is clearly Zenko's own: ZENKO_HOME could point anywhere.
  const dir = zenkoDir();
  if (path.isAbsolute(dir) && path.basename(dir) === '.zenko' && fs.existsSync(dir)) {
    fs.rmSync(dir, { recursive: true, force: true });
    console.log(c.ok(`Removed ${dir}`));
  }
  removeOldKitsune();
  console.log('Zenko helper removed. Also remove the Zenko extension from Firefox (about:addons) and from any other AI client you added it to.');
}
