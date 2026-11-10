// Bundles the CLI (helper + MCP server + setup) into one dependency-free file.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import { thirdPartyNotices } from '../scripts/licenses.mjs';
const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url)));
const result = await esbuild.build({
  metafile: true,
  entryPoints: ['src/cli.js'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/zenko.mjs',
  external: ['bufferutil', 'utf-8-validate'],
  legalComments: 'inline',
  define: { __ZENKO_BUNDLED__: 'true', __ZENKO_VERSION__: JSON.stringify(pkg.version) },
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __zenkoCreateRequire } from 'node:module';\nconst require = __zenkoCreateRequire(import.meta.url);" },
  logLevel: 'warning',
});
fs.chmodSync('dist/zenko.mjs', 0o755);
// MIT/ISC/Apache licenses of the bundled packages must ship with the bundle.
fs.writeFileSync('dist/THIRD-PARTY-NOTICES.txt', thirdPartyNotices(result.metafile, process.cwd()) || 'No third-party code bundled.\n');
console.log('built dist/zenko.mjs', (fs.statSync('dist/zenko.mjs').size / 1024).toFixed(0) + ' KB');
