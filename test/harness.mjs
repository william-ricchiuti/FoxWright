// Test harness: static fixture servers + real Firefox (via web-ext) with the Foxwright
// extension + the Foxwright MCP server driven by an MCP client.
//
//   FIREFOX=/path/to/firefox node test/e2e.mjs
//   FOXWRIGHT_E2E_TRUSTED=1  -> also start Firefox with --remote-debugging-port (BiDi)
//   FOXWRIGHT_E2E_HEADFUL=1  -> don't pass --headless
//   FOXWRIGHT_E2E_BUILD=store|full|<folder>
//                            -> which extension build a suite runs against when it doesn't ask for
//                               one itself (default full). A folder is an unpacked extension, e.g.
//                               the signed AMO XPI unzipped (see test/fetch-amo-xpi.mjs).
//   FOXWRIGHT_E2E_PAGE_EVAL=bidi|beacon
//                            -> force the route h.pageEval() uses to read page state (see below).
//   FOXWRIGHT_E2E_SUITE_TIMEOUT_MIN=25
//                            -> give up on a whole suite after this many minutes, printing which
//                               test and tool call it was stuck in and the helper log tail.
//   FOXWRIGHT_E2E_ISOLATE=0  -> on Linux, use your real ~/.foxwright instead of a temporary HOME.
import http from 'node:http';
import fs from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import os from 'node:os';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { execFileSync } from 'node:child_process';
import webExt from 'web-ext';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { WebSocket } from './ws-shim.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const isWin = process.platform === 'win32';
const sleep = ms => new Promise(r => setTimeout(r, ms));

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
if (!process.env.FOXWRIGHT_P1) {
  process.env.FOXWRIGHT_P1 = String(await freePort(8765));
  process.env.FOXWRIGHT_P2 = String(await freePort(process.env.FOXWRIGHT_P1 === '8765' ? 8766 : 0));
}
export const P1 = Number(process.env.FOXWRIGHT_P1);
export const P2 = Number(process.env.FOXWRIGHT_P2);
const fixtures = path.join(root, 'test', 'fixtures');

// ---------- page probe ("beacon") for reading page state without javascript_tool ----------
//
// When enabled, every HTML page the fixture servers send gets a tiny script that opens a
// WebSocket back to the fixture server. h.pageEval() sends it code to run in the page and gets the
// result back. Used where the test can't have its own WebDriver BiDi session: trusted mode (the
// MCP server holds Firefox's single session) and plain synthetic runs of the store build.
const PROBE_PATH = '/__foxwright_probe';
const probe = { enabled: false, conns: new Set(), nextId: 1, pending: new Map(), wss: null };
const PROBE_JS = `(() => {
  if (window.__foxwrightProbe) return;
  window.__foxwrightProbe = true;
  const AsyncFunction = (async () => {}).constructor;
  const ser = ${serializeInPage.toString()};
  const connect = () => {
    let ws;
    try { ws = new WebSocket((location.protocol === 'https:' ? 'wss://' : 'ws://') + location.host + '${PROBE_PATH}'); } catch { return; }
    ws.onopen = () => ws.send(JSON.stringify({ hello: true, top: window.top === window, href: location.href }));
    ws.onmessage = async (e) => {
      const job = JSON.parse(e.data);
      let out;
      try { out = { ok: true, value: ser(await new AsyncFunction(job.body)()) }; }
      catch (err) { out = { ok: false, error: String(err && err.stack ? err.message : err) }; }
      ws.send(JSON.stringify({ id: job.id, href: location.href, top: window.top === window, ...out }));
    };
  };
  connect();
})();`;

// The same value formatting javascript_tool uses (src/background/tools.js), so a test that reads
// state through pageEvalText() sees exactly what it saw through javascript_tool.
function serializeInPage(v) {
  if (v === undefined)
    return 'undefined';
  if (typeof v === 'function')
    return v.toString().slice(0, 2000);
  if (typeof Element !== 'undefined' && v instanceof Element)
    return v.outerHTML.length > 5000 ? v.outerHTML.slice(0, 5000) + '…' : v.outerHTML;
  if (typeof NodeList !== 'undefined' && (v instanceof NodeList || v instanceof HTMLCollection))
    return JSON.stringify(Array.from(v).map(n => n.outerHTML ? n.outerHTML.slice(0, 300) : String(n)), null, 2);
  try {
    const s = JSON.stringify(v, null, 2);
    return s === undefined ? String(v) : s;
  } catch {
    return String(v);
  }
}

