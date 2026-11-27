// `foxwright setup`, `foxwright doctor`, `foxwright uninstall`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import { EXTENSION_IDS, HOST_NAME, foxwrightDir, nativeManifestDir, socketPath, logPath, browsersDir } from './paths.js';
import { doctorVersionFindings, compareVersions, SETUP_LATEST, OLD_CLIENT_USER_MSG } from './compat.js';

const isWin = process.platform === 'win32';
const REG_KEY = `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${HOST_NAME}`;
// The name the 0.6.x (Zenko) extension asks Firefox for; setup registers this helper under it too.
const OLD_HOST_NAME = 'zenko';
const OLD_REG_KEY = `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${OLD_HOST_NAME}`;
const STORE_URL = 'https://addons.mozilla.org/firefox/addon/foxwright/';
const CLIENTS_URL = 'https://github.com/william-ricchiuti/FoxWright/blob/main/docs/CLIENTS.md';
const SETUP_CMD = 'npx foxwright-firefox setup';
const VERSION = typeof __FOXWRIGHT_VERSION__ !== 'undefined' ? __FOXWRIGHT_VERSION__ : '0.0.0';
// Colour only on a terminal, and never with NO_COLOR (https://no-color.org): AI agents, logs and
// pasted output get plain text instead of escape codes.
const color = !!process.stdout.isTTY && !process.env.NO_COLOR;
const sgr = (code, s) => (color ? `\x1b[${code}m${s}\x1b[0m` : s);
const c = {
  ok: (s) => `${sgr(32, '✓')} ${s}`,
  bad: (s) => `${sgr(31, '✗')} ${s}`,
  warn: (s) => `${sgr(33, '!')} ${s}`,
  b: (s) => sgr(1, s),
  dim: (s) => sgr(2, s),
};

function appDir() {
  return path.join(foxwrightDir(), 'app');
}
function appScript() {
  return path.join(appDir(), 'foxwright.mjs');
}
function wrapperPath() {
  return path.join(foxwrightDir(), isWin ? 'foxwright-host.bat' : 'foxwright-host');
}
/** Folders setup created (so uninstall can remove them again if they are empty). */
function createdDirsFile() {
  return path.join(foxwrightDir(), 'created-dirs.json');
}

/**
 * Firefox-based browsers besides Firefox itself (they accept the same extension IDs).
 *   write:   native-messaging folders of their own that setup registers in, for browsers that appear present.
 *   covered: browsers that appear present and read Firefox's own folder, which setup always writes.
 */
function otherBrowsers() {
  if (process.env.FOXWRIGHT_NATIVE_MANIFEST_DIR || isWin)
    return { write: [], covered: [] };
  const home = os.homedir();
  const has = (p) => fs.existsSync(p);
  if (process.platform === 'darwin') {
    const write = [['LibreWolf', path.join(home, 'Library', 'Application Support', 'LibreWolf')], ['Waterfox', path.join(home, 'Library', 'Application Support', 'Waterfox')]]
      .filter(([, base]) => has(base)).map(([name, base]) => [name, path.join(base, 'NativeMessagingHosts')]);
    return { write, covered: [] };
  }
  const write = [];
  const covered = [];
  if (has(path.join(home, '.var', 'app', 'org.mozilla.firefox', '.mozilla')))
    write.push(['Flatpak Firefox', path.join(home, '.var', 'app', 'org.mozilla.firefox', '.mozilla', 'native-messaging-hosts')]);
  // LibreWolf and Floorp used ~/.librewolf and ~/.floorp; newer versions keep their profiles in
  // ~/.config/<name> and read the Firefox registration in ~/.mozilla/native-messaging-hosts.
  for (const [name, legacy, xdg] of [['LibreWolf', '.librewolf', 'librewolf'], ['Waterfox', '.waterfox', null], ['Floorp', '.floorp', 'floorp']]) {
    if (has(path.join(home, legacy)))
      write.push([name, path.join(home, legacy, 'native-messaging-hosts')]);
    else if (xdg && has(path.join(home, '.config', xdg)))
      covered.push([name, path.join('~', '.config', xdg)]);
  }
  return { write, covered };
}
function extraManifestDirs() {
  return otherBrowsers().write;
}

function manifestFile() {
  return path.join(nativeManifestDir(), `${HOST_NAME}.json`);
}

// ---------- finding programs ----------

/**
 * Every file called `name` on PATH, in PATH order, without spawning anything. On Windows only
 * runnable kinds (.exe/.cmd/.bat/.com, in PATHEXT order): npm puts an extensionless shell script
 * next to claude.cmd, and `where claude` lists that one first although Windows can't run it.
 */
export function findAllOnPath(name, env = process.env) {
  const dirs = (env.PATH || env.Path || '').split(path.delimiter).map(d => d.replace(/^"(.*)"$/, '$1')).filter(Boolean);
  const exts = isWin
    ? (env.PATHEXT || '.COM;.EXE;.BAT;.CMD').toLowerCase().split(';').filter(e => ['.com', '.exe', '.bat', '.cmd'].includes(e))
    : [''];
  const out = [];
  for (const d of dirs) {
    for (const e of exts) {
      const p = path.join(d, name + e);
      try {
        const st = fs.statSync(p);
        if (st.isFile() && (isWin || (st.mode & 0o111)))
          out.push(p);
      } catch { /* not there */ }
    }
  }
  return [...new Set(out)];
}
function which(name) {
  return findAllOnPath(name)[0] || null;
}

/**
 * Run the Claude Code CLI. Node >= 20.12.2 refuses to spawn .cmd/.bat files directly (EINVAL), and
 * an npm-installed Claude Code on Windows is claude.cmd. Those go through cmd.exe, the way Node's
 * own `shell: true` does it, with every argument quoted; arguments cmd.exe can't carry safely
 * inside quotes (" and %, which it expands even there) are refused instead of risking injection.
 */
