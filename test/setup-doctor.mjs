// `foxwright setup`, `doctor` and `uninstall` against throwaway home folders.
//
//   node test/setup-doctor.mjs                                 no browser: safe anywhere (needs `npm run build`)
//   FIREFOX=/path/to/firefox node test/setup-doctor.mjs        also the live cases with a real Firefox
//                                                              (Linux/Docker only: they need the isolated HOME
//                                                              the harness sets up there)
//
// Every run gets its own HOME, a PATH without your real `claude`, a canned process list
// (FOXWRIGHT_TEST_PS) and a BiDi port nobody listens on, so your own install and browser are never touched.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const cli = path.join(root, 'host/dist/foxwright.mjs');
if (!fs.existsSync(cli)) {
  console.error('Build first: npm run build');
  process.exit(2);
}
const S = await import(path.join(root, 'host/src/setup.js'));
const isMac = process.platform === 'darwin';
const isLinux = process.platform === 'linux';
const strip = (s) => s.replace(/\x1b\[[0-9;]*m/g, '');

const results = [];
async function test(name, fn, { skip } = {}) {
  if (skip) {
    console.log(`  - ${name} (skipped: ${skip})`);
    return;
  }
  try {
    await fn();
    results.push(true);
    console.log(`  ✓ ${name}`);
  } catch (e) {
    results.push(false);
    console.log(`  ✗ ${name}\n      ${String(e.message).split('\n').join('\n      ')}`);
  }
}
const expect = (c, m) => { if (!c) throw new Error(m); };

const homes = [];
/** A fresh fake home: { home, bin, env, run(args, extraEnv) }. */
function sandbox() {
  const home = fs.realpathSync(fs.mkdtempSync(path.join(os.tmpdir(), 'fw-setup-')));
  homes.push(home);
  const bin = path.join(home, 'bin');
  fs.mkdirSync(bin);
  const env = { ...process.env, HOME: home, USERPROFILE: home, PATH: `${bin}${path.delimiter}/usr/bin${path.delimiter}/bin`, FOXWRIGHT_TEST_PS: '', FOXWRIGHT_BIDI_PORT: '1' };
  for (const k of ['FOXWRIGHT_HOME', 'FOXWRIGHT_SOCKET', 'FOXWRIGHT_NATIVE_MANIFEST_DIR', 'FOXWRIGHT_BIDI_URL', 'XDG_CONFIG_HOME', 'FNM_DIR', 'VOLTA_HOME', 'MISE_DATA_DIR', 'ASDF_DATA_DIR'])
    delete env[k];
  const run = (args, extra = {}, file = cli) => {
    const r = spawnSync(process.execPath, [file, ...args], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 60000 });
    return { code: r.status, out: strip(r.stdout + r.stderr) };
  };
  const nmDir = isMac ? path.join(home, 'Library/Application Support/Mozilla/NativeMessagingHosts') : path.join(home, '.mozilla/native-messaging-hosts');
  const launcher = path.join(home, '.foxwright', 'foxwright-host');
  return { home, bin, env, run, nmDir, launcher };
}
/** Run the launcher like Firefox does, with stdin closed so the helper exits at once. */
function runLauncher(sb, extra = {}) {
  const r = spawnSync(sb.launcher, ['/x/foxwright.json', 'kitsune@william-ricchiuti.com'], { env: { ...sb.env, ...extra }, input: '', encoding: 'utf8', timeout: 30000 });
  return { code: r.status, err: r.stderr || '', log: fs.existsSync(path.join(sb.home, '.foxwright/helper.log')) ? fs.readFileSync(path.join(sb.home, '.foxwright/helper.log'), 'utf8') : '' };
}
function writeProfile(home, { ext }) {
  const rootDir = isMac ? path.join(home, 'Library/Application Support/Firefox') : path.join(home, '.mozilla/firefox');
  fs.mkdirSync(path.join(rootDir, 'abc.default-release'), { recursive: true });
  fs.writeFileSync(path.join(rootDir, 'profiles.ini'), '[General]\nStartWithLastProfile=1\n\n[Profile0]\nName=default-release\nIsRelative=1\nPath=abc.default-release\nDefault=1\n');
  const addons = [{ id: 'uBlock0@raymondhill.net', active: true }];
  if (ext)
    addons.push({ id: 'kitsune@william-ricchiuti.com', version: '0.7.1', active: ext === 'enabled', userDisabled: ext === 'disabled' });
  fs.writeFileSync(path.join(rootDir, 'abc.default-release', 'extensions.json'), JSON.stringify({ schemaVersion: 36, addons }));
}
const firefoxPs = (exe = '/usr/lib/firefox/firefox') => `  4242 ${process.getuid?.() ?? 0} ${exe}\n  77 ${(process.getuid?.() ?? 0) + 1} /usr/lib/firefox/firefox`;

