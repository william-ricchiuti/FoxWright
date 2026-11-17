// Hostile-input tests and a bounded fuzzer for the built-in PDF text extractor
// (src/background/pdftext.js). The extractor parses untrusted files inside the extension's
// background page, so whatever it is given it must: finish within its time limit, never block the
// event loop for long, keep memory bounded, and fail only with a PdfError.
//
//   node test/pdf-fuzz.mjs                       hostile cases + 15 s of mutation fuzzing
//   node test/pdf-fuzz.mjs --seconds 120         fuzz longer
//   node test/pdf-fuzz.mjs --seed 1234           reproduce a run (the seed is printed)
//   node test/pdf-fuzz.mjs --only bfrange        only hostile cases whose name contains this
//   node test/pdf-fuzz.mjs --save /tmp/dir       keep the inputs that failed
//   node test/pdf-fuzz.mjs --no-fuzz             hostile cases only
//
// Each input runs in a worker thread: if it hangs, the worker is killed and that counts as a failure.
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';
import { Worker, isMainThread, parentPort } from 'node:worker_threads';

const TIME_LIMIT_MS = 4000; // the extractor's own limit in these tests (20 s in the extension)
const SLACK_MS = 3000; // how much later than its limit it may return (slow CI machines)
const MAX_BLOCK_MS = 2500; // longest it may keep the event loop busy in one go
const HARD_TIMEOUT_MS = 30000; // after this the worker is killed: a hang
const MAX_MEMORY_MB = 1400; // heap + array buffers, sampled

// ---------- worker: run one input, report what happened ----------

if (!isMainThread) {
  const { extractPdfText, PdfError } = await import('../src/background/pdftext.js');
  let gc = () => {};
  try {
    (await import('node:v8')).setFlagsFromString('--expose-gc');
    gc = (await import('node:vm')).runInNewContext('gc');
  } catch { /* memory readings then include what earlier inputs left behind */ }
  parentPort.on('message', async ({ id, bytes }) => {
    gc(); // what an earlier input left behind doesn't count
    let last = performance.now(), maxBlock = 0, peak = 0;
    const sample = () => {
      const now = performance.now();
      maxBlock = Math.max(maxBlock, now - last);
      last = now;
      const m = process.memoryUsage();
      peak = Math.max(peak, (m.heapUsed + m.arrayBuffers) / 1048576);
    };
    const timer = setInterval(sample, 10);
    const t0 = performance.now();
    const out = { id };
    try {
      const r = await extractPdfText(bytes, { timeMs: TIME_LIMIT_MS });
      out.ok = true;
      out.chars = r.pages.reduce((n, p) => n + p.length, 0);
      out.text = r.pages.join('\n').slice(0, 400);
      out.truncated = !!r.truncated;
      out.stopped = r.stopped || '';
    } catch (e) {
      out.ok = false;
      out.pdfError = e instanceof PdfError;
      out.code = e?.code;
      out.message = String(e?.message || e).slice(0, 300);
    }
    sample();
    clearInterval(timer);
    out.ms = Math.round(performance.now() - t0);
    out.maxBlock = Math.round(maxBlock);
    out.peakMb = Math.round(peak);
    parentPort.postMessage(out);
  });
}

// ---------- building PDFs ----------

const B = (s) => (Buffer.isBuffer(s) ? s : Buffer.from(s, 'latin1'));
const deflate = (data) => zlib.deflateSync(B(data), { level: 1 });

/** A stream object body: dict entries (without << >>) and the data as stored in the file. */
function stream(dict, data, { length = true, end = true } = {}) {
  const d = B(data);
  return Buffer.concat([B(`<<${dict}${length ? ` /Length ${d.length}` : ''}>>\nstream\n`), d, B(end ? '\nendstream' : '\n')]);
}

/** objs: [[num, body], ...] -> a PDF file (with a classic xref table that the extractor ignores). */
function pdf(objs, { trailer = '/Root 1 0 R', header = '%PDF-1.7\n%\xE2\xE3\xCF\xD3\n' } = {}) {
  const parts = [B(header)];
  for (const [num, body] of objs)
    parts.push(B(`${num} 0 obj\n`), B(body), B('\nendobj\n'));
  parts.push(B(`trailer\n<<${trailer} /Size ${objs.length + 1}>>\nstartxref\n0\n%%EOF\n`));
  return Buffer.concat(parts);
}

const FONT = '<</Type/Font/Subtype/Type1/BaseFont/Helvetica/Encoding/WinAnsiEncoding>>';
const CANARY = 'BT /F1 12 Tf 72 700 Td (CANARY TEXT) Tj ET';