function probeServer() {
  if (probe.wss)
    return probe.wss;
  const { WebSocketServer } = createRequire(path.join(root, 'host', 'package.json'))('ws');
  probe.wss = new WebSocketServer({ noServer: true });
  probe.wss.on('connection', (ws) => {
    const c = { ws, top: false, href: '' };
    probe.conns.add(c);
    ws.on('message', (data) => {
      let m;
      try {
        m = JSON.parse(String(data));
      } catch {
        return;
      }
      if (m.href)
        c.href = m.href;
      if (typeof m.top === 'boolean')
        c.top = m.top;
      if (m.id && probe.pending.has(m.id)) {
        probe.pending.get(m.id)(m);
        probe.pending.delete(m.id);
      }
    });
    ws.on('close', () => probe.conns.delete(c));
    ws.on('error', () => probe.conns.delete(c));
  });
  return probe.wss;
}

function probeRun(c, body, ms = 15000) {
  return new Promise((resolve, reject) => {
    const id = probe.nextId++;
    const timer = setTimeout(() => {
      probe.pending.delete(id);
      reject(new Error(`pageEval (page probe): no answer from ${c.href} within ${ms} ms (page frozen or navigating?)`));
    }, ms);
    probe.pending.set(id, (m) => {
      clearTimeout(timer);
      resolve(m);
    });
    c.ws.send(JSON.stringify({ id, body }));
  });
}

function injectProbe(html) {
  const tag = `<script src="${PROBE_PATH}.js"></script>`;
  for (const re of [/<head\b[^>]*>/i, /<html\b[^>]*>/i, /<!doctype[^>]*>/i]) {
    const m = re.exec(html);
    if (m)
      return html.slice(0, m.index + m[0].length) + tag + html.slice(m.index + m[0].length);
  }
  return tag + html;
}

function serve(port) {
  const types = { html: 'text/html', js: 'text/javascript', json: 'application/json', css: 'text/css', pdf: 'application/pdf' };
  const server = http.createServer((req, res) => {
    const u = new URL(req.url, 'http://x');
    if (u.pathname === `${PROBE_PATH}.js`) {
      res.writeHead(200, { 'content-type': 'text/javascript', 'cache-control': 'no-store' });
      return res.end(probe.enabled ? PROBE_JS : '');
    }
    const p = path.join(fixtures, decodeURIComponent(u.pathname));
    if (!p.startsWith(fixtures) || !fs.existsSync(p) || fs.statSync(p).isDirectory()) {
      res.writeHead(404);
      return res.end('not found');
    }
    const send = () => {
      res.writeHead(200, { 'content-type': types[path.extname(p).slice(1)] || 'application/octet-stream' });
      if (p.endsWith('.html')) { // fixtures refer to each other by port
        const html = fs.readFileSync(p, 'utf8').replaceAll(':8765', `:${P1}`).replaceAll(':8766', `:${P2}`);
        return res.end(probe.enabled ? injectProbe(html) : html);
      }
      fs.createReadStream(p).pipe(res);
    };
    // ?delay=ms holds the response, e.g. so a frame is still loading when its parent page is ready.
    const delay = Math.min(5000, parseInt(u.searchParams.get('delay') || '0', 10) || 0);
    if (delay)
      setTimeout(send, delay);
    else
      send();
  });
  server.on('upgrade', (req, socket, head) => {
    if (!probe.enabled || new URL(req.url, 'http://x').pathname !== PROBE_PATH)
      return socket.destroy();
    const wss = probeServer();
    wss.handleUpgrade(req, socket, head, ws => wss.emit('connection', ws, req));
  });
  return new Promise(r => server.listen(port, '127.0.0.1', () => r(server)));
}

// Socket path, or a function returning it (null while it isn't known yet: on Windows the pipe name
// comes from ~/.foxwright/pipe-id, which the helper creates on first start).
function waitForSocket(p, ms = 30000) {
  const start = Date.now();
  const target = typeof p === 'function' ? p : () => p;
  return new Promise((resolve, reject) => {
    const tryOnce = () => {
      const t = target();
      const retry = () => {
        if (Date.now() - start > ms)
          reject(new Error(`helper socket never appeared (${t || 'pipe name not known yet'})`));
        else
          setTimeout(tryOnce, 300);
      };
      if (!t)
        return retry();
      const s = net.connect(t);
      s.once('connect', () => {
        s.destroy();
        resolve();
      });
      s.once('error', retry);
    };
    tryOnce();
  });
}

