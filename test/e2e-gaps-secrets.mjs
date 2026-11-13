// Uploads (gap area 5) and secrets in tool output (gap area 6).
//
//   FIREFOX=... FOXWRIGHT_E2E_HEADFUL=1 xvfb-run -a -s "-screen 0 1400x900x24" node test/e2e-gaps-secrets.mjs
// Linux only for the upload part (it plants fake credential files in the harness's temporary HOME).
import fs from 'node:fs';
import path from 'node:path';
import { start } from './harness.mjs';
import { runner, extraServer, connectPerson, chromeEval, sleep, expect, refOf, tabIdOf } from './gap-lib.mjs';

const { test, skip, finish } = runner('e2e-gaps-secrets');
const P1 = process.env.FOXWRIGHT_P1, P2 = process.env.FOXWRIGHT_P2;
const xs = await extraServer(P1, P2);
const { P3 } = xs;
const A = `http://a.test:${P3}`;
const C = `http://c.test:${P3}`;

console.log('Foxwright gap tests: uploads and secrets');
const h = await start({ testDriver: true, policy: { mode: 'all', confirmUploads: true, promptTimeoutSec: 15 } });
const d = await connectPerson(h.bidiUrl);
const tabId = tabIdOf((await h.call('tabs_context_mcp', { createIfEmpty: true })).text);
const promptW = async (ms) => { try { return await d.promptWindow(ms); } catch { return null; } };

/** file_upload while watching for the Foxwright window (denied if it shows). */
async function upload(paths, ref) {
  let asked = null, done = false;
  const call = h.call('file_upload', { tabId, ref, paths }).finally(() => { done = true; });
  while (!done) {
    const w = (await d.contexts()).find(x => x.url.includes('/prompt/prompt.html'));
    if (w) {
      for (let i = 0; i < 40 && !asked; i++) {
        asked = await d.evalIn(w.context, `document.getElementById('files').textContent`).catch(() => '');
        if (!asked)
          await sleep(50);
      }
      await d.answer('deny', w).catch(() => {});
    }
    await sleep(60);
  }
  return { r: await call, asked };
}

if (process.platform !== 'linux' || h.home === (await import('node:os')).homedir()) {
  skip('upload refusal list', 'needs the harness\'s isolated HOME (Linux)', { area: '5' });
} else {
  const H = h.home;
  const put = (rel, body = 'SECRET-CONTENT\n') => {
    const p = path.join(H, rel);
    fs.mkdirSync(path.dirname(p), { recursive: true });
    fs.writeFileSync(p, body);
    return p;
  };
  const key = put('.ssh/id_ed25519', '-----BEGIN OPENSSH PRIVATE KEY-----\nfake\n');
  put('proj/.env'); put('proj/.env.production'); put('.aws/credentials'); put('.git-credentials'); put('.bash_history');
  put('.mozilla/firefox/abc.default/logins.json'); put('.mozilla/firefox/abc.default/cookies.sqlite');
  put('.mozilla/firefox/abc.default/places.sqlite'); put('.mozilla/firefox/abc.default/formhistory.sqlite');
  put('.config/gcloud/application_default_credentials.json'); put('.kube/config');
  try { fs.symlinkSync(key, path.join(H, 'innocent-link.txt')); } catch { /* exists */ }
  try { fs.symlinkSync(path.join(H, '.ssh'), path.join(H, 'notes')); } catch { /* exists */ }
  try { fs.linkSync(key, path.join(H, 'innocent-hard.txt')); } catch { /* exists */ }
  const gaps = ['.pgpass', '.vault-token', '.local/share/keyrings/login.keyring', '.cargo/credentials.toml', '.terraform.d/credentials.tfrc.json', '.config/op/config', '.docker/config.json', '.my.cnf', '.s3cfg', '.config/rclone/rclone.conf', '.gnupg/private-keys-v1.d/x.key', '.password-store/x.gpg', 'id_rsa_old', '.ssh2/id_ed25519'];
  for (const g of gaps)
    put(g);
  const normal = put('Documents/report.txt', 'quarterly numbers\n');

  await h.call('navigate', { tabId, url: `${A}/user-tab.html?up` });
  const ref = refOf((await h.call('find', { tabId, query: 'Avatar' })).text);

  await test('a normal file asks first, naming the absolute path and size', async () => {
    const { r, asked } = await upload([normal], ref);
    expect(asked && asked.includes(normal) && /bytes|KB/.test(asked), 'window showed: ' + asked);
    expect(r.isError && /did not approve/.test(r.text), r.text);
  }, { area: '5' });

  await test('credential paths are refused without asking (symlinks, .., relative paths included)', async () => {
    const rel = path.relative(process.cwd(), key);
    const cases = [key, path.join(H, 'proj/.env'), path.join(H, 'proj/.env.production'), path.join(H, '.aws/credentials'), path.join(H, '.git-credentials'), path.join(H, '.bash_history'),
      path.join(H, '.mozilla/firefox/abc.default/logins.json'), path.join(H, '.mozilla/firefox/abc.default/cookies.sqlite'), path.join(H, '.config/gcloud/application_default_credentials.json'), path.join(H, '.kube/config'),
      path.join(H, '.foxwright/helper.log'), path.join(H, '.foxwright/foxwright.sock'), path.join(H, 'innocent-link.txt'), path.join(H, 'notes/id_ed25519'), `${H}/Documents/../.ssh/id_ed25519`, rel, `./${rel}`];
    const bad = [];
    for (const p of cases) {
      const { r, asked } = await upload([p], ref);
      if (asked || !(r.isError && /credential or key/.test(r.text)))
        bad.push(`${p}: ${asked ? `ASKED (window listed ${asked})` : r.text.slice(0, 120)}`);
    }
    // A normal file plus a key in one call: nothing is uploaded and nothing is asked.
    const mixed = await upload([normal, key], ref);
    if (mixed.asked || !mixed.r.isError)
      bad.push(`[normal, key]: ${mixed.asked ? 'ASKED ' + mixed.asked : mixed.r.text.slice(0, 100)}`);
    expect(!bad.length, bad.join('\n'));
  }, { area: '5' });

  await test('more secret stores are refused too (hard link to a key, browser history, keyrings, other CLIs\' tokens, /proc/self/environ)', async () => {
    const cases = [path.join(H, 'innocent-hard.txt'), path.join(H, '.mozilla/firefox/abc.default/places.sqlite'), path.join(H, '.mozilla/firefox/abc.default/formhistory.sqlite'), '/proc/self/environ', ...gaps.map(g => path.join(H, g))];
    const asked = [];
    for (const p of cases) {
      const { r, asked: a } = await upload([p], ref);
      if (a || !(r.isError && /credential or key/.test(r.text)))
        asked.push(`${p} -> ${a ? 'asks the person (not refused)' : r.text.slice(0, 100)}`);
    }
    expect(!asked.length, asked.join('\n'));
  }, { area: '5' });
}

