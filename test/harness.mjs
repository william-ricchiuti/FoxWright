// Test harness: static fixture servers + real Firefox (via web-ext) with the Kitsune
// extension + the Kitsune MCP server driven by an MCP client.
//
//   FIREFOX=/path/to/firefox node test/e2e.mjs
//   KITSUNE_E2E_TRUSTED=1  -> also start Firefox with --remote-debugging-port (BiDi)
//   KITSUNE_E2E_HEADFUL=1  -> don't pass --headless
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import webExt from 'web-ext';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');

// Two free local ports for the fixture servers (set before the tests read them).
async function freePort(preferred) {
  const tryPort = (port) => new Promise((resolve) => {
    const srv = net.createServer();
    srv.once('error', () => resolve(null));
    srv.listen(port, '127.0.0.1', () => {
      const p = srv.address().port;
      srv.close(() => resolve(p));
    });
  });
  return (await tryPort(preferred)) || tryPort(0);
}
if (!process.env.KITSUNE_P1) {
  process.env.KITSUNE_P1 = String(await freePort(8765));
  process.env.KITSUNE_P2 = String(await freePort(process.env.KITSUNE_P1 === '8765' ? 8766 : 0));
}
export const P1 = Number(process.env.KITSUNE_P1);
export const P2 = Number(process.env.KITSUNE_P2);
const fixtures = path.join(root, 'test', 'fixtures');

function serve(port) {
  const types = { html: 'text/html', js: 'text/javascript', json: 'application/json', css: 'text/css' };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    const p = path.join(fixtures, decodeURIComponent(u.pathname));
    if (!p.startsWith(fixtures) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
      res.writeHead(404);
      return res.end('not found');
    }
    res.writeHead(200, { 'content-type': types[path.extname(p).slice(1)] || 'application/octet-stream' });
    if (p.endsWith('.html')) // fixtures refer to each other by port
      return res.end(fs.readFileSync(p, 'utf8').replaceAll(':8765', `:${P1}`).replaceAll(':8766', `:${P2}`));
    fs.createReadStream(p).pipe(res);
  });
  return new Promise(r => server.listen(port, '127.0.0.1', () => r(server)));
}

function waitForSocket(p, ms = 30000) {
  const start = Date.now();
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const s = net.connect(p);
      s.once('connect', () => {
        s.destroy();
        resolve();
      });
      s.once('error', () => {
        if (Date.now() - start > ms)
          reject(new Error('helper socket never appeared'));
        else
          setTimeout(tryOnce, 300);
      });
    };
    tryOnce();
  });
}