function runClaude(claude, args, opts = {}) {
  const o = { timeout: 60000, ...opts };
  if (isWin && /\.(cmd|bat)$/i.test(claude)) {
    const bad = [claude, ...args].find(a => /["%\r\n]/.test(a) || /\\$/.test(a));
    if (bad !== undefined)
      throw new Error(`can't pass ${JSON.stringify(bad)} through cmd.exe safely`);
    const line = [claude, ...args].map(a => `"${a}"`).join(' ');
    return execFileSync(process.env.ComSpec || 'cmd.exe', ['/d', '/s', '/c', `"${line}"`], { ...o, windowsVerbatimArguments: true });
  }
  return execFileSync(claude, args, o);
}

function shellQuote(s) {
  return /^[\w@%+=:,./-]+$/.test(s) ? s : `'${s.replace(/'/g, `'\\''`)}'`;
}
/** A command line to show the user, quoted for their shell (cmd/PowerShell on Windows). */
function displayCmd(parts) {
  return parts.map(s => (isWin ? (/^[\w@+=:,./\\-]+$/.test(s) ? s : `"${s}"`) : shellQuote(s))).join(' ');
}

// ---------- which Node the launcher and the AI clients run ----------

function realpath(p) {
  try {
    return fs.realpathSync(p);
  } catch {
    return null;
  }
}
function nodeMajor(bin, cwd) {
  try {
    const v = execFileSync(bin, ['--version'], { encoding: 'utf8', cwd, timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }).trim();
    const m = /^v(\d+)\./.exec(v);
    return m ? { major: +m[1], version: v.slice(1) } : null;
  } catch {
    return null;
  }
}

/**
 * Node.js paths that survive upgrades better than process.execPath, which is the resolved binary
 * (e.g. /opt/homebrew/Cellar/node/22.3.0/bin/node, removed by the next `brew upgrade`).
 *   stable: other paths that resolve to this very binary today: symlinks like /opt/homebrew/bin/node,
 *           Homebrew's opt/ link, a version manager's "default" alias, `node` on PATH.
 *   shims:  version-manager shims on PATH (Volta, asdf, mise, nodenv). They pick a Node themselves,
 *           so they are only a fallback, and only if the one they pick now is 20 or newer.
 */
export function nodeCandidates({ execPath = process.execPath, env = process.env, home = os.homedir() } = {}) {
  const real = realpath(execPath);
  const onPath = findAllOnPath('node', env);
  const guesses = [...onPath];
  if (isWin) {
    for (const pf of [env.ProgramFiles, env['ProgramFiles(x86)'], env.ProgramW6432].filter(Boolean))
      guesses.push(path.join(pf, 'nodejs', 'node.exe'));
    if (env.NVM_SYMLINK) // nvm-windows: a link to the active version
      guesses.push(path.join(env.NVM_SYMLINK, 'node.exe'));
    const scoop = env.SCOOP || path.join(home, 'scoop');
    guesses.push(path.join(scoop, 'apps', 'nodejs', 'current', 'node.exe'), path.join(scoop, 'apps', 'nodejs-lts', 'current', 'node.exe'));
    const fnm = env.FNM_DIR || path.join(env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'fnm');
    guesses.push(path.join(fnm, 'aliases', 'default', 'node.exe'));
  } else {
    const brew = /^(.*)\/Cellar\/(node(?:@\d+)?)\/[^/]+\/bin\/node$/.exec(real || '');
    if (brew)
      guesses.push(`${brew[1]}/opt/${brew[2]}/bin/node`, `${brew[1]}/bin/node`);
    guesses.push('/opt/homebrew/bin/node', '/usr/local/bin/node', '/usr/bin/node');
    for (const fnm of [env.FNM_DIR, path.join(home, '.local', 'share', 'fnm'), path.join(home, 'Library', 'Application Support', 'fnm'), path.join(home, '.fnm')].filter(Boolean))
      guesses.push(path.join(fnm, 'aliases', 'default', 'bin', 'node'));
    const mise = env.MISE_DATA_DIR || path.join(home, '.local', 'share', 'mise');
    const major = process.versions.node.split('.')[0];
    guesses.push(path.join(mise, 'installs', 'node', major, 'bin', 'node'), path.join(mise, 'installs', 'node', 'latest', 'bin', 'node'));
  }
  // fnm puts a per-shell link on PATH that disappears with the shell.
  const ephemeral = (p) => /fnm_multishells/.test(p);
  const stable = [...new Set(guesses)].filter(p => p !== execPath && !ephemeral(p) && real && realpath(p) === real);

  const shimPaths = isWin
    ? [path.join(env.LOCALAPPDATA || path.join(home, 'AppData', 'Local'), 'Volta', 'bin', 'node.exe')]
    : [
      path.join(env.VOLTA_HOME || path.join(home, '.volta'), 'bin', 'node'),
      path.join(env.ASDF_DATA_DIR || path.join(home, '.asdf'), 'shims', 'node'),
      path.join(env.MISE_DATA_DIR || path.join(home, '.local', 'share', 'mise'), 'shims', 'node'),
      path.join(env.NODENV_ROOT || path.join(home, '.nodenv'), 'shims', 'node'),
    ];
  const onPathReal = new Set(onPath.map(realpath));
  const shims = shimPaths.filter(p => fs.existsSync(p) && !stable.includes(p) && realpath(p) !== real && (onPath.includes(p) || onPathReal.has(realpath(p))))
    .filter(p => (nodeMajor(p, home)?.major || 0) >= 20);
  return { stable, shims };
}

let chosenNodes = null;
/** The Node.js paths setup writes, best first: { mcp: for AI client configs, launcher: tried in order }. */
function chooseNodes() {
  if (!chosenNodes) {
    const { stable, shims } = nodeCandidates();
    chosenNodes = { mcp: stable[0] || process.execPath, launcher: [...new Set([...stable, process.execPath, ...shims])] };
  }
  return chosenNodes;
}

export function mcpCommand() {
  return { command: chooseNodes().mcp, args: [appScript(), 'mcp'] };
}

/** The launcher Firefox runs: tries each Node in turn, then `node` on PATH, else says why it can't start. */
export function launcherScript(nodes, app = appScript(), log = logPath()) {
  const noNode = `Foxwright: no Node.js found (tried ${nodes.join(', ')} and node on PATH). Install Node.js 20 or newer, then run: ${SETUP_CMD}`;
  if (isWin) {
    const bat = (s) => s.replace(/%/g, '%%');
    return [
      '@echo off',
      `rem Foxwright helper launcher, written by \`foxwright setup\` ${VERSION}. Firefox runs it to start the helper.`,
      `rem nodes: ${JSON.stringify(nodes)}`,
      'set "FW_NODE="',
      ...nodes.map(n => `if not defined FW_NODE if exist "${bat(n)}" set "FW_NODE=${bat(n)}"`),
      'if not defined FW_NODE for %%I in (node.exe) do if not "%%~$PATH:I"=="" set "FW_NODE=%%~$PATH:I"',
      'if not defined FW_NODE goto nonode',
      `"%FW_NODE%" "${bat(app)}" host %*`,
      'exit /b %ERRORLEVEL%',
      ':nonode',
      'echo Foxwright: no Node.js found. Install Node.js 20 or newer, then run npx foxwright-firefox setup 1>&2',
      `>>"${bat(log)}" echo [%DATE% %TIME%] launcher: no Node.js found. Install Node.js 20 or newer, then run npx foxwright-firefox setup`,
      'exit /b 127',
      '',
    ].join('\r\n');
  }
  return [
    '#!/bin/sh',
    `# Foxwright helper launcher, written by \`foxwright setup\` ${VERSION}. Firefox runs it to start the helper.`,
    '# It tries each Node.js below in turn (a path that survives upgrades first), then `node` on PATH.',
    `# nodes: ${JSON.stringify(nodes)}`,
    `app=${shellQuote(app)}`,
    `for node in ${nodes.map(shellQuote).join(' ')}; do`,
    '  [ -x "$node" ] && exec "$node" "$app" host "$@"',
    'done',
    'node=$(command -v node 2>/dev/null) && exec "$node" "$app" host "$@"',
    `msg=${shellQuote(noNode)}`,
    'echo "$msg" >&2',
    `echo "[$(date -u +%Y-%m-%dT%H:%M:%SZ)] launcher: $msg" >> ${shellQuote(log)} 2>/dev/null`,
    'exit 127',
    '',
  ].join('\n');
}

/** The Node.js paths a launcher tries, in order (this version's layout and the single path of 0.7.1 and older). */
export function launcherNodes(text) {
  const m = /^(?:#|rem) nodes: (\[.*\])\s*$/m.exec(text);
  if (m) {
    try {
      return JSON.parse(m[1]);
    } catch { /* fall through */ }
  }
  const sh = /^exec\s+('(?:[^']|'\\'')*'|\S+)/m.exec(text);
  if (sh)
    return [sh[1].startsWith('\'') ? sh[1].slice(1, -1).replace(/'\\''/g, '\'') : sh[1]];
  const bat = /^"([^"]+)"\s+"[^"]+"\s+host\b/m.exec(text);
  return bat ? [bat[1]] : [];
}

// ---------- folders setup creates ----------

/** mkdir -p that remembers which folders didn't exist yet. */
function mkdirTracked(dir, created) {
  const missing = [];
  for (let d = path.resolve(dir); !fs.existsSync(d) && path.dirname(d) !== d; d = path.dirname(d))
    missing.push(d);
  fs.mkdirSync(dir, { recursive: true });
  created.push(...missing);
}
function readCreatedDirs() {
  try {
    const list = JSON.parse(fs.readFileSync(createdDirsFile(), 'utf8'));
    return Array.isArray(list) ? list.filter(d => typeof d === 'string' && path.isAbsolute(d)) : [];
  } catch {
    return [];
  }
}
/** Remove the folders setup created, deepest first, but only those that are empty now. */
function removeEmptyDirs(dirs) {
  for (const d of [...new Set(dirs)].sort((a, b) => b.length - a.length)) {
    try {
      fs.rmdirSync(d);
      console.log(c.ok(`Removed the empty folder ${d}`));
    } catch { /* not empty, or gone */ }
  }
}

function claudeDesktopConfigPath() {
  const home = os.homedir();
  if (process.platform === 'darwin')
    return path.join(home, 'Library', 'Application Support', 'Claude', 'claude_desktop_config.json');
  if (isWin)
    return path.join(process.env.APPDATA || path.join(home, 'AppData', 'Roaming'), 'Claude', 'claude_desktop_config.json');
  return path.join(home, '.config', 'Claude', 'claude_desktop_config.json');
}

/** A Claude Desktop config with nothing in it but an empty mcpServers (what setup creates, minus Foxwright). */
function isEmptyDesktopConfig(cfg, ignore = []) {
  if (!cfg || typeof cfg !== 'object' || Array.isArray(cfg))
    return false;
  const keys = Object.keys(cfg);
  if (keys.some(k => k !== 'mcpServers'))
    return false;
  const servers = cfg.mcpServers || {};
  return typeof servers === 'object' && Object.keys(servers).every(k => ignore.includes(k));
}