console.log('Foxwright: setup, doctor and uninstall');

// ---------- pure functions ----------
await test('launcherNodes reads the new launcher layout and the single path of 0.7.1', () => {
  const text = S.launcherScript(['/opt/homebrew/bin/node', '/opt/homebrew/Cellar/node/22.3.0/bin/node'], '/h/.foxwright/app/foxwright.mjs', '/h/.foxwright/helper.log');
  expect(JSON.stringify(S.launcherNodes(text)) === JSON.stringify(['/opt/homebrew/bin/node', '/opt/homebrew/Cellar/node/22.3.0/bin/node']), text);
  expect(S.launcherNodes('#!/bin/sh\nexec /usr/local/bin/node /h/app/foxwright.mjs host "$@"\n')[0] === '/usr/local/bin/node', 'old unquoted');
  expect(S.launcherNodes('#!/bin/sh\nexec \'/Users/a b/node\' \'/h/app/foxwright.mjs\' host "$@"\n')[0] === '/Users/a b/node', 'old quoted with a space');
  expect(S.launcherNodes('@echo off\r\n"C:\\Program Files\\nodejs\\node.exe" "C:\\Users\\a\\.foxwright\\app\\foxwright.mjs" host %*\r\n')[0] === 'C:\\Program Files\\nodejs\\node.exe', 'old .bat');
});

await test('parseProcessList finds this user\'s Firefox (macOS ps and Windows tasklist output), sandboxKind spots Snap/Flatpak', () => {
  const uid = 501;
  const ps = `  1 0 /sbin/launchd\n 900 ${uid} /Applications/Firefox Nightly.app/Contents/MacOS/firefox\n 901 ${uid} /Applications/Firefox.app/Contents/MacOS/plugin-container\n 902 502 /Applications/Firefox.app/Contents/MacOS/firefox\n 903 ${uid} /usr/bin/firefoxpwa`;
  const got = S.parseProcessList(ps, 'darwin', uid);
  expect(got.length === 1 && got[0].pid === 900, JSON.stringify(got));
  const tl = '"System Idle Process","0","Services","0","8 K"\r\n"firefox.exe","5120","Console","1","300,000 K"\r\n"node.exe","77","Console","1","50,000 K"';
  const w = S.parseProcessList(tl, 'win32');
  expect(w.length === 1 && w[0].pid === 5120, JSON.stringify(w));
  expect(S.sandboxKind('/snap/firefox/4793/usr/lib/firefox/firefox') === 'snap', 'snap');
  expect(S.sandboxKind('/app/lib/firefox/firefox') === 'flatpak', 'flatpak');
  expect(S.sandboxKind('/usr/lib/firefox/firefox') === null, 'deb');
});

await test('nodeCandidates prefers a link that resolves to this Node, and skips fnm\'s per-shell links', () => {
  const sb = sandbox();
  const link = path.join(sb.bin, 'node');
  fs.symlinkSync(process.execPath, link);
  const multi = path.join(sb.home, 'fnm_multishells', '123_456', 'bin');
  fs.mkdirSync(multi, { recursive: true });
  fs.symlinkSync(process.execPath, path.join(multi, 'node'));
  const { stable } = S.nodeCandidates({ env: { PATH: [multi, sb.bin].join(path.delimiter) }, home: sb.home });
  expect(stable.includes(link), `stable: ${JSON.stringify(stable)}`);
  expect(!stable.some(p => p.includes('fnm_multishells')), `stable: ${JSON.stringify(stable)}`);
  expect(!stable.includes(process.execPath), 'the exact path is the fallback, not a stable path');
});

