// Version compatibility with the releases people really have: every combination of
//   extension   Zenko 0.6.0 and Foxwright 0.7.1 (the signed store files), and this build
//   helper      zenko-firefox 0.6.0, foxwright-firefox 0.7.1 and 0.8.0 (npm), and this build
//   MCP server  each of those as a process (an AI client keeps running the one it started)
// plus the upgrade paths people take (the store updates the extension first; `setup` first; setup
// while Firefox and the AI client stay open; Kitsune → Zenko → Foxwright; a fresh install).
// For each: does it connect, what works, and what do the agent (tool results) and the person
// (toolbar popup, doctor) get told. Nothing may hang, fail silently, or lose approvals.
//
//   node test/fetch-compat-artifacts.mjs                  once (network); CI caches dist/compat
//   FIREFOX=/path/to/firefox node test/e2e-compat.mjs     Linux only (a container): needs an isolated HOME
//     --only a,b      run only parts: matrix, store-first, setup-first, migration, fresh
//     FOXWRIGHT_COMPAT_DIR      where the artifacts are (default dist/compat)
//     FOXWRIGHT_COMPAT_REQUIRE=1  fail instead of skipping when artifacts are missing
//
// The matrix is printed as a table and written to test/results/e2e-compat-matrix.md.
// The browser-free part (a fake extension) is test/compat-offline.mjs.
import fs from 'node:fs';
import path from 'node:path';
import { runner, sleep, expect, tabIdOf, refOf } from './gap-lib.mjs';
import { machine, fixtureServer, destroyAll, brief, missingArtifacts, HELPERS, CURRENT, verOf, root } from './compat-lib.mjs';
import { compareVersions } from '../host/src/compat.js';

const { test, skip, finish } = runner('e2e-compat');
const onlyArg = process.argv.indexOf('--only');
const only = onlyArg > 0 ? new Set(process.argv[onlyArg + 1].split(',')) : null;
const part = (name) => !only || only.has(name);
const fx = await fixtureServer();
const SITE = fx.origin;
const older = (a, b) => compareVersions(verOf(a), verOf(b)) === -1;
const pre08 = (v) => older(v, '0.8.0');

const missing = missingArtifacts('0.5.0', '0.6.0', '0.7.1', '0.8.0', 'current');
if (missing.length) {
  console.log(`Missing: ${missing.join(', ')}\nRun: node test/fetch-compat-artifacts.mjs (and npm run build)`);
  if (process.env.FOXWRIGHT_COMPAT_REQUIRE === '1' || !missing.every(f => f.includes(`${path.sep}compat${path.sep}`)))
    process.exit(2);
  skip('everything', 'the published artifacts are not in dist/compat');
  fx.close();
  process.exit(finish());
}

console.log(`Foxwright version compatibility (this build: ${CURRENT})`);

/** Wait until fn() is truthy (polling), or fail with msg. */
async function until(fn, ms, msg) {
  let v;
  for (const t0 = Date.now(); Date.now() - t0 < ms;) {
    v = await fn().catch(() => null);
    if (v)
      return v;
    await sleep(300);
  }
  throw new Error(typeof msg === 'function' ? msg(v) : msg);
}

/** Navigate; if the permission window shows, answer it like a person ('always' | 'once' | 'deny'). */
async function navAsking(ff, c, tabId, url, answer) {
  let asked = false, done = false;
  const call = c.call('navigate', { tabId, url }, 60000).finally(() => { done = true; });
  while (!done) {
    const w = (await ff.d.contexts().catch(() => [])).find(x => x.url.includes('/prompt/prompt.html'));
    if (w && !asked) {
      asked = true;
      await ff.d.answer(answer, w).catch(() => {});
    }
    await sleep(80);
  }
  return { asked, r: await call };
}

/**
 * What one MCP server version can do in the current setup: connects?, the basics (navigate, read,
 * click, screenshot), and the options added in 0.8 (read_page diff / wait_for, computer wait for
 * text, PDFs). Returns observations; the callers assert on them.
 */