await test('upload_image: the permission window says which site the screenshot was taken on', async () => {
  await h.call('navigate', { tabId, url: `${A}/secrets.html?shot` });
  const s = await h.call('computer', { tabId, action: 'screenshot' });
  const id = /Screenshot ID: (shot-\d+)/.exec(s.text)?.[1];
  await h.call('navigate', { tabId, url: `${C}/user-tab.html?dest` });
  const ref = refOf((await h.call('find', { tabId, query: 'Avatar' })).text);
  let shown = '', origin = '', done = false;
  const call = h.call('upload_image', { tabId, imageId: id, ref }).finally(() => { done = true; });
  const w = await promptW(8000);
  if (w) {
    for (let i = 0; i < 40 && !shown; i++) {
      shown = await d.evalIn(w.context, `document.getElementById('files').textContent`).catch(() => '');
      await sleep(50);
    }
    origin = await d.evalIn(w.context, `document.getElementById('origin').textContent`).catch(() => '');
    await d.answer('deny', w);
  }
  await call;
  expect(w, 'no permission window');
  expect(shown.includes('a.test'), `a screenshot of ${A} is about to be uploaded to ${origin}; the window lists only: ${JSON.stringify(shown)}`);
}, { area: '5' });

// ---------- secrets ----------
const SECRETS = ['hunter2-attr', 's3cret-script-PIN', 'NEWPIN-123', 'typed-secret-9'];
const leaks = (t) => SECRETS.filter(s => t.includes(s));

