// Builds the Zenko extension into dist/store and dist/full.
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
import { thirdPartyNotices } from './licenses.mjs';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const zip = args.includes('--zip');
const only = args.find(a => a.startsWith('--target='))?.split('=')[1];

export const TARGETS = {
  store: { id: 'kitsune@william-ricchiuti.com', name: 'Zenko', full: false },
  full: { id: 'kitsune-full@william-ricchiuti.com', name: 'Zenko (Full)', full: true },
};

const alias = { '@isomorphic': path.join(root, 'vendor/playwright/isomorphic') };

// Small, documented patches applied to the vendored Playwright code at build time
// (the files in vendor/ stay byte-identical to upstream). See vendor/playwright/README.md.
const PATCHES = [
  {
    file: 'vendor/playwright/injected/roleUtils.ts',
    find: 'function computeAriaRole(element: Element): AriaRole | null {\n  const explicitRole = getExplicitAriaRole(element);\n  if (!explicitRole)\n    return getImplicitAriaRole(element);',
    replace: 'function computeAriaRole(element: Element): AriaRole | null {\n  const explicitRole = getExplicitAriaRole(element);\n  // [zenko patch] expose contenteditable roots as textboxes, as Firefox/Chrome accessibility trees do.\n  if (!explicitRole && (element as HTMLElement).isContentEditable && !(element.parentElement as HTMLElement | null)?.isContentEditable)\n    return \'textbox\';\n  if (!explicitRole)\n    return getImplicitAriaRole(element);',
  },
  {
    file: 'vendor/playwright/injected/ariaSnapshot.ts',
    find: "if (element.type !== 'checkbox' && element.type !== 'radio' && element.type !== 'file')\n      result.children = [element.value];",
    replace: "if (element.type !== 'checkbox' && element.type !== 'radio' && element.type !== 'file')\n      // [zenko patch] never show password values to the agent (Firefox autofills saved logins into the DOM).\n      result.children = [element.type === 'password' ? (element.value ? `(password, ${element.value.length} characters)` : '') : element.value];",
  },
  // [zenko patch] see closed shadow roots too. Firefox gives content scripts `openOrClosedShadowRoot`.
  ...['ariaSnapshot.ts', 'roleUtils.ts'].map(f => ({
    file: `vendor/playwright/injected/${f}`,
    find: /if \(element\.shadowRoot\) \{\n(\s*)for \(let child = element\.shadowRoot\.firstChild;/,
    replace: 'if (zenkoShadowRoot(element)) {\n$1for (let child = zenkoShadowRoot(element)!.firstChild;',
    append: '\n// [zenko patch]\nfunction zenkoShadowRoot(e: Element): ShadowRoot | null {\n  return (e as any).openOrClosedShadowRoot ?? e.shadowRoot;\n}\n',
  })),
];

const patchPlugin = {
  name: 'zenko-vendor-patches',
  setup(build) {
    build.onLoad({ filter: /vendor[\\/]playwright[\\/].*\.ts$/ }, async (args) => {
      let src = fs.readFileSync(args.path, 'utf8');
      for (const p of PATCHES) {
        if (args.path.endsWith(p.file.split('/').join(path.sep))) {
          const applies = typeof p.find === 'string' ? src.includes(p.find) : p.find.test(src);
          if (!applies)
            throw new Error(`Vendored patch no longer applies to ${p.file}; update scripts/build.mjs`);
          src = src.replace(p.find, p.replace) + (p.append || '');
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
    minifySyntax: true, // drops dead `if (__ZENKO_FULL__)` branches; names and whitespace stay readable
    logLevel: 'warning',
    alias,
    plugins: [patchPlugin],
    define: { __ZENKO_FULL__: JSON.stringify(t.full), __ZENKO_VERSION__: JSON.stringify(readVersion()) },
  };
  const inputs = {};
  for (const [entry, outfile] of [['src/content/index.ts', 'content/content.js'], ['src/content/hooks.ts', 'content/hooks.js'], ['src/content/page-hooks.ts', 'content/page-hooks.js'], ['src/background/index.js', 'background.js']]) {
    const r = await esbuild.build({ ...common, metafile: true, entryPoints: [path.join(root, entry)], format: 'iife', outfile: path.join(out, outfile) });
    Object.assign(inputs, r.metafile.inputs);
  }

  // License files the shipped add-on must carry: Zenko's own, and Playwright's (Apache-2.0 §4),
  // plus any npm packages that got bundled.
  fs.copyFileSync(path.join(root, 'LICENSE'), path.join(out, 'LICENSE'));
  fs.copyFileSync(path.join(root, 'NOTICE'), path.join(out, 'NOTICE'));
  const playwright = `Playwright (vendored, modified at build time; see NOTICE)\nLicense: Apache-2.0\n\n${fs.readFileSync(path.join(root, 'vendor/playwright/NOTICE'), 'utf8').trim()}\n\n${fs.readFileSync(path.join(root, 'vendor/playwright/LICENSE'), 'utf8').trim()}`;
  fs.writeFileSync(path.join(out, 'THIRD-PARTY-NOTICES.txt'), thirdPartyNotices({ inputs }, root, [playwright]));

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
    // Remove zips of other versions, so an old one can't be uploaded by mistake.
    for (const f of fs.readdirSync(zipDir)) {
      if (f.startsWith(`zenko-${key}-`) && f !== `zenko-${key}-${m.version}.zip`)
        fs.rmSync(path.join(zipDir, f));
    }
    execFileSync(path.join(root, 'node_modules/.bin/web-ext'), ['build', '--source-dir', out, '--artifacts-dir', zipDir, '--filename', `zenko-${key}-${m.version}.zip`, '--overwrite-dest'], { stdio: 'inherit' });
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