/**
 * Foxwright was called Kitsune before 0.6.0 and Zenko in 0.6.x. Remove those installs: the Firefox
 * registration, the Claude entries and the files in ~/.kitsune and ~/.zenko. Carefully, because an
 * unrelated project (also named Kitsune: github.com/junyeong-nero/kitsune) uses ~/.kitsune and the
 * Claude name "kitsune" too: only things that are provably ours (our extension ids, our helper
 * path) are removed.
 */
export function removeOldInstalls(opts = {}) {
  const a = removeOldInstall('kitsune', 'Kitsune', opts);
  const b = removeOldInstall('zenko', 'Zenko', opts);
  // Which AI clients had an entry for the old helper (setup gives them a Foxwright entry instead),
  // and whether there was an old install at all.
  return { claudeCode: a.claudeCode || b.claudeCode, claudeDesktop: a.claudeDesktop || b.claudeDesktop, found: a.found || b.found };
}

/** Is an install under an old name (Kitsune, Zenko) present? [{ name, label, dir }] */
export function oldInstallsPresent() {
  return [['kitsune', 'Kitsune'], ['zenko', 'Zenko']]
    .map(([name, label]) => ({ name, label, dir: path.join(os.homedir(), '.' + name) }))
    .filter(o => fs.existsSync(path.join(o.dir, 'app', o.name + '.mjs')) || fs.existsSync(path.join(o.dir, o.name + (isWin ? '-host.bat' : '-host'))));
}

