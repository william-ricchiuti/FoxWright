// Bundles the CLI (helper + MCP server + setup) into one dependency-free file.
import * as esbuild from 'esbuild';
import fs from 'node:fs';
const pkg = JSON.parse(fs.readFileSync(new URL('./package.json', import.meta.url)));
await esbuild.build({
  entryPoints: ['src/cli.js'],
  bundle: true,
  platform: 'node',
  format: 'esm',
  target: 'node20',
  outfile: 'dist/kitsune.mjs',
  external: ['bufferutil', 'utf-8-validate'],
  legalComments: 'inline',
  define: { __KITSUNE_BUNDLED__: 'true', __KITSUNE_VERSION__: JSON.stringify(pkg.version) },
  banner: { js: "#!/usr/bin/env node\nimport { createRequire as __kitsuneCreateRequire } from 'node:module';\nconst require = __kitsuneCreateRequire(import.meta.url);" },
  logLevel: 'warning',
});
fs.chmodSync('dist/kitsune.mjs', 0o755);
console.log('built dist/kitsune.mjs', (fs.statSync('dist/kitsune.mjs').size / 1024).toFixed(0) + ' KB');