/** One page with the given content stream object (a body), a font, and optional extra objects. */
function onePage(contentBody, { font = FONT, extra = [], resources = '/Font<</F1 5 0 R>>', canaryPage = false, want } = {}) {
  const objs = [
    [1, '<</Type/Catalog/Pages 2 0 R>>'],
    [2, `<</Type/Pages/Kids[3 0 R${canaryPage ? ' 90 0 R' : ''}]/Count ${canaryPage ? 2 : 1}>>`],
    [3, `<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 4 0 R/Resources<<${resources}>>>>`],
    [4, contentBody],
    [5, font],
    ...extra,
  ];
  if (canaryPage) {
    objs.push([90, '<</Type/Page/Parent 2 0 R/MediaBox[0 0 612 792]/Contents 91 0 R/Resources<</Font<</F1 92 0 R>>>>>>']);
    objs.push([91, stream('', CANARY)]);
    objs.push([92, FONT]);
  }
  const out = pdf(objs);
  if (want)
    out.want = want;
  return out;
}

const flateContent = (content, parms = '') => stream(`/Filter/FlateDecode${parms}`, deflate(content));

/** Pack LZW codes the way the extractor's decoder reads them (MSB first, 9 to 12 bits, early change). */
function lzwPack(codes) {
  const out = [];
  let buf = 0, n = 0, bits = 9, dict = 258, prev = false;
  for (const c of codes) {
    buf = (buf << bits) | c;
    n += bits;
    while (n >= 8) {
      out.push((buf >>> (n - 8)) & 255);
      n -= 8;
    }
    buf &= (1 << n) - 1;
    if (prev)
      dict++;
    prev = true;
    if (dict + 1 >= (1 << bits) && bits < 12)
      bits++;
  }
  if (n)
    out.push((buf << (8 - n)) & 255);
  return Buffer.from(out);
}

function cmap(body) {
  return `/CIDInit /ProcSet findresource begin 12 dict begin begincmap /CMapName /X def /CMapType 2 def\n${body}\nendcmap CMapName currentdict /CMap defineresource pop end end`;
}
const TYPE0 = (extra = '') => `<</Type/Font/Subtype/Type0/BaseFont/X/Encoding/Identity-H/DescendantFonts[<</Type/Font/Subtype/CIDFontType2/BaseFont/X/DW 1000${extra}>>]/ToUnicode 6 0 R>>`;

const big = (n) => '9'.repeat(n);