function removeOldInstall(old, label, { quiet = false } = {}) {
  const did = { claudeCode: false, claudeDesktop: false, found: false };
  const oldHelper = new RegExp(`[\\\\/]\\.${old}[\\\\/]app[\\\\/]${old}\\.mjs`);
  const say = (m) => !quiet && console.log(c.ok(m));
  const home = os.homedir();
  const oldDir = path.join(home, '.' + old);
  const oldApp = path.join(oldDir, 'app', old + '.mjs');
  const ours = (text) => typeof text === 'string' && EXTENSION_IDS.some(id => text.includes(id));
  // setup's own registration under the old name (for 0.6 extensions) starts the current helper:
  // it's rewritten below, so removing it here would only print "Removed…" on every re-run.
  const current = (text) => {
    try {
      return JSON.parse(text).path === wrapperPath();
    } catch {
      return false;
    }
  };
  // Firefox native-messaging registrations named after the old name that list our extension ids.
  const dirs = [nativeManifestDir(), ...extraManifestDirs().map(([, d]) => d)];
  for (const d of dirs) {
    const f = path.join(d, old + '.json');
    try {
      const text = fs.readFileSync(f, 'utf8');
      if (ours(text) && !current(text)) {
        fs.rmSync(f, { force: true });
        say(`Removed the old ${label} registration ${f}`);
      }
    } catch { /* none */ }
  }
  if (isWin) {
    try {
      const out = execFileSync('reg', ['query', 'HKCU\\Software\\Mozilla\\NativeMessagingHosts\\' + old, '/ve'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const m = /REG_SZ\s+(.+)/.exec(out);
      const text = m ? fs.readFileSync(m[1].trim(), 'utf8') : '';
      if (ours(text) && !current(text)) {
        execFileSync('reg', ['delete', 'HKCU\\Software\\Mozilla\\NativeMessagingHosts\\' + old, '/f'], { stdio: 'ignore' });
        say(`Removed the old ${label} registry entry.`);
      }
    } catch { /* none */ }
  }
  // Claude Code / Desktop entries named after the old name that run our old helper.
  const claude = which('claude');
  if (claude) {
    try {
      const out = runClaude(claude, ['mcp', 'get', old], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      if (oldHelper.test(out)) {
        runClaude(claude, ['mcp', 'remove', '--scope', 'user', old], { stdio: 'ignore' });
        did.claudeCode = true;
        say(`Removed the old "${old}" entry from Claude Code.`);
      }
    } catch { /* not registered */ }
  }
  const cfgPath = claudeDesktopConfigPath();
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    const e = cfg.mcpServers?.[old];
    if (e && JSON.stringify(e.args || []).match(oldHelper)) {
      delete cfg.mcpServers[old];
      fs.copyFileSync(cfgPath, cfgPath + '.bak');
      fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
      did.claudeDesktop = true;
      say(`Removed the old "${old}" entry from Claude Desktop (${cfgPath}).`);
    }
  } catch { /* no config */ }
  // Our files in the old folder, then the folder only if nothing else is left in it.
  if (fs.existsSync(oldApp) || fs.existsSync(path.join(oldDir, old + (isWin ? '-host.bat' : '-host')))) {
    did.found = true;
    for (const n of [`app/${old}.mjs`, 'app', `${old}-host`, `${old}-host.bat`, `${old}.sock`, 'pipe-id', 'helper.log', 'helper.log.1', 'browsers']) {
      try {
        fs.rmSync(path.join(oldDir, n), { recursive: n === 'browsers' || n === 'app', force: true });
      } catch { /* in use or not there */ }
    }
    try {
      fs.rmdirSync(oldDir); // fails, harmlessly, if another program keeps files there
      say(`Removed ${oldDir}`);
    } catch {
      say(`Removed the old ${label} files from ${oldDir} (other files there were left alone).`);
    }
  }
  return did;
}

// ---------- helpers that are running while setup replaces them ----------

/**
 * Ask whatever listens on a helper socket who it is: { pid, version, pre08 } or null. The pid comes
 * from the live helper itself, over a socket in the user's own Foxwright folder, never from a file
 * a crashed helper may have left (that pid could belong to another program by now).
 * Understands helpers from before the 0.8 handshake too (they answer plain JSON lines).
 */
async function identifyHelper(sock) {
  const first = await new Promise((resolve) => {
    const s = net.connect(sock);
    let buf = '';
    let asked = false;
    const done = (v) => {
      clearTimeout(timer);
      clearTimeout(ask);
      s.destroy();
      resolve(v);
    };
    const timer = setTimeout(() => done(null), 4000);
    // A 0.8+ helper speaks first (its challenge). One from before says nothing until asked.
    const ask = setTimeout(() => {
      asked = true;
      s.write(JSON.stringify({ type: 'status', id: 1 }) + '\n');
    }, 700);
    s.setEncoding('utf8');
    s.on('data', (d) => {
      buf += d;
      const nl = buf.indexOf('\n');
      if (nl < 0)
        return;
      let msg = null;
      try {
        msg = JSON.parse(buf.slice(0, nl));
      } catch { /* not a helper */ }
      if (msg?.type === 'auth-challenge')
        return done('handshake');
      done(asked && msg?.type === 'status' && Number.isInteger(msg.pid) ? { pid: msg.pid, version: typeof msg.helper?.version === 'string' ? msg.helper.version : null, pre08: true } : null);
    });
    s.on('error', () => done(null));
    s.on('close', () => done(null));
  });
  if (first !== 'handshake')
    return first;
  const st = await probeSocket(sock);
  return !st.error && Number.isInteger(st.pid) ? { pid: st.pid, version: st.helper?.version || null, pre08: false } : null;
}

/** Sockets of the helpers registered in a Foxwright (or Zenko/Kitsune) folder, plus its shared socket. */
function helperSockets(dir, name) {
  const out = [];
  try {
    for (const n of fs.readdirSync(path.join(dir, 'browsers')).filter(f => f.endsWith('.json'))) {
      try {
        const e = JSON.parse(fs.readFileSync(path.join(dir, 'browsers', n), 'utf8'));
        if (typeof e.socket === 'string')
          out.push(e.socket);
      } catch { /* unreadable entry */ }
    }
  } catch { /* no registry */ }
  if (!isWin)
    out.push(path.join(dir, `${name}.sock`));
  return [...new Set(out)];
}

/**
 * The helpers a running Firefox started from an install that setup is replacing (another version
 * of Foxwright, or Zenko/Kitsune). Call before the old files are removed; stopHelpers() ends them
 * once the new helper is registered. The extension then starts the new helper by itself within
 * seconds (it retries from 2 s on), so the update takes effect without restarting Firefox.
 */
async function findReplacedHelpers() {
  const found = new Map(); // pid -> { pid, version, label }
  const dirs = [[foxwrightDir(), HOST_NAME, 'Foxwright'], ...oldInstallsPresent().map(o => [o.dir, o.name, o.label])];
  for (const [dir, name, label] of dirs) {
    for (const sock of helperSockets(dir, name)) {
      if (!isWin && !fs.existsSync(sock))
        continue;
      const id = await identifyHelper(sock).catch(() => null);
      if (!id || id.pid === process.pid || found.has(id.pid))
        continue;
      if (name === HOST_NAME && id.version === VERSION)
        continue; // already this version: leave it running
      found.set(id.pid, { ...id, label });
    }
  }
  return [...found.values()];
}

function stopHelpers(list) {
  const stopped = [];
  for (const h of list) {
    try {
      process.kill(h.pid, 'SIGTERM'); // the helper removes its sockets and exits
      stopped.push(h);
    } catch { /* gone already */ }
  }
  return stopped;
}

export async function setup(flags) {
  const self = fileURLToPath(import.meta.url);
  if (!/\.mjs$/.test(self) || typeof __FOXWRIGHT_BUNDLED__ === 'undefined') {
    console.error('Run setup from the bundled CLI (npx foxwright-firefox setup, or `npm run build` in host/ and then `node host/dist/foxwright.mjs setup`).');
    process.exit(1);
  }
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < 20) {
    console.error(`Foxwright needs Node.js 20 or newer (found ${process.versions.node}). Install the LTS version from https://nodejs.org, open a new terminal window, and run this command again.`);
    process.exit(1);
  }

  // 0. Foxwright used to be called Kitsune, then Zenko: remove those installs so they don't run side by side.
  //    Helpers of the install being replaced that a running Firefox still uses are stopped at the end.
  const hadInstall = fs.existsSync(appScript());
  const replaced = await findReplacedHelpers().catch(() => []);
  const migrated = removeOldInstalls();
  const updating = hadInstall || migrated.found;
  // An AI client that had an entry for the old helper gets one for this helper, flag or not:
  // otherwise it would have no browser tools at all after its next restart.
  if (migrated.claudeCode && !flags.includes('--claude-code'))
    flags = [...flags, '--claude-code'];
  if (migrated.claudeDesktop && !flags.includes('--claude-desktop'))
    flags = [...flags, '--claude-desktop'];

  // 1. Copy this single-file CLI somewhere stable (npx caches get cleaned).
  const created = [];
  mkdirTracked(appDir(), created);
  if (!isWin)
    fs.chmodSync(foxwrightDir(), 0o700);
  fs.copyFileSync(self, appScript());
  console.log(c.ok(`Installed helper ${VERSION} to ${appScript()}`));

  // 2. Launcher Firefox can execute (it can't pass interpreter args itself).
  const nodes = chooseNodes();
  fs.writeFileSync(wrapperPath(), launcherScript(nodes.launcher), isWin ? {} : { mode: 0o755 });
  if (!isWin)
    fs.chmodSync(wrapperPath(), 0o755);
  console.log(c.ok(`Wrote launcher ${wrapperPath()} (uses Node at ${nodes.launcher[0]}${nodes.launcher.length > 1 ? `; falls back to ${nodes.launcher.slice(1).join(', ')}` : ''}, then \`node\` on PATH)`));

  // 3. Native messaging manifest.
  mkdirTracked(nativeManifestDir(), created);
  const manifest = {
    name: HOST_NAME,
    description: 'Foxwright helper: connects the Foxwright Firefox extension to local AI agents (MCP).',
    path: wrapperPath(),
    type: 'stdio',
    allowed_extensions: EXTENSION_IDS,
  };
  fs.writeFileSync(manifestFile(), JSON.stringify(manifest, null, 2) + '\n');
  if (isWin)
    execFileSync('reg', ['add', REG_KEY, '/ve', '/t', 'REG_SZ', '/d', manifestFile(), '/f'], { stdio: 'ignore' });
  console.log(c.ok(`Registered with Firefox: ${manifestFile()}${isWin ? ` (+ registry ${REG_KEY})` : ''}`));
  const others = otherBrowsers();
  for (const [name, dir] of others.write) {
    try {
      mkdirTracked(dir, created);
      fs.writeFileSync(path.join(dir, `${HOST_NAME}.json`), JSON.stringify(manifest, null, 2) + '\n');
      console.log(c.ok(`Also registered with ${name}: ${dir}`));
    } catch (e) {
      console.log(c.warn(`Couldn't register with ${name} (${e.message}).`));
    }
  }
  for (const [name, dir] of others.covered)
    console.log(c.ok(`${name} (${dir}) uses the Firefox registration above.`));

  // The extension was named Zenko in 0.6.x and asks Firefox for a helper called "zenko". Until
  // Firefox updates it to 0.7 (which asks for "foxwright"), answer to the old name too, so a
  // 0.6 extension keeps working with this helper.
  const compat = { ...manifest, name: OLD_HOST_NAME };
  const compatFile = path.join(nativeManifestDir(), `${OLD_HOST_NAME}.json`);
  try {
    fs.writeFileSync(compatFile, JSON.stringify(compat, null, 2) + '\n');
    if (isWin)
      execFileSync('reg', ['add', OLD_REG_KEY, '/ve', '/t', 'REG_SZ', '/d', compatFile, '/f'], { stdio: 'ignore' });
    for (const [, dir] of others.write) {
      try {
        fs.writeFileSync(path.join(dir, `${OLD_HOST_NAME}.json`), JSON.stringify(compat, null, 2) + '\n');
      } catch { /* that browser just won't have it */ }
    }
    console.log(c.ok('Also registered for the extension\'s 0.6 versions (then called Zenko), until Firefox updates them.'));
  } catch (e) {
    console.log(c.warn(`Couldn't add the registration for the Zenko 0.6 extension (${e.message}). Update the extension to Foxwright 0.7 or newer.`));
  }

  if (process.platform === 'linux') {
    if (fs.existsSync('/snap/bin/firefox') || which('flatpak') && fs.existsSync(path.join(os.homedir(), '.var/app/org.mozilla.firefox')))
      console.log(c.warn('Found Snap or Flatpak Firefox (Ubuntu\'s built-in Firefox is a Snap). Its sandbox usually can\'t start this helper, so Foxwright would stay at "Helper not found". If that is the Firefox you use, install Firefox from Mozilla\'s .deb repository or tarball and add Foxwright to it: https://support.mozilla.org/kb/install-firefox-linux'));
  }

  // 4. Hook up AI clients. A failure here never undoes the steps above: say what to run instead.
  const { command, args } = mcpCommand();
  const claudeCodeCmd = displayCmd(['claude', 'mcp', 'add', '--scope', 'user', 'foxwright', '--', command, ...args]);
  const hooked = []; // AI clients setup connected just now
  if (flags.includes('--claude-code') || flags.includes('--all')) {
    const claude = which('claude');
    if (claude) {
      try {
        runClaude(claude, ['mcp', 'remove', '--scope', 'user', 'foxwright'], { stdio: 'ignore' });
      } catch { /* not there yet */ }
      try {
        runClaude(claude, ['mcp', 'add', '--scope', 'user', 'foxwright', '--', command, ...args], { stdio: 'inherit' });
        console.log(c.ok('Added Foxwright to Claude Code (user scope).'));
        hooked.push('Claude Code');
      } catch (e) {
        console.log(c.warn(`Couldn't add Foxwright to Claude Code (${e.message.split('\n')[0]}). Run this yourself:\n    ${claudeCodeCmd}`));
      }
    } else {
      console.log(c.warn(`Skipped Claude Code: its \`claude\` command isn't on PATH. Install Claude Code, then run:\n    ${claudeCodeCmd}`));
    }
  }
  if (flags.includes('--claude-desktop') || flags.includes('--all')) {
    const cfgPath = claudeDesktopConfigPath();
    // There is no official Claude Desktop for Linux: don't invent a config folder for it.
    if (process.platform === 'linux' && !fs.existsSync(path.dirname(cfgPath))) {
      console.log(c.warn(`Skipped Claude Desktop: ${path.dirname(cfgPath)} doesn't exist yet. If you use Claude Desktop, open it once, then run setup again.`));
    } else {
      try {
        let cfg = {};
        try {
          cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
        } catch { /* new file */ }
        cfg.mcpServers = cfg.mcpServers || {};
        cfg.mcpServers.foxwright = { command, args };
        mkdirTracked(path.dirname(cfgPath), created);
        if (fs.existsSync(cfgPath))
          fs.copyFileSync(cfgPath, cfgPath + '.bak');
        fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
        console.log(c.ok(`Added Foxwright to Claude Desktop (${cfgPath}). Quit Claude Desktop completely (not just its window) and open it again to load it.`));
        hooked.push('Claude Desktop');
      } catch (e) {
        console.log(c.warn(`Couldn't add Foxwright to Claude Desktop (${e.message}). Add it to ${cfgPath} yourself (see below).`));
      }
    }
  }
  try {
    fs.writeFileSync(createdDirsFile(), JSON.stringify([...new Set([...readCreatedDirs(), ...created])], null, 2) + '\n');
  } catch { /* uninstall then leaves empty folders behind; harmless */ }

  // 5. A Firefox that is open still runs the helper this setup replaced: stop it, and the extension
  //    starts the new one (registered above) by itself.
  const stopped = stopHelpers(replaced);
  for (const h of stopped)
    console.log(c.ok(`Stopped the ${h.label === 'Foxwright' ? '' : `${h.label} `}helper ${h.version || '(older version)'} that Firefox was running (pid ${h.pid}). The extension starts helper ${VERSION} by itself in a few seconds; no need to restart Firefox.`));
  if (migrated.found && !migrated.claudeCode && !migrated.claudeDesktop)
    console.log(c.warn(`If an AI client was set up for the old helper by hand, change its MCP settings to: ${displayCmd([command, ...args])}`));
  if (updating) {
    console.log(`\n${c.b('Updated an existing install.')} ${c.b('Restart your AI client')} (quit it completely and open it again): one that was open
during this update still runs the old MCP server, which the new helper refuses.
The Firefox extension updates separately: Firefox installs new versions from the add-ons store by itself,
sometimes days after a helper release (Mozilla reviews each one). An older extension keeps working.`);
  }

  const ffCmd = process.platform === 'darwin' ? '/Applications/Firefox.app/Contents/MacOS/firefox' : isWin ? '"C:\\Program Files\\Mozilla Firefox\\firefox.exe"' : 'firefox';
  const entry = JSON.stringify({ command, args });
  // VS Code's own installer command. On Windows, cmd and PowerShell quote JSON differently: show the file entry.
  const vscode = isWin
    ? `add to .vscode\\mcp.json (or the file "MCP: Open User Configuration" opens) under "servers":  "foxwright": ${JSON.stringify({ type: 'stdio', command, args })}`
    : `code --add-mcp ${shellQuote(JSON.stringify({ name: 'foxwright', type: 'stdio', command, args }))}`;
  // Every client's settings, unless setup just connected the one the person asked for.
  const clientSteps = hooked.length
    ? `  2. Restart ${hooked.join(' and ')} so it loads Foxwright.
     Other AI apps (Codex, Cursor, VS Code, Gemini CLI, Windsurf, Zed): run ${c.b(SETUP_CMD)}
     without a flag to print their settings, or see ${CLIENTS_URL}`
    : `  2. Connect your AI app, then restart it:
     ${c.b('Claude Code:')}  ${claudeCodeCmd}
     ${c.b('Codex:')}        ${displayCmd(['codex', 'mcp', 'add', 'foxwright', '--', command, ...args])}
                   then add  tool_timeout_sec = 180  under [mcp_servers.foxwright] in ~/.codex/config.toml
                   (Codex stops waiting after 60 s; Foxwright's permission window waits 2 minutes)
     ${c.b('OpenCode:')}     in ~/.config/opencode/opencode.json, inside "mcp":  "foxwright": ${JSON.stringify({ type: 'local', command: [command, ...args], enabled: true })}
     ${c.b('Gemini CLI:')}   ${displayCmd(['gemini', 'mcp', 'add', '--scope', 'user', 'foxwright', command, ...args])}
     ${c.b('VS Code:')}      ${vscode}
     ${c.b('Claude Desktop, Cursor, Windsurf')} and other apps with an "mcpServers" settings file,
       add inside "mcpServers":  "foxwright": ${entry}
     ${c.b('Zed:')} the same entry inside "context_servers" in its settings.json.
     Where each app keeps its settings: ${CLIENTS_URL}
     ${c.dim('(setup --claude-code / --claude-desktop / --all connects Claude for you)')}`;
  console.log(`
${c.b('Next steps')}
  1. Install the Foxwright extension in Firefox (152+): ${STORE_URL}
     If it's already installed, it finds this helper by itself within a few seconds
     (or press "Try again" in its toolbar popup). The toolbar fox loses its "!" badge.
${clientSteps}
  3. Ask your AI app: "Use Foxwright to open https://example.com and tell me the main heading."
     Firefox asks you to approve the site first.

  Optional, real (trusted) clicks and typing: start Firefox with
       ${ffCmd} --remote-debugging-port=9222
     Foxwright detects it automatically. See the README for the trade-offs.

  Check everything with: ${c.b('npx foxwright-firefox doctor')}
`);
}

// ---------- doctor ----------

async function probeSocket(p) {
  // Through the authenticated client: the helper answers nothing else (see auth.js).
  // p: one helper's own socket; none: the shared socket.
  const { HelperClient } = await import('./client.js');
  const c = new HelperClient(p ? { path: p } : {});
  let timer;
  try {
    return await Promise.race([
      c.status(),
      new Promise((resolve) => {
        timer = setTimeout(() => resolve({ error: 'timeout' }), 5000);
      }),
    ]);
  } catch (e) {
    return { error: e.code || e.message };
  } finally {
    clearTimeout(timer);
    c.close();
  }
}

/** { state: 'ok' | 'held' | 'off', url, error } for Firefox's WebDriver BiDi port (trusted input). */
async function probeBidi() {
  const { Bidi } = await import('./bidi.js');
  const b = new Bidi();
  if (!(await b.available())) {
    // Firefox allows one WebDriver session: someone may already hold it.
    if (/session not created|maximum|already/i.test(b.lastError || ''))
      return { state: 'held', url: b.url, error: b.lastError };
    return { state: 'off', url: b.url, error: b.lastError };
  }
  try {
    await b.cmd('session.end', {});
  } catch { /* ignore */ }
  b.ws?.close();
  return { state: 'ok', url: b.url };
}

function pidAlive(pid) {
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return e.code === 'EPERM';
  }
}

