// Robustness of tool arguments (gap area 7): wrong types, huge strings, odd numbers, unknown refs and
// tab IDs, browser_batch abuse, concurrent conflicting calls, and garbage on the helper's socket.
// After every call: a clean MCP result within the time limit, and the helper still answers.
//
//   FIREFOX=... node test/e2e-gaps-fuzz.mjs        (headless is fine)
import net from 'node:net';
import { start } from './harness.mjs';
import { runner, sleep, expect, refOf, tabIdOf } from './gap-lib.mjs';

const { test, finish } = runner('e2e-gaps-fuzz');
const P1 = process.env.FOXWRIGHT_P1;
const O = `http://127.0.0.1:${P1}`;
console.log('Foxwright gap tests: argument fuzzing and robustness');
const h = await start({ policy: { mode: 'all', confirmUploads: false } });
const tabId = tabIdOf((await h.call('tabs_context_mcp', { createIfEmpty: true })).text);
await h.call('navigate', { tabId, url: `${O}/basic.html` });

/** Call with a deadline. Never throws: returns { r, ms, hung, threw }. */
async function guarded(name, args, ms = 30000) {
  const t0 = Date.now();
  let timer;
  try {
    const call = h.client.callTool({ name, arguments: args }, undefined, { timeout: ms + 60000 }).then(x => ({ isError: !!x.isError, text: (x.content || []).filter(c => c.type === 'text').map(c => c.text).join('\n'), images: (x.content || []).filter(c => c.type === 'image') }));
    const r = await Promise.race([call, new Promise((_, rej) => { timer = setTimeout(() => rej(new Error('HUNG')), ms); })]);
    return { r, ms: Date.now() - t0 };
  } catch (e) {
    return { hung: e.message === 'HUNG', threw: e.message, ms: Date.now() - t0 };
  } finally {
    clearTimeout(timer);
  }
}
async function healthy() {
  const g = await guarded('tabs_context_mcp', {}, 15000);
  return !!g.r && !g.r.isError;
}