/** Hostile inputs. want: 'canary' = the text of the harmless second page must still come out. */
const HOSTILE = {
  'predictor 2 with /Columns 0': () => onePage(flateContent(CANARY, '/DecodeParms<</Predictor 2/Columns 0>>')),
  'predictor 2 with negative /Columns': () => onePage(flateContent(CANARY, '/DecodeParms<</Predictor 2/Columns -7/Colors 3>>')),
  'PNG predictor with huge /Columns': () => onePage(flateContent(CANARY, '/DecodeParms<</Predictor 15/Columns 2000000000/Colors 4/BitsPerComponent 16>>'), { canaryPage: true, want: 'canary' }),
  'PNG predictor with /Columns 0 and NaN-ish parms': () => onePage(flateContent(CANARY, `/DecodeParms<</Predictor 12/Columns 0/Colors ${big(400)}/BitsPerComponent -${big(400)}>>`)),
  'bfrange whose codes are too big to count (float stall)': () => onePage(stream('', 'BT /F1 12 Tf (A) Tj ET'), {
    font: TYPE0(),
    extra: [[6, stream('', cmap('1 begincodespacerange <00> <FF> endcodespacerange\n1 beginbfrange\n<1000000000000000> <1000000000000800> <0041>\nendbfrange'))]],
    canaryPage: true,
  }),
  'bfrange array form with huge codes': () => onePage(stream('', 'BT /F1 12 Tf (A) Tj ET'), {
    font: TYPE0(),
    extra: [[6, stream('', cmap('1 beginbfrange\n<1000000000000000> <1000000000000800> [<0041>]\nendbfrange'))]],
    canaryPage: true,
  }),
  'Type0 /W range with huge codes (float stall)': () => onePage(stream('', 'BT /F1 12 Tf (A) Tj ET'), {
    font: TYPE0('/W[1152921504606846976 1152921504606847999 500]'),
    extra: [[6, stream('', cmap('1 beginbfchar <0041> <0041> endbfchar'))]],
    canaryPage: true,
  }),
  'Type0 /W with a million full ranges': () => onePage(stream('', 'BT /F1 12 Tf (A) Tj ET'), {
    font: TYPE0(`/W[${'0 65535 500 '.repeat(1000000)}]`),
    extra: [[6, stream('', cmap('1 beginbfchar <0041> <0041> endbfchar'))]],
    canaryPage: true,
  }),
  'ToUnicode with 30,000 full bfranges': () => onePage(stream('', 'BT /F1 12 Tf (A) Tj ET'), {
    font: TYPE0(),
    extra: [[6, flateContent(cmap(`1 begincodespacerange <0000> <FFFF> endcodespacerange\n30000 beginbfrange\n${'<0000> <FFFF> <0041>\n'.repeat(30000)}endbfrange`))]],
    canaryPage: true,
  }),
  'ToUnicode entry that maps one code to a megabyte, drawn a million times': () => onePage(flateContent(`BT /F1 12 Tf (${'\x01'.repeat(1000000)}) Tj ET`), {
    font: '<</Type/Font/Subtype/Type1/BaseFont/X/ToUnicode 6 0 R>>',
    extra: [[6, flateContent(cmap(`1 begincodespacerange <00> <FF> endcodespacerange\n1 beginbfchar <01> <${'0041'.repeat(500000)}> endbfchar`))]],
  }),
  '200,000 codespace ranges and a 2 MB string': () => onePage(flateContent(`BT /F1 12 Tf (${'AB'.repeat(1000000)}) Tj ET`), {
    font: '<</Type/Font/Subtype/Type1/BaseFont/X/ToUnicode 6 0 R>>',
    extra: [[6, flateContent(cmap(`200000 begincodespacerange\n${'<7A> <7B>\n'.repeat(200000)}endcodespacerange\n1 beginbfchar <41> <0041> endbfchar`))]],
  }),
  'a 20 MB string shown with a 4-byte codespace': () => onePage(flateContent(`BT /F1 12 Tf (${'ABCD'.repeat(5000000)}) Tj ET`), {
    font: TYPE0(),
    extra: [[6, stream('', cmap('1 begincodespacerange <00000000> <FFFFFFFF> endcodespacerange\n1 beginbfchar <41424344> <0041> endbfchar'))]],
  }),
  'Flate bomb as page content (400 MB)': () => onePage(stream('/Filter/FlateDecode', deflate(Buffer.alloc(400 * 1048576, 32))), { canaryPage: true }),
  'Flate bombs in 300 object streams (100 MB each)': () => {
    const bomb = deflate(Buffer.alloc(100 * 1048576, 32));
    const objs = [[1, '<</Type/Catalog/Pages 2 0 R>>'], [2, '<</Type/Pages/Kids[3 0 R]/Count 1>>'], [3, '<</Type/Page/Parent 2 0 R/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>'], [4, stream('', CANARY)], [5, FONT]];
    for (let i = 0; i < 300; i++)
      objs.push([100 + i, stream('/Type/ObjStm/N 1/First 10/Filter/FlateDecode', bomb)]);
    return pdf(objs);
  },
  'a file over the size limit': () => Buffer.concat([B('%PDF-1.7\n'), Buffer.alloc(101 * 1048576, 32)]),
  'Flate bombs drawn as 2000 form XObjects': () => {
    const bomb = zlib.deflateSync(Buffer.alloc(60 * 1048576, 32), { level: 9 });
    const objs = [[1, '<</Type/Catalog/Pages 2 0 R>>'], [2, '<</Type/Pages/Kids[3 0 R]/Count 1>>'], [5, FONT]];
    const names = [];
    for (let i = 0; i < 2000; i++) {
      objs.push([100 + i, stream('/Type/XObject/Subtype/Form/BBox[0 0 1 1]/Filter/FlateDecode', bomb)]);
      names.push(`/X${i} ${100 + i} 0 R`);
    }
    objs.push([3, `<</Type/Page/Parent 2 0 R/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>/XObject<<${names.join(' ')}>>>>>>`]);
    objs.push([4, stream('', names.map((n, i) => `/X${i} Do`).join(' '))]);
    return pdf(objs);
  },
  'LZW bomb (codes that each repeat the longest entry)': () => {
    const codes = [32];
    for (let i = 0; i < 3800; i++)
      codes.push(258 + i); // each is the entry being defined: one byte longer every time
    for (let i = 0; i < 4000000; i++)
      codes.push(4000);
    return onePage(stream('/Filter/LZWDecode', lzwPack(codes)), { canaryPage: true });
  },
  'LZW without a clear code for 8 million codes': () => {
    const codes = [];
    for (let i = 0; i < 8000000; i++)
      codes.push(i % 251);
    return onePage(stream('/Filter/LZWDecode', lzwPack(codes)), { canaryPage: true });
  },
  'RunLength bomb (30 MB to 1.9 GB)': () => {
    const b = Buffer.alloc(30 * 1048576);
    for (let i = 0; i < b.length; i += 2) {
      b[i] = 129;
      b[i + 1] = 32;
    }
    return onePage(stream('/Filter/RunLengthDecode', b), { canaryPage: true });
  },
  'ASCII85 "z" bomb (30 MB)': () => onePage(stream('/Filter/ASCII85Decode', Buffer.alloc(30 * 1048576, 122)), { canaryPage: true }),
  'ASCIIHex stream of 40 MB': () => onePage(stream('/Filter/ASCIIHexDecode', Buffer.alloc(40 * 1048576, 0x32)), { canaryPage: true }),
  'chained filters still decode': () => {
    const flate = deflate(CANARY);
    let a85 = '';
    for (let i = 0; i < flate.length; i += 4) {
      const chunk = Buffer.alloc(4);
      const n = Math.min(4, flate.length - i);
      flate.copy(chunk, 0, i, i + n);
      let v = chunk.readUInt32BE(0);
      const five = [];
      for (let k = 0; k < 5; k++) {
        five.unshift(String.fromCharCode(33 + (v % 85)));
        v = Math.floor(v / 85);
      }
      a85 += five.slice(0, n + 1).join('');
    }
    a85 += '~>';
    const hex = Buffer.from(a85, 'latin1').toString('hex') + '>';
    return { bytes: onePage(stream('/Filter[/ASCIIHexDecode/ASCII85Decode/FlateDecode]', hex)), want: 'canary' };
  },
  'two million nested arrays in page content': () => onePage(flateContent('['.repeat(2000000)), { canaryPage: true, want: 'canary' }),
  'two million nested arrays in an object': () => pdf([[1, '<</Type/Catalog/Pages 2 0 R>>'], [7, '['.repeat(2000000)], [2, '<</Type/Pages/Kids[3 0 R]/Count 1>>'], [3, '<</Type/Page/Parent 2 0 R/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>'], [4, stream('', CANARY)], [5, FONT]]),
  'half a million nested dictionaries': () => onePage(flateContent('<</A'.repeat(500000)), { canaryPage: true, want: 'canary' }),
  'three million stray ")" in page content': () => onePage(flateContent(')'.repeat(3000000) + ' ' + CANARY), { want: 'canary' }),
  '400,000 streams without endstream': () => {
    const parts = [B('%PDF-1.7\n')];
    for (let i = 0; i < 400000; i++)
      parts.push(B(`${i + 10} 0 obj<</Type/ObjStm/N 0/First 0>>stream\nxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n`));
    parts.push(B('trailer<</Root 1 0 R>>'));
    return Buffer.concat(parts);
  },
  '400,000 streams sharing one far-away endstream': () => {
    const parts = [B('%PDF-1.7\n')];
    for (let i = 0; i < 400000; i++)
      parts.push(B(`${i + 10} 0 obj<</Length 99999999>>stream\nxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxxx\n`));
    parts.push(B('endstream endobj trailer<</Root 1 0 R>>'));
    return Buffer.concat(parts);
  },
  'three million tiny objects': () => {
    const parts = [B('%PDF-1.7\n')];
    const chunk = [];
    for (let i = 0; i < 3000000; i++) {
      chunk.push(`${i + 10} 0 obj 1 endobj\n`);
      if (chunk.length === 100000)
        parts.push(B(chunk.splice(0).join('')));
    }
    parts.push(B('1 0 obj<</Type/Catalog/Pages 2 0 R>>endobj 2 0 obj<</Type/Pages/Kids[]>>endobj trailer<</Root 1 0 R>>'));
    return Buffer.concat(parts);
  },
  'page tree with two million links to one page': () => pdf([[1, '<</Type/Catalog/Pages 2 0 R>>'], [2, `<</Type/Pages/Kids[${'3 0 R '.repeat(2000000)}]>>`], [3, '<</Type/Page/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>'], [4, stream('', CANARY)], [5, FONT]]),
  '150,000 pages that share one 300 KB content stream': () => {
    const objs = [[1, '<</Type/Catalog/Pages 2 0 R>>'], [4, flateContent('q 1 0 0 1 0 0 cm Q '.repeat(15000))], [5, FONT]];
    const kids = [];
    for (let i = 0; i < 150000; i++) {
      objs.push([10 + i, '<</Type/Page/Contents 4 0 R>>']);
      kids.push(`${10 + i} 0 R`);
    }
    objs.push([2, `<</Type/Pages/Kids[${kids.join(' ')}]>>`]);
    return pdf(objs);
  },
  'a page whose /Contents lists one stream 200,000 times': () => onePage(flateContent(`${CANARY} `.repeat(2000)), { resources: '/Font<</F1 5 0 R>>', extra: [[3, `<</Type/Page/Parent 2 0 R/Contents[${'4 0 R '.repeat(200000)}]/Resources<</Font<</F1 5 0 R>>>>>>`]] }),
  'cyclic page tree and self-referencing objects': () => pdf([
    [1, '<</Type/Catalog/Pages 2 0 R>>'],
    [2, '<</Type/Pages/Kids[2 0 R 3 0 R 6 0 R 7 0 R]/Parent 2 0 R/Resources 2 0 R>>'],
    [3, '<</Type/Pages/Kids[2 0 R 3 0 R 8 0 R]>>'],
    [6, '6 0 R'],
    [7, '<</Type/Page/Contents 7 0 R/Resources 7 0 R>>'],
    [8, '<</Type/Page/Contents 9 0 R/Resources<</Font<</F1 5 0 R>>/XObject<</A 10 0 R/B 11 0 R>>>>>>'],
    [9, stream('/Length 9 0 R/Filter 9 0 R/DecodeParms 9 0 R', `${CANARY} /A Do /B Do`, { length: false })],
    [10, stream('/Type/XObject/Subtype/Form/Resources<</XObject<</B 11 0 R/A 10 0 R>>>>', '/B Do /A Do')],
    [11, stream('/Type/XObject/Subtype/Form/Resources 8 0 R', '/A Do /B Do')],
    [5, FONT],
  ]),
  'form XObjects that fan out 20 ways, 8 levels deep': () => {
    const objs = [[1, '<</Type/Catalog/Pages 2 0 R>>'], [2, '<</Type/Pages/Kids[3 0 R]/Count 1>>'], [3, '<</Type/Page/Parent 2 0 R/Contents 4 0 R/Resources<</XObject<</X 10 0 R>>>>>>'], [4, stream('', '/X Do '.repeat(20))], [5, FONT]];
    for (let i = 0; i < 8; i++)
      objs.push([10 + i, stream(`/Type/XObject/Subtype/Form/Resources<</XObject<</X ${11 + i} 0 R>>/Font<</F1 5 0 R>>>>`, i === 7 ? 'q Q' : '/X Do '.repeat(20))]);
    return pdf(objs);
  },
  '400,000 short text operations on one page': () => onePage(flateContent(`BT /F1 12 Tf 72 700 Td ${'(ab cd ) Tj '.repeat(400000)} ET`)),
  'megabytes of spaces between words': () => onePage(flateContent(`BT /F1 12 Tf 72 700 Td (a${' '.repeat(1500000)}b${' '.repeat(1500000)}c) Tj ET`)),
  'megabytes of trailing spaces before each new line': () => onePage(flateContent(`BT /F1 12 Tf 72 700 Td ${`(x${' '.repeat(3000)}) Tj 0 -14 Td `.repeat(900)} ET`)),
  'glyph name with an impossible code point': () => ({ bytes: onePage(stream('', 'BT /F1 12 Tf (A) Tj ET'), { font: '<</Type/Font/Subtype/Type1/BaseFont/X/Encoding<</Differences[65/uFFFFFF 66/uni 67/u110000]>>>>', canaryPage: true }), want: 'canary' }),
  'object stream with infinite offsets': () => pdf([[1, '<</Type/Catalog/Pages 2 0 R>>'], [2, '<</Type/Pages/Kids[3 0 R 20 0 R]/Count 1>>'], [3, '<</Type/Page/Parent 2 0 R/Contents 4 0 R/Resources<</Font<</F1 5 0 R>>>>>>'], [4, stream('', CANARY)], [5, FONT], [9, stream(`/Type/ObjStm/N ${big(400)}/First ${big(400)}`, `20 -${big(400)} 21 ${big(400)} 22 0.5 `)]]),
  'a 30 MB name and a 30 MB keyword': () => onePage(flateContent(`/${'A'.repeat(30000000)} ${'q'.repeat(30000000)} ${CANARY}`), { want: 'canary' }),
  'a 30 MB string full of escapes': () => onePage(flateContent(`BT /F1 12 Tf (${'\\(\\101\\n'.repeat(3500000)}) Tj ET`)),
  'a 40 MB hex string': () => onePage(flateContent(`BT /F1 12 Tf <${'41'.repeat(20000000)}> Tj ET`)),
  'half a million trailers and garbage': () => Buffer.concat([B('%PDF-1.4\n'), B('trailer<</Root 1 0 R/Size 1/Prev 1>>\n'.repeat(500000)), B('xref\n0 99999999999\n0000000000 65535 f \nstartxref\n999999999999\n%%EOF')]),
  'only a header and binary garbage': () => {
    const b = Buffer.alloc(8 * 1048576);
    let x = 12345;
    for (let i = 0; i < b.length; i++) {
      x = (x * 1103515245 + 12345) & 0x7fffffff;
      b[i] = x >>> 16;
    }
    b.write('%PDF-1.7\n', 0, 'latin1');
    return b;
  },
  'digits and spaces that look like the start of objects': () => Buffer.concat([B('%PDF-1.7\n'), B('1 '.repeat(8000000)), B(' '.repeat(8000000)), B('1 0 ob')]),
  'inline images that never end': () => onePage(flateContent(`${'BI /W 1 /H 1 ID '.repeat(200000)} ${CANARY}`)),
};

