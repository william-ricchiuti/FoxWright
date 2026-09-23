// Measures how big read_page output is on real sites vs. a screenshot (needs internet).
import { start } from './harness.mjs';
const sites = ['https://en.wikipedia.org/wiki/Red_fox', 'https://news.ycombinator.com/', 'https://www.amazon.com/', 'https://www.reddit.com/r/firefox/', 'https://www.bbc.com/news', 'https://www.youtube.com/', 'https://demoqa.com/automation-practice-form', 'https://react.dev/learn'];
const h = await start({});
const tabId = parseInt(/tabId (\d+)/.exec((await h.call('tabs_context_mcp', { createIfEmpty: true })).text)[1], 10);
console.log('site | interactive (chars / ~tokens / ms) | full outline default 50k cap (chars) | full uncapped (chars) | refs');
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
}
await h.stop();
process.exit(0);