export function writePolicies(firefoxBin, policy) {
  // Enterprise policies live next to the binary on Linux/Windows, in Contents/Resources on macOS.
  const mac = /\.app\/Contents\/MacOS\//.test(firefoxBin);
  const dist = mac ? path.join(path.dirname(firefoxBin), '..', 'Resources', 'distribution') : path.join(path.dirname(firefoxBin), 'distribution');
  if (/^\/Applications\//.test(firefoxBin) && !process.env.KITSUNE_E2E_ALLOW_SYSTEM_FIREFOX)
    throw new Error('The tests write a policies.json into the Firefox install. Point FIREFOX at a copy of Firefox.app (scripts/mac-test.sh does this) instead of /Applications/Firefox.app.');
  fs.mkdirSync(dist, { recursive: true });
  const file = path.join(dist, 'policies.json');
  if (!policy) {
    fs.rmSync(file, { force: true });
    return;
  }
  const ext = {};
  for (const id of ['kitsune@william-ricchiuti.com', 'kitsune-full@william-ricchiuti.com'])
    ext[id] = policy;
  fs.writeFileSync(file, JSON.stringify({ policies: { '3rdparty': { Extensions: ext } } }, null, 2));
}

/**
 * Start fixture servers, Firefox with the Kitsune build, and an MCP client.
 *   trusted:     Firefox gets a remote-debugging port and the MCP server uses it (trusted input).
 *   testDriver:  Firefox gets a remote-debugging port, but the MCP server is told not to use it,
 *                so the test itself can open a WebDriver BiDi session (e.g. to press buttons in
 *                Kitsune's permission window like a person would). Returned as `bidiUrl`.
 *
 * On Linux the run is isolated from your own Kitsune install: HOME points at a temporary folder,
 * where the dev build is set up (native-messaging manifest, ~/.kitsune), and GIFs go to a temp
 * folder. Set KITSUNE_E2E_ISOLATE=0 to use your real install instead (macOS always does).
 */
export async function start({ build = 'full', trusted = false, testDriver = false, policy = { mode: 'all', confirmUploads: false } } = {}) {
  const firefox = process.env.FIREFOX;
  if (!firefox || !fs.existsSync(firefox))
    throw new Error('Set FIREFOX to the Firefox binary to test with, e.g. FIREFOX=/path/to/firefox/firefox (see docs/TESTING.md).');
  writePolicies(firefox, policy);

  const isolate = process.platform === 'linux' && process.env.KITSUNE_E2E_ISOLATE !== '0';
  let home = os.homedir();
  const env = { ...process.env };
  if (isolate) {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-home-'));
    env.HOME = home;
    execFileSync(process.execPath, [path.join(root, 'host/dist/kitsune.mjs'), 'setup'], { env, stdio: 'ignore' });
  }
  env.KITSUNE_GIF_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-gifs-'));
  const bidiPort = trusted || testDriver ? await freePort(0) : null;
  if (bidiPort)
    env.KITSUNE_BIDI_PORT = String(bidiPort);
  if (testDriver)
    env.KITSUNE_TRUSTED = '0';
  // Optional: reach real websites through an HTTP(S) proxy that re-signs TLS with its own CA
  // (e.g. a CI sandbox). Builds a throwaway profile whose NSS DB trusts that CA.
  let profile;
  const proxyPrefs = {};
  if (process.env.KITSUNE_E2E_PROXY) {
    const [host, port] = process.env.KITSUNE_E2E_PROXY.split(':');
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'kitsune-prof-'));
    execFileSync('certutil', ['-N', '-d', `sql:${profile}`, '--empty-password']);
    if (process.env.KITSUNE_E2E_PROXY_CA)
      execFileSync('certutil', ['-A', '-n', 'e2e-proxy', '-t', 'C,,', '-i', process.env.KITSUNE_E2E_PROXY_CA, '-d', `sql:${profile}`]);
    Object.assign(proxyPrefs, {
      'network.proxy.type': 1, 'network.proxy.http': host, 'network.proxy.http_port': Number(port),
      'network.proxy.ssl': host, 'network.proxy.ssl_port': Number(port), 'network.proxy.no_proxies_on': 'localhost, 127.0.0.1',
      'security.OCSP.enabled': 0, 'network.captive-portal-service.enabled': false, 'network.connectivity-service.enabled': false,
    });
  }
  const s1 = await serve(P1);
  const s2 = await serve(P2);
  const sock = path.join(home, '.kitsune', 'kitsune.sock');
  fs.rmSync(sock, { force: true });

  const args = [];
  if (!process.env.KITSUNE_E2E_HEADFUL)
    args.push('--headless');
  if (bidiPort)
    args.push(`--remote-debugging-port=${bidiPort}`);
  if (testDriver)
    args.push('-remote-allow-system-access'); // lets the test script read and press buttons in extension pages
  const runOpts = {
    sourceDir: path.join(root, 'dist', build),
    firefox,
    args,
    noReload: true,
    ...(profile ? { firefoxProfile: profile } : {}),
    noInput: true,
    browserConsole: false,
    pref: {
      'remote.prefs.recommended': true,
      'browser.shell.checkDefaultBrowser': false,
      ...proxyPrefs,
    },
  };
  // Firefox (and the helper it starts) inherit the environment at launch: point HOME at the
  // isolated folder just for that.
  const runFirefox = async () => {
    const saved = { HOME: process.env.HOME, KITSUNE_GIF_DIR: process.env.KITSUNE_GIF_DIR };
    Object.assign(process.env, { HOME: env.HOME, KITSUNE_GIF_DIR: env.KITSUNE_GIF_DIR });
    try {
      return await webExt.cmd.run(runOpts, { shouldExitProgram: false });
    } finally {
      for (const [k, v] of Object.entries(saved)) {
        if (v === undefined)
          delete process.env[k];
        else
          process.env[k] = v;
      }
    }
  };
  let runner = await runFirefox();
  await waitForSocket(sock);

  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'host/dist/kitsune.mjs'), 'mcp'], stderr: 'inherit', env });
  const client = new Client({ name: 'kitsune-e2e', version: '0' });
  await client.connect(transport);

  async function call(name, args = {}) {
    const r = await client.callTool({ name, arguments: args });
    const textOut = (r.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
    const images = (r.content || []).filter(c => c.type === 'image');
    return { text: textOut, images, isError: !!r.isError };
  }

  async function stop() {
    try {
      await client.close();
    } catch { /* ignore */ }
    try {
      await runner.exit();
    } catch { /* ignore */ }
    s1.close();
    s2.close();
  }
  async function stopFirefoxOnly() {
    await runner.exit();
    await new Promise(r => setTimeout(r, 1500));
  }
  async function restartFirefox() {
    runner = await runFirefox();
    await waitForSocket(sock);
  }
  return { call, stop, client, stopFirefoxOnly, restartFirefox, home, sock, gifDir: env.KITSUNE_GIF_DIR, bidiUrl: bidiPort ? `ws://127.0.0.1:${bidiPort}/session` : null };
}