// ---------- mutation fuzzing ----------

function rng(seed) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6D2B79F5) >>> 0;
    let t = a;
    t = Math.imul(t ^ (t >>> 15), t | 1);
    t ^= t + Math.imul(t ^ (t >>> 7), t | 61);
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const TOKENS = ['/Columns 0', '/Columns -1', '/Predictor 2', '/Predictor 15', '/Colors 0', '/BitsPerComponent 0', '/Length 99999999999', '/Length -1', '/N 99999999', '/First -5', '/Count -1', '/Kids[2 0 R]', '/Kids[1 0 R 2 0 R 3 0 R 4 0 R]', '/Contents 3 0 R', '/Contents[4 0 R 4 0 R 4 0 R 4 0 R]', '/Filter/LZWDecode', '/Filter[/ASCII85Decode/FlateDecode]', '/Filter/RunLengthDecode', '/Filter/ASCIIHexDecode', '/Type/ObjStm', '/Type/XRef', '/Type/Page', '/Type/Pages', '/Subtype/Form', '/Subtype/Type0', '/ToUnicode 4 0 R', '/Encoding/Identity-H', '/Encoding<</Differences[0/uFFFFFF]>>', '/W[0 99999999 1]', '/W[1152921504606846976 1152921504606847999 1]', '/DW 1e99', '[[[[[[[[', ']]]]', '<<<<<<', '>>>>', '((((', '))))', '<FFFFFFFFFFFFFFFFFFFF>', 'endstream', 'stream\n', 'endobj', ' obj ', ' 0 R', ' R', 'BT', 'ET', 'Tj', 'TJ', 'Tf', 'Td', 'Tm', 'Do', 'BI', 'ID ', 'EI', 'q', 'Q', 'cm', "'", '"', 'trailer<<', 'beginbfrange', 'endbfrange', 'beginbfchar', 'begincodespacerange', '<0000> <FFFF> <0041>', '<00000000> <FFFFFFFF>', '%', '\\', '\n', '\r', '\0', '#', '/', '.', '-', '+', '99999999999999999999999999999999', '-99999999999999999999999999999999', '0.0000000000001', '1e', '65536', '4294967296', '2147483648', '-2147483649'];
const NUMBERS = ['0', '-1', '1', '2', '255', '256', '65535', '65536', '2147483647', '4294967296', '9007199254740993', '99999999999999999999', '-99999999999999999999', '0.5', '-0.5', big(320)];

