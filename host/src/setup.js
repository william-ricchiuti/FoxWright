// `foxwright setup`, `foxwright doctor`, `foxwright uninstall`.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { EXTENSION_IDS, HOST_NAME, foxwrightDir, nativeManifestDir, socketPath, logPath, browsersDir } from './paths.js';

const isWin = process.platform === 'win32';
const REG_KEY = `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${HOST_NAME}`;
// The name the 0.6.x (Zenko) extension asks Firefox for; setup registers this helper under it too.
const OLD_HOST_NAME = 'zenko';
const OLD_REG_KEY = `HKCU\\Software\\Mozilla\\NativeMessagingHosts\\${OLD_HOST_NAME}`;
const STORE_URL = 'https://addons.mozilla.org/firefox/addon/foxwright/';
const SETUP_CMD = 'npx foxwright-firefox setup';
const VERSION = typeof __FOXWRIGHT_VERSION__ !== 'undefined' ? __FOXWRIGHT_VERSION__ : '0.0.0';
const c = {
  ok: (s) => `\x1b[32m✓\x1b[0m ${s}`,
  bad: (s) => `\x1b[31m✗\x1b[0m ${s}`,
  warn: (s) => `\x1b[33m!\x1b[0m ${s}`,
  b: (s) => `\x1b[1m${s}\x1b[0m`,
  dim: (s) => `\x1b[2m${s}\x1b[0m`,
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
  removeOldInstall('kitsune', 'Kitsune', opts);
  removeOldInstall('zenko', 'Zenko', opts);
}