async function probe(c) {
  const o = { connect: null };
  const t = await c.call('tabs_context_mcp', { createIfEmpty: true }, 25000);
  o.first = t;
  o.connect = !t.isError;
  if (t.isError)
    return o;
  const tabId = tabIdOf(t.text);
  const nav = await c.call('navigate', { tabId, url: `${SITE}/waits.html` });
  const r1 = await c.call('read_page', { tabId });
  const ref = refOf(r1.text, /button "Count 0" \[ref=([^\]]+)\]/);
  await c.call('computer', { tabId, action: 'left_click', ref });
  o.diff = await c.call('read_page', { tabId, diff: true });
  const shot = await c.call('computer', { tabId, action: 'screenshot' });
  o.basics = !nav.isError && !!ref && /Count 1/.test(o.diff.text + (await c.call('find', { tabId, query: 'Count' })).text) && shot.images === 1;
  o.basicsWhy = `navigate: ${brief(nav.text, 80)}; ref: ${ref}; screenshot images: ${shot.images}`;
  o.waitText = await c.call('computer', { tabId, action: 'wait', text: 'Never there', timeout: 1 });
  o.waitFor = await c.call('read_page', { tabId, wait_for: 'Never there', timeout: 1, filter: 'interactive' });
  await c.call('navigate', { tabId, url: `${SITE}/pdf/simple.pdf` });
  o.pdf = await c.call('get_page_text', { tabId });
  await c.call('navigate', { tabId, url: `${SITE}/page2.html` });
  return o;
}
const realDiff = (r) => /Changes since the previous read_page|No changes since the previous read_page/.test(r.text);

// ---------- the matrix ----------

const matrix = []; // rows for the table
const cell = (s) => String(s).replace(/\|/g, '\\|').replace(/\n/g, ' ');

/** What must happen for extension E, running helper H, MCP server process M. */
function expected(E, H, M) {
  const hostName = HELPERS[H].name, wants = E === '0.6.0' ? 'zenko' : 'foxwright';
  // The 0.7.1+ helpers also register under "zenko"; the Zenko helper only knows that name.
  const extConnects = hostName === 'foxwright' || wants === 'zenko';
  if (HELPERS[M].name !== hostName)
    return { extConnects, kind: 'other-product' }; // a Zenko MCP server looks in ~/.zenko, a Foxwright one in ~/.foxwright
  if (!extConnects)
    return { extConnects, kind: 'no-firefox' };
  if (pre08(H) !== pre08(M))
    return { extConnects, kind: pre08(H) ? 'old-helper' : 'old-client' };
  return { extConnects, kind: 'works' };
}

