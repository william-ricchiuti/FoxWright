// Download the signed Foxwright XPI that addons.mozilla.org currently serves and unpack it, so the
// suites can run against exactly what users install:
//
//   node test/fetch-amo-xpi.mjs [outDir]       (default dist/amo)
//   FOXWRIGHT_E2E_BUILD=dist/amo node test/e2e-storebuild.mjs
//
// Only when AMO's current version equals the version in package.json; otherwise it says so and
// exits 0 without unpacking anything (the version under test isn't on AMO yet). Writes
// `found=true|false`, `dir=...` and `version=...` to $GITHUB_OUTPUT when set.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const out = path.resolve(process.argv[2] || path.join(root, 'dist', 'amo'));
const want = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
const API = 'https://addons.mozilla.org/api/v5/addons/addon/foxwright/';

function output(o) {
  if (process.env.GITHUB_OUTPUT)
    fs.appendFileSync(process.env.GITHUB_OUTPUT, Object.entries(o).map(([k, v]) => `${k}=${v}\n`).join(''));
}

/** Minimal ZIP reader (stored and deflated entries), enough for an XPI. */
function unzip(buf, dir) {
  let eocd = -1;
  for (let i = buf.length - 22; i >= Math.max(0, buf.length - 65557); i--) {
    if (buf.readUInt32LE(i) === 0x06054b50) {
      eocd = i;
      break;
    }
  }
  if (eocd < 0)
    throw new Error('not a zip file (no end of central directory)');
  const count = buf.readUInt16LE(eocd + 10);
  let p = buf.readUInt32LE(eocd + 16);
  const files = [];
  for (let n = 0; n < count; n++) {
    if (buf.readUInt32LE(p) !== 0x02014b50)
      throw new Error('bad central directory entry');
    const method = buf.readUInt16LE(p + 10);
    const csize = buf.readUInt32LE(p + 20);
    const nameLen = buf.readUInt16LE(p + 28), extraLen = buf.readUInt16LE(p + 30), commentLen = buf.readUInt16LE(p + 32);
    const local = buf.readUInt32LE(p + 42);
    const name = buf.toString('utf8', p + 46, p + 46 + nameLen);
    p += 46 + nameLen + extraLen + commentLen;
    if (name.endsWith('/'))
      continue;
    const target = path.resolve(dir, name);
    if (!target.startsWith(dir + path.sep))
      throw new Error(`refusing to unpack ${name} outside ${dir}`);
    const lNameLen = buf.readUInt16LE(local + 26), lExtraLen = buf.readUInt16LE(local + 28);
    const data = buf.subarray(local + 30 + lNameLen + lExtraLen, local + 30 + lNameLen + lExtraLen + csize);
    const bytes = method === 0 ? data : method === 8 ? zlib.inflateRawSync(data) : null;
    if (!bytes)
      throw new Error(`unsupported compression method ${method} for ${name}`);
    fs.mkdirSync(path.dirname(target), { recursive: true });
    fs.writeFileSync(target, bytes);
    files.push(name);
  }
  return files;
}

const info = await (await fetch(API, { headers: { accept: 'application/json' } })).json();
const cur = info.current_version || {};
const file = cur.file || (cur.files || [])[0];
if (!cur.version || !file?.url) {
  console.log(`AMO did not return a current version for foxwright (${API}); nothing to test.`);
  output({ found: 'false' });
  process.exit(0);
}
if (cur.version !== want) {
  console.log(`Skipping the signed-XPI run: AMO serves Foxwright ${cur.version}, but this tree is ${want} (not on AMO yet, or AMO is ahead).`);
  output({ found: 'false', version: cur.version });
  process.exit(0);
}
const res = await fetch(file.url);
if (!res.ok)
  throw new Error(`download failed: ${res.status} ${file.url}`);
const buf = Buffer.from(await res.arrayBuffer());
fs.rmSync(out, { recursive: true, force: true });
fs.mkdirSync(out, { recursive: true });
const files = unzip(buf, out);
const manifest = JSON.parse(fs.readFileSync(path.join(out, 'manifest.json'), 'utf8'));
const id = manifest.browser_specific_settings?.gecko?.id;
if (manifest.version !== want || id !== 'kitsune@william-ricchiuti.com')
  throw new Error(`unexpected XPI contents: version ${manifest.version}, id ${id}`);
const signed = files.some(f => /^META-INF\/.*\.(rsa|p7s|sf)$/i.test(f));
console.log(`Unpacked the signed AMO XPI of Foxwright ${manifest.version} (${buf.length} bytes, ${files.length} files${signed ? ', signature files present' : ', NO signature files'}) to ${out}`);
output({ found: 'true', dir: out, version: manifest.version });
