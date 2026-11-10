// Zenko was called Kitsune before 0.6.0. `setup` removes that old install, but must not touch an
// unrelated project that also uses ~/.kitsune and a "kitsune" native-messaging name
// (github.com/junyeong-nero/kitsune). Runs against fake home folders; no browser needed.
//   node test/rename-cleanup.mjs
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const scenario = process.argv[2];
if (scenario) {
  // Child process: build a fake old install under HOME, run the cleanup, report what's left.
  const home = process.env.HOME;
  const mk = (p, s = 'x') => { fs.mkdirSync(path.dirname(p), { recursive: true }); fs.writeFileSync(p, s); };
  const old = path.join(home, '.kitsune');
  const nmDir = process.env.ZENKO_NATIVE_MANIFEST_DIR;
  const nm = path.join(nmDir, 'kitsune.json');
  for (const f of ['app/kitsune.mjs', 'kitsune-host', 'helper.log', 'browsers/123.json'])
    mk(path.join(old, f));
  if (scenario === 'shared')
    mk(path.join(old, 'token'), 'the other project\'s token');
  mk(nm, JSON.stringify({ name: 'kitsune', allowed_extensions: [scenario === 'foreign' ? 'kitsune@junyeong-nero.github.io' : 'kitsune@william-ricchiuti.com'] }));
  const { removeOldKitsune } = await import(path.join(root, 'host/src/setup.js'));
  removeOldKitsune({ quiet: true });
  const has = (p) => fs.existsSync(p);
  console.log(JSON.stringify({ oldDir: has(old), ourApp: has(path.join(old, 'app/kitsune.mjs')), registry: has(path.join(old, 'browsers')), theirToken: has(path.join(old, 'token')), manifest: has(nm) }));
  process.exit(0);
}

const cases = [
  ['alone', { oldDir: false, ourApp: false, registry: false, theirToken: false, manifest: false }, 'an old Kitsune install alone is removed completely'],
  ['shared', { oldDir: true, ourApp: false, registry: false, theirToken: true, manifest: false }, 'files of another program in ~/.kitsune are kept, and so is the folder'],
  ['foreign', { oldDir: false, ourApp: false, registry: false, theirToken: false, manifest: true }, 'a "kitsune" registration for another extension is kept'],
];
let failed = 0;
console.log('Zenko: cleanup of the old Kitsune install');
for (const [name, want, label] of cases) {
  const home = fs.mkdtempSync(path.join(os.tmpdir(), 'zenko-rename-'));
  const env = { ...process.env, HOME: home, USERPROFILE: home, ZENKO_NATIVE_MANIFEST_DIR: path.join(home, 'native-messaging-hosts'), PATH: '' }; // PATH '' : never touch a real Claude CLI
  const got = JSON.parse(execFileSync(process.execPath, [fileURLToPath(import.meta.url), name], { env, encoding: 'utf8' }).trim().split('\n').pop());
  const ok = Object.entries(want).every(([k, v]) => got[k] === v);
  console.log(`  ${ok ? '✓' : '✗'} ${label}${ok ? '' : `\n      got ${JSON.stringify(got)}`}`);
  if (!ok)
    failed++;
  fs.rmSync(home, { recursive: true, force: true });
}
console.log(failed ? `\n${failed} failed` : `\n${cases.length}/${cases.length} passed`);
process.exit(failed ? 1 : 0);
