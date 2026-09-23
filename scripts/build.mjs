// Builds the Kitsune extension into dist/store and dist/full.
//
//   store: for addons.mozilla.org (listed). No arbitrary-JavaScript tool, per AMO policy §4.
//   full:  self-distributed (AMO "unlisted" signing). Adds the javascript_tool.
//
// Usage: node scripts/build.mjs [--zip] [--target=store|full]
import * as esbuild from 'esbuild';
import fs from 'node:fs';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const zip = args.includes('--zip');
const only = args.find(a => a.startsWith('--target='))?.split('=')[1];

export const TARGETS = {
  store: { id: 'kitsune@william-ricchiuti.com', name: 'Kitsune', full: false },
  full: { id: 'kitsune-full@william-ricchiuti.com', name: 'Kitsune (Full)', full: true },
};

const alias = { '@isomorphic': path.join(root, 'vendor/playwright/isomorphic') };

// Small, documented patches applied to the vendored Playwright code at build time
// (the files in vendor/ stay byte-identical to upstream). See vendor/playwright/README.md.
const PATCHES = [
  {
    file: 'vendor/playwright/injected/roleUtils.ts',
    find: 'function computeAriaRole(element: Element): AriaRole | null {\n  const explicitRole = getExplicitAriaRole(element);\n  if (!explicitRole)\n    return getImplicitAriaRole(element);',
    replace: 'function computeAriaRole(element: Element): AriaRole | null {\n  const explicitRole = getExplicitAriaRole(element);\n  // [kitsune patch] expose contenteditable roots as textboxes, as Firefox/Chrome accessibility trees do.\n  if (!explicitRole && (element as HTMLElement).isContentEditable && !(element.parentElement as HTMLElement | null)?.isContentEditable)\n    return \'textbox\';\n  if (!explicitRole)\n    return getImplicitAriaRole(element);',
  },
];

const patchPlugin = {
  name: 'kitsune-vendor-patches',
  setup(build) {
    build.onLoad({ filter: /vendor[\\/]playwright[\\/].*\.ts$/ }, async (args) => {
      let src = fs.readFileSync(args.path, 'utf8');
      for (const p of PATCHES) {
        if (args.path.endsWith(p.file.split('/').join(path.sep))) {
          if (!src.includes(p.find))
            throw new Error(`Vendored patch no longer applies to ${p.file}; update scripts/build.mjs`);
          src = src.replace(p.find, p.replace);
        }
      }
      return { contents: src, loader: 'ts' };
    });
  },
};

function copyDir(src, dst) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory())
      copyDir(s, d);
    else
      fs.copyFileSync(s, d);
  }
}

async function buildTarget(key) {
  const t = TARGETS[key];
  const out = path.join(root, 'dist', key);
  fs.rmSync(out, { recursive: true, force: true });
  copyDir(path.join(root, 'extension'), out);

  const common = {
    bundle: true,
    target: 'firefox128',
    legalComments: 'inline',
    minifySyntax: true, // drops dead `if (__KITSUNE_FULL__)` branches; names and whitespace stay readable
    logLevel: 'warning',
    alias,
    plugins: [patchPlugin],
    define: { __KITSUNE_FULL__: JSON.stringify(t.full), __KITSUNE_VERSION__: JSON.stringify(readVersion()) },
  };
  await esbuild.build({ ...common, entryPoints: [path.join(root, 'src/content/index.ts')], format: 'iife', outfile: path.join(out, 'content/content.js') });
  await esbuild.build({ ...common, entryPoints: [path.join(root, 'src/content/page-hooks.ts')], format: 'iife', outfile: path.join(out, 'content/page-hooks.js') });
  await esbuild.build({ ...common, entryPoints: [path.join(root, 'src/background/index.js')], format: 'iife', outfile: path.join(out, 'background.js') });

  const manifestPath = path.join(out, 'manifest.json');
  const m = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  m.name = t.name;
  m.version = readVersion();
  m.browser_specific_settings.gecko.id = t.id;
  if (t.full)
    m.description = m.description + ' This self-distributed build also lets the agent run custom JavaScript in pages.';
  fs.writeFileSync(manifestPath, JSON.stringify(m, null, 2) + '\n');

  if (zip) {
    const zipDir = path.join(root, 'dist', 'zips');
    fs.mkdirSync(zipDir, { recursive: true });
    execFileSync(path.join(root, 'node_modules/.bin/web-ext'), ['build', '--source-dir', out, '--artifacts-dir', zipDir, '--filename', `kitsune-${key}-${m.version}.zip`, '--overwrite-dest'], { stdio: 'inherit' });
  }
  console.log(`built ${key} -> ${path.relative(root, out)}`);
}

function readVersion() {
  return JSON.parse(fs.readFileSync(path.join(root, 'package.json'), 'utf8')).version;
}

for (const key of Object.keys(TARGETS)) {
  if (!only || only === key)
    await buildTarget(key);
}
