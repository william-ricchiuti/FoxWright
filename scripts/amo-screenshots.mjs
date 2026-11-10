// Makes the addons.mozilla.org listing screenshots (1280x800 PNGs in docs/amo/) from the real UI:
// the agent working in a tab, Zenko's permission window, and the toolbar popup.
//
//   FIREFOX=/path/to/firefox node scripts/amo-screenshots.mjs
//
// Needs ImageMagick (`convert`) to compose the windows onto a page background.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import http from 'node:http';
import { fileURLToPath } from 'node:url';
import { start } from '../test/harness.mjs';
import { connectDriver } from '../test/bidi-driver.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.join(root, 'docs', 'amo');
const tmp = fs.mkdtempSync(path.join(os.tmpdir(), 'zenko-shots-'));
fs.mkdirSync(out, { recursive: true });
const sleep = ms => new Promise(r => setTimeout(r, ms));
const W = 1280, H = 800;

const h = await start({ build: 'store', testDriver: true, policy: { mode: 'ask', promptTimeoutSec: 120 } });
const d = await connectDriver(h.bidiUrl);
const shot = async (context, file) => {
  const r = await d.bidi('browsingContext.captureScreenshot', { context });
  fs.writeFileSync(file, Buffer.from(r.data, 'base64'));
  return file;
};

const ctx = await h.call('tabs_context_mcp', { createIfEmpty: true });
const tabId = parseInt(/tabId (\d+)/.exec(ctx.text)[1], 10);
const url = `http://127.0.0.1:${process.env.ZENKO_P1}/wizard.html`;

// Extension pages can't be screenshotted over WebDriver BiDi, so the permission window and the
// popup are rendered from their real HTML/CSS/JS with a stubbed `browser` API and sample data.
const stubDir = path.join(tmp, 'ui');
for (const dir of ['popup', 'prompt', 'icons'])
  fs.cpSync(path.join(root, 'extension', dir), path.join(stubDir, dir), { recursive: true });
const STUB = {
  prompt: { type: 'site', origin: 'https://github.com', tabTitle: 'Notifications · GitHub' },
  status: {
    version: JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version, full: false, connected: true, lastError: null,
    clients: 1, bidi: false, paused: false, mode: 'ask', managedMode: false, managedAllowed: [],
    allowed: ['https://github.com', 'https://en.wikipedia.org'], sessionAllowed: ['https://www.saucedemo.com'], groupTabs: 2,
  },
};
const stub = (page) => `window.close = () => {};
window.browser = { runtime: { sendMessage: async (m) => ${page === 'prompt'
  ? `(m.kind === 'prompt-details' ? ${JSON.stringify(STUB.prompt)} : new Promise(() => {}))`
  : `(${JSON.stringify(STUB.status)})`} } };`;
for (const page of ['prompt', 'popup']) {
  fs.writeFileSync(path.join(stubDir, page, 'stub.js'), stub(page));
  const html = path.join(stubDir, page, `${page}.html`);
  fs.writeFileSync(html, fs.readFileSync(html, 'utf8').replace(`<script src="${page}.js">`, `<script src="stub.js"></script><script src="${page}.js">`));
}
const types = { html: 'text/html', css: 'text/css', js: 'text/javascript', svg: 'image/svg+xml', png: 'image/png' };
const server = http.createServer((req, res) => {
  const p = path.join(stubDir, decodeURIComponent(new URL(req.url, 'http://x').pathname));
  if (!p.startsWith(stubDir) || !fs.existsSync(p))
    return res.writeHead(404).end();
  res.writeHead(200, { 'content-type': types[path.extname(p).slice(1)] || 'application/octet-stream' });
  fs.createReadStream(p).pipe(res);
});
await new Promise(r => server.listen(0, '127.0.0.1', r));
const uiBase = `http://127.0.0.1:${server.address().port}`;
async function renderUi(page, width, height) {
  const { context } = await d.bidi('browsingContext.create', { type: 'window' });
  await d.bidi('browsingContext.setViewport', { context, viewport: { width, height } });
  await d.bidi('browsingContext.navigate', { context, url: `${uiBase}/${page}/${page}.html`, wait: 'complete' });
  await sleep(1300); // prompt buttons arm after a moment
  const file = await shot(context, path.join(tmp, `${page}.png`));
  await d.bidi('browsingContext.close', { context });
  return file;
}
const promptPng = await renderUi('prompt', 500, 360);
const popupPng = await renderUi('popup', 360, 540);

// The real agent tab: open the fixture page, approving it in the real permission window.
const nav = h.call('navigate', { tabId, url });
await d.answer('once');
await nav;
const agentCtx = (await d.contexts()).find(c => c.url.startsWith(url)).context;
await d.bidi('browsingContext.setViewport', { context: agentCtx, viewport: { width: W, height: H } });
await sleep(9000); // let the "working" glow fade for the background shot
const plainPage = await shot(agentCtx, path.join(tmp, 'page.png'));

// The agent at work: fill the first step (the tab glows and shows the Stop pill while it works).
const find = async (q) => /\[ref=([^\]]+)\]/.exec((await h.call('find', { tabId, query: q })).text)[1];
await h.call('form_input', { tabId, ref: await find('Username'), value: 'ada_l' });
await h.call('form_input', { tabId, ref: await find('Email'), value: 'ada@example.com' });
await h.call('computer', { tabId, action: 'left_click', ref: await find('Password') });
await h.call('computer', { tabId, action: 'type', text: 'zenko2026!' });
await sleep(300);
await shot(agentCtx, path.join(out, 'screenshot-1-agent-working.png'));

// Compose a window image onto the dimmed page, with a caption.
function compose(windowPng, file, caption, gravity = 'center', offset = '+0+0') {
  execFileSync('convert', [
    plainPage, '-resize', `${W}x${H}!`, '-fill', 'rgba(20,12,8,0.45)', '-draw', `rectangle 0,0 ${W},${H}`,
    '(', windowPng, '(', '+clone', '-background', 'black', '-shadow', '60x12+0+8', ')', '+swap', '-background', 'none', '-layers', 'merge', '+repage', ')',
    '-gravity', gravity, '-geometry', offset, '-composite',
    '-gravity', 'northwest', '-fill', 'rgba(20,12,8,0.82)', '-draw', `rectangle 0,${H - 84} ${W},${H}`,
    '-gravity', 'south', '-fill', 'white', '-pointsize', '26', '-annotate', '+0+28', caption,
    file,
  ]);
}
compose(promptPng, path.join(out, 'screenshot-2-permission-window.png'), 'You approve every site in a window the page and the agent can\'t touch.');
compose(popupPng, path.join(out, 'screenshot-3-popup.png'), 'Pause the agent, review and revoke sites, see the input mode.', 'northeast', '+40+40');

server.close();
d.close();
await h.stop();
fs.rmSync(tmp, { recursive: true, force: true });
console.log(`wrote ${fs.readdirSync(out).filter(f => f.endsWith('.png')).map(f => path.join('docs/amo', f)).join(', ')}`);
process.exit(0);