export function writePolicies(firefoxBin, policy, extraPolicies = {}) {
  // Enterprise policies live next to the binary on Linux/Windows, in Contents/Resources on macOS.
  // (The bundle isn't always named *.app: setup-firefox on CI unpacks it as .../arm64/Contents/MacOS/firefox.)
  const mac = /\/Contents\/MacOS\/[^/]+$/.test(firefoxBin);
  const dist = mac ? path.join(path.dirname(firefoxBin), '..', 'Resources', 'distribution') : path.join(path.dirname(firefoxBin), 'distribution');
  if (/^\/Applications\//.test(firefoxBin) && !process.env.FOXWRIGHT_E2E_ALLOW_SYSTEM_FIREFOX)
    throw new Error('The tests write a policies.json into the Firefox install. Point FIREFOX at a copy of Firefox.app (scripts/mac-test.sh does this) instead of /Applications/Firefox.app.');
  fs.mkdirSync(dist, { recursive: true });
  const file = path.join(dist, 'policies.json');
  // Always keep the test Firefox from updating itself: a throwaway copy once updated mid-suite
  // (macOS) and hung the run.
  const policies = { DisableAppUpdate: true };
  if (policy) {
    const ext = {};
    for (const id of ['kitsune@william-ricchiuti.com', 'kitsune-full@william-ricchiuti.com'])
      ext[id] = policy;
    policies['3rdparty'] = { Extensions: ext };
  }
  fs.writeFileSync(file, JSON.stringify({ policies: { ...extraPolicies, ...policies } }, null, 2));
}

// ---------- suite watchdog ----------
//
// A suite that hangs (a tool call that never returns, a Firefox that stopped answering) used to
// sit silently until the CI job timed out. The watchdog gives up after a while and says where.
const watch = { timer: null, test: null, lastLine: '', lastCall: null, inflight: new Map(), callSeq: 0, harnesses: new Set(), t0: Date.now() };

/** Tell the watchdog which test is running (gap-lib's runner and e2e-storebuild do this). */
export function setCurrentTest(name) {
  watch.test = name ? { name, at: Date.now() } : null;
}

function armWatchdog() {
  if (watch.timer)
    return;
  // The real-site and real-agent runs are long by design (17 agent tasks can take an hour).
  const long = /(agent-eval|realsites)\.mjs$/.test(process.argv[1] || '');
  const min = Number(process.env.FOXWRIGHT_E2E_SUITE_TIMEOUT_MIN || (long ? 120 : 25));
  watch.timer = setTimeout(onSuiteTimeout, min * 60000);
  watch.timer.unref();
  watch.minutes = min;
  // Remember the last test result line, for suites that don't call setCurrentTest().
  const orig = console.log.bind(console);
  console.log = (...a) => {
    const s = a.map(String).join(' ');
    if (/^\s+[✓✗-] /.test(s))
      watch.lastLine = s.split('\n')[0].trim();
    orig(...a);
  };
}

function tail(file, lines = 40) {
  try {
    return fs.readFileSync(file, 'utf8').split('\n').slice(-lines).join('\n');
  } catch (e) {
    return `(could not read ${file}: ${e.code || e.message})`;
  }
}

const short = (v, n = 300) => {
  const s = typeof v === 'string' ? v : JSON.stringify(v);
  return s && s.length > n ? s.slice(0, n) + '…' : s;
};

/** What the suite was doing: current test, last and in-flight tool calls, helper log tail. */
export function describeState() {
  const now = Date.now();
  const out = [];
  out.push(`suite: ${path.basename(process.argv[1] || '?')} (running for ${Math.round((now - watch.t0) / 1000)} s)`);
  if (watch.test)
    out.push(`current test: ${watch.test.name} (for ${Math.round((now - watch.test.at) / 1000)} s)`);
  if (watch.lastLine)
    out.push(`last finished test: ${watch.lastLine}${watch.test ? '' : '  (the stuck test is the one after it)'}`);
  const lc = watch.lastCall;
  if (lc)
    out.push(`last tool call: ${lc.name} ${short(lc.args)} started ${Math.round((now - lc.at) / 1000)} s ago, ${lc.done ? `answered after ${lc.ms} ms${lc.isError ? ' (error)' : ''}` : 'NO ANSWER YET'}`);
  for (const c of watch.inflight.values())
    if (c !== lc)
      out.push(`also waiting on: ${c.name} ${short(c.args, 150)} for ${Math.round((now - c.at) / 1000)} s`);
  for (const h of watch.harnesses) {
    const log = path.join(h.home, '.foxwright', 'helper.log');
    out.push(`helper log tail (${log}):\n${tail(log).split('\n').map(l => '    ' + l).join('\n')}`);
  }
  return out.join('\n');
}

async function onSuiteTimeout() {
  const msg = `\n!! Suite timeout: gave up after ${watch.minutes} min (FOXWRIGHT_E2E_SUITE_TIMEOUT_MIN).\n${describeState()}\n`;
  console.error(msg);
  try {
    fs.mkdirSync(path.join(root, 'test/results'), { recursive: true });
    fs.writeFileSync(path.join(root, 'test/results', `${path.basename(process.argv[1] || 'suite', '.mjs')}-timeout.txt`), msg);
  } catch { /* best effort */ }
  await Promise.race([Promise.allSettled([...watch.harnesses].map(h => h.stop())), sleep(15000)]);
  process.exit(124);
}

// ---------- trusted mode readiness ----------

/**
 * Wait until Firefox's WebDriver BiDi endpoint creates a session promptly (and release it again),
 * so the MCP server's own first connection, which gives up after 1.5-2.5 s, doesn't hit a remote
 * agent that is still starting under load and silently fall back to synthetic input.
 */
async function waitForBidiReady(port, ms = Number(process.env.FOXWRIGHT_E2E_TRUSTED_WAIT_SEC || 90) * 1000) {
  const url = `ws://127.0.0.1:${port}/session`;
  const t0 = Date.now();
  let last = 'no attempt yet';
  while (Date.now() - t0 < ms) {
    const a0 = Date.now();
    try {
      await new Promise((resolve, reject) => {
        const ws = new WebSocket(url);
        const timer = setTimeout(() => {
          try { ws.close(); } catch { /* ignore */ }
          reject(new Error('no answer within 10 s'));
        }, 10000);
        let step = 0;
        ws.addEventListener('error', (e) => {
          clearTimeout(timer);
          reject(new Error(e?.message || e?.error?.message || 'connection error'));
        });
        ws.addEventListener('open', () => ws.send(JSON.stringify({ id: 1, method: 'session.new', params: { capabilities: {} } })));
        ws.addEventListener('message', (e) => {
          const m = JSON.parse(String(e.data));
          if (m.id === 1 && step === 0) {
            if (m.type === 'error')
              return reject(new Error(`session.new: ${m.error} ${m.message}`));
            step = 1;
            ws.send(JSON.stringify({ id: 2, method: 'session.end', params: {} }));
          } else if (m.id === 2) {
            clearTimeout(timer);
            ws.addEventListener('close', () => resolve());
            ws.close();
          }
        });
      });
      const took = Date.now() - a0;
      if (took < 2000) {
        await sleep(300); // let Firefox drop the ended session before the MCP server connects
        return took;
      }
      last = `a session took ${took} ms to open and close (Firefox is busy)`;
    } catch (e) {
      last = String(e.message || e);
    }
    await sleep(1000);
  }
  throw new Error(`Trusted mode never became ready: Firefox's WebDriver BiDi endpoint on port ${port} did not open a session promptly within ${Math.round(ms / 1000)} s (last: ${last}). Without it the "trusted" run would quietly test synthetic input, so the harness stops here. Raise FOXWRIGHT_E2E_TRUSTED_WAIT_SEC on a slow machine.`);
}

// ---------- helpers for pageEval ----------

// javascript_tool's REPL semantics: the value of the last top-level expression is returned.
function lastTopLevelSplit(src) {
  let depth = 0, quote = null, last = -1;
  for (let i = 0; i < src.length; i++) {
    const ch = src[i];
    if (quote) {
      if (ch === '\\') i++;
      else if (ch === quote) quote = null;
      continue;
    }
    if (ch === '"' || ch === "'" || ch === '`') quote = ch;
    else if (ch === '/' && src[i + 1] === '/') { const nl = src.indexOf('\n', i); if (nl < 0) break; i = nl; if (depth === 0) last = i; }
    else if ('([{'.includes(ch)) depth++;
    else if (')]}'.includes(ch)) { depth--; if (depth === 0 && ch === '}') last = i; }
    else if ((ch === ';' || ch === '\n') && depth === 0) last = i;
  }
  return last;
}
const AsyncFunction = (async () => {}).constructor;
function functionBody(code) {
  const trimmed = code.trim().replace(/;+\s*$/, '');
  const attempts = [`return (${trimmed}\n);`];
  const cut = lastTopLevelSplit(trimmed);
  if (cut > 0 && trimmed.slice(cut + 1).trim())
    attempts.push(`${trimmed.slice(0, cut + 1)}\nreturn (${trimmed.slice(cut + 1)}\n);`);
  attempts.push(code);
  for (const body of attempts) {
    try {
      new AsyncFunction(body); // syntax check only (Node and Firefox agree on JS syntax)
      return body;
    } catch (e) {
      if (!(e instanceof SyntaxError))
        return body;
    }
  }
  return code;
}

/** Parse tabs_context_mcp output into { tabId: url }. */
function tabUrls(text) {
  const out = {};
  for (const line of String(text).split('\n')) {
    const m = /^- tabId (\d+): (.*)$/.exec(line.trim());
    if (!m)
      continue;
    const rest = m[2].replace(/ \(active in its window\)$/, '');
    if (/site not approved yet/.test(rest))
      continue;
    out[m[1]] = rest.split(' ').pop();
  }
  return out;
}

const sameDoc = (a, b) => a === b || (a && b && a.split('#')[0] === b.split('#')[0]);

/**
 * Start fixture servers, Firefox with the Foxwright build, and an MCP client.
 *   build:       'full' | 'store' | a folder with an unpacked extension. Default: FOXWRIGHT_E2E_BUILD or 'full'.
 *   trusted:     Firefox gets a remote-debugging port and the MCP server uses it (trusted input).
 *                The harness waits until Firefox's BiDi endpoint is ready before the first test, and
 *                fails clearly if trusted input never comes up.
 *   testDriver:  Firefox gets a remote-debugging port, but the MCP server is told not to use it,
 *                so the test itself can open a WebDriver BiDi session (e.g. to press buttons in
 *                Foxwright's permission window like a person would). Returned as `bidiUrl`.
 *   profileDir:  keep this Firefox profile across restartFirefox() (web-ext keepProfileChanges), so
 *                stored settings survive a restart.
 *   pageEval:    how h.pageEval() reads page state without javascript_tool:
 *                'bidi'   through a WebDriver BiDi session of the test's own (default with testDriver;
 *                         without it the harness opens a debugging port the MCP server doesn't use),
 *                'beacon' through a probe script the fixture server adds to every page (default in
 *                         trusted mode, where the MCP server owns Firefox's only BiDi session, and
 *                         for the store build),
 *                true     pick one of those, false/undefined: only if testDriver or the store build.
 *
 * On Linux the run is isolated from your own Foxwright install: HOME points at a temporary folder,
 * where the dev build is set up (native-messaging manifest, ~/.foxwright), and GIFs go to a temp
 * folder. Set FOXWRIGHT_E2E_ISOLATE=0 to use your real install instead. macOS and Windows use the
 * real HOME (Firefox finds the native-messaging manifest there regardless of HOME, and on Windows
 * through the registry): run `node host/dist/foxwright.mjs setup` first. On a throwaway CI runner
 * that is fine; on your own Mac see test/README.md for keeping a test run apart from your install.
 *
 * alongside: a harness from an earlier start(). Starts a second Firefox (its own temporary profile)
 * that shares that one's Foxwright folder and fixture servers, like a second Firefox profile on the
 * same computer. Resolves once the second browser has registered in ~/.foxwright/browsers.
 *
 * extraPolicies: other Firefox enterprise policies to set, e.g. { ExtensionSettings: ... }.
 */
export async function start({ build, trusted = false, testDriver = false, policy = { mode: 'all', confirmUploads: false }, alongside = null, profileDir = null, deferSetup = false, extraPolicies = {}, pageEval: pageEvalOpt } = {}) {
  armWatchdog();
  const firefox = process.env.FIREFOX;
  if (!firefox || !fs.existsSync(firefox))
    throw new Error('Set FIREFOX to the Firefox binary to test with, e.g. FIREFOX=/path/to/firefox/firefox (see docs/TESTING.md).');
  writePolicies(firefox, policy, extraPolicies);

  build = build || process.env.FOXWRIGHT_E2E_BUILD || 'full';
  const sourceDir = build === 'full' || build === 'store' ? path.join(root, 'dist', build) : path.resolve(build);
  if (!fs.existsSync(path.join(sourceDir, 'manifest.json')))
    throw new Error(`No extension build at ${sourceDir} (FOXWRIGHT_E2E_BUILD=${build}). Run npm run build first.`);
  const manifest = JSON.parse(fs.readFileSync(path.join(sourceDir, 'manifest.json'), 'utf8'));
  const isStore = manifest.browser_specific_settings?.gecko?.id === 'kitsune@william-ricchiuti.com';

  let evalMode = process.env.FOXWRIGHT_E2E_PAGE_EVAL || pageEvalOpt;
  if (evalMode === true || evalMode === undefined || evalMode === false) {
    const wanted = evalMode === true || testDriver || isStore;
    evalMode = wanted ? (testDriver ? 'bidi' : 'beacon') : null;
  }
  if (evalMode && !['bidi', 'beacon'].includes(evalMode))
    throw new Error(`Unknown pageEval mode ${evalMode} (use bidi or beacon).`);
  if (evalMode === 'bidi' && trusted)
    throw new Error('pageEval "bidi" needs a BiDi session of the test\'s own, but in trusted mode the MCP server holds Firefox\'s only one. Use "beacon".');
  if (evalMode === 'beacon' && !alongside)
    probe.enabled = true;

  const isolate = !alongside && process.platform === 'linux' && process.env.FOXWRIGHT_E2E_ISOLATE !== '0';
  let home = alongside ? alongside.home : os.homedir();
  const env = { ...(alongside ? alongside.env : process.env) };
  if (isolate) {
    home = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwright-home-'));
    env.HOME = home;
    if (!deferSetup)
      execFileSync(process.execPath, [path.join(root, 'host/dist/foxwright.mjs'), 'setup'], { env, stdio: 'ignore' });
  }
  if (!alongside)
    env.FOXWRIGHT_GIF_DIR = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwright-gifs-'));
  const ownBidi = evalMode === 'bidi' && !testDriver; // a port only the test uses
  const bidiPort = trusted || testDriver || ownBidi ? await freePort(0) : null;
  if (bidiPort)
    env.FOXWRIGHT_BIDI_PORT = String(bidiPort);
  if (testDriver || ownBidi)
    env.FOXWRIGHT_TRUSTED = '0';
  // Optional: reach real websites through an HTTP(S) proxy that re-signs TLS with its own CA
  // (e.g. a CI sandbox). Builds a throwaway profile whose NSS DB trusts that CA.
  let profile;
  const proxyPrefs = {};
  if (process.env.FOXWRIGHT_E2E_PROXY) {
    const [host, port] = process.env.FOXWRIGHT_E2E_PROXY.split(':');
    profile = fs.mkdtempSync(path.join(os.tmpdir(), 'foxwright-prof-'));
    execFileSync('certutil', ['-N', '-d', `sql:${profile}`, '--empty-password']);
    if (process.env.FOXWRIGHT_E2E_PROXY_CA)
      execFileSync('certutil', ['-A', '-n', 'e2e-proxy', '-t', 'C,,', '-i', process.env.FOXWRIGHT_E2E_PROXY_CA, '-d', `sql:${profile}`]);
    Object.assign(proxyPrefs, {
      'network.proxy.type': 1, 'network.proxy.http': host, 'network.proxy.http_port': Number(port),
      'network.proxy.ssl': host, 'network.proxy.ssl_port': Number(port), 'network.proxy.no_proxies_on': 'localhost, 127.0.0.1',
      'security.OCSP.enabled': 0, 'network.captive-portal-service.enabled': false, 'network.connectivity-service.enabled': false,
    });
  }
  const s1 = alongside ? null : await serve(P1);
  const s2 = alongside ? null : await serve(P2);
  const fwDir = path.join(home, '.foxwright');
  const sockPath = () => {
    if (!isWin)
      return path.join(fwDir, 'foxwright.sock');
    try {
      const id = fs.readFileSync(path.join(fwDir, 'pipe-id'), 'utf8').trim();
      return /^[a-f0-9]{32}$/.test(id) ? `\\\\.\\pipe\\foxwright-${id}` : null;
    } catch {
      return null;
    }
  };
  const registry = path.join(fwDir, 'browsers');
  const registered = () => {
    try {
      return fs.readdirSync(registry).filter(n => n.endsWith('.json'));
    } catch {
      return [];
    }
  };
  const before = new Set(registered());
  if (!alongside && !isWin)
    fs.rmSync(sockPath(), { force: true });

  const args = [];
  if (!process.env.FOXWRIGHT_E2E_HEADFUL)
    args.push('--headless');
  if (bidiPort)
    args.push(`--remote-debugging-port=${bidiPort}`);
  if (testDriver) {
    // Lets the test script read and press buttons in extension pages. Firefox 159 removed the
    // flag in favour of the environment variable; older versions (140 ESR) only know the flag.
    args.push('-remote-allow-system-access');
    process.env.MOZ_REMOTE_ALLOW_SYSTEM_ACCESS = '1';
  }
  const runOpts = {
    sourceDir,
    firefox,
    args,
    noReload: true,
    ...(profile ? { firefoxProfile: profile } : {}),
    ...(profileDir ? { firefoxProfile: profileDir, keepProfileChanges: true } : {}),
    noInput: true,
    browserConsole: false,
    pref: {
      'remote.prefs.recommended': true,
      'browser.shell.checkDefaultBrowser': false,
      'app.update.disabledForTesting': true,
      ...(profileDir ? { 'extensions.webextensions.keepStorageOnUninstall': true, 'extensions.webextensions.keepUuidOnUninstall': true } : {}),
      ...proxyPrefs,
    },
  };
  // Firefox (and the helper it starts) inherit the environment at launch: point HOME at the
  // isolated folder just for that.
  const runFirefox = async () => {
    const saved = { HOME: process.env.HOME, FOXWRIGHT_GIF_DIR: process.env.FOXWRIGHT_GIF_DIR };
    for (const k of Object.keys(saved)) {
      if (env[k] !== undefined) // (Windows often has no HOME: don't set the string "undefined")
        process.env[k] = env[k];
    }
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
  // deferSetup: Firefox runs with no helper installed (a new user's first start). The test calls
  // runSetup() (`foxwright setup` in the isolated HOME) when it wants the helper to appear.
  if (deferSetup) {
    if (!isolate)
      throw new Error('deferSetup needs the isolated HOME (Linux, FOXWRIGHT_E2E_ISOLATE not 0).');
    return {
      home, env, bidiUrl: bidiPort ? `ws://127.0.0.1:${bidiPort}/session` : null,
      runSetup: async () => {
        execFileSync(process.execPath, [path.join(root, 'host/dist/foxwright.mjs'), 'setup'], { env, stdio: 'ignore' });
        return attach();
      },
      stop: async () => {
        try {
          await runner.exit();
        } catch { /* ignore */ }
        s1?.close();
        s2?.close();
      },
    };
  }
  return attach();

  async function attach() {
  try {
    if (alongside) {
      // The shared socket belongs to the first browser; wait for this one's own registry entry.
      const t0 = Date.now();
      while (!registered().some(n => !before.has(n))) {
        if (Date.now() - t0 > 30000)
          throw new Error('The second Firefox never registered in ~/.foxwright/browsers.');
        await sleep(200);
      }
    } else
      await waitForSocket(sockPath);
    if (trusted)
      await waitForBidiReady(bidiPort);
  } catch (e) {
    // Don't leave this Firefox running behind a failed start.
    await Promise.race([runner.exit().catch(() => {}), sleep(15000)]);
    s1?.close();
    s2?.close();
    throw e;
  }

  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'host/dist/foxwright.mjs'), 'mcp'], stderr: 'inherit', env });
  const client = new Client({ name: 'foxwright-e2e', version: '0' });
  await client.connect(transport);

  async function rawCall(name, args = {}) {
    const rec = { name, args, at: Date.now(), done: false };
    const key = ++watch.callSeq;
    watch.lastCall = rec;
    watch.inflight.set(key, rec);
    try {
      const r = await client.callTool({ name, arguments: args });
      const textOut = (r.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n');
      const images = (r.content || []).filter(c => c.type === 'image');
      Object.assign(rec, { done: true, ms: Date.now() - rec.at, isError: !!r.isError });
      return { text: textOut, images, isError: !!r.isError };
    } finally {
      rec.done = true;
      watch.inflight.delete(key);
    }
  }

  // In trusted runs the first tabs_context_mcp is where a suite checks the input mode. If the MCP
  // server's first BiDi connection lost a race with a busy Firefox it reports synthetic input and
  // retries 5 s later: wait for that instead of letting the whole run test the wrong mode.
  let firstContext = true;
  async function call(name, args = {}) {
    if (!(trusted && firstContext && name === 'tabs_context_mcp'))
      return rawCall(name, args);
    firstContext = false;
    let r = await rawCall(name, args);
    const t0 = Date.now();
    while (!r.isError && /Input mode: synthetic/.test(r.text) && Date.now() - t0 < 60000) {
      console.log(`      [harness] trusted input not active yet (${(/real input couldn't start: ([^\n]*)/.exec(r.text) || [, 'Firefox busy'])[1].slice(0, 120)}); waiting`);
      await sleep(6000);
      const again = await rawCall(name, args);
      if (again.isError || /Input mode: trusted/.test(again.text))
        return again;
    }
    if (/Input mode: synthetic/.test(r.text))
      throw new Error(`[harness] Trusted mode never became active: the MCP server still reports synthetic input 60 s after Firefox's BiDi endpoint accepted a test session. First answer was:\n${r.text}`);
    return r;
  }

  let stopped = false;
  async function stop() {
    if (stopped)
      return;
    stopped = true;
    watch.harnesses.delete(h);
    try {
      driver?.close?.();
    } catch { /* ignore */ }
    try {
      await Promise.race([client.close(), sleep(5000)]);
    } catch { /* ignore */ }
    const pids = isWin ? helperPids() : [];
    try {
      await Promise.race([runner.exit(), sleep(15000)]);
    } catch { /* ignore */ }
    // On Windows the helper (node, started by Firefox through a .bat) can outlive Firefox and
    // keep the named pipe; end it so the next suite starts clean.
    for (const pid of pids) {
      try {
        process.kill(pid);
      } catch { /* already gone */ }
    }
    s1?.close();
    s2?.close();
    for (const c of probe.conns)
      c.ws.terminate();
    if (!alongside)
      probe.wss?.close();
  }
  function helperPids() {
    return registered().map((n) => {
      try {
        return JSON.parse(fs.readFileSync(path.join(registry, n), 'utf8')).pid;
      } catch {
        return null;
      }
    }).filter(p => Number.isInteger(p) && p !== process.pid);
  }
  async function stopFirefoxOnly() {
    await runner.exit();
    await sleep(1500);
  }
  async function restartFirefox() {
    runner = await runFirefox();
    await waitForSocket(sockPath);
  }

  // ---------- page state without javascript_tool ----------
  let driver = null;
  const lastUrl = {};
  /** Use a BiDi session the suite opened itself (Firefox allows only one) for pageEval. */
  function useDriver(d) {
    driver = d;
  }
  async function ownDriver() {
    if (driver)
      return driver;
    const { connectDriver } = await import('./bidi-driver.mjs');
    driver = await connectDriver(`ws://127.0.0.1:${bidiPort}/session`);
    return driver;
  }
  async function urlOf(tabId) {
    const r = await rawCall('tabs_context_mcp', {});
    if (!r.isError)
      Object.assign(lastUrl, tabUrls(r.text));
    const u = lastUrl[tabId];
    if (!u)
      throw new Error(`pageEval: tab ${tabId} is not in the Foxwright group or its site isn't approved:\n${r.text}`);
    return u;
  }
  async function evalBidi(tabId, body) {
    const d = await ownDriver();
    const url = await urlOf(tabId);
    let ctxs = [];
    for (let i = 0; i < 40; i++) {
      ctxs = (await d.contexts()).filter(c => sameDoc(c.url, url));
      if (ctxs.length)
        break;
      await sleep(50);
    }
    if (ctxs.length !== 1)
      throw new Error(`pageEval: ${ctxs.length} browsing contexts show ${url}; give the tabs distinct URLs (e.g. ?tab=2)`);
    const expression = `(async () => { ${body}\n})().then(${serializeInPage.toString()})`;
    const r = await d.bidi('script.evaluate', { expression, target: { context: ctxs[0].context }, awaitPromise: true });
    if (r.type === 'exception')
      throw new Error(`pageEval: ${r.exceptionDetails?.text}`);
    return r.result?.value;
  }
  async function evalBeacon(tabId, body) {
    const url = await urlOf(tabId);
    let cands = [];
    for (let i = 0; i < 60; i++) {
      // Ask every top-level page where it is now (pushState/hash changes since it connected).
      const tops = [...probe.conns].filter(c => c.top);
      await Promise.all(tops.map(c => probeRun(c, 'return location.href', 3000).catch(() => null)));
      cands = tops.filter(c => sameDoc(c.href, url));
      if (cands.length)
        break;
      await sleep(100);
    }
    if (cands.length !== 1)
      throw new Error(cands.length ? `pageEval: ${cands.length} pages show ${url}; give the tabs distinct URLs (e.g. ?tab=2)` : `pageEval: no page probe connected from ${url}. The page probe only runs in pages served by the harness's fixture servers (ports ${P1}/${P2}).`);
    const m = await probeRun(cands[0], body);
    if (!m.ok)
      throw new Error(`pageEval: ${m.error}`);
    return m.value;
  }
  /**
   * Run `code` in the top document of a Foxwright tab and return the result formatted exactly like
   * javascript_tool's text (JSON for values, "undefined", outerHTML for elements), without
   * javascript_tool, so checks also work on the store build. REPL semantics like javascript_tool.
   */
  async function pageEvalText(tabId, code) {
    if (!evalMode)
      throw new Error('pageEval is off: start the harness with { pageEval: true } (or testDriver: true, or the store build).');
    const body = functionBody(code);
    return evalMode === 'bidi' ? evalBidi(tabId, body) : evalBeacon(tabId, body);
  }
  /** Like pageEvalText, but parsed: the expression's value (JSON round-trip). */
  async function pageEval(tabId, code) {
    const t = await pageEvalText(tabId, code);
    if (t === 'undefined')
      return undefined;
    try {
      return JSON.parse(t);
    } catch {
      return t;
    }
  }
  /**
   * javascript_tool's text on the full build, pageEvalText otherwise: the drop-in replacement for
   * the suites' js() helpers so they run unchanged on the store build.
   */
  async function js(tabId, code) {
    if (!isStore && !process.env.FOXWRIGHT_E2E_PAGE_EVAL) {
      const r = await rawCall('javascript_tool', { tabId, action: 'javascript_exec', text: code });
      if (r.isError)
        throw new Error(`javascript_tool failed: ${r.text}`);
      return r.text;
    }
    return pageEvalText(tabId, code);
  }

  const h = { call, stop, client, stopFirefoxOnly, restartFirefox, home, env, get sock() { return sockPath(); }, gifDir: env.FOXWRIGHT_GIF_DIR, bidiUrl: bidiPort && !ownBidi ? `ws://127.0.0.1:${bidiPort}/session` : null, build, isStore, sourceDir, pageEvalMode: evalMode, pageEval, pageEvalText, js, useDriver, describeState };
  watch.harnesses.add(h);
  return h;
  }
}
