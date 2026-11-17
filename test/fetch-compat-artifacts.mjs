// Download the published releases that test/e2e-compat.mjs mixes with the build under test:
// the signed store extensions (Zenko 0.6.0, Foxwright 0.7.1) from addons.mozilla.org and the
// helpers (kitsune-firefox 0.5.0, zenko-firefox 0.6.0, foxwright-firefox 0.7.1 and 0.8.0) from
// the npm registry. Every file is checked against the SHA-256 pinned below, so a run always
// tests exactly what users got.
//
//   node test/fetch-compat-artifacts.mjs [outDir]     (default dist/compat, which git ignores)
//
// Needs network once; afterwards the folder can be cached (CI: actions/cache keyed on this file).
// Files that are already there with the right hash are not downloaded again.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import crypto from 'node:crypto';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] || path.join(root, 'dist', 'compat'));

export const XPIS = [
  { file: 'zenko-0.6.0.xpi', url: 'https://addons.mozilla.org/firefox/downloads/file/5232240/zenko-0.6.0.xpi', sha256: '25ce45ddd8ec922b6852cb678bbbab5c86ba126bc286da4d5f616683fa48eb36' },
  { file: 'foxwright-0.7.1.xpi', url: 'https://addons.mozilla.org/firefox/downloads/file/5250029/foxwright-0.7.1.xpi', sha256: '666ffe9132711f51c6f7dec0645da15a103bf78729eaf7af2caa6fc3c6241abc' },
];
// `entry`: the single-file CLI inside the npm tarball; saved as `file`.
export const HELPERS = [
  { file: 'kitsune-0.5.0.mjs', entry: 'package/dist/kitsune.mjs', url: 'https://registry.npmjs.org/kitsune-firefox/-/kitsune-firefox-0.5.0.tgz', sha256: '66e0ab3becab5aa663d0e9c1625668c3ffa5c29d29c057cd53798178a2161613' },
  { file: 'zenko-0.6.0.mjs', entry: 'package/dist/zenko.mjs', url: 'https://registry.npmjs.org/zenko-firefox/-/zenko-firefox-0.6.0.tgz', sha256: 'e8575ee54d3c83619b95b7e505e342563339bd90a92f4c7d14d85668319494a7' },
  { file: 'foxwright-0.7.1.mjs', entry: 'package/dist/foxwright.mjs', url: 'https://registry.npmjs.org/foxwright-firefox/-/foxwright-firefox-0.7.1.tgz', sha256: 'ac20d5db36fcd82b9a3bdc8337ec74ce6685bcc80d2836b6beea40eb319f1e94' },
  { file: 'foxwright-0.8.0.mjs', entry: 'package/dist/foxwright.mjs', url: 'https://registry.npmjs.org/foxwright-firefox/-/foxwright-firefox-0.8.0.tgz', sha256: 'a319c7002b78f2c06e31f1b29619d64a5be6ac279c924a06d24c29a10f4da8e8' },
];

const sha = (buf) => crypto.createHash('sha256').update(buf).digest('hex');

async function download(url, want) {
  const res = await fetch(url, { redirect: 'follow', headers: { 'user-agent': 'foxwright-compat-tests' } });
  if (!res.ok)
    throw new Error(`${url}: HTTP ${res.status}`);
  const buf = Buffer.from(await res.arrayBuffer());
  if (sha(buf) !== want)
    throw new Error(`${url}: SHA-256 is ${sha(buf)}, expected ${want}. Not using it.`);
  return buf;
}

/** One file out of a .tgz (plain ustar entries are enough for npm tarballs). */
function fromTgz(tgz, entry) {
  const tar = zlib.gunzipSync(tgz);
  for (let p = 0; p + 512 <= tar.length;) {
    const name = tar.toString('utf8', p, p + 100).replace(/\0.*$/, '');
    if (!name)
      break;
    const prefix = tar.toString('utf8', p + 345, p + 500).replace(/\0.*$/, '');
    const size = parseInt(tar.toString('utf8', p + 124, p + 136).replace(/\0.*$/, '').trim() || '0', 8);
    if ((prefix ? `${prefix}/${name}` : name) === entry)
      return tar.subarray(p + 512, p + 512 + size);
    p += 512 + Math.ceil(size / 512) * 512;
  }
  throw new Error(`${entry} is not in the tarball`);
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  fs.mkdirSync(out, { recursive: true });
  let failed = 0;
  // The tarball hash is what's pinned; remember it next to the extracted file.
  const stamp = (f) => path.join(out, `${f}.sha256`);
  const have = (f, want) => {
    try {
      return fs.existsSync(path.join(out, f)) && fs.readFileSync(stamp(f), 'utf8').trim() === want;
    } catch {
      return false;
    }
  };
  for (const a of [...XPIS, ...HELPERS]) {
    if (have(a.file, a.sha256)) {
      console.log(`  = ${a.file} (already there)`);
      continue;
    }
    try {
      const buf = await download(a.url, a.sha256);
      fs.writeFileSync(path.join(out, a.file), a.entry ? fromTgz(buf, a.entry) : buf);
      fs.writeFileSync(stamp(a.file), a.sha256 + '\n');
      console.log(`  ✓ ${a.file}`);
    } catch (e) {
      failed++;
      console.log(`  ✗ ${a.file}: ${e.message}`);
    }
  }
  console.log(failed ? `\n${failed} artifact(s) could not be fetched; test/e2e-compat.mjs will skip the cells that need them.` : `\nAll artifacts are in ${out}`);
  process.exit(failed ? 1 : 0);
}