const FIREFOX_NAMES = /^(firefox|firefox-bin|firefox-esr|librewolf|floorp|waterfox)(\.exe)?$/i;

/**
 * Firefox-family processes from `ps -A -o pid=,uid=,comm=` (macOS) or `tasklist /fo csv /nh`
 * (Windows) output. Only this user's processes where the OS says whose they are.
 */
export function parseProcessList(text, platform = process.platform, uid = process.getuid?.()) {
  const out = [];
  for (const raw of String(text).split(/\r?\n/)) {
    const line = raw.trim();
    if (!line)
      continue;
    if (platform === 'win32') {
      const m = /^"([^"]+)","(\d+)"/.exec(line);
      if (m && FIREFOX_NAMES.test(m[1]))
        out.push({ pid: +m[2], name: m[1] });
      continue;
    }
    const m = /^(\d+)\s+(\d+)\s+(.+)$/.exec(line);
    if (!m || (uid !== undefined && +m[2] !== uid))
      continue;
    const exe = m[3];
    if (FIREFOX_NAMES.test(path.basename(exe)))
      out.push({ pid: +m[1], name: path.basename(exe), exe });
  }
  return out;
}

/** How a Firefox process was installed, from its command line: 'snap' | 'flatpak' | null. */
export function sandboxKind(args) {
  if (/(^|\s)\/snap\/|\/snap\/firefox\//.test(args || ''))
    return 'snap';
  if (/(^|\s)\/app\/(lib|extra)\/|flatpak/.test(args || ''))
    return 'flatpak';
  return null;
}

/** Firefox-family processes of this user on Linux, from /proc (no `ps` needed). */
function linuxProcesses() {
  const out = [];
  const uid = process.getuid?.();
  for (const d of fs.readdirSync('/proc').filter(n => /^\d+$/.test(n))) {
    try {
      const name = fs.readFileSync(`/proc/${d}/comm`, 'utf8').trim();
      if (!FIREFOX_NAMES.test(name) || (uid !== undefined && fs.statSync(`/proc/${d}`).uid !== uid))
        continue;
      let exe = '';
      try {
        exe = fs.readlinkSync(`/proc/${d}/exe`);
      } catch {
        exe = fs.readFileSync(`/proc/${d}/cmdline`, 'utf8').replace(/\0/g, ' ');
      }
      out.push({ pid: +d, name, exe });
    } catch { /* gone, or not ours to read */ }
  }
  return out;
}

/**
 * 'snap' | 'flatpak' when the only Firefox installed on this Linux computer is a sandboxed one
 * (what setup warns about), else null. A running one is found by firefoxStatus() instead.
 */
export function sandboxedFirefoxOnly({ home = os.homedir(), env = process.env, exists = fs.existsSync } = {}) {
  if (process.platform !== 'linux')
    return null;
  const snap = exists('/snap/bin/firefox');
  const flatpak = exists(path.join(home, '.var', 'app', 'org.mozilla.firefox')) || exists('/var/lib/flatpak/app/org.mozilla.firefox');
  if (!snap && !flatpak)
    return null;
  // Ubuntu's /usr/bin/firefox is a small script that starts the Snap: that doesn't count as another Firefox.
  const real = (f) => {
    try {
      if (fs.realpathSync(f).startsWith('/snap/'))
        return false;
      const st = fs.statSync(f);
      return !(st.size < 16384 && /\/snap\/|flatpak run/.test(fs.readFileSync(f, 'utf8')));
    } catch {
      return false;
    }
  };
  const others = [...['firefox', 'firefox-esr', 'librewolf', 'floorp', 'waterfox'].flatMap(n => findAllOnPath(n, env)),
    '/opt/firefox/firefox', '/usr/lib/firefox/firefox', '/usr/lib64/firefox/firefox', '/usr/lib/firefox-esr/firefox-esr'].filter(f => exists(f) && real(f));
  return others.length ? null : snap ? 'snap' : 'flatpak';
}

/** Running Firefox-family processes: { running: true|false|null (couldn't tell), sandbox: 'snap'|'flatpak'|null }. */
function firefoxStatus() {
  const fake = process.env.FOXWRIGHT_TEST_PS; // tests: a canned `ps -A -o pid=,uid=,comm=` listing instead of the real one
  let list;
  try {
    if (fake !== undefined)
      list = parseProcessList(fake);
    else if (process.platform === 'linux')
      list = linuxProcesses();
    else if (isWin)
      list = parseProcessList(execFileSync('tasklist', ['/fo', 'csv', '/nh'], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }));
    else
      list = parseProcessList(execFileSync('ps', ['-A', '-o', 'pid=,uid=,comm='], { encoding: 'utf8', timeout: 10000, stdio: ['ignore', 'pipe', 'ignore'] }));
  } catch {
    return { running: null, sandbox: null };
  }
  const sandbox = list.map(p => sandboxKind(p.exe)).find(Boolean) || null;
  return { running: list.length > 0, sandbox };
}