function removeOldInstall(old, label, { quiet = false } = {}) {
  const oldHelper = new RegExp(`[\\\\/]\\.${old}[\\\\/]app[\\\\/]${old}\\.mjs`);
  const say = (m) => !quiet && console.log(c.ok(m));
  const home = os.homedir();
  const oldDir = path.join(home, '.' + old);
  const oldApp = path.join(oldDir, 'app', old + '.mjs');
  const ours = (text) => typeof text === 'string' && EXTENSION_IDS.some(id => text.includes(id));
  // Firefox native-messaging registrations named after the old name that list our extension ids.
  const dirs = [nativeManifestDir(), ...extraManifestDirs().map(([, d]) => d)];
  for (const d of dirs) {
    const f = path.join(d, old + '.json');
    try {
      if (ours(fs.readFileSync(f, 'utf8'))) {
        fs.rmSync(f, { force: true });
        say(`Removed the old ${label} registration ${f}`);
      }
    } catch { /* none */ }
  }
  if (isWin) {
    try {
      const out = execFileSync('reg', ['query', 'HKCU\\Software\\Mozilla\\NativeMessagingHosts\\' + old, '/ve'], { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] });
      const m = /REG_SZ\s+(.+)/.exec(out);
      if (m && ours(fs.readFileSync(m[1].trim(), 'utf8'))) {
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
      say(`Removed the old "${old}" entry from Claude Desktop (${cfgPath}).`);
    }
  } catch { /* no config */ }
  // Our files in the old folder, then the folder only if nothing else is left in it.
  if (fs.existsSync(oldApp) || fs.existsSync(path.join(oldDir, old + (isWin ? '-host.bat' : '-host')))) {
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
}

export async function setup(flags) {
  const self = fileURLToPath(import.meta.url);
  if (!/\.mjs$/.test(self) || typeof __FOXWRIGHT_BUNDLED__ === 'undefined') {
    console.error('Run setup from the bundled CLI (npx foxwright-firefox setup, or `npm run build` in host/ and then `node host/dist/foxwright.mjs setup`).');
    process.exit(1);
  }
  const major = parseInt(process.versions.node.split('.')[0], 10);
  if (major < 20) {
    console.error(`Foxwright needs Node.js 20 or newer (found ${process.versions.node}).`);
    process.exit(1);
  }

  // 0. Foxwright used to be called Kitsune, then Zenko: remove those installs so they don't run side by side.
  removeOldInstalls();

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
    console.log(c.ok('Also registered under the old name "zenko", so the Zenko 0.6 extension keeps working until Firefox updates it.'));
  } catch (e) {
    console.log(c.warn(`Couldn't add the registration for the Zenko 0.6 extension (${e.message}). Update the extension to Foxwright 0.7 or newer.`));
  }

  if (process.platform === 'linux') {
    if (fs.existsSync('/snap/bin/firefox') || which('flatpak') && fs.existsSync(path.join(os.homedir(), '.var/app/org.mozilla.firefox')))
      console.log(c.warn('Snap/Flatpak Firefox is sandboxed and may not be able to start the helper (Ubuntu ships the Snap by default). If the toolbar fox keeps its "!" badge, install Firefox from Mozilla\'s .deb repository or tarball: https://support.mozilla.org/kb/install-firefox-linux'));
  }

  // 4. Hook up AI clients. A failure here never undoes the steps above: say what to run instead.
  const { command, args } = mcpCommand();
  const claudeCodeCmd = displayCmd(['claude', 'mcp', 'add', '--scope', 'user', 'foxwright', '--', command, ...args]);
  if (flags.includes('--claude-code') || flags.includes('--all')) {
    const claude = which('claude');
    if (claude) {
      try {
        runClaude(claude, ['mcp', 'remove', '--scope', 'user', 'foxwright'], { stdio: 'ignore' });
      } catch { /* not there yet */ }
      try {
        runClaude(claude, ['mcp', 'add', '--scope', 'user', 'foxwright', '--', command, ...args], { stdio: 'inherit' });
        console.log(c.ok('Added Foxwright to Claude Code (user scope).'));
      } catch (e) {
        console.log(c.warn(`Couldn't add Foxwright to Claude Code (${e.message.split('\n')[0]}). Run this yourself:\n    ${claudeCodeCmd}`));
      }
    } else {
      console.log(c.warn('`claude` CLI not found; skipping Claude Code.'));
    }
  }
  if (flags.includes('--claude-desktop') || flags.includes('--all')) {
    const cfgPath = claudeDesktopConfigPath();
    // There is no official Claude Desktop for Linux: don't invent a config folder for it.
    if (process.platform === 'linux' && !fs.existsSync(path.dirname(cfgPath))) {
      console.log(c.warn(`Skipped Claude Desktop: ${path.dirname(cfgPath)} doesn't exist (there is no official Claude Desktop for Linux). If you use one, start it once and re-run setup.`));
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
        console.log(c.ok(`Added Foxwright to Claude Desktop (${cfgPath}). Restart Claude Desktop to load it.`));
      } catch (e) {
        console.log(c.warn(`Couldn't add Foxwright to Claude Desktop (${e.message}). Add it to ${cfgPath} yourself (see below).`));
      }
    }
  }
  try {
    fs.writeFileSync(createdDirsFile(), JSON.stringify([...new Set([...readCreatedDirs(), ...created])], null, 2) + '\n');
  } catch { /* uninstall then leaves empty folders behind; harmless */ }

  const ffCmd = process.platform === 'darwin' ? '/Applications/Firefox.app/Contents/MacOS/firefox' : isWin ? '"C:\\Program Files\\Mozilla Firefox\\firefox.exe"' : 'firefox';
  console.log(`
${c.b('Next steps')}
  1. Install the Foxwright extension in Firefox (152+): ${STORE_URL}
     If it was already installed, restart Firefox or toggle the extension off/on.
     The toolbar fox should lose its "!" badge once it finds this helper.
  2. Connect your AI client:
     ${c.b('Claude Code:')}   ${claudeCodeCmd}
     ${c.b('Claude Desktop / Cowork:')} add to claude_desktop_config.json → "mcpServers":
       "foxwright": ${JSON.stringify({ command, args })}
     ${c.dim('(or re-run setup with --claude-code / --claude-desktop / --all to do this for you)')}
  3. Optional, real (trusted) clicks and typing: start Firefox with
       ${ffCmd} --remote-debugging-port=9222
     Foxwright detects it automatically. See README for trade-offs.

  Check everything with: ${c.b(displayCmd([command, appScript(), 'doctor']))}
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

export async function doctor() {
  const fixes = [];
  let problems = 0;
  const ok = (s) => console.log(c.ok(s));
  const bad = (s, fix) => {
    console.log(c.bad(s));
    problems++;
    if (fix && !fixes.includes(fix))
      fixes.push(fix);
  };
  const warn = (s, fix) => {
    console.log(c.warn(s));
    if (fix && !fixes.includes(fix))
      fixes.push(fix);
  };
  const finish = () => {
    console.log(c.dim(`  Helper log: ${logPath()}`));
    if (fixes.length)
      console.log(`\n${c.b(problems ? `${problems} problem(s) found. What to do:` : 'Suggestions:')}\n${fixes.map((f, i) => `  ${i + 1}. ${f}`).join('\n')}`);
    else
      console.log(problems ? `\n${problems} problem(s) found.` : '\nAll good.');
    process.exit(problems ? 1 : 0);
  };
  console.log(c.b('Foxwright doctor\n'));
  console.log(`  This command: foxwright ${VERSION} (${fileURLToPath(import.meta.url)})`);
  ok(`Node.js ${process.versions.node} (${process.execPath})`);
  if (parseInt(process.versions.node) < 20)
    bad(`Node.js ${process.versions.node} is too old`, 'Install Node.js 20 or newer.');

  // 1. Set up at all?
  let manifest = null;
  let manifestError = null;
  try {
    manifest = JSON.parse(fs.readFileSync(manifestFile(), 'utf8'));
  } catch (e) {
    manifestError = e.code === 'ENOENT' ? 'missing' : `unreadable: ${e.message}`;
  }
  const hasApp = fs.existsSync(appScript());
  if (!hasApp && !manifest) {
    bad(`Foxwright isn't set up for this user (no helper at ${appScript()}, no registration at ${manifestFile()})`, `Run: ${SETUP_CMD}`);
    const ff = firefoxStatus();
    if (ff.running === false)
      console.log(c.dim('  Firefox is not running.'));
    return finish();
  }

  // 2. The installation.
  let nodes = [];
  if (fs.existsSync(wrapperPath()))
    nodes = launcherNodes(fs.readFileSync(wrapperPath(), 'utf8'));
  const usable = nodes.find(n => fs.existsSync(n));
  const installed = hasApp ? installedVersion(usable) : null;
  if (hasApp)
    ok(`Installed helper ${installed || '(version unknown)'} at ${appScript()}`);
  else
    bad(`Helper missing: ${appScript()}`, `Re-run setup to reinstall the helper: ${SETUP_CMD}`);
  if (installed && installed !== VERSION)
    warn(`The installed helper is ${installed}, but this command is ${VERSION}`, `To install this version (${VERSION}) of the helper, run setup with it: ${SETUP_CMD}`);

  if (manifest)
    ok(`Registered with Firefox: ${manifestFile()}`);
  else
    bad(`Native-messaging registration ${manifestFile()} ${manifestError}`, `Re-run setup to register the helper with Firefox: ${SETUP_CMD}`);
  if (manifest) {
    if (!EXTENSION_IDS.every(id => manifest.allowed_extensions?.includes(id)))
      bad('The registration does not allow the Foxwright extension IDs', `Re-run setup: ${SETUP_CMD}`);
    if (!manifest.path || !fs.existsSync(manifest.path))
      bad(`The registration points at a launcher that doesn't exist: ${manifest.path}`, `Re-run setup: ${SETUP_CMD}`);
    else if (path.resolve(manifest.path) !== path.resolve(wrapperPath()))
      warn(`The registration points at ${manifest.path}, not ${wrapperPath()}`, `Re-run setup: ${SETUP_CMD}`);
  }
  if (fs.existsSync(wrapperPath())) {
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
    } catch {
      bad(`Registry key ${REG_KEY} missing`, `Re-run setup: ${SETUP_CMD}`);
    }
  }

  // 3. Firefox and the extension.
  const ff = firefoxStatus();
  if (ff.sandbox)
    warn(`Firefox is running as a ${ff.sandbox === 'snap' ? 'Snap' : 'Flatpak'}. Its sandbox may not let the extension start the helper`,
      'Install Firefox from Mozilla\'s .deb repository or tarball instead of the Snap/Flatpak: https://support.mozilla.org/kb/install-firefox-linux');

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
  if (!st.error)
    connected.push(st);
  for (const e of live) {
    if (connected.some(x => x.pid === e.pid))
      continue;
    const s = typeof e.socket === 'string' ? await probeSocket(e.socket) : { error: 'no socket' };
    if (!s.error)
      connected.push(s);
  }
  const withExt = connected.filter(s => s.extension);
  if (withExt.length) {
    for (const s of withExt) {
      ok(`Firefox connected${s.browser?.name ? ` ("${s.browser.name}")` : ''}: extension ${s.extension.version || '?'}${s.extension.full ? ' (full build)' : ''}, helper ${s.helper?.version || '?'} (pid ${s.pid})`);
      if (s.helper?.version && installed && s.helper.version !== installed)
        warn(`That Firefox still runs helper ${s.helper.version}; ${installed} is installed`, 'Restart Firefox (or toggle the Foxwright extension off and on in about:addons) to start the updated helper.');
    }
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
  console.log('Foxwright helper removed. Also remove the Foxwright extension from Firefox (about:addons) and from any other AI client you added it to.');
}
