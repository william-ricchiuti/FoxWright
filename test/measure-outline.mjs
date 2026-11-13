// Measures how big read_page output is on real sites vs. a screenshot (needs internet), and how
// much read_page {diff: true} saves on a second read.
//   node test/measure-outline.mjs [site-regex]
import { start } from './harness.mjs';
const all = ['https://en.wikipedia.org/wiki/Red_fox', 'https://news.ycombinator.com/', 'https://www.amazon.com/', 'https://www.reddit.com/r/firefox/', 'https://www.bbc.com/news', 'https://www.youtube.com/', 'https://demoqa.com/automation-practice-form', 'https://react.dev/learn'];
const sites = process.argv[2] ? all.filter(u => new RegExp(process.argv[2], 'i').test(u)) : all;
const h = await start({});
const tabId = parseInt(/tabId (\d+)/.exec((await h.call('tabs_context_mcp', { createIfEmpty: true })).text)[1], 10);
console.log('site | interactive (chars / ~tokens / ms) | full outline default 50k cap (chars) | full uncapped (chars) | refs');
const diffs = [];
for (const url of sites) {
  await h.call('navigate', { tabId, url });
  await new Promise(r => setTimeout(r, 2500));
  let t0 = Date.now();
  const i = await h.call('read_page', { tabId, filter: 'interactive', max_chars: 1e7 });
  const ims = Date.now() - t0;
  const v = await h.call('read_page', { tabId, visible_only: true, max_chars: 1e7 });
  const f = await h.call('read_page', { tabId });
  const u = await h.call('read_page', { tabId, max_chars: 1e7 });
  const refs = (u.text.match(/\[ref=/g) || []).length;
  console.log(`visible_only ${v.text.length} chars | ${new URL(url).host}${new URL(url).pathname.slice(0, 20)} | ${i.text.length} / ${Math.round(i.text.length / 4)} / ${ims} | ${f.text.length} | ${u.text.length} | ${refs}`);
  // Second read after the page had a few seconds to change (carousels, lazy content), then after a scroll.
  await new Promise(r => setTimeout(r, 3000));
  t0 = Date.now();
  const d1 = await h.call('read_page', { tabId, max_chars: 1e7, diff: true });
  const d1ms = Date.now() - t0;
  await h.call('computer', { tabId, action: 'scroll', scroll_direction: 'down', scroll_amount: 10 });
  await new Promise(r => setTimeout(r, 1500));
  const d2 = await h.call('read_page', { tabId, max_chars: 1e7, diff: true });
  const kind = (t) => (/No changes since/.test(t) ? 'no changes' : /Full outline: ([^)]*)/.exec(t)?.[1] || 'diff');
  diffs.push(`${new URL(url).host} | full ${u.text.length} | after 3 s: ${d1.text.length} (${kind(d1.text)}, ${d1ms} ms) | after scrolling: ${d2.text.length} (${kind(d2.text)})`);
}
console.log('\nread_page {diff: true} vs the full outline (chars):');
for (const d of diffs)
  console.log(d);
await h.stop();
process.exit(0);
