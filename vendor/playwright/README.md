# Vendored Playwright aria-snapshot code

These files are copied unmodified from [microsoft/playwright](https://github.com/microsoft/playwright)
at commit `9234738fbcb7da3bd0fd2b5478f6fbcf69de3358` (2026-09-23), under the Apache License 2.0
(see `LICENSE` and `NOTICE` in this folder).

| Here | Upstream |
|---|---|
| `injected/*.ts` | `packages/injected/src/*.ts` |
| `isomorphic/*.ts` | `packages/isomorphic/*.ts` |

They compute the WAI-ARIA role / accessible name tree of a page entirely in JavaScript
(no CDP), which is what Kitsune's `read_page` returns. Kitsune's own entry point is
`src/content/snapshot.ts`; the files are bundled into `extension/content/content.js` by
`scripts/build.mjs` (esbuild). To update: copy the same files from a newer Playwright commit
and update the hash above.

## Build-time patch

`scripts/build.mjs` applies one small patch while bundling (the files here stay
byte-identical to upstream, as required for easy updates and Apache-2.0 §4(b) notice):

- `injected/roleUtils.ts`, `computeAriaRole`: a `contenteditable` root element with no
  explicit role is reported as `textbox` (matching Firefox's and Chrome's accessibility
  trees), so rich-text editors like ProseMirror/Lexical/Slate get a ref and can be targeted.
