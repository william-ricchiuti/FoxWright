// Smoke test of the addons.mozilla.org build (no javascript_tool).
import { start } from './harness.mjs';
const h = await start({ build: 'store' });
let ok = true;
const check = (name, cond, detail) => { console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : '\n      ' + detail}`); ok &&= cond; };
const ctx = await h.call('tabs_context_mcp', { createIfEmpty: true });
const tabId = parseInt(/tabId (\d+)/.exec(ctx.text)[1], 10);
await h.call('navigate', { tabId, url: `http://127.0.0.1:${process.env.ZENKO_P1}/react.html` });
const f = await h.call('find', { tabId, query: 'Your name' });
const ref = /\[ref=(e\d+)\]/.exec(f.text)[1];
await h.call('computer', { tabId, action: 'left_click', ref });
await h.call('computer', { tabId, action: 'type', text: 'store build' });
const p = await h.call('read_page', { tabId });
check('store build types into React', p.text.includes('Hello, store build'), p.text);
const j = await h.call('javascript_tool', { tabId, action: 'javascript_exec', text: '1+1' });
check('javascript_tool is disabled with a clear message', j.isError && /not available in the Firefox Add-ons store edition/.test(j.text), j.text);
await h.stop();
process.exit(ok ? 0 : 1);