await test('password values never appear in read_page, find, get_page_text, form_input, type, key, console or network output', async () => {
  await h.call('navigate', { tabId, url: `${A}/secrets.html?s1` });
  const out = [];
  const add = async (label, p) => { const r = await p; out.push([label, r.text]); return r; };
  await add('read_page', h.call('read_page', { tabId }));
  await add('read_page interactive', h.call('read_page', { tabId, filter: 'interactive' }));
  await add('read_page visible_only', h.call('read_page', { tabId, visible_only: true }));
  await add('find Password', h.call('find', { tabId, query: 'Password' }));
  await add('find value', h.call('find', { tabId, query: 'hunter2-attr' }));
  await add('get_page_text', h.call('get_page_text', { tabId }));
  await add('get_page_text query', h.call('get_page_text', { tabId, query: 'hunter2 password' }));
  const pin = refOf((await h.call('find', { tabId, query: 'PIN' })).text);
  const pw2 = refOf((await h.call('find', { tabId, query: 'Second password' })).text);
  await add('form_input', h.call('form_input', { tabId, ref: pin, value: 'NEWPIN-123' }));
  await add('click pw2', h.call('computer', { tabId, action: 'left_click', ref: pw2 }));
  await add('type', h.call('computer', { tabId, action: 'type', text: 'typed-secret-9' }));
  await add('key', h.call('computer', { tabId, action: 'key', text: 'End' }));
  await add('read_page after', h.call('read_page', { tabId }));
  await add('console', h.call('read_console_messages', {}));
  await add('network', h.call('read_network_requests', { tabId }));
  await add('tabs', h.call('tabs_context_mcp', {}));
  // `find` echoes its query; what matters is whether the value matched an element.
  const bad = out.filter(([l, t]) => (l === 'find value' ? !/^No elements matched/.test(t) : leaks(t).length)).map(([l, t]) => `${l}: ${l === 'find value' ? t.slice(0, 200) : leaks(t)}`);
  expect(/password, \d+ characters|password/i.test(out[0][1]), 'masking marker missing: ' + out[0][1].slice(0, 400));
  expect(!bad.length, bad.join('\n'));
}, { area: '6' });

await test('a "Show password" toggle (type flipped to text) does not reveal the value to the agent', async () => {
  await h.call('navigate', { tabId, url: `${A}/secrets.html?s2` });
  const show = refOf((await h.call('find', { tabId, query: 'Show password' })).text);
  await h.call('computer', { tabId, action: 'left_click', ref: show });
  const outs = [await h.call('read_page', { tabId }), await h.call('find', { tabId, query: 'Password' }), await h.call('get_page_text', { tabId })];
  const found = outs.map((r, i) => [['read_page', 'find', 'get_page_text'][i], leaks(r.text)]).filter(([, l]) => l.length);
  expect(!found.length, `after the page shows the password as text, the agent sees it: ${JSON.stringify(found)}\n${outs[0].text.split('\n').find(l => /Password/.test(l))}`);
}, { area: '6' });

await test('submitting a login form that uses GET: the password does not show up in network/tab output', async () => {
  await h.call('navigate', { tabId, url: `${A}/secrets.html?s3` });
  const go = refOf((await h.call('find', { tabId, query: 'Sign in' })).text.split('\n').find(l => /button "Sign in"/.test(l)));
  const click = await h.call('computer', { tabId, action: 'left_click', ref: go });
  const net = await h.call('read_network_requests', { tabId });
  const tabs = await h.call('tabs_context_mcp', {});
  const where = [['click result', click.text], ['read_network_requests', net.text], ['tabs_context_mcp', tabs.text]].filter(([, t]) => leaks(t).length).map(([l]) => l);
  expect(!where.length, `the password (sent in the URL by the page's own GET form) appears in: ${where.join(', ')}`);
}, { area: '6' });

await test('a saved login filled in by Firefox stays hidden (read_page, find, get_page_text, form_input result)', async () => {
  await chromeEval(d, `(async () => { Services.prefs.setBoolPref('signon.rememberSignons', true); Services.prefs.setBoolPref('signon.autofillForms', true); Services.prefs.setBoolPref('signon.autofillForms.http', true); const LI = Components.Constructor('@mozilla.org/login-manager/loginInfo;1', Ci.nsILoginInfo, 'init'); await Services.logins.addLoginAsync(new LI('${A}', '${A}', null, 'ada', 'saved-PASS-777', 'username', 'password')); return true; })()`);
  await h.call('navigate', { tabId, url: `${A}/autofill.html` });
  await sleep(500);
  await h.call('navigate', { tabId, url: `${A}/autofill.html?again` });
  await sleep(1500);
  const ctx = (await d.contexts()).find(x => x.url.includes('autofill.html')).context;
  const filled = await d.evalIn(ctx, `document.getElementById('p').value`);
  const outs = [await h.call('read_page', { tabId }), await h.call('find', { tabId, query: 'password' }), await h.call('get_page_text', { tabId })];
  const ref = refOf((await h.call('find', { tabId, query: 'password' })).text);
  if (ref)
    outs.push(await h.call('computer', { tabId, action: 'left_click', ref }));
  const bad = outs.filter(r => r.text.includes('saved-PASS-777'));
  expect(filled === 'saved-PASS-777', `Firefox did not autofill (value=${JSON.stringify(filled)}), test inconclusive`);
  expect(!bad.length, 'autofilled password leaked: ' + bad.map(r => r.text.slice(0, 200)).join('\n'));
}, { area: '6' });

d.close();
await h.stop();
xs.close();
process.exit(finish());
