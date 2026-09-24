// Kitsune's version lives in three files that must agree:
//   package.json, host/package.json, extension/manifest.json
//
//   node scripts/version.mjs check          exit 1 if they differ (CI runs this)
//   node scripts/version.mjs bump 0.4.0     set all three, and start a CHANGELOG section
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const FILES = ['package.json', 'host/package.json', 'extension/manifest.json'];
const read = (f) => JSON.parse(fs.readFileSync(path.join(root, f), 'utf8'));

const [cmd, next] = process.argv.slice(2);
if (cmd === 'check') {
  const versions = Object.fromEntries(FILES.map(f => [f, read(f).version]));
  const distinct = new Set(Object.values(versions));
  if (distinct.size !== 1) {
    console.error('Version mismatch:', versions);
    process.exit(1);
  }
  console.log(`All versions are ${[...distinct][0]}`);
} else if (cmd === 'bump' && /^\d+\.\d+\.\d+$/.test(next || '')) {
  for (const f of FILES) {
    const file = path.join(root, f);
    const text = fs.readFileSync(file, 'utf8');
    fs.writeFileSync(file, text.replace(/("version"\s*:\s*")[^"]+(")/, `$1${next}$2`));
  }
  const cl = path.join(root, 'CHANGELOG.md');
  const log = fs.readFileSync(cl, 'utf8');
  const today = new Date().toISOString().slice(0, 10);
  fs.writeFileSync(cl, log.replace(/^## Unreleased\b.*$/m, `## ${next} (${today})`));
  console.log(`Set version ${next} in ${FILES.join(', ')}; renamed the CHANGELOG "Unreleased" section, if any.`);
  console.log('Next: npm install (updates the lockfiles), commit, then tag: git tag v' + next);
} else {
  console.error('Usage: node scripts/version.mjs check | bump X.Y.Z');
  process.exit(2);
}
