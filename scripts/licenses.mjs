// Collects the license texts of every third-party package that esbuild bundled into an output
// file, so shipped builds keep the notices their licenses (MIT, Apache-2.0, ISC...) require.
// Usage: pass esbuild's `metafile` result; returns the text of a THIRD-PARTY-NOTICES file.
import fs from 'node:fs';
import path from 'node:path';

const LICENSE_NAMES = ['LICENSE', 'LICENSE.md', 'LICENSE.txt', 'license', 'LICENCE', 'COPYING'];

function packageRoot(file) {
  // .../node_modules/@scope/name/... or .../node_modules/name/...
  const parts = file.split(/[\\/]/);
  const i = parts.lastIndexOf('node_modules');
  if (i < 0)
    return null;
  const n = parts[i + 1]?.startsWith('@') ? 3 : 2;
  return parts.slice(0, i + n).join(path.sep);
}

export function thirdPartyNotices(metafile, baseDir, extra = []) {
  const roots = new Set();
  for (const input of Object.keys(metafile.inputs)) {
    const root = packageRoot(path.resolve(baseDir, input));
    if (root)
      roots.add(root);
  }
  const sections = [];
  for (const root of [...roots].sort()) {
    let pkg = {};
    try {
      pkg = JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8'));
    } catch { /* ignore */ }
    const lic = LICENSE_NAMES.map(n => path.join(root, n)).find(p => fs.existsSync(p));
    const text = lic ? fs.readFileSync(lic, 'utf8').trim() : `License: ${pkg.license || 'unknown'} (no license file in package)`;
    sections.push(`${pkg.name || path.basename(root)} ${pkg.version || ''}\n${pkg.license ? `License: ${pkg.license}\n` : ''}\n${text}`);
  }
  for (const e of extra)
    sections.push(e);
  if (!sections.length)
    return null;
  return 'Third-party software bundled in this file\n' + '='.repeat(42) + '\n\n' + sections.join('\n\n' + '-'.repeat(72) + '\n\n') + '\n';
}
