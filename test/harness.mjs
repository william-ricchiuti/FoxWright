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
import webExt from 'web-ext';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
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

export function writePolicies(firefoxBin, policy, extra = {}) {
  const dist = path.join(path.dirname(firefoxBin), 'distribution');
  fs.mkdirSync(dist, { recursive: true });
  const file = path.join(dist, 'policies.json');
  if (!policy) {
    fs.rmSync(file, { force: true });
    return;
  }
  const ext = {};
  for (const id of ['kitsune@william-ricchiuti.com', 'kitsune-full@william-ricchiuti.com'])
    ext[id] = policy;
  fs.writeFileSync(file, JSON.stringify({ policies: { '3rdparty': { Extensions: ext }, ...extra } }, null, 2));
}

export async function start({ build = 'full', trusted = false, policy = { mode: 'all', confirmUploads: false } } = {}) {
  const firefox = process.env.FIREFOX || '/home/claude/ff/firefox/firefox';
  // Optional: reach real websites through an HTTP proxy with its own CA (used in CI sandboxes).
  const extra = {};
  if (process.env.KITSUNE_E2E_PROXY) {
    extra.Proxy = { Mode: 'manual', HTTPProxy: process.env.KITSUNE_E2E_PROXY, UseHTTPProxyForAllProtocols: true, Passthrough: 'localhost, 127.0.0.1', Locked: false };
    if (process.env.KITSUNE_E2E_PROXY_CA)
      extra.Certificates = { Install: [process.env.KITSUNE_E2E_PROXY_CA] };
  }
  writePolicies(firefox, policy, extra);
  const s1 = await serve(8765);
  const s2 = await serve(8766);
  const sock = path.join(os.homedir(), '.kitsune', 'kitsune.sock');
  fs.rmSync(sock, { force: true });

  const args = [];
  if (!process.env.KITSUNE_E2E_HEADFUL)
    args.push('--headless');
  if (trusted)
    args.push('--remote-debugging-port=9222');
  const runner = await webExt.cmd.run({
    sourceDir: path.join(root, 'dist', build),
    firefox,
    args,
    noReload: true,
    noInput: true,
    browserConsole: false,
    pref: {
      'remote.prefs.recommended': true,
      'browser.shell.checkDefaultBrowser': false,
      ...(process.env.KITSUNE_E2E_PROXY ? { 'security.OCSP.enabled': 0, 'network.captive-portal-service.enabled': false, 'network.connectivity-service.enabled': false, 'security.enterprise_roots.enabled': true } : {}),
    },
  }, { shouldExitProgram: false });
  await waitForSocket(sock);

  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'host/dist/kitsune.mjs'), 'mcp'], stderr: 'inherit' });
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
  return { call, stop, client };
}