// ---------- setup + doctor without a browser ----------
await test('doctor on a computer where setup never ran says so, and what to run', () => {
  const sb = sandbox();
  const r = sb.run(['doctor']);
  expect(r.code === 1, r.out);
  expect(/isn't set up/.test(r.out) && /Run: npx foxwright-firefox setup/.test(r.out), r.out);
  expect(/This command: foxwright \d+\.\d+\.\d+/.test(r.out), r.out);
  expect(!fs.existsSync(path.join(sb.home, '.foxwright')), 'doctor must not create ~/.foxwright');
});

let main; // a set-up sandbox the next tests share
await test('setup writes a launcher that tries a stable Node path, then the exact one; registers "foxwright" and "zenko"', () => {
  main = sandbox();
  fs.symlinkSync(process.execPath, path.join(main.bin, 'node'));
  const r = main.run(['setup']);
  expect(r.code === 0, r.out);
  const nodes = S.launcherNodes(fs.readFileSync(main.launcher, 'utf8'));
  expect(nodes[0] === path.join(main.bin, 'node'), `nodes: ${JSON.stringify(nodes)}\n${r.out}`);
  expect(nodes.includes(process.execPath), `nodes: ${JSON.stringify(nodes)}`);
  for (const n of ['foxwright.json', 'zenko.json'])
    expect(JSON.parse(fs.readFileSync(path.join(main.nmDir, n), 'utf8')).path === main.launcher, n);
  expect(/Installed helper \d/.test(r.out), r.out);
});

await test('the launcher starts the helper; with the stable link gone it falls back to the exact path', () => {
  let l = runLauncher(main);
  expect(l.code === 0 && /helper starting/.test(l.log), `code ${l.code}\n${l.err}\n${l.log}`);
  fs.rmSync(path.join(main.bin, 'node'));
  fs.rmSync(path.join(main.home, '.foxwright/helper.log'));
  l = runLauncher(main);
  expect(l.code === 0 && /helper starting/.test(l.log), `code ${l.code}\n${l.err}\n${l.log}`);
  const r = main.run(['doctor']);
  expect(new RegExp(`Launcher uses Node.js [\\d.]+ at ${process.execPath.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')} \\(.*is gone\\)`).test(r.out), r.out);
});

await test('doctor: Firefox not running; stale registry entries of dead helpers are cleaned up', () => {
  const reg = path.join(main.home, '.foxwright/browsers');
  fs.mkdirSync(reg, { recursive: true });
  fs.writeFileSync(path.join(reg, '999999.json'), JSON.stringify({ pid: 999999, socket: path.join(reg, '999999.sock'), browserId: 'x' }));
  fs.writeFileSync(path.join(reg, '999999.sock'), '');
  const r = main.run(['doctor']);
  expect(r.code === 1 && /Cleaned up 1 stale registry entry/.test(r.out), r.out);
  expect(/✗ Firefox is not running/.test(r.out) && /Start Firefox/.test(r.out), r.out);
  expect(!fs.existsSync(path.join(reg, '999999.json')) && !fs.existsSync(path.join(reg, '999999.sock')), 'stale files should be gone');
});

await test('doctor: Firefox running, extension not installed / disabled / enabled-but-not-connected', () => {
  const ps = { FOXWRIGHT_TEST_PS: firefoxPs() };
  writeProfile(main.home, { ext: null });
  let r = main.run(['doctor'], ps);
  expect(/Firefox is running, but the Foxwright extension isn't installed/.test(r.out) && r.out.includes('https://addons.mozilla.org/firefox/addon/foxwright/'), r.out);
  writeProfile(main.home, { ext: 'disabled' });
  r = main.run(['doctor'], ps);
  expect(/installed but disabled \(Firefox profile "default-release"\)/.test(r.out) && /about:addons/.test(r.out), r.out);
  writeProfile(main.home, { ext: 'enabled' });
  r = main.run(['doctor'], ps);
  expect(/extension is enabled \(Firefox profile "default-release"\), but it isn't connected/.test(r.out) && /Restart Firefox/.test(r.out), r.out);
  expect(r.code === 1, 'exit code');
});

await test('doctor warns about a Snap Firefox', () => {
  const r = main.run(['doctor'], { FOXWRIGHT_TEST_PS: firefoxPs('/snap/firefox/4793/usr/lib/firefox/firefox') });
  expect(/running as a Snap/.test(r.out) && /support\.mozilla\.org\/kb\/install-firefox-linux/.test(r.out), r.out);
});

await test('doctor prints the installed helper\'s version next to its own, and flags a difference', () => {
  const app = path.join(main.home, '.foxwright/app/foxwright.mjs');
  const real = fs.readFileSync(app);
  fs.writeFileSync(app, 'console.log("0.6.9");\n');
  const r = main.run(['doctor']);
  fs.writeFileSync(app, real);
  expect(/Installed helper 0\.6\.9/.test(r.out) && /installed helper is 0\.6\.9, but this command is \d/.test(r.out), r.out);
});

await test('doctor: the launcher\'s Node.js is gone (it then says no Node in the helper log, exit 127)', () => {
  const sb = sandbox();
  expect(sb.run(['setup']).code === 0, 'setup');
  const app = path.join(sb.home, '.foxwright/app/foxwright.mjs');
  fs.writeFileSync(sb.launcher, S.launcherScript([path.join(sb.home, 'gone/bin/node')], app, path.join(sb.home, '.foxwright/helper.log')), { mode: 0o755 });
  const noNodePath = `${sb.bin}${path.delimiter}/bin`;
  const l = runLauncher(sb, { PATH: noNodePath });
  if (!S.findAllOnPath('node', { PATH: noNodePath }).length) {
    expect(l.code === 127 && /no Node\.js found/.test(l.err) && /launcher: Foxwright: no Node\.js found/.test(l.log), `code ${l.code}\n${l.err}\n${l.log}`);
  }
  const r = sb.run(['doctor']);
  expect(r.code === 1 && /The Node\.js the launcher was set up with is gone/.test(r.out) && /Re-run setup with the Node\.js you have now/.test(r.out), r.out);
}, { skip: process.platform === 'win32' && 'POSIX launcher' });

await test('setup --claude-code: a failing `claude mcp add` doesn\'t abort setup; it prints the command to run', () => {
  const sb = sandbox();
  fs.writeFileSync(path.join(sb.bin, 'claude'), '#!/bin/sh\nif [ "$2" = add ]; then echo "boom" >&2; exit 3; fi\nexit 1\n', { mode: 0o755 });
  const r = sb.run(['setup', '--claude-code']);
  expect(r.code === 0, r.out);
  expect(/Couldn't add Foxwright to Claude Code/.test(r.out) && /claude mcp add --scope user foxwright -- /.test(r.out), r.out);
  expect(/Next steps/.test(r.out), 'setup should carry on');
}, { skip: process.platform === 'win32' && 'POSIX shell script as fake claude' });

await test('Claude Desktop config: skipped on Linux without ~/.config/Claude; uninstall leaves no empty config, backup or folder', () => {
  const sb = sandbox();
  const cfgDir = isMac ? path.join(sb.home, 'Library/Application Support/Claude') : path.join(sb.home, '.config/Claude');
  const cfg = path.join(cfgDir, 'claude_desktop_config.json');
  let r = sb.run(['setup', '--claude-desktop']);
  if (isLinux) {
    expect(/Skipped Claude Desktop/.test(r.out) && !fs.existsSync(cfgDir), r.out);
    fs.mkdirSync(cfgDir, { recursive: true }); // as if an (unofficial) Claude Desktop had made it
    r = sb.run(['setup', '--claude-desktop']);
  }
  expect(fs.existsSync(cfg) && JSON.parse(fs.readFileSync(cfg, 'utf8')).mcpServers.foxwright, r.out);
  sb.run(['setup', '--claude-desktop']); // a second run makes a .bak of our own file
  r = sb.run(['uninstall']);
  expect(r.code === 0, r.out);
  expect(!fs.existsSync(cfg) && !fs.existsSync(cfg + '.bak'), `config or backup left behind:\n${r.out}`);
  if (isMac)
    expect(!fs.existsSync(cfgDir), 'setup created the Claude folder, so uninstall removes it when empty');
  else
    expect(fs.existsSync(cfgDir), 'a Claude folder setup didn\'t create stays');
  expect(!fs.existsSync(sb.nmDir), `empty native-messaging folder left behind:\n${r.out}`);
  expect(!fs.existsSync(path.join(sb.home, '.foxwright')), '~/.foxwright');
});

await test('uninstall keeps a Claude Desktop config that has other servers, and a native-messaging folder with other files', () => {
  const sb = sandbox();
  const cfgDir = isMac ? path.join(sb.home, 'Library/Application Support/Claude') : path.join(sb.home, '.config/Claude');
  const cfg = path.join(cfgDir, 'claude_desktop_config.json');
  fs.mkdirSync(cfgDir, { recursive: true });
  fs.writeFileSync(cfg, JSON.stringify({ mcpServers: { other: { command: 'x' } } }));
  fs.mkdirSync(sb.nmDir, { recursive: true });
  fs.writeFileSync(path.join(sb.nmDir, 'other.json'), '{}');
  sb.run(['setup', '--claude-desktop']);
  const r = sb.run(['uninstall']);
  const left = JSON.parse(fs.readFileSync(cfg, 'utf8'));
  expect(left.mcpServers.other && !left.mcpServers.foxwright, JSON.stringify(left));
  expect(fs.existsSync(path.join(sb.nmDir, 'other.json')) && !fs.existsSync(path.join(sb.nmDir, 'foxwright.json')), r.out);
});

await test('LibreWolf/Floorp in ~/.config use the Firefox registration; ~/.librewolf gets its own', () => {
  const sb = sandbox();
  fs.mkdirSync(path.join(sb.home, '.config/librewolf'), { recursive: true });
  fs.mkdirSync(path.join(sb.home, '.config/floorp'), { recursive: true });
  let r = sb.run(['setup']);
  expect(/LibreWolf \(~\/\.config\/librewolf\) uses the Firefox registration/.test(r.out) && /Floorp \(~\/\.config\/floorp\) uses the Firefox registration/.test(r.out), r.out);
  expect(!fs.existsSync(path.join(sb.home, '.config/librewolf/native-messaging-hosts')), 'no folder under ~/.config/librewolf');
  fs.mkdirSync(path.join(sb.home, '.librewolf'));
  r = sb.run(['setup']);
  expect(/Also registered with LibreWolf: .*\.librewolf\/native-messaging-hosts/.test(r.out) && fs.existsSync(path.join(sb.home, '.librewolf/native-messaging-hosts/foxwright.json')), r.out);
  r = sb.run(['uninstall']);
  expect(!fs.existsSync(path.join(sb.home, '.librewolf/native-messaging-hosts')), `left: ${r.out}`);
  expect(fs.existsSync(path.join(sb.home, '.librewolf')), 'LibreWolf\'s own folder stays');
}, { skip: !isLinux && 'Linux folders' });

// ---------- with a real Firefox (Docker/Linux) ----------
const live = process.env.FIREFOX && isLinux;
const liveSkip = !live && 'set FIREFOX (Linux/Docker only)';
let h = null;
const doctorIn = (env, extra = {}) => {
  const r = spawnSync(process.execPath, [cli, 'doctor'], { env: { ...env, ...extra }, encoding: 'utf8', timeout: 60000 });
  return { code: r.status, out: strip(r.stdout + r.stderr) };
};
if (live) {
  const { start } = await import('./harness.mjs');
  h = await start({});
}
await test('live: doctor sees the connected Firefox, extension and helper versions, exit 0', () => {
  const r = doctorIn(h.env, { FOXWRIGHT_BIDI_PORT: '1' });
  expect(r.code === 0 && /✓ Firefox connected.*extension [\d.]+.*helper [\d.]+ \(pid \d+\)/.test(r.out) && /All good/.test(r.out), r.out);
}, { skip: liveSkip });
await test('live: Firefox running (found in /proc) for a user whose helper isn\'t connected', () => {
  const sb = sandbox();
  expect(sb.run(['setup']).code === 0, 'setup');
  const env = { ...sb.env };
  delete env.FOXWRIGHT_TEST_PS; // the real process list
  const r = doctorIn(env);
  expect(r.code === 1 && /Firefox is running, but the Foxwright extension isn't (connected|installed)/.test(r.out), r.out);
}, { skip: liveSkip });
if (h)
  await h.stop();

if (live) {
  const { start } = await import('./harness.mjs');
  const { connectDriver } = await import('./bidi-driver.mjs');
  h = await start({ testDriver: true }); // Firefox has a BiDi port; the MCP server leaves it alone
  const port = new URL(h.bidiUrl).port;
  await test('live: a WebDriver session held with no Foxwright MCP server connected → "restart Firefox"', async () => {
    const driver = await connectDriver(h.bidiUrl); // takes Firefox's only session
    await h.client.close(); // no MCP server connected any more
    await new Promise(r => setTimeout(r, 1000));
    const r = doctorIn(h.env, { FOXWRIGHT_BIDI_PORT: port, FOXWRIGHT_TRUSTED: '1' }); // h.env turns trusted input off for the MCP server
    driver.close();
    expect(/WebDriver session is taken/.test(r.out) && /Restart Firefox \(with --remote-debugging-port\)/.test(r.out), r.out);
  });
  await h.stop();
  h = await start({ trusted: true }); // the MCP server holds the session itself
  await test('live: a WebDriver session held by the connected Foxwright MCP server is fine', async () => {
    await h.call('tabs_context_mcp', { createIfEmpty: true }); // the MCP server has opened its BiDi session by now
    const r = doctorIn(h.env);
    expect(/Trusted input: WebDriver BiDi at .* is in use, probably by the Foxwright MCP server/.test(r.out) && r.code === 0, r.out);
  });
  await h.stop();
} else {
  for (const n of ['live: held WebDriver session → "restart Firefox"', 'live: session held by the MCP server is fine'])
    await test(n, null, { skip: liveSkip });
}

for (const d of homes)
  fs.rmSync(d, { recursive: true, force: true });
const failed = results.filter(x => !x).length;
console.log(failed ? `\n${failed} failed` : `\n${results.length}/${results.length} passed`);
process.exit(failed ? 1 : 0);