const BIG = 'x'.repeat(2_000_000);
const nested = (n) => { let o = {}; for (let i = 0; i < n; i++) o = { a: o }; return o; };
const T = () => tabId;
const cases = [
  ['navigate', { url: 123 }], ['navigate', { url: BIG }], ['navigate', { url: 'http://[::1' }], ['navigate', { url: 'http://' }], ['navigate', { url: '' }], ['navigate', { url: `http://${'a'.repeat(300)}.test/` }], ['navigate', { url: 'back', tabId: -1 }], ['navigate', { url: 'forward', tabId: 2 ** 53 }],
  ['read_page', { tabId: 'abc' }], ['read_page', { tabId: -1 }], ['read_page', { tabId: 0 }], ['read_page', { tabId: 1.5 }], ['read_page', { tabId: 1e15 }], ['read_page', { tabId: T(), depth: 1e9 }], ['read_page', { tabId: T(), max_chars: -1 }], ['read_page', { tabId: T(), max_chars: 1e12 }], ['read_page', { tabId: T(), ref_id: 'e999999' }], ['read_page', { tabId: T(), ref_id: 'f99e1' }], ['read_page', { tabId: T(), ref_id: BIG }], ['read_page', { tabId: T(), filter: 'nope' }],
  ['find', { tabId: T(), query: BIG }], ['find', { tabId: T(), query: '(a+)+$[' }], ['find', { tabId: T(), query: '' }], ['find', { tabId: T(), query: { $ne: 1 } }],
  ['form_input', { tabId: T(), ref: 'e99999', value: 'x' }], ['form_input', { tabId: T(), ref: 'e5', value: { a: 1 } }], ['form_input', { tabId: T(), ref: 'e5', value: [1, 2] }], ['form_input', { tabId: T(), ref: 'e5', value: null }], ['form_input', { tabId: T(), ref: 'e5', value: BIG }], ['form_input', { tabId: T(), ref: '__proto__', value: 'x' }],
  ['get_page_text', { tabId: T(), offset: -5 }], ['get_page_text', { tabId: T(), offset: 1e12 }], ['get_page_text', { tabId: T(), max_chars: 'NaN' }], ['get_page_text', { tabId: T(), query: BIG }],
  ['computer', { tabId: T(), action: 'left_click', coordinate: [-50, -50] }], ['computer', { tabId: T(), action: 'left_click', coordinate: [1e9, 1e9] }], ['computer', { tabId: T(), action: 'left_click', coordinate: ['NaN', 1] }], ['computer', { tabId: T(), action: 'left_click', coordinate: [1] }], ['computer', { tabId: T(), action: 'left_click', coordinate: '[1,2]' }],
  ['computer', { tabId: T(), action: 'left_click' }], ['computer', { tabId: T(), action: 'left_click', ref: 'e99999' }], ['computer', { tabId: T(), action: 'left_click', ref: 'f77e1' }], ['computer', { tabId: T(), action: 'explode' }],
  ['computer', { tabId: T(), action: 'zoom', region: [0, 0, 0, 0] }], ['computer', { tabId: T(), action: 'zoom', region: [-100, -100, 1e6, 1e6] }], ['computer', { tabId: T(), action: 'zoom', region: [0, 0, 10, 10], scale: -1 }],
  ['computer', { tabId: T(), action: 'scroll', coordinate: [10, 10], scroll_amount: 1e9 }], ['computer', { tabId: T(), action: 'scroll', scroll_direction: 'diagonal' }], ['computer', { tabId: T(), action: 'wait', duration: 1e9 }], ['computer', { tabId: T(), action: 'wait', duration: -3 }],
  ['computer', { tabId: T(), action: 'type' }], ['computer', { tabId: T(), action: 'type', text: 5 }], ['computer', { tabId: T(), action: 'key', text: '' }], ['computer', { tabId: T(), action: 'key', text: 'ctrl+alt+shift+meta+F99' }], ['computer', { tabId: T(), action: 'key', text: 'Shift', repeat: 1e9 }],
  ['computer', { tabId: T(), action: 'left_click_drag', start_coordinate: [-1, -1], coordinate: [1e7, 1e7] }], ['computer', { tabId: T(), action: 'scroll_to' }],
  ['resize_window', { tabId: T(), width: 1e6, height: 1e6 }], ['resize_window', { tabId: T(), width: -1, height: 0 }], ['resize_window', { tabId: T(), width: 'wide', height: 5 }],
  ['read_console_messages', { tabId: T(), pattern: '[' }], ['read_console_messages', { tabId: T(), limit: -5 }], ['read_network_requests', { tabId: T(), limit: 0 }], ['read_network_requests', { tabId: T(), urlPattern: BIG }],
  ['handle_dialog', { tabId: T(), accept: 'yes' }], ['handle_dialog', { tabId: T(), accept: true, prompt_text: BIG }],
  ['file_upload', { tabId: T(), paths: [] }], ['file_upload', { tabId: T(), paths: '/dev/zero' }], ['file_upload', { tabId: T(), paths: ['/nonexistent/file'] }], ['file_upload', { tabId: T(), paths: ['/tmp'] }], ['file_upload', { tabId: T(), paths: ['\0/etc/hosts'] }], ['file_upload', { tabId: T(), paths: [BIG] }],
  ['upload_image', { tabId: T(), imageId: '__proto__', ref: 'e1' }], ['upload_image', { tabId: T(), imageId: 'constructor', ref: 'e1' }], ['upload_image', { tabId: T(), imageId: 'shot-1' }],
  ['gif_creator', { tabId: T(), action: 'export' }], ['gif_creator', { tabId: T(), action: 'export', filename: '../../../../etc/passwd' }], ['gif_creator', { tabId: T(), action: 'boom' }], ['gif_creator', { tabId: T(), action: 'start_recording', options: '{bad json' }],
  ['browser_batch', { actions: [] }], ['browser_batch', { actions: 'not json' }], ['browser_batch', { actions: [{ tool: 'browser_batch', args: { actions: [{ tool: 'read_page' }] } }] }], ['browser_batch', { actions: Array.from({ length: 31 }, () => ({ tool: 'find', args: { query: 'x' } })) }],
  ['browser_batch', { tabId: T(), actions: Array.from({ length: 30 }, () => ({ tool: 'find', args: { query: 'Full name' } })) }], ['browser_batch', { actions: [{ tool: 'read_page', args: nested(1500) }] }], ['browser_batch', { actions: [{ tool: 'read_page', args: '{"tabId": "x"' }] }], ['browser_batch', { actions: [{ tool: 'tabs_close_mcp', args: {} }] }],
];

