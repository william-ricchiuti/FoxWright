// The MCP server against the real helper and a fake extension (no Firefox):
//   - javascript_tool is listed only while a full-build extension is connected, with
//     notifications/tools/list_changed when that changes;
//   - file_upload shows the paths to the user first and reads/sends the contents only after approval,
//     and still works with an extension from before that (one-step file_upload).
//   node test/mcp-offline.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { createRequire } from 'node:module';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const req = createRequire(path.join(root, 'host', 'package.json'));
const { Client } = await import(req.resolve('@modelcontextprotocol/sdk/client/index.js'));
const { StdioClientTransport } = await import(req.resolve('@modelcontextprotocol/sdk/client/stdio.js'));
const { ToolListChangedNotificationSchema } = await import(req.resolve('@modelcontextprotocol/sdk/types.js'));
const home = fs.mkdtempSync(path.join(os.tmpdir(), 'fw-offline-'));
const sleep = ms => new Promise(r => setTimeout(r, ms));
const sock = path.join(home, 'foxwright.sock');
const CLI = path.join(root, 'host/dist/foxwright.mjs'); // built: npm run build

let failed = 0, passed = 0;
async function test(name, fn) {
  try {
    await fn();
    passed++;
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${String(e?.message || e).split('\n').join('\n      ')}`);
  }
}
const expect = (c, m) => { if (!c) throw new Error(m); };

/** The real helper, with a fake extension answering on its stdio. `answer(tool, args)` returns a result or throws. */
async function startHelper({ full, answer }) {
  const p = spawn(process.execPath, [CLI, 'host'], { env: { ...process.env, FOXWRIGHT_HOME: home }, stdio: ['pipe', 'pipe', 'inherit'] });
  const frames = []; // everything the extension received, raw
  const write = (obj) => {
    const body = Buffer.from(JSON.stringify(obj));
    const h = Buffer.alloc(4);
    h.writeUInt32LE(body.length);
    p.stdin.write(Buffer.concat([h, body]));
  };
  let buf = Buffer.alloc(0);
  p.stdout.on('data', async (d) => {
    buf = Buffer.concat([buf, d]);
    while (buf.length >= 4 && buf.length >= 4 + buf.readUInt32LE(0)) {
      const raw = buf.subarray(4, 4 + buf.readUInt32LE(0)).toString();
      buf = buf.subarray(4 + buf.readUInt32LE(0));
      frames.push(raw);
      const msg = JSON.parse(raw);
      if (msg.type !== 'request')
        continue;
      try {
        write({ type: 'response', id: msg.id, result: await answer(msg.tool, msg.args, frames) });
      } catch (e) {
        write({ type: 'response', id: msg.id, error: e.message });
      }
    }
  });
  write({ type: 'hello', version: '0.8.0', full, browserId: 'abcdefabcdef', name: 'Test' });
  fs.rmSync(sock, { force: true });
  for (let i = 0; i < 100 && !fs.existsSync(sock); i++)
    await sleep(50);
  return { frames, stop: async () => { p.kill(); await new Promise(r => p.once('exit', r)); fs.rmSync(sock, { force: true }); } };
}

const text = (t) => ({ content: [{ type: 'text', text: t }] });
const STATUS = { data: { groupTabIds: [1], clients: 1 } };
let answer = async (tool) => (tool === '_status' ? STATUS : tool === 'tabs_context_mcp' ? text('Foxwright tab group:\n- tabId 1: "x" http://a.test/') : text(`ok ${tool}`));
let helper = await startHelper({ full: false, answer: (...a) => answer(...a) });

const transport = new StdioClientTransport({ command: process.execPath, args: [CLI, 'mcp'], env: { ...process.env, FOXWRIGHT_HOME: home, FOXWRIGHT_TRUSTED: '0' }, stderr: 'inherit' });
const client = new Client({ name: 'offline-test', version: '0' });
let listChanged = 0;
client.setNotificationHandler(ToolListChangedNotificationSchema, () => { listChanged++; });
await client.connect(transport);
const names = async () => (await client.listTools()).tools.map(t => t.name);
const call = async (name, args) => {
  const r = await client.callTool({ name, arguments: args });
  return { text: (r.content || []).map(c => c.text).join('\n'), isError: !!r.isError };
};

console.log('Foxwright MCP server, offline (fake extension)');

await test('store build connected: javascript_tool is not listed, and calling it still explains why', async () => {
  const list = await names();
  expect(list.includes('computer') && !list.includes('javascript_tool'), list.join(', '));
  const r = await call('javascript_tool', { text: '1+1', tabId: 1 });
  expect(r.isError && /not available in the Firefox Add-ons store edition/.test(r.text), r.text);
});

await test('the extension becomes the full build (Firefox restarted): tools/list_changed, then javascript_tool is listed', async () => {
  await helper.stop();
  helper = await startHelper({ full: true, answer: (...a) => answer(...a) });
  const before = listChanged;
  await call('tabs_context_mcp', {}); // reconnects to the new helper
  for (let i = 0; i < 50 && listChanged === before; i++)
    await sleep(100);
  expect(listChanged > before, 'no notifications/tools/list_changed');
  const list = await names();
  expect(list.includes('javascript_tool'), list.join(', '));
  const r = await call('javascript_tool', { text: '1+1', tabId: 1 });
  expect(!r.isError && /ok javascript_tool/.test(r.text), r.text);
});

const file = path.join(home, 'report.txt');
fs.writeFileSync(file, 'UPLOAD-CONTENT-1234');
const b64 = Buffer.from('UPLOAD-CONTENT-1234').toString('base64');

await test('file_upload: the user sees the paths before any content is read or sent; contents follow the approval', async () => {
  let askedWith = null, contentBeforeAnswer = null, sent = null;
  answer = async (tool, args, frames) => {
    if (tool === '_upload_ask') {
      askedWith = args.paths;
      contentBeforeAnswer = frames.some(f => f.includes(b64));
      await sleep(300); // the user reads the window
      return { data: { token: 't1' } };
    }
    if (tool === '_upload_send') {
      sent = args;
      return text(`Attached ${args.files.map(f => f.name).join(', ')} to <input#f>.`);
    }
    return tool === '_status' ? STATUS : text(`ok ${tool}`);
  };
  const r = await call('file_upload', { paths: [file], ref: 'e1', tabId: 1 });
  expect(!r.isError && /Attached report.txt/.test(r.text), r.text);
  expect(askedWith?.length === 1 && askedWith[0].includes('report.txt') && /19 bytes/.test(askedWith[0]), 'asked with ' + JSON.stringify(askedWith));
  expect(contentBeforeAnswer === false, 'the file contents reached Firefox before the user answered');
  expect(sent?.token === 't1' && sent.files?.[0]?.base64 === b64, 'sent ' + JSON.stringify(sent)?.slice(0, 200));
});