/** Folders that hold a Firefox-family profiles.ini, by browser. */
function profileRoots() {
  const home = os.homedir();
  if (process.platform === 'darwin') {
    const as = path.join(home, 'Library', 'Application Support');
    return [['Firefox', path.join(as, 'Firefox')], ['LibreWolf', path.join(as, 'LibreWolf')], ['Waterfox', path.join(as, 'Waterfox')], ['Floorp', path.join(as, 'Floorp')]];
  }
  if (isWin) {
    const ad = process.env.APPDATA || path.join(home, 'AppData', 'Roaming');
    return [['Firefox', path.join(ad, 'Mozilla', 'Firefox')], ['LibreWolf', path.join(ad, 'librewolf')], ['Waterfox', path.join(ad, 'Waterfox')], ['Floorp', path.join(ad, 'Floorp')]];
  }
  return [
    ['Firefox', path.join(home, '.mozilla', 'firefox')],
    ['Firefox', path.join(home, '.config', 'mozilla', 'firefox')],
    ['Snap Firefox', path.join(home, 'snap', 'firefox', 'common', '.mozilla', 'firefox')],
    ['Flatpak Firefox', path.join(home, '.var', 'app', 'org.mozilla.firefox', '.mozilla', 'firefox')],
    ['LibreWolf', path.join(home, '.librewolf')],
    ['LibreWolf', path.join(home, '.config', 'librewolf', 'librewolf')],
    ['LibreWolf', path.join(home, '.config', 'librewolf')],
    ['Waterfox', path.join(home, '.waterfox')],
    ['Floorp', path.join(home, '.floorp')],
    ['Floorp', path.join(home, '.config', 'floorp')],
  ];
}

/**
 * Is the Foxwright extension installed in the user's profiles? Reads each profile's extensions.json
 * (best effort: Firefox writes it lazily). Returns { profiles: n scanned, found: [{ browser, profile, enabled, version }] }.
 */
export function extensionInProfiles(roots = profileRoots()) {
  let profiles = 0;
  const found = [];
  const seen = new Set();
  for (const [browser, root] of roots) {
    let ini;
    try {
      ini = fs.readFileSync(path.join(root, 'profiles.ini'), 'utf8');
    } catch {
      continue;
    }
    for (const sect of ini.split(/^\[/m).filter(s => /^Profile\d+\]/.test(s))) {
      const get = (k) => new RegExp(`^${k}=(.*)$`, 'm').exec(sect)?.[1]?.trim();
      const rel = get('IsRelative') !== '0';
      const p = get('Path');
      if (!p)
        continue;
      const dir = rel ? path.join(root, p) : p;
      if (seen.has(dir))
        continue;
      seen.add(dir);
      let data;
      try {
        data = JSON.parse(fs.readFileSync(path.join(dir, 'extensions.json'), 'utf8'));
      } catch {
        if (fs.existsSync(dir))
          profiles++;
        continue;
      }
      profiles++;
      for (const a of data.addons || []) {
        if (EXTENSION_IDS.includes(a.id))
          found.push({ browser, profile: get('Name') || p, enabled: !!a.active && !a.userDisabled, version: a.version });
      }
    }
  }
  return { profiles, found };
}

/** The installed helper's version, by asking it (the launcher's Node, else this one). */
function installedVersion(node) {
  try {
    return execFileSync(node && fs.existsSync(node) ? node : process.execPath, [appScript(), '--version'], { encoding: 'utf8', timeout: 15000, stdio: ['ignore', 'pipe', 'ignore'] }).trim() || null;
  } catch {
    return null;
  }
}

function logTail(n = 3) {
  try {
    const lines = fs.readFileSync(logPath(), 'utf8').trimEnd().split('\n');
    return lines.slice(-n);
  } catch {
    return [];
  }
}

// Shareable diagnostics are assembled from check results, never from terminal output.
function reportVersion(value) {
  return typeof value === 'string' && /^\d{1,6}(?:\.\d{1,6}){1,3}$/.test(value) ? value : 'unknown';
}

