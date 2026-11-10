// Resilience & load: concurrent MCP clients, parallel tabs, latency under repetition,
// helper crash recovery, and Firefox restart recovery.
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import { fileURLToPath } from 'node:url';
import webExt from 'web-ext';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { start } from './harness.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const BASE = `http://127.0.0.1:${process.env.ZENKO_P1}`;
const sleep = ms => new Promise(r => setTimeout(r, ms));
const results = [];
async function test(name, fn) {
  const t0 = Date.now();
  try {
    const note = await fn();
    results.push({ name, ok: true });
    console.log(`  ✓ ${name} (${((Date.now() - t0) / 1000).toFixed(1)}s)${note ? '  — ' + note : ''}`);
  } catch (e) {
    results.push({ name, ok: false, err: e.message });
    console.log(`  ✗ ${name}\n      ${e.message}`);
  }
}
const expect = (c, m) => { if (!c) throw new Error(m); };
const pct = (arr, p) => arr.slice().sort((a, b) => a - b)[Math.min(arr.length - 1, Math.floor(arr.length * p))];

async function newClient() {
  const transport = new StdioClientTransport({ command: process.execPath, args: [path.join(root, 'host/dist/zenko.mjs'), 'mcp'], stderr: 'ignore', env: { ...process.env, ZENKO_HOME: path.join(h.home, '.zenko') } });
  const client = new Client({ name: 'zenko-resilience', version: '0' });
  await client.connect(transport);
  const call = async (name, args = {}) => {
    const r = await client.callTool({ name, arguments: args });
    return { text: (r.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n'), isError: !!r.isError };
  };
  return { client, call };
}

const h = await start({});
const a = { call: h.call };
const b = await newClient();

await test('two MCP clients at once, each with its own tab', async () => {
  const t1 = parseInt(/tabId (\d+)/.exec((await a.call('tabs_context_mcp', { createIfEmpty: true })).text)[1], 10);
  const t2 = parseInt(/Created tab (\d+)/.exec((await b.call('tabs_create_mcp', {})).text)[1], 10);
  const [r1, r2] = await Promise.all([
    a.call('navigate', { tabId: t1, url: `${BASE}/basic.html` }),
    b.call('navigate', { tabId: t2, url: `${BASE}/react.html` }),
  ]);
  expect(!r1.isError && !r2.isError, r1.text + r2.text);
  const [p1, p2] = await Promise.all([a.call('read_page', { tabId: t1 }), b.call('read_page', { tabId: t2 })]);
  expect(p1.text.includes('Sign up') && p2.text.includes('React form'), 'wrong pages');
  globalThis.tabs = [t1, t2];
});

await test('parallel tool calls across 3 tabs', async () => {
  const t3 = parseInt(/Created tab (\d+)/.exec((await a.call('tabs_create_mcp', {})).text)[1], 10);
  await a.call('navigate', { tabId: t3, url: `${BASE}/editor.html` });
  const [t1, t2] = globalThis.tabs;
  const rs = await Promise.all([
    a.call('find', { tabId: t1, query: 'Create account' }),
    b.call('find', { tabId: t2, query: 'Your name' }),
    a.call('read_page', { tabId: t3, filter: 'interactive' }),
    a.call('computer', { tabId: t1, action: 'screenshot' }),
    b.call('get_page_text', { tabId: t2 }),
  ]);
  expect(rs.every(r => !r.isError), rs.map(r => r.text.slice(0, 100)).join(' | '));
});

await test('latency under repetition (60 mixed calls)', async () => {
  const [t1] = globalThis.tabs;
  const lat = { read_page: [], find: [], click: [], screenshot: [] };
  for (let i = 0; i < 15; i++) {
    let t0 = Date.now();
    await a.call('read_page', { tabId: t1, filter: 'interactive' });
    lat.read_page.push(Date.now() - t0);
    t0 = Date.now();
    const f = await a.call('find', { tabId: t1, query: 'Clicked times' });
    lat.find.push(Date.now() - t0);
    const ref = /\[ref=([^\]]+)\]/.exec(f.text)[1];
    t0 = Date.now();
    const c = await a.call('computer', { tabId: t1, action: 'left_click', ref });
    lat.click.push(Date.now() - t0);
    expect(!c.isError, c.text);
    t0 = Date.now();
    await a.call('computer', { tabId: t1, action: 'screenshot' });
    lat.screenshot.push(Date.now() - t0);
  }
  const p = await a.call('read_page', { tabId: t1, filter: 'interactive' });
  expect(p.text.includes('Clicked 15 times'), 'expected 15 clicks registered');
  return Object.entries(lat).map(([k, v]) => `${k} p50 ${pct(v, 0.5)}ms p95 ${pct(v, 0.95)}ms`).join(', ');
});

await test('helper crash: extension restarts it and calls work again', async () => {
  const sock = h.sock;
  const status = await new Promise((resolve) => {
    const s = net.connect(sock);
    s.on('connect', () => s.write(JSON.stringify({ type: 'status', id: 1 }) + '\n'));
    s.on('data', d => { s.destroy(); resolve(JSON.parse(String(d).split('\n')[0])); });
  });
  process.kill(status.pid, 'SIGKILL');
  await sleep(500);
  let r;
  for (let i = 0; i < 40; i++) {
    r = await a.call('tabs_context_mcp', {});
    if (!r.isError)
      break;
    await sleep(500);
  }
  expect(!r.isError, 'never recovered: ' + r.text);
  return 'recovered';
});

await test('Firefox restart: the same MCP server reconnects', async () => {
  await h.stopFirefoxOnly();
  const down = await b.call('tabs_context_mcp', {});
  expect(down.isError && /not running|Lost connection|helper/i.test(down.text), 'expected a clear "Firefox not running" error: ' + down.text);
  await h.restartFirefox();
  let r;
  for (let i = 0; i < 40; i++) {
    r = await b.call('tabs_context_mcp', { createIfEmpty: true });
    if (!r.isError)
      break;
    await sleep(500);
  }
  expect(!r.isError, 'never reconnected: ' + r.text);
  return `while down: "${down.text.slice(0, 90)}…"`;
});

await b.client.close();
await h.stop();
const failed = results.filter(r => !r.ok).length;
console.log(`\n${results.length - failed}/${results.length} resilience tests passed`);
process.exit(failed ? 1 : 0);
void webExt; void fs;