await test('every malformed call returns a clean result in time, and the helper stays up', async () => {
  const bad = [];
  for (const [name, args] of cases) {
    const g = await guarded(name, args, name === 'javascript_tool' ? 40000 : 30000);
    let label;
    try {
      label = `${name} ${JSON.stringify(args).slice(0, 90)}`;
    } catch {
      label = `${name} (deeply nested args)`;
    }
    if (g.hung || g.threw)
      bad.push(`${label}: ${g.hung ? `no answer within ${g.ms} ms` : 'client threw ' + g.threw}`);
    else if (!(await healthy()))
      bad.push(`${label}: helper unhealthy afterwards`);
    if (name === 'navigate')
      await h.call('navigate', { tabId, url: `${O}/basic.html` }); // keep later cases on a real page
    if (g.r && !g.r.isError && /^(navigate|read_page|form_input|computer|file_upload|upload_image|resize_window)$/.test(name) && /(-1|1e9|1e6|NaN|e99999|f77e1|abc|BIG|zero|nonexistent|__proto__)/.test(label))
      console.log(`      note: accepted ${label} -> ${g.r.text.replace(/\n/g, ' ').slice(0, 120)}`);
  }
  expect(!bad.length, bad.join('\n'));
}, { area: '7' });

await test('huge key repeat (2000 combos x 100) cannot block the tab for the next caller', async () => {
  await h.call('navigate', { tabId, url: `${O}/basic.html?keys` });
  const t0 = Date.now();
  const big = guarded('computer', { tabId, action: 'key', text: Array(2000).fill('Shift').join(' '), repeat: 100 }, 200000);
  await sleep(1000);
  const next = await guarded('read_page', { tabId }, 30000);
  const g = await big;
  console.log(`      (the 200,000-key call: ${g.hung ? 'no answer' : g.r?.isError ? 'error ' + g.r.text.slice(0, 80) : 'ok'} after ${g.ms} ms)`);
  expect(next.r && !next.r.isError, `read_page on the same tab waited ${next.ms} ms behind it: ${next.hung ? 'no answer in 30 s' : next.r?.text.slice(0, 100)}`);
  void t0;
}, { area: '7' });

await test('concurrent conflicting calls on one tab (navigate x5, type, close) end cleanly', async () => {
  const t2 = tabIdOf((await h.call('tabs_create_mcp', {})).text);
  await h.call('navigate', { tabId: t2, url: `${O}/basic.html?conc` });
  const calls = [
    ...[1, 2, 3, 4, 5].map(i => guarded('navigate', { tabId: t2, url: `${O}/page2.html?n=${i}` }, 60000)),
    guarded('computer', { tabId: t2, action: 'type', text: 'z'.repeat(200) }, 60000),
    guarded('read_page', { tabId: t2 }, 60000),
    guarded('tabs_close_mcp', { tabId: t2 }, 60000),
    guarded('find', { tabId: t2, query: 'x' }, 60000),
    ...Array.from({ length: 10 }, () => guarded('tabs_create_mcp', {}, 60000)),
  ];
  const res = await Promise.all(calls);
  const hung = res.filter(g => g.hung || g.threw);
  expect(!hung.length && await healthy(), `${hung.length} call(s) hung/threw: ${hung.map(g => g.threw).join(', ')}`);
  // Clean up the extra tabs.
  const ids = [...(await h.call('tabs_context_mcp', {})).text.matchAll(/tabId (\d+)/g)].map(m => Number(m[1])).filter(id => id !== tabId);
  for (const id of ids)
    await h.call('tabs_close_mcp', { tabId: id });
}, { area: '7' });

/** Ask the helper itself (not the extension) for its status over the socket. */
function helperStatus() {
  return new Promise((resolve) => {
    const s = net.connect(h.sock);
    let got = '';
    const t = setTimeout(() => { s.destroy(); resolve(false); }, 5000);
    s.on('data', d => { got += d; if (got.includes('"status"')) { clearTimeout(t); s.destroy(); resolve(true); } });
    s.on('error', () => { clearTimeout(t); resolve(false); });
    s.on('connect', () => s.write(JSON.stringify({ type: 'status', id: 1 }) + '\n'));
  });
}

