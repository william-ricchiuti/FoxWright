// Run several test suites one after another, keep going when one fails, and print a summary table.
// Exits 1 if any suite failed.
//
//   node test/run-suites.mjs gaps                    the seven e2e-gaps-* suites (headful; under xvfb-run on Linux without a display)
//   node test/run-suites.mjs e2e-safety e2e-multi    named suites (test/<name>.mjs)
//   node test/run-suites.mjs --headful e2e           any suite headful
//
// Each suite's output goes to the console and to test/results/<suite>.log.
import { spawn, execFileSync } from 'node:child_process';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const GROUPS = {
  gaps: ['e2e-gaps-boundary', 'e2e-gaps-fuzz', 'e2e-gaps-hostile', 'e2e-gaps-persistence', 'e2e-gaps-secrets', 'e2e-gaps-stop', 'e2e-gaps-trusted'],
};
const HEADFUL = new Set(GROUPS.gaps);

let headful = false;
const suites = [];
for (const a of process.argv.slice(2)) {
  if (a === '--headful')
    headful = true;
  else if (GROUPS[a])
    suites.push(...GROUPS[a]);
  else
    suites.push(a.replace(/^test\//, '').replace(/\.mjs$/, ''));
}
if (!suites.length) {
  console.error('usage: node test/run-suites.mjs [--headful] gaps | <suite> ...');
  process.exit(2);
}

const hasCmd = (c) => {
  try {
    execFileSync(process.platform === 'win32' ? 'where' : 'which', [c], { stdio: 'ignore' });
    return true;
  } catch {
    return false;
  }
};
const noise = /^(Running web extension|Setting custom Firefox|  "|\}$|Use --verbose|Installed \/|Automatic extension reloading|Profile changes|The extension will reload)/;

fs.mkdirSync(path.join(root, 'test/results'), { recursive: true });
const rows = [];
for (const s of suites) {
  const file = path.join(root, 'test', `${s}.mjs`);
  if (!fs.existsSync(file)) {
    rows.push({ s, code: 'missing', summary: `no such suite ${file}`, sec: 0 });
    continue;
  }
  const wantHead = headful || HEADFUL.has(s);
  const env = { ...process.env, ...(wantHead ? { FOXWRIGHT_E2E_HEADFUL: '1' } : {}) };
  let cmd = process.execPath, args = [file];
  if (wantHead && process.platform === 'linux' && !process.env.DISPLAY) {
    if (!hasCmd('xvfb-run')) {
      rows.push({ s, code: 'skipped', summary: 'needs a display: install xvfb (xvfb-run) or set DISPLAY', sec: 0 });
      continue;
    }
    cmd = 'xvfb-run';
    args = ['-a', '-s', '-screen 0 1400x900x24', process.execPath, file];
  }
  console.log(`\n== ${s}${wantHead ? ' (headful)' : ''}`);
  const t0 = Date.now();
  const log = fs.createWriteStream(path.join(root, 'test/results', `${s}.log`));
  let summary = '';
  const code = await new Promise((resolve) => {
    const p = spawn(cmd, args, { cwd: root, env, stdio: ['ignore', 'pipe', 'pipe'] });
    let buf = '';
    const onData = (d) => {
      log.write(d);
      buf += d;
      let i;
      while ((i = buf.indexOf('\n')) >= 0) {
        const line = buf.slice(0, i);
        buf = buf.slice(i + 1);
        if (/\d+ passed|\d+\/\d+ .*passed|Suite timeout/.test(line))
          summary = line.trim();
        if (!noise.test(line))
          console.log(line);
      }
    };
    p.stdout.on('data', onData);
    p.stderr.on('data', onData);
    p.on('close', (c, sig) => resolve(c ?? sig));
  });
  log.end();
  rows.push({ s, code, summary, sec: Math.round((Date.now() - t0) / 1000) });
}

const ok = r => r.code === 0;
console.log('\n== Summary');
const w = Math.max(...rows.map(r => r.s.length));
for (const r of rows)
  console.log(`  ${ok(r) ? 'PASS' : r.code === 'skipped' ? 'SKIP' : 'FAIL'}  ${r.s.padEnd(w)}  ${String(r.sec).padStart(4)} s  ${ok(r) ? '' : `(exit ${r.code}) `}${r.summary}`);
const failed = rows.filter(r => !ok(r) && r.code !== 'skipped');
console.log(failed.length ? `\n${failed.length} of ${rows.length} suites failed` : `\nall ${rows.length} suites passed`);
process.exit(failed.length ? 1 : 0);
