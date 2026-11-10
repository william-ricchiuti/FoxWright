# Vendored Playwright aria-snapshot code

These files are copied unmodified from [microsoft/playwright](https://github.com/microsoft/playwright)
at commit `9234738fbcb7da3bd0fd2b5478f6fbcf69de3358` (2026-09-23), under the Apache License 2.0
(see `LICENSE` and `NOTICE` in this folder).

| Here | Upstream |
|---|---|
| `injected/*.ts` | `packages/injected/src/*.ts` |
| `isomorphic/*.ts` | `packages/isomorphic/*.ts` |

They compute the WAI-ARIA role / accessible name tree of a page entirely in JavaScript
(no CDP), which is what Zenko's `read_page` returns. Zenko's own entry point is
`src/content/snapshot.ts`; the files are bundled into `extension/content/content.js` by
`scripts/build.mjs` (esbuild). To update: copy the same files from a newer Playwright commit
and update the hash above.

## Build-time patches

`scripts/build.mjs` applies small patches while bundling. The files here stay byte-identical
to upstream (for easy updates); the shipped build is the modified version, which the root
`NOTICE` states as Apache-2.0 §4(b) requires.

- `injected/roleUtils.ts`, `computeAriaRole`: a `contenteditable` root element with no
  explicit role is reported as `textbox` (matching Firefox's and Chrome's accessibility
  trees), so rich-text editors like ProseMirror/Lexical/Slate get a ref and can be targeted.
- `injected/ariaSnapshot.ts`: password fields show `(password, N characters)` instead of
  their value, so saved logins that Firefox autofills are never sent to the agent.
- `injected/ariaSnapshot.ts` and `injected/roleUtils.ts`: shadow roots are read through
  `openOrClosedShadowRoot` (available to Firefox content scripts), so web components with
  closed shadow roots appear in the outline.

If an upstream change makes a patch stop applying, the build fails with a message naming the file.
