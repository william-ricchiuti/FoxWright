// Drives a few real websites (needs internet). Not part of the default test run.
import { start } from './harness.mjs';
const h = await start({ trusted: !!process.env.KITSUNE_E2E_TRUSTED });
const out = (label, r) => console.log(`\n### ${label}\n${r.isError ? 'ERROR: ' : ''}${r.text.slice(0, 900)}`);
const ctx = await h.call('tabs_context_mcp', { createIfEmpty: true });
const tabId = parseInt(/tabId (\d+)/.exec(ctx.text)[1], 10);
const refOf = (t, re) => (re.exec(t) || [])[1];
try {
  out('wikipedia: navigate', await h.call('navigate', { tabId, url: 'en.wikipedia.org/wiki/Main_Page' }));
  let f = await h.call('find', { tabId, query: 'search wikipedia' });
  out('wikipedia: find search', f);
  const sref = refOf(f.text, /(?:searchbox|combobox|textbox)[^\n]*\[ref=(e\d+)\]/);
  await h.call('computer', { tabId, action: 'left_click', ref: sref });
  await h.call('computer', { tabId, action: 'type', text: 'Red fox' });
  out('wikipedia: Enter', await h.call('computer', { tabId, action: 'key', text: 'Enter' }));
  const t = await h.call('get_page_text', { tabId });
  out('wikipedia: article text', { ...t, text: t.text.slice(0, 600) });

  out('github: navigate', await h.call('navigate', { tabId, url: 'https://github.com/microsoft/playwright' }));
  f = await h.call('find', { tabId, query: 'Issues tab link' });
  out('github: find issues', f);
  const iref = refOf(f.text, /link[^\n]*Issues[^\n]*\[ref=(e\d+)\]/);
  out('github: click issues', await h.call('computer', { tabId, action: 'left_click', ref: iref }));
  const rp = await h.call('read_page', { tabId, filter: 'interactive', max_chars: 3000 });
  out('github: issues outline (first 3000 chars)', rp);
  const shot = await h.call('computer', { tabId, action: 'screenshot' });
  console.log(`\nscreenshot: ${shot.images.length} image, ${shot.text}`);
  if (shot.images[0])
    (await import('node:fs')).writeFileSync('test/results/github-issues.jpg', Buffer.from(shot.images[0].data, 'base64'));
} catch (e) {
  console.error('FAILED', e);
}
await h.stop();
process.exit(0);