function rawSocket(chunks) {
  return new Promise((resolve) => {
    const s = net.connect(h.sock);
    let got = '';
    s.on('data', d => { got += d; });
    s.on('error', () => resolve(got));
    s.on('connect', async () => {
      for (const c of chunks) {
        s.write(c);
        await sleep(5);
      }
      await sleep(1500);
      s.destroy();
      resolve(got);
    });
  });
}

await test('garbage on the helper socket (bad JSON, odd tool names, 32 MB line) leaves the helper answering', async () => {
  await rawSocket(['not json\n', '{"type":"request","id":1}\n', '{"type":"request","id":2,"tool":"__proto__","args":{}}\n', '{"type":"request","id":3,"tool":"constructor"}\n', '{"type":"request","id":4,"tool":"_annotate_frame","args":{"jpeg":"!!!"}}\n', '{"type":"request","id":5,"tool":"read_page","args":{"tabId":{"$gt":1}}}\n', '\n\n\n', '{"type":"bidi","available":"yes"}\n', '{"type":"status"}\n']);
  const t0 = Date.now();
  const chunk = 'y'.repeat(1 << 20);
  await rawSocket(Array(32).fill(chunk));
  const ms = Date.now() - t0;
  const ok = await helperStatus();
  const ext = await healthy();
  expect(ok && ext, `after a 32 MB line without newline (${ms} ms): helper status ${ok}, tool calls ${ext}`);
  console.log(`      (32 MB without a newline took the helper ${ms} ms to swallow)`);
}, { area: '7' });

await test('an endless javascript_tool loop in one tab does not take other tabs (or Foxwright) down', async () => {
  const t2 = tabIdOf((await h.call('tabs_create_mcp', {})).text);
  await h.call('navigate', { tabId: t2, url: `${O}/basic.html?loop` });
  const g = await guarded('javascript_tool', { tabId: t2, text: 'while(true){}' }, 40000);
  const other = await guarded('read_page', { tabId }, 20000);
  const same = await guarded('read_page', { tabId: t2 }, 20000);
  const close = await guarded('tabs_close_mcp', { tabId: t2 }, 20000);
  console.log(`      (loop call: ${g.hung ? 'no answer in 40 s' : g.r.text.slice(0, 80)}; same tab afterwards: ${same.hung ? 'no answer' : same.r.text.slice(0, 60)}; closing it: ${close.hung ? 'no answer' : close.r.text.slice(0, 60)})`);
  expect(other.r && !other.r.isError, `another tab stopped working: ${other.hung ? 'no answer' : other.r.text.slice(0, 100)}`);
  expect(!g.hung, 'javascript_tool never returns for an endless loop (no timeout of its own); the tab stays frozen for later calls');
}, { area: '7' });

await test('read_console_messages with a catastrophic regex does not freeze Foxwright', async () => {
  await h.call('navigate', { tabId, url: `${O}/basic.html?redos` });
  await h.call('computer', { tabId, action: 'wait', duration: 0 });
  // Fill the console with strings that make /^(a+)+$/ backtrack exponentially.
  await h.call('javascript_tool', { tabId, text: `for (let i = 0; i < 5; i++) console.log('a'.repeat(32) + '!'); 1` });
  const g = await guarded('read_console_messages', { tabId, pattern: '^(a+)+$' }, 30000);
  const other = await guarded('tabs_context_mcp', {}, 10000);
  let recovered = null;
  if (g.hung) {
    for (let i = 0; i < 12 && !recovered; i++) {
      const x = await guarded('tabs_context_mcp', {}, 10000);
      if (x.r)
        recovered = (i + 1) * 10;
    }
  }
  const helperOk = await helperStatus();
  console.log(`      (helper socket still answering status: ${helperOk}; extension answered again after ~${recovered ?? 'never (2 min)'} s)`);
  expect(!g.hung && other.r, `pattern call: ${g.hung ? `no answer in ${g.ms} ms` : g.r.text.slice(0, 80)}; another call meanwhile: ${other.hung ? 'no answer (background frozen)' : 'ok'}`);
}, { area: '7' });

await h.stop();
process.exit(finish());
