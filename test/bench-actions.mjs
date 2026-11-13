// Latency of common tool calls against the local fixtures (median of N runs).
//   node test/bench-actions.mjs            synthetic input
//   FOXWRIGHT_E2E_TRUSTED=1 node test/bench-actions.mjs
import { start } from './harness.mjs';

const N = Number(process.env.BENCH_N || 15);
const BASE = `http://127.0.0.1:${process.env.FOXWRIGHT_P1}`;
const h = await start({ trusted: !!process.env.FOXWRIGHT_E2E_TRUSTED });
const r0 = await h.call('tabs_context_mcp', { createIfEmpty: true });
const tabId = Number(/tabId (\d+)/.exec(r0.text)[1]);
const call = async (name, args = {}) => {
  const r = await h.call(name, { tabId, ...args });
  if (r.isError)
    throw new Error(`${name}: ${r.text}`);
  return r;
};
const refOf = async (query) => /\[ref=([^\]]+)\]/.exec((await call('find', { query })).text)[1];

async function time(label, fn, setup) {
  const ms = [];
  for (let i = 0; i < N; i++) {
    if (setup)
      await setup();
    const t = performance.now();
    await fn();
    ms.push(performance.now() - t);
  }
  ms.sort((a, b) => a - b);
  const med = ms[Math.floor(ms.length / 2)];
  console.log(`${label.padEnd(36)} median ${med.toFixed(0).padStart(5)} ms   p90 ${ms[Math.floor(ms.length * 0.9)].toFixed(0).padStart(5)} ms`);
  return med;
}

await call('navigate', { url: BASE + '/basic.html' });
await time('navigate (local page)', () => call('navigate', { url: BASE + '/basic.html' }));
await time('read_page', () => call('read_page', {}));
await time('find', () => call('find', { query: 'Full name' }));
const btn = await refOf('Clicked 0 times');
await time('click button (no navigation)', () => call('computer', { action: 'left_click', ref: btn }));
const name = await refOf('Full name');
await call('computer', { action: 'left_click', ref: name });
await time('type 10 characters', () => call('computer', { action: 'type', text: 'abcdefghij' }));
await time('key Tab', () => call('computer', { action: 'key', text: 'Tab' }));
let link;
await time('click link (navigates)', () => call('computer', { action: 'left_click', ref: link }), async () => {
  await call('navigate', { url: BASE + '/basic.html' });
  link = await refOf('Go to page two');
});
await time('screenshot', () => call('computer', { action: 'screenshot' }));
await h.stop?.();
process.exit(0);