function mutate(buf, r) {
  let b = Buffer.from(buf);
  const n = 1 + Math.floor(r() * 6);
  for (let k = 0; k < n && b.length > 20; k++) {
    const pos = Math.floor(r() * b.length);
    switch (Math.floor(r() * 9)) {
      case 0: // flip bytes
        for (let i = 0; i < 1 + r() * 8; i++)
          b[Math.floor(r() * b.length)] ^= 1 << Math.floor(r() * 8);
        break;
      case 1: { // delete a range
        const len = Math.floor(r() * Math.min(200, b.length - pos));
        b = Buffer.concat([b.subarray(0, pos), b.subarray(pos + len)]);
        break;
      }
      case 2: { // repeat a range many times
        const len = 1 + Math.floor(r() * Math.min(300, b.length - pos));
        const times = 1 + Math.floor(r() * r() * 400);
        b = Buffer.concat([b.subarray(0, pos), ...Array(times).fill(b.subarray(pos, pos + len)), b.subarray(pos)]);
        break;
      }
      case 3: // insert a token
        b = Buffer.concat([b.subarray(0, pos), B(` ${TOKENS[Math.floor(r() * TOKENS.length)]} `), b.subarray(pos)]);
        break;
      case 4: { // replace a number
        const s = b.toString('latin1');
        const nums = [...s.matchAll(/\d+/g)];
        if (nums.length) {
          const m = nums[Math.floor(r() * nums.length)];
          b = Buffer.concat([b.subarray(0, m.index), B(NUMBERS[Math.floor(r() * NUMBERS.length)]), b.subarray(m.index + m[0].length)]);
        }
        break;
      }
      case 5: // truncate
        b = b.subarray(0, Math.max(20, pos));
        break;
      case 6: { // swap two ranges
        const len = Math.floor(r() * Math.min(120, b.length - pos));
        const other = Math.floor(r() * (b.length - len));
        const tmp = Buffer.from(b.subarray(pos, pos + len));
        b.copy(b, pos, other, other + len);
        tmp.copy(b, other);
        break;
      }
      case 7: // overwrite with one byte value
        b.fill([0, 32, 40, 41, 60, 62, 91, 255][Math.floor(r() * 8)], pos, Math.min(b.length, pos + Math.floor(r() * 64)));
        break;
      default: { // re-wrap a stream's data with another filter name (the data no longer matches)
        const s = b.toString('latin1');
        const names = ['/FlateDecode', '/LZWDecode', '/ASCII85Decode', '/ASCIIHexDecode', '/RunLengthDecode'];
        const at = s.indexOf('/FlateDecode', Math.floor(r() * s.length));
        if (at >= 0)
          b = Buffer.concat([b.subarray(0, at), B(names[Math.floor(r() * names.length)]), b.subarray(at + 12)]);
      }
    }
  }
  return b;
}

