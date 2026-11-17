// Building blocks for test/e2e-compat.mjs: one throwaway "computer" (HOME + Firefox profile) on
// which published helpers and extensions are installed, updated and mixed the way real people end
// up with them. Unlike harness.mjs (web-ext, one build), Firefox is started directly and the
// extension is installed and updated through Firefox's own AddonManager, so runtime.onInstalled
// fires with the same reasons ("install", "update") as for a store install or auto-update.
//
// Linux only (Firefox must follow HOME to find the native-messaging registration).
import fs from 'node:fs';
import os from 'node:os';
import net from 'node:net';
import http from 'node:http';
import path from 'node:path';
import { spawn, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { writePolicies } from './harness.mjs';
import { connectPerson, chromeEval, sleep } from './gap-lib.mjs';

export const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
export const ART = path.resolve(process.env.FOXWRIGHT_COMPAT_DIR || path.join(root, 'dist', 'compat'));
export const EXT_ID = 'kitsune@william-ricchiuti.com';
const strip = (s) => String(s).replace(/\x1b\[[0-9;]*m/g, '');

/** Helper releases: the single-file CLI, the folder it installs to, and its own name. */
export const HELPERS = {
  '0.5.0': { file: path.join(ART, 'kitsune-0.5.0.mjs'), name: 'kitsune' },
  '0.6.0': { file: path.join(ART, 'zenko-0.6.0.mjs'), name: 'zenko' },
  '0.7.1': { file: path.join(ART, 'foxwright-0.7.1.mjs'), name: 'foxwright' },
  '0.8.0': { file: path.join(ART, 'foxwright-0.8.0.mjs'), name: 'foxwright' },
  current: { file: path.join(root, 'host/dist/foxwright.mjs'), name: 'foxwright' },
};
/** Extension releases: signed store files, and the store build of this checkout (unsigned). */
export const EXTENSIONS = {
  '0.6.0': path.join(ART, 'zenko-0.6.0.xpi'),
  '0.7.1': path.join(ART, 'foxwright-0.7.1.xpi'),
  current: path.join(root, 'dist/store'),
};
export const CURRENT = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
export const verOf = (v) => (v === 'current' ? CURRENT : v);
export const missingArtifacts = (...vs) => vs.flatMap(v => [HELPERS[v]?.file, EXTENSIONS[v]]).filter(f => f && !fs.existsSync(f));

function freePort() {
  return new Promise((resolve) => {
    const srv = net.createServer();
    srv.listen(0, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
}

/** A static server for test/fixtures on a free port (fixtures refer to each other by port; not needed here). */
export async function fixtureServer() {
  const fixtures = path.join(root, 'test', 'fixtures');
  const types = { html: 'text/html', js: 'text/javascript', json: 'application/json', css: 'text/css', pdf: 'application/pdf' };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = path.join(fixtures, decodeURIComponent(u.pathname));
    if (!p.startsWith(fixtures) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
      res.writeHead(404);
      return res.end('not found');
    }
    const delay = Math.min(5000, parseInt(u.searchParams.get('delay') || '0', 10) || 0);
    setTimeout(() => {
      res.writeHead(200, { 'content-type': types[path.extname(p).slice(1)] || 'application/octet-stream' });
      fs.createReadStream(p).pipe(res);
    }, delay);
  });
  await new Promise(r => server.listen(0, '127.0.0.1', r));
  const port = server.address().port;
  return { port, origin: `http://127.0.0.1:${port}`, close: () => server.close() };
}

const machines = new Set();

/**
 * A fresh computer: its own HOME (helper installs, native-messaging registrations, AI client
 * config) and one Firefox profile that survives Firefox restarts.
 */
export function machine() {
  const firefoxBin = process.env.FIREFOX;
  if (!firefoxBin || !fs.existsSync(firefoxBin))
    throw new Error('Set FIREFOX to the Firefox binary to test with (a copy, never your own install).');
  if (process.platform !== 'linux')
    throw new Error('test/e2e-compat.mjs runs on Linux only (in a container): Firefox must follow HOME.');
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fwc-')); // short: socket paths are limited to ~104 bytes
  const profile = path.join(home, 'profile');
  fs.mkdirSync(profile);
  fs.writeFileSync(path.join(profile, 'user.js'), Object.entries({
    'remote.prefs.recommended': true,
    'browser.shell.checkDefaultBrowser': false,
    'app.update.disabledForTesting': true,
    // The store must not update the extension behind the test's back: updates are the test's job.
    'extensions.update.enabled': false,
    'extensions.update.autoUpdateDefault': false,
    'extensions.getAddons.cache.enabled': false,
    'browser.aboutwelcome.enabled': false,
    'datareporting.policy.dataSubmissionEnabled': false,
    'toolkit.telemetry.reportingpolicy.firstRun': false,
    'browser.startup.homepage_override.mstone': 'ignore',
    'startup.homepage_welcome_url': 'about:blank',
    'startup.homepage_welcome_url.additional': '',
    // Honoured by Nightly, Developer Edition and ESR only: there the unsigned build under test
    // installs permanently, so it survives a Firefox restart like a store update does.
    'xpinstall.signatures.required': false,
  }).map(([k, v]) => `user_pref(${JSON.stringify(k)}, ${JSON.stringify(v)});`).join('\n') + '\n');
  writePolicies(firefoxBin, null); // DisableAppUpdate only: site access is the person's own choice here
  const env = { ...process.env, HOME: home, MOZ_REMOTE_ALLOW_SYSTEM_ACCESS: '1', PATH: `${path.join(home, 'bin')}${path.delimiter}${process.env.PATH}` };
  for (const k of Object.keys(env)) {
    if (/^(FOXWRIGHT|ZENKO|KITSUNE)_/.test(k) && !/_E2E_|_COMPAT_/.test(k))
      delete env[k];
  }
  // The MCP servers must not take Firefox's one WebDriver BiDi session: the test acts as the person through it.
  for (const p of ['FOXWRIGHT', 'ZENKO', 'KITSUNE']) {
    env[`${p}_TRUSTED`] = '0';
    env[`${p}_BIDI_PORT`] = '1';
  }
  env.FOXWRIGHT_TEST_PS = undefined;
  delete env.FOXWRIGHT_TEST_PS;
  const m = { home, profile, env, firefoxBin, ff: null, mcps: new Set() };

  /** Run a helper release's CLI on this computer: cli('0.7.1', 'setup'), cli('current', 'doctor'). */
  m.cli = (version, ...args) => {
    const r = spawnSync(process.execPath, [HELPERS[version].file, ...args], { env, encoding: 'utf8', timeout: 90000 });
    return { code: r.status, out: strip((r.stdout || '') + (r.stderr || '')) };
  };
  /** The copy `setup` installed (what an AI client's config and Firefox's launcher run). */
  m.installed = (name = 'foxwright') => path.join(home, `.${name}`, 'app', `${name}.mjs`);
  m.installedCli = (name, ...args) => {
    const r = spawnSync(process.execPath, [m.installed(name), ...args], { env, encoding: 'utf8', timeout: 90000 });
    return { code: r.status, out: strip((r.stdout || '') + (r.stderr || '')) };
  };
  m.helperLog = (name = 'foxwright') => {
    try {
      return fs.readFileSync(path.join(home, `.${name}`, 'helper.log'), 'utf8');
    } catch {
      return '';
    }
  };

  /**
   * A stand-in for the Claude Code CLI on this computer's PATH that keeps `claude mcp add/remove/get`
   * entries in a file, so a test can see which MCP servers "Claude Code" would start.
   * entries(): { name: [command, ...args] }.
   */
  m.fakeClaude = () => {
    const store = path.join(home, 'claude-mcp.json');
    fs.mkdirSync(path.join(home, 'bin'), { recursive: true });
    fs.writeFileSync(path.join(home, 'bin', 'claude'), `#!${process.execPath}
const fs = require('fs');
const store = ${JSON.stringify(store)};
let db = {};
try { db = JSON.parse(fs.readFileSync(store, 'utf8')); } catch {}
const a = process.argv.slice(2);
if (a[0] !== 'mcp') process.exit(2);
const rest = a.slice(2).filter((x, i, l) => x !== '--scope' && l[i - 1] !== '--scope');
if (a[1] === 'add') {
  const sep = rest.indexOf('--');
  db[rest[0]] = rest.slice(sep + 1);
  fs.writeFileSync(store, JSON.stringify(db));
  console.log('Added stdio MCP server ' + rest[0]);
} else if (a[1] === 'remove') {
  if (!db[rest[0]]) process.exit(1);
  delete db[rest[0]];
  fs.writeFileSync(store, JSON.stringify(db));
} else if (a[1] === 'get') {
  if (!db[rest[0]]) process.exit(1);
  console.log(rest[0] + ':\\n  Type: stdio\\n  Command: ' + db[rest[0]][0] + '\\n  Args: ' + db[rest[0]].slice(1).join(' '));
} else process.exit(2);
`, { mode: 0o755 });
    return {
      entries: () => {
        try {
          return JSON.parse(fs.readFileSync(store, 'utf8'));
        } catch {
          return {};
        }
      },
    };
  };

  /**
   * Start an MCP server the way an AI client does (a long-lived process). `file`: the CLI to run,
   * by default the installed copy. The process keeps the code it started with, like an AI client
   * that isn't restarted after an update.
   */
  m.mcp = async (file = m.installed()) => {
    let stderr = '';
    const transport = new StdioClientTransport({ command: process.execPath, args: [file, 'mcp'], env, stderr: 'pipe' });
    transport.stderr?.on('data', (d) => { stderr += d; });
    const client = new Client({ name: 'foxwright-compat', version: '0' });
    await client.connect(transport);
    const c = {
      client,
      version: client.getServerVersion()?.version,
      get stderr() { return stderr; },
      /** { text, isError }; a call that never answers within `ms` is reported, not thrown. */
      call: async (name, args = {}, ms = 45000) => {
        const t0 = Date.now();
        try {
          const r = await client.callTool({ name, arguments: args }, undefined, { timeout: ms });
          return { text: (r.content || []).filter(x => x.type === 'text').map(x => x.text).join('\n'), isError: !!r.isError, ms: Date.now() - t0, images: (r.content || []).filter(x => x.type === 'image').length };
        } catch (e) {
          return { text: `NO ANSWER (${e?.message || e})`, isError: true, hung: true, ms: Date.now() - t0, images: 0 };
        }
      },
      tools: async () => (await client.listTools()).tools,
      close: async () => {
        m.mcps.delete(c);
        await Promise.race([client.close().catch(() => {}), sleep(5000)]);
      },
    };
    m.mcps.add(c);
    return c;
  };

  /** Start Firefox with this computer's profile; resolves once the test's own BiDi session is open. */
  m.startFirefox = async () => {
    if (m.ff)
      throw new Error('Firefox is already running on this machine');
    const port = await freePort();
    const args = ['--profile', profile, '--no-remote', `--remote-debugging-port=${port}`, '-remote-allow-system-access'];
    if (!process.env.FOXWRIGHT_E2E_HEADFUL)
      args.push('--headless');
    const proc = spawn(firefoxBin, args, { env, stdio: 'ignore' });
    let exited = false;
    proc.on('exit', () => { exited = true; });
    const url = `ws://127.0.0.1:${port}/session`;
    let d = null, last = '';
    for (const t0 = Date.now(); Date.now() - t0 < 90000 && !d && !exited;) {
      try {
        d = await connectPerson(url);
      } catch (e) {
        last = String(e?.message || e?.error?.message || e);
        await sleep(400);
      }
    }
    if (!d) {
      proc.kill('SIGKILL');
      throw new Error(`Firefox's WebDriver BiDi endpoint never came up on port ${port} (${exited ? 'Firefox exited' : last})`);
    }
    const ff = { proc, d, port, url, get exited() { return exited; } };
    ff.chrome = (expr) => chromeEval(d, expr);
    /** Install or update the extension through AddonManager. Signed files install permanently;
     *  the build under test is unsigned, so on release Firefox it is a temporary install. */
    ff.install = async (version) => {
      const src = EXTENSIONS[version];
      const temporary = version === 'current' && !(await ff.chrome(`!Services.prefs.getBoolPref('xpinstall.signatures.required', true) && (AppConstants.NIGHTLY_BUILD || AppConstants.MOZ_DEV_EDITION || AppConstants.IS_ESR)`).catch(() => false));
      let file = src;
      if (version === 'current' && !temporary) {
        file = path.join(home, `foxwright-${CURRENT}-unsigned.xpi`);
        fs.rmSync(file, { force: true });
        const z = spawnSync('zip', ['-qr', file, '.'], { cwd: src });
        if (z.status !== 0)
          throw new Error('could not zip the build under test (is `zip` installed?)');
      }
      const how = await ff.chrome(`(async () => {
        const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs');
        const { FileUtils } = ChromeUtils.importESModule('resource://gre/modules/FileUtils.sys.mjs');
        const file = new FileUtils.File(${JSON.stringify(file)});
        const before = (await AddonManager.getAddonByID(${JSON.stringify(EXT_ID)}))?.version || null;
        if (${JSON.stringify(temporary)}) {
          await AddonManager.installTemporaryAddon(file);
        } else {
          const install = await AddonManager.getInstallForFile(file, null, { source: 'test' });
          await install.install();
        }
        const a = await AddonManager.getAddonByID(${JSON.stringify(EXT_ID)});
        return JSON.stringify({ before, after: a?.version || null, active: !!a?.isActive, temporary: !!a?.temporarilyInstalled });
      })()`);
      const r = JSON.parse(how);
      if (r.after !== verOf(version) || !r.active)
        throw new Error(`installing extension ${version} left Firefox with ${JSON.stringify(r)}`);
      await sleep(1500); // the new background page loads its settings and connects to the helper
      return r;
    };
    ff.extVersion = () => ff.chrome(`(async () => { const { AddonManager } = ChromeUtils.importESModule('resource://gre/modules/AddonManager.sys.mjs'); return (await AddonManager.getAddonByID(${JSON.stringify(EXT_ID)}))?.version || null; })()`);
    ff.extBase = async () => `moz-extension://${await ff.chrome(`WebExtensionPolicy.getByID(${JSON.stringify(EXT_ID)}).mozExtensionHostname`)}/`;
    /** Open one of the extension's own pages in a new window; returns its browsing context. */
    ff.openPage = async (rel) => {
      const { context } = await d.bidi('browsingContext.create', { type: 'window' });
      await d.bidi('browsingContext.navigate', { context, url: `${await ff.extBase()}${rel}`, wait: 'complete' });
      return context;
    };
    /** Run `fn(context)` in the toolbar popup opened as a page, then close it. */
    ff.withPopup = async (fn) => {
      const ctx = await ff.openPage('popup/popup.html');
      try {
        return await fn(ctx);
      } finally {
        await d.bidi('browsingContext.close', { context: ctx }).catch(() => {});
      }
    };
    /** A message from the popup to the background page (what its buttons send). */
    ff.message = (msg) => ff.withPopup(ctx => d.evalIn(ctx, `browser.runtime.sendMessage(${JSON.stringify(msg)}).then(s => JSON.stringify(s ?? null))`).then(JSON.parse));
    ff.status = () => ff.message({ kind: 'status', initial: true });
    /** What the person reads in the toolbar popup right now (visible text only). */
    ff.popupText = (waitMs = 2500) => ff.withPopup(async (ctx) => {
      await sleep(waitMs); // the popup renders after its first status answer, then every 1.5 s
      return (await d.evalIn(ctx, `document.body.innerText`)).replace(/\n{2,}/g, '\n');
    });
    ff.storage = (area = 'local') => ff.withPopup(ctx => d.evalIn(ctx, `browser.storage.${area}.get(null).then(s => JSON.stringify(s))`).then(JSON.parse));
    ff.setStorage = (obj, area = 'local') => ff.withPopup(ctx => d.evalIn(ctx, `browser.storage.${area}.set(${JSON.stringify(obj)}).then(() => true)`));
    /** Extension pages of a kind that are open ('welcome/welcome.html', 'prompt/prompt.html'). */
    ff.openExtPages = async (rel) => (await d.contexts()).filter(c => c.url.startsWith('moz-extension://') && c.url.includes(rel));
    /** Wait until the toolbar popup's status satisfies `pred` (the extension retries the helper with a backoff). */
    ff.waitStatus = async (pred, ms = 20000) => {
      let s = null;
      for (const t0 = Date.now(); Date.now() - t0 < ms;) {
        s = await ff.status().catch(() => null);
        if (s && pred(s))
          return s;
        await sleep(500);
      }
      return s;
    };
    ff.stop = async () => {
      if (m.ff === ff)
        m.ff = null;
      try {
        await Promise.race([d.bidi('browser.close', {}), sleep(5000)]);
      } catch { /* already going */ }
      try {
        d.close();
      } catch { /* ignore */ }
      for (const t0 = Date.now(); !exited && Date.now() - t0 < 15000;)
        await sleep(100);
      if (!exited)
        proc.kill('SIGKILL');
      await sleep(500); // the helper notices its stdin closing and removes its socket
    };
    m.ff = ff;
    return ff;
  };

  m.destroy = async () => {
    machines.delete(m);
    for (const c of [...m.mcps])
      await c.close();
    if (m.ff)
      await m.ff.stop();
    spawnSync('pkill', ['-f', home]); // helpers and MCP servers of this machine only
    fs.rmSync(home, { recursive: true, force: true, maxRetries: 3 });
  };
  machines.add(m);
  return m;
}

export async function destroyAll() {
  for (const m of [...machines])
    await m.destroy().catch(() => {});
}

/** Shorten a tool result for a table cell or a failure message. */
export const brief = (t, n = 220) => {
  const s = String(t ?? '').replace(/\s+/g, ' ').trim();
  return s.length > n ? s.slice(0, n - 1) + '…' : s;
};
