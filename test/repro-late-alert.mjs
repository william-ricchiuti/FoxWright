// Minimal repro: a real alert() that opens while the agent is idle blocks the next tool call.
//   FIREFOX=... FOXWRIGHT_E2E_HEADFUL=1 xvfb-run -a node test/repro-late-alert.mjs
import { start } from './harness.mjs';
import { connectPerson, sleep, refOf, tabIdOf } from './gap-lib.mjs';
const O = `http://127.0.0.1:${process.env.FOXWRIGHT_P1}`;
const h = await start({ testDriver: true, policy: { mode: 'all' } });
const d = await connectPerson(h.bidiUrl);
const tabId = tabIdOf((await h.call('tabs_context_mcp', { createIfEmpty: true })).text);
await h.call('navigate', { tabId, url: `${O}/hostile-dialogs.html?late` });
const ctx = (await d.contexts()).find(x => x.url.includes('late')).context;
await d.evalIn(ctx, `document.getElementById('later').dataset.ms = '9000'`);
const T0 = Date.now();
const ref = refOf((await h.call('find', { tabId, query: 'Schedule late alerts' })).text);
await h.call('computer', { tabId, action: 'left_click', ref });
await sleep(11000);
const ev = () => d.events.map(e => `${e.method.split('.').pop()}@${e.at - T0}ms ${e.params?.message || ''}`).join(', ');
console.log('events before read_page:', ev());
for (const tool of ['read_page', 'computer']) {
  const t0 = Date.now();
  const r = await h.call(tool, { tabId, action: 'screenshot' });
  console.log(`${tool}: ${Date.now() - t0} ms, isError=${r.isError}, ${r.text.replace(/\n/g, ' ').slice(0, 140)}`);
}
console.log('events after:', ev());
for (let i = 0; i < 10; i++)
  await d.bidi('browsingContext.handleUserPrompt', { context: ctx, accept: true }).catch(() => {});
d.close();
await h.stop();
process.exit(0);