export async function doctor({ share = false } = {}) {
  const report = ['Foxwright doctor (shareable)',
    `Foxwright command: ${reportVersion(VERSION)}`,
    `Node.js: ${reportVersion(process.versions.node)}`,
    `Operating system: ${process.platform}`,
  ];
  const detail = (line) => {
    if (!share)
      console.log(line);
  };
  const fixes = [];
  let problems = 0;
  const ok = (s) => detail(c.ok(s));
  const bad = (s, fix) => {
    detail(c.bad(s));
    problems++;
    if (fix && !fixes.includes(fix))
      fixes.push(fix);
  };
  const warn = (s, fix) => {
    detail(c.warn(s));
    if (fix && !fixes.includes(fix))
      fixes.push(fix);
  };
  const finish = () => {
    if (share) {
      console.log(report.join('\n'));
      process.exitCode = problems ? 1 : 0;
      return;
    }
    console.log(c.dim(`  Helper log: ${logPath()}`));
    if (fixes.length)
      console.log(`\n${c.b(problems ? `${problems} problem(s) found. What to do:` : 'Suggestions:')}\n${fixes.map((f, i) => `  ${i + 1}. ${f}`).join('\n')}`);
    else
      console.log(problems ? `\n${problems} problem(s) found.` : '\nAll good.');
    process.exit(problems ? 1 : 0);
  };
  detail(c.b('Foxwright doctor\n'));
  detail(`  This command: foxwright ${VERSION} (${fileURLToPath(import.meta.url)})`);
  ok(`Node.js ${process.versions.node} (${process.execPath})`);
  if (parseInt(process.versions.node) < 20)
    bad(`Node.js ${process.versions.node} is too old`, 'Install Node.js 20 or newer (the LTS version from https://nodejs.org), open a new terminal window, then run setup again.');

  // 1. Set up at all?
  let manifest = null;
  let manifestError = null;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile(), 'utf8'));
  } catch (e) {
    manifestError = e.code === 'ENOENT' ? 'missing' : `unreadable: ${e.message}`;
  }
  const hasApp = fs.existsSync(appScript());
  report.push(`Helper installation: ${hasApp ? 'found' : 'missing'}`);
  report.push(`Firefox native registration: ${manifest ? 'found' : manifestError === 'missing' ? 'missing' : 'unreadable'}`);
  if (!hasApp && !manifest) {
    const old = oldInstallsPresent();
    report.push(`Install under an old name: ${old.length ? old.map(o => o.label).join(', ') : 'none'}`);
    if (old.length)
      bad(`Only an install from when Foxwright was called ${old.map(o => o.label).join(' / ')} is here (${old.map(o => o.dir).join(', ')}). The Foxwright extension (0.7 and newer) can't use it`, `Replace it with the Foxwright helper: ${SETUP_LATEST} (it removes the old install and moves its Claude entries over). Then restart your AI client.`);
    else
      bad(`Foxwright isn't set up for this user (no helper at ${appScript()}, no registration at ${manifestFile()})`, `Run: ${SETUP_CMD}`);
    const ff = firefoxStatus();
    if (ff.running === false)
      detail(c.dim('  Firefox is not running.'));
    report.push(`Firefox process: ${ff.running === null ? 'unknown' : ff.running ? 'running' : 'not running'}`);
    report.push('Firefox connection: no helper installation found');
    return finish();
  }

  // 2. The installation.
  let nodes = [];
  if (fs.existsSync(wrapperPath()))
    nodes = launcherNodes(fs.readFileSync(wrapperPath(), 'utf8'));
  const usable = nodes.find(n => fs.existsSync(n));
  // The installed script is ours. Use this process's Node for the shareable report.
  const installed = hasApp ? installedVersion(share ? null : usable) : null;
  if (hasApp)
    report.push(`Installed helper: ${reportVersion(installed)}`);
  if (hasApp)
    ok(`Installed helper ${installed || '(version unknown)'} at ${appScript()}`);
  else
    bad(`Helper missing: ${appScript()}`, `Re-run setup to reinstall the helper: ${SETUP_CMD}`);
  for (const f of doctorVersionFindings({ cmd: VERSION, installed }))
    warn(f.text, f.fix);

  if (manifest)
    ok(`Registered with Firefox: ${manifestFile()}`);
  else
    bad(`Native-messaging registration ${manifestFile()} ${manifestError}`, `Re-run setup to register the helper with Firefox: ${SETUP_CMD}`);
  if (manifest) {
    const permitsExtension = EXTENSION_IDS.every(id => manifest.allowed_extensions?.includes(id));
    report.push(`Registration allows the Foxwright extension: ${permitsExtension ? 'yes' : 'no'}`);
    const launcherExists = !!manifest.path && fs.existsSync(manifest.path);
    report.push(`Registered launcher: ${launcherExists ? 'found' : 'missing'}`);
    if (!permitsExtension)
      bad('The registration does not allow the Foxwright extension IDs', `Re-run setup: ${SETUP_CMD}`);
    if (!launcherExists)
      bad(`The registration points at a launcher that doesn't exist: ${manifest.path}`, `Re-run setup: ${SETUP_CMD}`);
    else if (path.resolve(manifest.path) !== path.resolve(wrapperPath()))
      warn(`The registration points at ${manifest.path}, not ${wrapperPath()}`, `Re-run setup: ${SETUP_CMD}`);
  }
  report.push(`Configured launcher Node.js: ${usable ? 'found' : nodes.length ? 'missing' : 'unknown'}`);
  // Don't execute binaries named by the launcher when preparing a shareable report.
  if (!share && fs.existsSync(wrapperPath())) {
    if (!nodes.length)
      warn(`Couldn't tell which Node.js the launcher ${wrapperPath()} uses`);
    else if (usable) {
      const v = nodeMajor(usable, os.homedir());
      const gone = nodes.slice(0, nodes.indexOf(usable));
      if (!v)
        bad(`The launcher's Node.js ${usable} doesn't run`, `Re-run setup with a working Node.js 20+: ${SETUP_CMD}`);
      else if (v.major < 20)
        bad(`The launcher's Node.js ${usable} is ${v.version}; Foxwright needs 20 or newer`, `Re-run setup with Node.js 20+: ${SETUP_CMD}`);
      else
        ok(`Launcher uses Node.js ${v.version} at ${usable}${gone.length ? ` (${gone.join(', ')} ${gone.length > 1 ? 'are' : 'is'} gone)` : ''}`);
    } else {
      const pathNode = which('node');
      bad(`The Node.js the launcher was set up with is gone: ${nodes.join(', ')} (an upgrade or a version-manager cleanup removes old Node versions)${pathNode ? `. It falls back to \`node\` on PATH (${pathNode}), but Firefox may not see the same PATH as your terminal` : ''}`,
        `Re-run setup with the Node.js you have now, so the launcher points at it: ${SETUP_CMD}`);
    }
  }
  if (isWin) {
    try {
      execFileSync('reg', ['query', REG_KEY], { stdio: 'ignore' });
      ok(`Registry key ${REG_KEY}`);
      report.push('Windows registry entry: found');
    } catch {
      bad(`Registry key ${REG_KEY} missing`, `Re-run setup: ${SETUP_CMD}`);
      report.push('Windows registry entry: missing');
    }
  }

  // 3. Firefox and the extension.
  const ff = firefoxStatus();
  report.push(`Firefox process: ${ff.running === null ? 'unknown' : ff.running ? 'running' : 'not running'}`);
  if (ff.sandbox)
    report.push(`Firefox packaging: ${ff.sandbox === 'snap' ? 'Snap' : 'Flatpak'}`);
  if (ff.sandbox)
    warn(`Firefox is running as a ${ff.sandbox === 'snap' ? 'Snap' : 'Flatpak'}${ff.sandbox === 'snap' ? ' (Ubuntu\'s built-in Firefox)' : ''}. Its sandbox usually stops the extension from starting the helper`,
      'Install Firefox from Mozilla\'s .deb repository or tarball instead of the Snap/Flatpak, add Foxwright to that Firefox, and use it for your agent: https://support.mozilla.org/kb/install-firefox-linux');

  // Each connected Firefox profile's helper registers in ~/.foxwright/browsers; remove what dead helpers left.
  const live = [];
  let stale = 0;
  let names = [];
  try {
    names = fs.readdirSync(browsersDir()).filter(n => n.endsWith('.json'));
  } catch { /* none yet */ }
  for (const n of names) {
    const file = path.join(browsersDir(), n);
    let e = null;
    try {
      e = JSON.parse(fs.readFileSync(file, 'utf8'));
    } catch { /* unreadable: stale */ }
    if (e && Number.isInteger(e.pid) && pidAlive(e.pid)) {
      live.push(e);
      continue;
    }
    if (share)
      continue; // Registry cleanup belongs to the interactive command.
    for (const f of [file, !isWin && typeof e?.socket === 'string' && path.dirname(path.resolve(e.socket)) === path.resolve(browsersDir()) ? e.socket : null].filter(Boolean)) {
      try {
        fs.unlinkSync(f);
      } catch { /* ignore */ }
    }
    stale++;
  }
  if (stale)
    ok(`Cleaned up ${stale} stale registry ${stale > 1 ? 'entries' : 'entry'} left by helpers that are no longer running`);

  // Ask the helpers. The shared socket first, then each registered helper's own socket.
  let st = { error: 'ENOENT' };
  if (fs.existsSync(foxwrightDir())) // socketPath() creates the pipe id on Windows
    st = await probeSocket();
  const connected = [];
  let pre08 = st.error === 'EAUTH' ? 1 : 0; // helpers from before the 0.8 handshake: running, but this version can't talk to them
  if (!st.error)
    connected.push(st);
  for (const e of live) {
    if (connected.some(x => x.pid === e.pid))
      continue;
    const s = typeof e.socket === 'string' ? await probeSocket(e.socket) : { error: 'no socket' };
    if (!s.error)
      connected.push(s);
    else if (s.error === 'EAUTH')
      pre08++;
  }
  const withExt = connected.filter(s => s.extension);
  if (share) {
    report.push(`Firefox connection: ${withExt.length ? 'connected' : connected.length ? 'waiting for the extension' : pre08 ? 'Firefox runs a helper from before 0.8' : live.length ? 'helper did not answer' : 'no running helper found'}`);
    if (withExt.some(s => s.oldClientAt))
      report.push('An AI client with an MCP server from before 0.8 was refused: yes');
    if (!withExt.length)
      problems++;
    for (const connection of withExt.slice(0, 4))
      report.push(`Connected extension: ${reportVersion(connection.extension.version)}${connection.extension.full ? ' (Full build)' : ''}, helper: ${reportVersion(connection.helper?.version)}`);
    return finish();
  }
  if (withExt.length) {
    for (const s of withExt) {
      ok(`Firefox connected${s.browser?.name ? ` ("${s.browser.name}")` : ''}: extension ${s.extension.version || '?'}${s.extension.full ? ' (full build)' : ''}, helper ${s.helper?.version || '?'} (pid ${s.pid})`);
      // Which side is older decides the advice: an older extension only waits for the store.
      for (const f of doctorVersionFindings({ installed, running: s.helper?.version, ext: s.extension.version }))
        (f.level === 'bad' ? bad : warn)(f.text, f.fix);
      if (s.oldClientAt)
        warn(`${Math.max(1, Math.round((Date.now() - s.oldClientAt) / 60000))} min ago this helper refused an AI client's MCP server from before 0.8 (it was started before the update)`, OLD_CLIENT_USER_MSG);
    }
  } else if (pre08) {
    // The running helper is from before 0.8: only its own (old) MCP servers can talk to it.
    const newer = installed && compareVersions(installed, '0.8.0') !== -1;
    bad(`Firefox is running a Foxwright helper from before 0.8, which this version can't talk to${newer ? ` (${installed} is installed, but that Firefox hasn't started it yet)` : ''}`,
      `Run ${SETUP_LATEST} : it installs the current helper and restarts the one Firefox is running. Then restart your AI client.`);
  } else if (connected.length) {
    bad(`A helper is running (pid ${connected.map(s => s.pid).join(', ')}) but the extension hasn't said hello to it`, 'Restart Firefox, or toggle the Foxwright extension off and on in about:addons.');
  } else if (live.length) {
    bad(`A helper is registered (pid ${live.map(e => e.pid).join(', ')}) but doesn't answer`, `Restart Firefox. If it keeps happening, look at the end of the helper log: ${logPath()}`);
  } else {
    // No helper at all: why?
    const prof = extensionInProfiles();
    const enabled = prof.found.filter(f => f.enabled);
    const disabled = prof.found.filter(f => !f.enabled);
    const where = (list) => list.map(f => `${f.browser} profile "${f.profile}"`).join(', ');
    if (ff.running === false) {
      bad('Firefox is not running', `Start Firefox. The Foxwright extension starts the helper by itself${!prof.found.length && prof.profiles ? `; if it isn't installed yet, get it from ${STORE_URL}` : ''}.`);
    } else if (enabled.length) {
      bad(`${ff.running ? 'Firefox is running and the' : 'The'} Foxwright extension is enabled (${where(enabled)}), but it isn't connected to the helper`,
        `Restart Firefox, or toggle the Foxwright extension off and on in about:addons. If the toolbar fox still shows "!", read the end of the helper log: ${logPath()}`);
    } else if (disabled.length) {
      bad(`The Foxwright extension is installed but disabled (${where(disabled)})`, 'Enable Foxwright in Firefox: about:addons → Extensions → Foxwright.');
    } else if (prof.profiles) {
      bad(`${ff.running ? 'Firefox is running, but the' : 'The'} Foxwright extension isn't installed in any Firefox profile found (${prof.profiles} checked)`, `Install the Foxwright extension: ${STORE_URL}`);
    } else {
      bad(`${ff.running ? 'Firefox is running, but the' : 'The'} Foxwright extension isn't connected (not installed, disabled, or it can't start the helper)`,
        `If the extension isn't installed: ${STORE_URL} . If it is, enable it in about:addons, then restart Firefox.`);
    }
    // Not running (or not recognisable) as a Snap/Flatpak, but that is the only Firefox installed.
    const boxed = ff.sandbox ? null : sandboxedFirefoxOnly();
    if (boxed)
      warn(`The only Firefox found on this computer is the ${boxed === 'snap' ? 'Snap' : 'Flatpak'} one. Its sandbox may not let the extension start the helper`,
        'Install Firefox from Mozilla\'s .deb repository or tarball instead of the Snap/Flatpak: https://support.mozilla.org/kb/install-firefox-linux');
    const tail = logTail();
    if (tail.length && ff.running !== false)
      console.log(c.dim(`  Last helper log lines:\n${tail.map(l => `    ${l}`).join('\n')}`));
  }

  // 4. Trusted input (optional).
  const bidi = await probeBidi();
  if (bidi.state === 'ok') {
    ok(`Trusted input available: WebDriver BiDi at ${bidi.url}`);
  } else if (bidi.state === 'held') {
    const mcpClients = withExt.reduce((n, s) => n + Math.max(0, (s.clients || 1) - 1), 0);
    if (mcpClients)
      ok(`Trusted input: WebDriver BiDi at ${bidi.url} is in use, probably by the Foxwright MCP server${mcpClients > 1 ? 's' : ''} connected now (${mcpClients})`);
    else
      warn(`Trusted input: Firefox's remote-debugging port answers at ${bidi.url}, but its one WebDriver session is taken ("${(bidi.error || '').slice(0, 80)}"), and no Foxwright MCP server is connected. A Foxwright MCP server that didn't shut down cleanly, or another automation tool, holds it`,
        'Restart Firefox (with --remote-debugging-port) to free the WebDriver session for trusted input.');
  } else {
    console.log(c.dim('  Trusted input: off (optional; start Firefox with --remote-debugging-port=9222)'));
  }
  finish();
}

// ---------- uninstall ----------

export async function uninstall() {
  const createdDirs = readCreatedDirs(); // read before ~/.foxwright goes
  const extra = extraManifestDirs().map(([, d]) => d);
  // The registrations under the old name are ours only if they point at this helper's launcher.
  const oldNameFiles = [nativeManifestDir(), ...extra].map(d => path.join(d, `${OLD_HOST_NAME}.json`)).filter((f) => {
    try {
      return JSON.parse(fs.readFileSync(f, 'utf8')).path === wrapperPath();
    } catch {
      return false;
    }
  });
  if (isWin && oldNameFiles.length) {
    try {
      execFileSync('reg', ['delete', OLD_REG_KEY, '/f'], { stdio: 'ignore' });
    } catch { /* ignore */ }
  }
  const files = [manifestFile(), ...extra.map(d => path.join(d, `${HOST_NAME}.json`)), ...oldNameFiles, wrapperPath(), appScript()];
  for (const p of files) {
    if (!fs.existsSync(p))
      continue;
    try {
      fs.rmSync(p, { force: true });
      console.log(c.ok(`Removed ${p}`));
    } catch (e) {
      console.log(c.warn(`Couldn't remove ${p} (${e.message})`));
    }
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
      runClaude(claude, ['mcp', 'remove', '--scope', 'user', 'foxwright'], { stdio: 'ignore' });
      console.log(c.ok('Removed Foxwright from Claude Code.'));
    } catch { /* wasn't registered */ }
  }
  const cfgPath = claudeDesktopConfigPath();
  try {
    const cfg = JSON.parse(fs.readFileSync(cfgPath, 'utf8'));
    if (cfg.mcpServers?.foxwright) {
      delete cfg.mcpServers.foxwright;
      if (isEmptyDesktopConfig(cfg)) {
        // Nothing but our entry was in it: setup made this file, so take it (and its backup) away.
        fs.rmSync(cfgPath, { force: true });
        let bak = null;
        try {
          bak = JSON.parse(fs.readFileSync(cfgPath + '.bak', 'utf8'));
        } catch { /* none */ }
        if (bak && isEmptyDesktopConfig(bak, ['foxwright']))
          fs.rmSync(cfgPath + '.bak', { force: true });
        console.log(c.ok(`Removed Foxwright from Claude Desktop (deleted ${cfgPath}, which held nothing else).`));
      } else {
        fs.copyFileSync(cfgPath, cfgPath + '.bak');
        fs.writeFileSync(cfgPath, JSON.stringify(cfg, null, 2) + '\n');
        console.log(c.ok(`Removed Foxwright from Claude Desktop (${cfgPath}).`));
      }
    }
  } catch { /* no config */ }
  // The rest of ~/.foxwright: socket, pipe id, logs.
  // Only a folder that is clearly Foxwright's own: FOXWRIGHT_HOME could point anywhere.
  const dir = foxwrightDir();
  if (path.isAbsolute(dir) && path.basename(dir) === '.foxwright' && fs.existsSync(dir)) {
    try {
      fs.rmSync(dir, { recursive: true, force: true });
      console.log(c.ok(`Removed ${dir}`));
    } catch (e) {
      // Windows keeps files of a running helper locked.
      console.log(c.warn(`Couldn't remove all of ${dir} (${e.code || e.message}). Quit Firefox and delete it by hand.`));
    }
  }
  // Folders setup created, if they are empty now (e.g. ~/.mozilla/native-messaging-hosts).
  removeEmptyDirs(createdDirs.filter(d => d !== dir && !d.startsWith(dir + path.sep)));
  removeOldInstalls();
  console.log('Foxwright helper removed. To finish, remove the Foxwright extension in Firefox (about:addons), and delete the "foxwright" entry from any other AI app you added it to by hand (Cursor, Codex, VS Code, Gemini CLI, Windsurf, Zed).');
}