/** A small valid PDF built with random hostile-leaning parameters (so mutations start from varied structure). */
function generated(r) {
  const pick = (a) => a[Math.floor(r() * a.length)];
  const numTok = () => pick(NUMBERS);
  const text = () => `BT /F1 ${numTok()} Tf ${numTok()} ${numTok()} Td (${'fox '.repeat(1 + Math.floor(r() * 30))}) Tj [(a) ${numTok()} (b)] TJ T* (c) ' ET`;
  const content = `${text()} q ${numTok()} 0 0 ${numTok()} 0 0 cm /X1 Do Q ${r() < 0.3 ? 'BI /W 1 /H 1 ID \x00\x01 EI' : ''} ${text()}`;
  const filter = pick(['flate', 'flate-pred', 'lzw', 'rl', 'hex', 'none']);
  let body;
  if (filter === 'flate')
    body = flateContent(content);
  else if (filter === 'flate-pred')
    body = flateContent(content, `/DecodeParms<</Predictor ${pick([1, 2, 10, 12, 15])}/Columns ${numTok()}/Colors ${pick(['1', '3', '0', '-1'])}/BitsPerComponent ${pick(['8', '1', '16', '0'])}>>`);
  else if (filter === 'lzw')
    body = stream('/Filter/LZWDecode', lzwPack([...Buffer.from(content, 'latin1')]));
  else if (filter === 'rl')
    body = stream('/Filter/RunLengthDecode', Buffer.concat([...Buffer.from(content, 'latin1')].map(c => Buffer.from([0, c]))));
  else if (filter === 'hex')
    body = stream('/Filter/ASCIIHexDecode', Buffer.from(content, 'latin1').toString('hex') + '>');
  else
    body = stream('', content);
  const type0 = r() < 0.5;
  const cm = cmap(`1 begincodespacerange <${pick(['00', '0000', '00000000'])}> <${pick(['FF', 'FFFF', 'FFFFFFFF'])}> endcodespacerange\n2 beginbfchar <${pick(['66', '0066'])}> <0046> <6F> <004F00D8> endbfchar\n1 beginbfrange <${pick(['20', '0020'])}> <${pick(['7E', '007E', 'FFFF'])}> <0020> endbfrange`);
  const objs = [
    [1, '<</Type/Catalog/Pages 2 0 R>>'],
    [2, `<</Type/Pages/Kids[3 0 R]/Count 1/Resources<</Font<</F1 5 0 R>>/XObject<</X1 7 0 R>>>>>>`],
    [3, `<</Type/Page/Parent 2 0 R/Contents ${r() < 0.3 ? '[4 0 R 4 0 R]' : '4 0 R'}>>`],
    [4, body],
    [5, type0 ? TYPE0(`/W[${numTok()} ${numTok()} ${numTok()} 3 [500 600]]`) : `<</Type/Font/Subtype/TrueType/BaseFont/X/FirstChar ${numTok()}/Widths[500 600 700]/Encoding<</BaseEncoding/${pick(['WinAnsiEncoding', 'MacRomanEncoding', 'StandardEncoding'])}/Differences[${numTok()}/fi/uni0041/Aacute]>>${r() < 0.5 ? '/ToUnicode 6 0 R' : ''}>>`],
    [6, r() < 0.5 ? flateContent(cm) : stream('', cm)],
    [7, stream(`/Type/XObject/Subtype/Form/BBox[0 0 9 9]/Matrix[1 0 0 1 ${numTok()} 0]/Resources<</XObject<</X1 7 0 R>>>>`, `${text()} /X1 Do`)],
  ];
  if (r() < 0.4) {
    const inner = '<</Type/Font/Subtype/Type1/BaseFont/Helvetica>> <</A 1>>';
    objs.push([8, stream(`/Type/ObjStm/N 2/First ${pick(['10', '0', '-1', '99999'])}`, deflate(`20 0 21 ${inner.indexOf('<</A')} ${inner}`).length ? `20 0 21 50   ${inner}` : '')]);
  }
  return pdf(objs);
}

