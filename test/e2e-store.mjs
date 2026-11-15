// Smoke test of the addons.mozilla.org build (no javascript_tool). test/e2e-storebuild.mjs covers
// the store build in depth.
import fs from 'node:fs';
import { start } from './harness.mjs';
const h = await start({ build: 'store' });
const results = [];
const check = (name, cond, detail) => {
  console.log(`  ${cond ? '✓' : '✗'} ${name}${cond ? '' : '\n      ' + detail}`);
  results.push({ name, ok: !!cond, ...(cond ? {} : { err: String(detail).slice(0, 2000) }) });
};
const ctx = await h.call('tabs_context_mcp', { createIfEmpty: true });
const tabId = parseInt(/tabId (\d+)/.exec(ctx.text)[1], 10);
await h.call('navigate', { tabId, url: `http://127.0.0.1:${process.env.FOXWRIGHT_P1}/react.html` });
const f = await h.call('find', { tabId, query: 'Your name' });
const ref = /\[ref=(e\d+)\]/.exec(f.text)[1];
await h.call('computer', { tabId, action: 'left_click', ref });
await h.call('computer', { tabId, action: 'type', text: 'store build' });
const p = await h.call('read_page', { tabId });
check('store build types into React', p.text.includes('Hello, store build'), p.text);
const j = await h.call('javascript_tool', { tabId, action: 'javascript_exec', text: '1+1' });
check('javascript_tool is disabled with a clear message', j.isError && /not available in the Firefox Add-ons store edition/.test(j.text), j.text);
await h.stop();
const passed = results.filter(r => r.ok).length;
console.log(`\n${passed}/${results.length} store-build smoke checks passed`);
fs.mkdirSync('test/results', { recursive: true });
fs.writeFileSync('test/results/e2e-store.json', JSON.stringify(results, null, 2));
process.exit(passed === results.length ? 0 : 1);