await test('file_upload denied: the contents never leave the MCP server', async () => {
  const before = helper.frames.length;
  answer = async (tool) => {
    if (tool === '_upload_ask')
      throw new Error('The user did not approve uploading these files.');
    return tool === '_status' ? STATUS : text(`ok ${tool}`);
  };
  const r = await call('file_upload', { paths: [file], ref: 'e1', tabId: 1 });
  await sleep(200);
  expect(r.isError && /did not approve/.test(r.text), r.text);
  expect(!helper.frames.slice(before).some(f => f.includes(b64)), 'file contents were sent although the user said no');
});

await test('file_upload: a file changed after approval is refused', async () => {
  answer = async (tool) => {
    if (tool === '_upload_ask') {
      fs.writeFileSync(file, 'SOMETHING ELSE, LONGER THAN BEFORE');
      return { data: { token: 't2' } };
    }
    if (tool === '_upload_send')
      throw new Error('should not be reached');
    return tool === '_status' ? STATUS : text(`ok ${tool}`);
  };
  const r = await call('file_upload', { paths: [file], ref: 'e1', tabId: 1 });
  fs.writeFileSync(file, 'UPLOAD-CONTENT-1234');
  expect(r.isError && /changed after the user approved/.test(r.text), r.text);
});

await test('file_upload with an extension from before 0.8 (no _upload_ask) still works, the old way', async () => {
  let legacy = null;
  answer = async (tool, args) => {
    if (tool === '_upload_ask')
      throw new Error('Unknown tool _upload_ask');
    if (tool === 'file_upload') {
      legacy = args;
      return text('Attached report.txt to <input#f>.');
    }
    return tool === '_status' ? STATUS : text(`ok ${tool}`);
  };
  const r = await call('file_upload', { paths: [file], ref: 'e1', tabId: 1 });
  expect(!r.isError && /Attached/.test(r.text), r.text);
  expect(legacy?.files?.[0]?.base64 === b64 && /report\.txt/.test(legacy.paths?.[0]), JSON.stringify(legacy)?.slice(0, 200));
});

await client.close();
await helper.stop();
fs.rmSync(home, { recursive: true, force: true });
console.log(failed ? `\n${failed} failed, ${passed} passed` : `\n${passed}/${passed} passed`);
process.exit(failed ? 1 : 0);