// ---------- main ----------

if (isMainThread) {
  const argv = process.argv.slice(2);
  const opt = (name, dflt) => {
    const i = argv.indexOf(`--${name}`);
    return i >= 0 ? argv[i + 1] : dflt;
  };
  const seconds = Number(opt('seconds', 15));
  const seed = Number(opt('seed', Date.now() % 1000000000));
  const only = opt('only', '');
  const saveDir = opt('save', '');
  const noFuzz = argv.includes('--no-fuzz');
  const here = path.dirname(fileURLToPath(import.meta.url));

  let worker = null;
  let waiting = null;
  const spawn = () => {
    worker = new Worker(fileURLToPath(import.meta.url), { resourceLimits: { maxOldGenerationSizeMb: 1024 } });
    worker.on('message', (m) => waiting?.(m));
    worker.on('error', (e) => waiting?.({ crashed: String(e?.message || e) }));
    worker.on('exit', (code) => {
      if (code !== 0)
        waiting?.({ crashed: `worker exited with code ${code}` });
    });
  };
  spawn();
  let nextId = 1;
  const run = (bytes) => new Promise((resolve) => {
    const id = nextId++;
    let timer = null;
    const done = (m) => {
      if (m.id !== undefined && m.id !== id)
        return;
      clearTimeout(timer);
      waiting = null;
      if (m.crashed || m.hang) {
        worker.removeAllListeners();
        worker.terminate();
        spawn();
      }
      resolve(m);
    };
    waiting = done;
    timer = setTimeout(() => done({ hang: true }), HARD_TIMEOUT_MS);
    const copy = new Uint8Array(bytes); // the worker gets its own copy
    worker.postMessage({ id, bytes: copy }, [copy.buffer]);
  });

  /** What is wrong with a result (empty if nothing). */
  const problems = (m, want) => {
    const p = [];
    if (m.hang)
      return [`HANG: no result after ${HARD_TIMEOUT_MS / 1000} s (worker killed)`];
    if (m.crashed)
      return [`CRASH: ${m.crashed}`];
    if (!m.ok && !m.pdfError)
      p.push(`threw ${m.message} (not a PdfError)`);
    if (m.ms > TIME_LIMIT_MS + SLACK_MS)
      p.push(`took ${m.ms} ms (limit ${TIME_LIMIT_MS} ms)`);
    if (m.maxBlock > MAX_BLOCK_MS)
      p.push(`blocked the event loop for ${m.maxBlock} ms`);
    if (m.peakMb > MAX_MEMORY_MB)
      p.push(`used ${m.peakMb} MB`);
    if (want === 'canary' && !(m.ok && /CANARY TEXT/.test(m.text)))
      p.push(`the harmless page's text did not come out (${m.ok ? JSON.stringify(m.text.slice(0, 80)) : m.message})`);
    return p;
  };
  const describe = (m) => (m.hang || m.crashed ? '' : `${m.ok ? `ok, ${m.chars} chars${m.stopped ? `, stopped: ${m.stopped}` : m.truncated ? ', truncated' : ''}` : `${m.code}: ${m.message.slice(0, 90)}`} · ${m.ms} ms, longest block ${m.maxBlock} ms, ${m.peakMb} MB`);
  const save = (name, bytes) => {
    if (!saveDir)
      return;
    fs.mkdirSync(saveDir, { recursive: true });
    fs.writeFileSync(path.join(saveDir, name.replace(/[^\w.-]+/g, '_').slice(0, 80) + '.pdf'), bytes);
  };

  let failed = 0;
  console.log(`PDF extractor: hostile inputs (time limit ${TIME_LIMIT_MS} ms per file)`);
  for (const [name, make] of Object.entries(HOSTILE)) {
    if (only && !name.includes(only))
      continue;
    let made = make();
    if (Buffer.isBuffer(made))
      made = { bytes: made, want: made.want };
    const m = await run(made.bytes);
    const p = problems(m, made.want);
    if (p.length) {
      failed++;
      save(name, made.bytes);
      console.log(`  ✗ ${name} (${(made.bytes.length / 1048576).toFixed(1)} MB)\n      ${p.join('\n      ')}${describe(m) ? `\n      ${describe(m)}` : ''}`);
    } else {
      console.log(`  ✓ ${name} (${describe(m)})`);
    }
  }

  if (!noFuzz && !only) {
    console.log(`PDF extractor: mutation fuzzing for ${seconds} s (seed ${seed})`);
    const dir = path.join(here, 'fixtures', 'pdf');
    const corpus = fs.readdirSync(dir).filter(f => f.endsWith('.pdf')).map(f => fs.readFileSync(path.join(dir, f)));
    const r = rng(seed);
    const until = Date.now() + seconds * 1000;
    let n = 0, okCount = 0, errCount = 0, fuzzFailed = 0, slowest = 0;
    while (Date.now() < until || n < 200) {
      n++;
      const base = r() < 0.5 ? corpus[Math.floor(r() * corpus.length)] : generated(r);
      const bytes = r() < 0.1 ? base : mutate(base, r);
      const m = await run(bytes);
      const p = problems(m);
      slowest = Math.max(slowest, m.ms || 0);
      if (m.ok)
        okCount++;
      else
        errCount++;
      if (p.length) {
        fuzzFailed++;
        save(`fuzz-${seed}-${n}`, bytes);
        if (fuzzFailed <= 10)
          console.log(`  ✗ input ${n} (seed ${seed}, ${bytes.length} bytes)\n      ${p.join('\n      ')}`);
      }
    }
    failed += fuzzFailed;
    console.log(`  ${fuzzFailed ? '✗' : '✓'} ${n} inputs: ${okCount} gave text, ${errCount} were refused with a PdfError, ${fuzzFailed} failed; slowest ${slowest} ms`);
  }
  await worker.terminate();
  console.log(failed ? `${failed} failed` : 'all passed');
  process.exit(failed ? 1 : 0);
}
