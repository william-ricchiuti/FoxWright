// Unit test for the built-in PDF text extractor (src/background/pdftext.js), no browser needed:
//   node test/pdf-text.mjs                 the fixtures in test/fixtures/pdf
//   node test/pdf-text.mjs file.pdf ...    print what it extracts from other PDFs
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { extractPdfText, PdfError } from '../src/background/pdftext.js';

const dir = path.join(path.dirname(fileURLToPath(import.meta.url)), 'fixtures', 'pdf');

if (process.argv.length > 2) {
  for (const f of process.argv.slice(2)) {
    const t0 = Date.now();
    try {
      const r = await extractPdfText(fs.readFileSync(f));
      const all = r.pages.join('\n\n');
      console.log(`== ${f}: ${r.pageCount} pages, ${all.length} chars, ${r.undecoded}/${r.glyphs} undecoded glyphs, ${Date.now() - t0} ms\n${all.slice(0, 1500)}\n…`);
    } catch (e) {
      console.log(`== ${f}: ${e instanceof PdfError ? e.code : 'ERROR'}: ${e.message}`);
    }
  }
  process.exit(0);
}

let failed = 0;
async function check(name, fn) {
  try {
    await fn();
    console.log(`  ✓ ${name}`);
  } catch (e) {
    failed++;
    console.log(`  ✗ ${name}\n      ${String(e.message).split('\n').join('\n      ')}`);
  }
}
const expect = (c, m) => {
  if (!c)
    throw new Error(m);
};
const read = (f) => extractPdfText(fs.readFileSync(path.join(dir, f)));

console.log('PDF text extractor');
await check('simple.pdf: lines, WinAnsi accents and quotes', async () => {
  const r = await read('simple.pdf');
  const t = r.pages.join('\n');
  expect(r.pageCount === 1, `pages: ${r.pageCount}`);
  expect(t.includes('Foxwright PDF fixture: simple\n'), t);
  expect(t.includes('The quick brown fox jumps over the lazy dog.\nA second line with a café and “quotes”.'), t);
  expect(/Least Concern/.test(t), t);
});
await check('multipage.pdf: Type0 + ToUnicode, TJ gaps, columns, form XObject', async () => {
  const r = await read('multipage.pdf');
  expect(r.pageCount === 3, `pages: ${r.pageCount}`);
  const [p1, p2, p3] = r.pages;
  expect(p1.startsWith('Page one of the multipage fixture\n'), p1);
  expect(p1.includes('Red foxes live on every continent except Antarctica.'), p1);
  expect(p1.includes('Unicode: naïve – “ok” ✓ 日本'), p1);
  expect(/Left column\s+Right column/.test(p1), p1);
  expect(p2.includes('Words separated by gaps, and Well-kerned text.'), p2);
  expect(p2.includes('Population estimate: 4,500 foxes.'), p2);
  expect(p3.includes('Third page heading') && p3.includes('Text inside a form XObject.\nIts second line.'), p3);
});
await check('objstm.pdf: object streams, XRef stream, /Differences ligatures', async () => {
  const r = await read('objstm.pdf');
  const t = r.pages.join('\n');
  expect(t.includes('Object stream fixture'), t);
  expect(t.includes('The first flag – a déjà vu moment.'), t);
});
await check('encrypted.pdf is refused clearly', async () => {
  try {
    await read('encrypted.pdf');
    throw new Error('no error');
  } catch (e) {
    expect(e instanceof PdfError && e.code === 'encrypted', `${e.code}: ${e.message}`);
  }
});
await check('image-only.pdf says there is no text layer', async () => {
  try {
    await read('image-only.pdf');
    throw new Error('no error');
  } catch (e) {
    expect(e instanceof PdfError && e.code === 'images' && /no text layer/.test(e.message), `${e.code}: ${e.message}`);
  }
});
await check('not a PDF', async () => {
  try {
    await extractPdfText(new TextEncoder().encode('<html>login</html>'));
    throw new Error('no error');
  } catch (e) {
    expect(e instanceof PdfError && e.code === 'invalid', `${e.code}: ${e.message}`);
  }
});
console.log(failed ? `${failed} failed` : 'all passed');
process.exit(failed ? 1 : 0);