if (part('matrix')) {
  for (const E of ['0.6.0', '0.7.1', 'current']) {
    for (const H of ['0.6.0', '0.7.1', '0.8.0', 'current']) {
      await test(`matrix: extension ${verOf(E)} + helper ${verOf(H)}${H === 'current' ? ' (this build)' : ''}: every MCP server version connects or says exactly what to do`, async () => {
        const m = machine();
        try {
          expect(m.cli(H, 'setup').code === 0, 'setup failed');
          const ff = await m.startFirefox();
          await ff.install(E);
          const hostName = HELPERS[H].name;
          const want = expected(E, H, H);
          const st = await ff.waitStatus(s => s.connected === want.extConnects, 15000);
          expect(!!st?.connected === want.extConnects, `extension connected: ${st?.connected}, expected ${want.extConnects} (${st?.lastError})`);
          if (st.connected)
            await ff.message({ kind: 'setMode', mode: 'all' });
          const row = { E, H, connected: !!st.connected, cells: {}, popup: '', doctor: '' };

          for (const M of ['0.6.0', '0.7.1', '0.8.0', 'current']) {
            const w = expected(E, H, M);
            const c = await m.mcp(HELPERS[M].file);
            const t0 = Date.now();
            const o = await probe(c);
            await c.close();
            const first = o.first.text;
            expect(!o.first.hung && Date.now() - t0 < 60000, `MCP ${M}: a call hung (${brief(first)})`);
            let say;
            if (w.kind === 'works') {
              expect(o.connect && o.basics, `MCP ${M} should work: ${brief(first)} / ${o.basicsWhy}`);
              const newExt = !pre08(E), newMcp = !pre08(M);
              if (newExt && newMcp) {
                expect(realDiff(o.diff), `read_page diff: ${brief(o.diff.text)}`);
                expect(o.waitText.isError && /Timed out after 1 s waiting for "Never there"/.test(o.waitText.text), `wait text: ${brief(o.waitText.text)}`);
                expect(!o.pdf.isError && /Foxwright PDF fixture/.test(o.pdf.text), `PDF: ${brief(o.pdf.text)}`);
                say = 'works, all options';
              } else if (!newExt && M === 'current') {
                // Known fix (i): never silently ignored or misreported.
                expect(!o.diff.isError && /^Note: read_page \{diff\} needs Foxwright extension 0\.8 or newer/.test(o.diff.text) && /Count 1/.test(o.diff.text), `read_page diff: ${brief(o.diff.text)}`);
                expect(o.waitText.isError && /computer wait with text needs Foxwright extension 0\.8 or newer/.test(o.waitText.text), `wait text: ${brief(o.waitText.text)}`);
                expect(!o.waitFor.isError && /read_page \{wait_for\} needs Foxwright extension 0\.8 or newer/.test(o.waitFor.text), `wait_for: ${brief(o.waitFor.text)}`);
                expect(o.pdf.isError && /Reading PDFs \(get_page_text\) needs Foxwright extension 0\.8 or newer/.test(o.pdf.text), `PDF: ${brief(o.pdf.text)}`);
                // Known fix (ii): the extension is the older side, so no "run setup".
                expect(/Version note: The Foxwright extension in Firefox \(.*\) is older than this MCP server/.test(first) && /does NOT need to run setup/.test(first), `version note: ${brief(first, 500)}`);
                say = 'works; 0.8 options answer "needs extension 0.8+"; note: extension update comes from the store';
              } else if (!newExt) {
                say = M === '0.8.0' ? 'works; 0.8 options silently ignored (published 0.8.0 behaviour, fixed in this build)' : 'works (no 0.8 options in this MCP server)';
              } else {
                say = 'works; the older MCP server does not offer the 0.8 options';
              }
              if (!older(M, CURRENT) && !pre08(E))
                expect(!/Version note|version mismatch/.test(first), `no version note expected: ${brief(first, 400)}`);
            } else if (w.kind === 'old-helper') {
              expect(!o.connect && /helper .*is older than this MCP server/.test(first) && /npx foxwright-firefox@latest setup/.test(first), `MCP ${M}: ${brief(first, 400)}`);
              expect(o.first.ms < 12000, `took ${o.first.ms} ms to say so`);
              say = 'refused: "helper is older… run npx foxwright-firefox@latest setup"';
            } else if (w.kind === 'old-client') {
              expect(!o.connect && /older than the Foxwright helper/.test(first), `MCP ${M}: ${brief(first, 400)}`);
              if (H === 'current')
                expect(/restart this AI client: quit it completely and open it again/.test(first), `MCP ${M}: ${brief(first, 400)}`);
              say = `refused: "MCP server is older than the helper… ${H === 'current' ? 'restart this AI client' : 'update the MCP server, then restart the AI client'}"`;
            } else {
              expect(!o.connect && /is not running \(no helper socket found\)/.test(first), `MCP ${M}: ${brief(first, 400)}`);
              say = w.kind === 'other-product' ? `"Firefox with the ${HELPERS[M].name === 'zenko' ? 'Zenko' : 'Foxwright'} extension is not running" (it looks in ~/.${HELPERS[M].name})` : '"Firefox … is not running … run doctor"';
            }
            row.cells[M] = say;
          }

          // The person: toolbar popup (this build's extension only: the others are published as they are).
          const popup = await ff.popupText();
          if (E === 'current') {
            if (!st.connected) {
              expect(/Firefox can't find Foxwright's helper program/.test(popup) && /npx foxwright-firefox setup/.test(popup), `popup: ${brief(popup, 400)}`);
              row.popup = '"Firefox can\'t find Foxwright\'s helper… npx foxwright-firefox setup --claude-code"';
            } else if (pre08(H)) {
              expect(/The helper on this computer \(from before 0\.8\) is older than this extension/.test(popup) && /npx foxwright-firefox@latest setup/.test(popup) && /restart your AI client/.test(popup), `popup: ${brief(popup, 500)}`);
              row.popup = '"The helper on this computer (from before 0.8) is older than this extension… npx foxwright-firefox@latest setup… then restart your AI client"';
            } else if (H === 'current') {
              // The 0.7.1 MCP server above was refused: the popup must say so.
              expect(/An AI client is still running an older Foxwright and can't connect\. Restart your AI client/.test(popup), `popup: ${brief(popup, 500)}`);
              expect(!/older than this extension/.test(popup), `popup: ${brief(popup, 500)}`);
              row.popup = 'after the 0.7.1 MCP server was refused: "An AI client is still running an older Foxwright and can\'t connect. Restart your AI client…"';
            } else {
              expect(!/older than/.test(popup), `popup: ${brief(popup, 500)}`);
              row.popup = 'Ready; no note (the 0.8.0 helper does not report refused MCP servers)';
            }
          } else {
            row.popup = st.connected ? `Ready (${verOf(E)} popup, no version information)` : (/npx foxwright-firefox setup/.test(popup) ? '"Foxwright needs its small helper program… npx foxwright-firefox setup"' : brief(popup, 120));
          }

          // The person: `npx foxwright-firefox@latest doctor` (this build).
          const d = m.cli('current', 'doctor');
          if (hostName !== 'foxwright') {
            expect(d.code === 1 && /Only an install from when Foxwright was called Zenko is here/.test(d.out) && /npx foxwright-firefox@latest setup/.test(d.out), d.out);
            row.doctor = '✗ "Only an install from when Foxwright was called Zenko is here… Replace it: npx foxwright-firefox@latest setup"';
          } else if (pre08(H)) {
            expect(d.code === 1 && /Firefox is running a Foxwright helper from before 0\.8/.test(d.out) && /npx foxwright-firefox@latest setup : it installs the current helper and restarts the one Firefox is running/.test(d.out), d.out);
            row.doctor = '✗ "Firefox is running a Foxwright helper from before 0.8… Run npx foxwright-firefox@latest setup: it… restarts the one Firefox is running. Then restart your AI client."';
          } else {
            expect(/Firefox connected/.test(d.out), d.out);
            const notes = [];
            if (older(E, H)) {
              expect(/The Foxwright extension in that Firefox \(.*\) is older than the helper/.test(d.out) && /Nothing to run for the older extension/.test(d.out), d.out);
              expect(d.code === 0, `an older extension alone is not a problem (exit ${d.code}):\n${d.out}`);
              notes.push('! "extension is older than the helper… Nothing to run: Firefox updates the extension by itself…"');
            }
            if (H === 'current') {
              expect(/this helper refused an AI client's MCP server from before 0\.8/.test(d.out) && /Restart that AI client/.test(d.out), d.out);
              notes.push('! "this helper refused an AI client\'s MCP server from before 0.8… Restart that AI client"');
            }
            if (H === '0.8.0')
              expect(/this command is the newer|All good|Suggestions/.test(d.out), d.out);
            row.doctor = `✓ connected${notes.length ? '; ' + notes.join('; ') : ''}`;
          }
          matrix.push(row);
        } finally {
          await m.destroy();
        }
      });
    }
  }
}

// ---------- upgrade paths ----------

/** A 0.7.1 computer in use: helper, store extension, an AI client's MCP server, one site always allowed. */
async function computer071() {
  const m = machine();
  expect(m.cli('0.7.1', 'setup').code === 0, 'setup 0.7.1 failed');
  const ff = await m.startFirefox();
  await ff.install('0.7.1');
  expect((await ff.waitStatus(s => s.connected))?.connected, 'the 0.7.1 extension never connected');
  const oldMcp = await m.mcp(); // the AI client's MCP server: stays as started
  expect(oldMcp.version === '0.7.1', `MCP server ${oldMcp.version}`);
  const tabId = tabIdOf((await oldMcp.call('tabs_context_mcp', { createIfEmpty: true })).text);
  const a = await navAsking(ff, oldMcp, tabId, `${SITE}/basic.html`, 'always');
  expect(a.asked && !a.r.isError, `Always allow in the 0.7.1 permission window: ${JSON.stringify(a)}`);
  await ff.message({ kind: 'setName', name: 'Work Firefox' });
  const before = await ff.storage();
  expect(before.allowed?.includes(SITE) && before.mode === 'ask' && before.browserName === 'Work Firefox' && /^[a-f0-9]{12}$/.test(before.browserId), JSON.stringify(before));
  return { m, ff, oldMcp, tabId, before };
}

/** After an update: nothing stored was lost or reinterpreted, and no first-run page opened. */
async function settingsSurvived(ff, before, label) {
  const after = await ff.storage();
  for (const k of ['mode', 'browserId', 'browserName'])
    expect(after[k] === before[k], `${label}: ${k} changed from ${JSON.stringify(before[k])} to ${JSON.stringify(after[k])}`);
  expect(JSON.stringify(after.allowed) === JSON.stringify(before.allowed), `${label}: allowed sites changed: ${JSON.stringify(before.allowed)} -> ${JSON.stringify(after.allowed)}`);
  expect(!!after.paused === !!before.paused, `${label}: paused changed`);
  const s = await ff.status();
  expect(s.allowed.includes(SITE) && s.mode === before.mode && s.browserName === before.browserName, `${label}: ${JSON.stringify(s)}`);
  if (!pre08(s.version)) {
    // Keys added in 0.8 start empty: an old "always" approval must not turn into read-only or time-limited.
    expect(s.readOnly.length === 0 && s.timed.length === 0 && s.confirmActions === false && s.sessionReadOnly.length === 0, `${label}: ${JSON.stringify(s)}`);
    expect((await ff.openExtPages('welcome/welcome.html')).length === 0, `${label}: the first-run page opened on an update`);
    expect(after.welcomeShown === undefined, `${label}: welcomeShown was set by an update`);
  }
  return s;
}

if (part('store-first')) {
  await test('(a)+(c) the store updates the extension first, setup runs later with Firefox and the AI client open: approvals kept, each step says what is left to do', async () => {
    const { m, ff, oldMcp, tabId, before } = await computer071();
    try {
      // Pause survives the update too (Stop must not be undone by an update).
      await ff.message({ kind: 'pause' });
      const paused = await ff.storage();
      // 1. Firefox auto-updates the extension from the store.
      const up = await ff.install('current');
      expect(up.before === '0.7.1' && up.after === CURRENT, JSON.stringify(up));
      let s = await ff.waitStatus(x => x.connected);
      expect(s?.connected && s.paused === true, `after the update: ${JSON.stringify(s)}`);
      await settingsSurvived(ff, paused, 'extension 0.7.1 -> this build');
      await ff.message({ kind: 'resume' });
      // The person: the popup says the helper is the old part, and what to run.
      let popup = await ff.popupText();
      expect(/The helper on this computer \(from before 0\.8\) is older than this extension/.test(popup) && /npx foxwright-firefox@latest setup/.test(popup), `popup: ${brief(popup, 500)}`);
      // The agent: the AI client's 0.7.1 MCP server keeps working with the 0.7.1 helper, on the approved site, without a new prompt.
      let r = await oldMcp.call('tabs_context_mcp', { createIfEmpty: true });
      expect(!r.isError, `0.7.1 MCP server after the extension update: ${r.text}`);
      const tab = tabIdOf(r.text);
      const nav = await navAsking(ff, oldMcp, tab, `${SITE}/page2.html`, 'deny');
      expect(!nav.asked && !nav.r.isError, `the approved site asked again or failed: ${JSON.stringify(nav)}`);

      // 2. `npx foxwright-firefox@latest setup`, nothing closed.
      const setup = m.cli('current', 'setup');
      expect(setup.code === 0 && /Stopped the helper .* that Firefox was running/.test(setup.out) && /Restart your AI client/.test(setup.out), setup.out);
      // Firefox starts the new helper by itself: no restart.
      s = await ff.waitStatus(x => x.connected && x.helperVersion === CURRENT, 30000);
      expect(s?.helperVersion === CURRENT, `the extension did not pick up helper ${CURRENT} by itself: ${JSON.stringify({ connected: s?.connected, helperVersion: s?.helperVersion, lastError: s?.lastError })}`);
      // The AI client was not restarted: its agent is told to, and so is the person.
      r = await oldMcp.call('tabs_context_mcp', {});
      expect(r.isError && !r.hung && /older than the Foxwright helper/.test(r.text) && /restart this AI client: quit it completely and open it again/.test(r.text), `old MCP server after setup: ${r.text}`);
      popup = await ff.popupText();
      expect(/An AI client is still running an older Foxwright and can't connect\. Restart your AI client/.test(popup) && !/older than this extension/.test(popup), `popup: ${brief(popup, 500)}`);
      let d = m.installedCli('foxwright', 'doctor');
      expect(/refused an AI client's MCP server from before 0\.8/.test(d.out) && /Restart that AI client/.test(d.out), d.out);

      // 3. The AI client restarts: everything works, the site is still approved, new options work.
      await oldMcp.close();
      const c = await m.mcp();
      expect(c.version === CURRENT, c.version);
      r = await c.call('tabs_context_mcp', { createIfEmpty: true });
      expect(!r.isError && !/Version note/.test(r.text), r.text);
      const t2 = tabIdOf(r.text);
      const nav2 = await navAsking(ff, c, t2, `${SITE}/waits.html`, 'deny');
      expect(!nav2.asked && !nav2.r.isError, `the approved site asked again: ${JSON.stringify(nav2)}`);
      await c.call('read_page', { tabId: t2 });
      expect(realDiff(await c.call('read_page', { tabId: t2, diff: true })), 'read_page diff after the full update');
      await settingsSurvived(ff, { ...before, paused: false }, 'after setup');
      void tabId;
    } finally {
      await m.destroy();
    }
  });
}

if (part('setup-first')) {
  await test('(b)+(c) setup first (Firefox and the AI client open), the store extension follows later: works in between, nobody is told to run setup again', async () => {
    const { m, ff, oldMcp, before } = await computer071();
    try {
      const starts = () => m.helperLog().split('helper starting').length;
      const n0 = starts();
      const setup = m.cli('current', 'setup');
      expect(setup.code === 0 && /Stopped the helper .* that Firefox was running/.test(setup.out), setup.out);
      // The 0.7.1 extension restarts the helper by itself (it retries from 2 s on).
      await until(async () => starts() > n0 && /extension connected \{"version":"0\.7\.1"/.test(m.helperLog().split('helper starting').pop()) && (await ff.status()).connected, 30000,
        () => `the 0.7.1 extension did not reconnect to the new helper by itself. Helper log:\n${m.helperLog().split('\n').slice(-8).join('\n')}`);
      let r = await oldMcp.call('tabs_context_mcp', {});
      expect(r.isError && /restart this AI client/.test(r.text), `old MCP server: ${r.text}`);
      await oldMcp.close();

      // The AI client restarts. Extension 0.7.1 (the update is in store review) + helper and MCP server of this build.
      const c = await m.mcp();
      r = await c.call('tabs_context_mcp', { createIfEmpty: true });
      expect(!r.isError && /extension in Firefox \(0\.7\.1\) is older than this MCP server/.test(r.text) && /does NOT need to run setup/.test(r.text), r.text);
      const tab = tabIdOf(r.text);
      const nav = await navAsking(ff, c, tab, `${SITE}/waits.html`, 'deny');
      expect(!nav.asked && !nav.r.isError, `the approved site asked again: ${JSON.stringify(nav)}`);
      const diff = await c.call('read_page', { tabId: tab, diff: true });
      expect(!diff.isError && /^Note: read_page \{diff\} needs Foxwright extension 0\.8 or newer/.test(diff.text) && /button "Search"/.test(diff.text), brief(diff.text, 400));
      const d = m.cli('current', 'doctor');
      expect(d.code === 0 && /extension in that Firefox \(0\.7\.1\) is older than the helper/.test(d.out) && /Nothing to run for the older extension/.test(d.out) && !/What to do/.test(d.out), d.out);

      // Days later the store update arrives.
      await ff.install('current');
      const s = await ff.waitStatus(x => x.connected && x.helperVersion === CURRENT, 30000);
      expect(s?.connected && s.versionNotes.filter(n => n.kind !== 'old-client').length === 0, JSON.stringify(s?.versionNotes));
      await settingsSurvived(ff, before, 'extension 0.7.1 -> this build (helper first)');
      let t2;
      await until(async () => {
        r = await c.call('tabs_context_mcp', { createIfEmpty: true });
        return !r.isError;
      }, 20000, () => `the MCP server did not reconnect after the extension update: ${r.text}`);
      t2 = tabIdOf(r.text);
      expect(!/older than this MCP server/.test(r.text), r.text);
      await c.call('navigate', { tabId: t2, url: `${SITE}/waits.html` });
      await c.call('read_page', { tabId: t2 });
      expect(realDiff(await c.call('read_page', { tabId: t2, diff: true })), 'read_page diff once the extension is updated');
    } finally {
      await m.destroy();
    }
  });
}

if (part('migration')) {
  await test('(d) Kitsune 0.5 -> Zenko 0.6 -> Foxwright on one computer: approvals from 0.6 survive, Claude Code keeps its browser tools, no first-run page', async () => {
    const m = machine();
    try {
      const claude = m.fakeClaude();
      expect(m.cli('0.5.0', 'setup', '--claude-code').code === 0 && claude.entries().kitsune, `kitsune setup: ${JSON.stringify(claude.entries())}`);
      // Zenko era.
      const z = m.cli('0.6.0', 'setup', '--claude-code');
      expect(z.code === 0 && !claude.entries().kitsune && claude.entries().zenko, `zenko setup: ${z.out}\n${JSON.stringify(claude.entries())}`);
      const ff = await m.startFirefox();
      await ff.install('0.6.0');
      expect((await ff.waitStatus(s => s.connected))?.connected, 'Zenko 0.6.0 never connected to its helper');
      const zc = await m.mcp(m.installed('zenko'));
      const tabId = tabIdOf((await zc.call('tabs_context_mcp', { createIfEmpty: true })).text);
      const a = await navAsking(ff, zc, tabId, `${SITE}/basic.html`, 'always');
      expect(a.asked && !a.r.isError, `Always allow in the Zenko 0.6.0 window: ${JSON.stringify(a)}`);
      const before = await ff.storage();
      expect(before.allowed?.includes(SITE), JSON.stringify(before));

      // `npx foxwright-firefox@latest setup` while Zenko is running (no flags: the person just follows the README).
      const setup = m.cli('current', 'setup');
      expect(setup.code === 0 && /Stopped the Zenko helper/.test(setup.out), setup.out);
      const e = claude.entries();
      expect(!e.zenko && e.foxwright && e.foxwright.join(' ').includes(path.join('.foxwright', 'app', 'foxwright.mjs')), `Claude Code entries after setup: ${JSON.stringify(e)}\n${setup.out}`);
      expect(!fs.existsSync(path.join(m.home, '.zenko')) && !fs.existsSync(path.join(m.home, '.kitsune')), 'old folders left behind');
      // The Zenko 0.6.0 extension (asks for "zenko") finds this helper by itself.
      await until(async () => /extension connected \{"version":"0\.6\.0"/.test(m.helperLog()), 30000, () => `the Zenko extension did not reconnect. Helper log:\n${m.helperLog()}\nsetup:\n${setup.out}`);
      await zc.close();
      const c = await m.mcp();
      let r = await c.call('tabs_context_mcp', { createIfEmpty: true });
      expect(!r.isError && /extension in Firefox \(0\.6\.0\) is older than this MCP server/.test(r.text), r.text);
      const nav = await navAsking(ff, c, tabIdOf(r.text), `${SITE}/page2.html`, 'deny');
      expect(!nav.asked && !nav.r.isError, `Zenko's approval was lost: ${JSON.stringify(nav)}`);

      // The store then brings 0.7.1 and later this build.
      await ff.install('0.7.1');
      expect((await ff.waitStatus(s => s.connected))?.connected, '0.7.1 did not connect');
      await ff.install('current');
      expect((await ff.waitStatus(s => s.connected && s.helperVersion === CURRENT))?.connected, 'this build did not connect');
      await settingsSurvived(ff, before, 'Zenko 0.6.0 -> 0.7.1 -> this build');
    } finally {
      await m.destroy();
    }
  });

  await test('(d) the store updated Zenko 0.6 to Foxwright before setup ran: popup and doctor both lead to setup, which reconnects without restarting Firefox', async () => {
    const m = machine();
    try {
      expect(m.cli('0.6.0', 'setup').code === 0, 'zenko setup');
      const ff = await m.startFirefox();
      await ff.install('0.6.0');
      expect((await ff.waitStatus(s => s.connected))?.connected, 'Zenko never connected');
      await ff.message({ kind: 'setMode', mode: 'all' });
      const before = await ff.storage();
      await ff.install('current'); // 0.6.0 -> this build in one step (a computer that was off for a while)
      const s = await ff.waitStatus(x => x.errorKind === 'not-installed', 15000);
      expect(s && !s.connected && s.errorKind === 'not-installed', JSON.stringify(s));
      expect((await ff.openExtPages('welcome/welcome.html')).length === 0, 'the first-run page opened on an update from 0.6.0');
      const popup = await ff.popupText();
      expect(/Firefox can't find Foxwright's helper program/.test(popup) && /npx foxwright-firefox setup/.test(popup), brief(popup, 400));
      const d = m.cli('current', 'doctor');
      expect(d.code === 1 && /called Zenko is here/.test(d.out) && /npx foxwright-firefox@latest setup/.test(d.out), d.out);
      expect(m.cli('current', 'setup').code === 0, 'setup');
      // The popup's "Try again" (or simply opening it) reconnects at once; otherwise the extension retries by itself.
      const s2 = await ff.waitStatus(x => x.connected && x.helperVersion === CURRENT, 30000);
      expect(s2?.connected, `not connected after setup: ${JSON.stringify(s2)}`);
      const after = await ff.storage();
      expect(after.mode === 'all' && after.browserId === before.browserId, JSON.stringify(after));
    } finally {
      await m.destroy();
    }
  });
}

if (part('fresh')) {
  await test('(e) fresh install with the store page first: the setup page opens once, shows live status, and flips to Connected when setup has run', async () => {
    const m = machine();
    try {
      const ff = await m.startFirefox();
      const inst = await ff.install('current');
      const pages = await until(async () => {
        const p = await ff.openExtPages('welcome/welcome.html');
        return p.length ? p : null;
      }, 10000, 'the setup page did not open on a first install');
      expect(pages.length === 1, `${pages.length} setup pages`);
      const ctx = pages[0].context;
      const live = () => ff.d.evalIn(ctx, `document.getElementById('live').textContent`);
      await until(async () => /Helper not found/.test(await live()), 15000, 'the setup page never said "Helper not found"');
      expect(m.cli('current', 'setup').code === 0, 'setup');
      await until(async () => /Connected/.test(await live()), 75000, 'the setup page did not flip to Connected by itself');
      const diag = await ff.d.evalIn(ctx, `document.getElementById('diag').textContent`);
      expect(new RegExp(`Helper ${CURRENT.replace(/\./g, '\\.')} is running\\.$`).test(diag.trim()), `diag: ${diag}`);
      const c = await m.mcp();
      const r = await c.call('tabs_context_mcp', { createIfEmpty: true });
      expect(!r.isError && !/Version note/.test(r.text), r.text);
      // Reinstalling this version over itself (or any later update) is not a first install.
      await ff.install('current');
      await sleep(1500);
      const again = (await ff.openExtPages('welcome/welcome.html')).length;
      expect(again === 0, `the setup page opened again on an update (${again} open)`);
      if (!inst.temporary) {
        // A permanent install (Nightly, unsigned allowed): the page stays away after a Firefox restart too.
        await c.close();
        await ff.stop();
        const ff2 = await m.startFirefox();
        expect((await ff2.waitStatus(s => s.connected))?.connected, 'not connected after a restart');
        expect((await ff2.openExtPages('welcome/welcome.html')).length === 0, 'the setup page opened again after a restart');
      }
    } finally {
      await m.destroy();
    }
  });
}

// ---------- the table ----------
if (matrix.length) {
  const M = ['0.6.0', '0.7.1', '0.8.0', 'current'];
  const lines = [
    `Extension x helper x MCP server process, as run by test/e2e-compat.mjs on ${path.basename(path.dirname(process.env.FIREFOX || ''))} (this build: ${CURRENT}).`,
    '',
    `| Extension | Helper (installed and running) | Extension connects | ${M.map(v => `MCP server ${v === '0.6.0' ? 'zenko 0.6.0' : verOf(v)}${v === 'current' ? ' (this build)' : ''}`).join(' | ')} | Popup says | \`doctor\` (this build) says |`,
    `|---|---|---|${M.map(() => '---').join('|')}|---|---|`,
    ...matrix.map(r => `| ${r.E === '0.6.0' ? 'Zenko 0.6.0 (store)' : r.E === '0.7.1' ? '0.7.1 (store)' : `${CURRENT} (this build)`} | ${r.H === '0.6.0' ? 'zenko-firefox 0.6.0' : r.H === 'current' ? `${CURRENT} (this build)` : `foxwright-firefox ${r.H}`} | ${r.connected ? 'yes' : 'no'} | ${M.map(v => cell(r.cells[v])).join(' | ')} | ${cell(r.popup)} | ${cell(r.doctor)} |`),
  ];
  fs.mkdirSync(path.join(root, 'test/results'), { recursive: true });
  fs.writeFileSync(path.join(root, 'test/results/e2e-compat-matrix.md'), lines.join('\n') + '\n');
  console.log('\n' + lines.join('\n'));
}

await destroyAll();
fx.close();
process.exit(finish());
