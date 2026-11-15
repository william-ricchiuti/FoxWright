// Generates the PDF fixtures in test/fixtures/pdf/ (committed; rerun after changing this file):
//   node test/fixtures/src/make-pdfs.mjs
// simple.pdf      one page, uncompressed, Helvetica (WinAnsi), an accented word
// multipage.pdf   three pages, Flate-compressed content, a Type0 (Identity-H) font with a ToUnicode
//                 CMap, TJ kerning/word gaps, a Form XObject, a two-column-ish line layout
// objstm.pdf      PDF 1.5 with compressed object streams and an XRef stream, a simple font with
//                 /Differences glyph names (incl. ligatures)
// encrypted.pdf   has an /Encrypt dictionary: Foxwright must refuse with a clear message
// image-only.pdf  one page with only an image (like a scan): Foxwright must say there's no text
import fs from 'node:fs';
import path from 'node:path';
import zlib from 'node:zlib';
import { fileURLToPath } from 'node:url';

const out = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'pdf');
fs.mkdirSync(out, { recursive: true });

const esc = (s) => s.replace(/[\\()]/g, m => '\\' + m).replace(/[\u0080-ÿ]/g, c => '\\' + c.charCodeAt(0).toString(8));

/** objects: index i is object i+1; each a string (dict/value) or { dict, data: Buffer } (stream). */
function build(objects, { version = '1.4', root = 1, trailer = '' } = {}) {
  const parts = [Buffer.from(`%PDF-${version}\n%\xe2\xe3\xcf\xd3\n`, 'latin1')];
  const offsets = [];
  let len = parts[0].length;
  objects.forEach((o, i) => {
    offsets.push(len);
    let chunk;
    if (typeof o === 'string') {
      chunk = Buffer.from(`${i + 1} 0 obj\n${o}\nendobj\n`, 'latin1');
    } else {
      chunk = Buffer.concat([Buffer.from(`${i + 1} 0 obj\n${o.dict.replace('>>', ` /Length ${o.data.length} >>`)}\nstream\n`, 'latin1'), o.data, Buffer.from('\nendstream\nendobj\n', 'latin1')]);
    }
    parts.push(chunk);
    len += chunk.length;
  });
  const xref = [`xref\n0 ${objects.length + 1}\n0000000000 65535 f \n`, ...offsets.map(o => `${String(o).padStart(10, '0')} 00000 n \n`)].join('');
  parts.push(Buffer.from(`${xref}trailer\n<< /Size ${objects.length + 1} /Root ${root} 0 R ${trailer}>>\nstartxref\n${len}\n%%EOF\n`, 'latin1'));
  return Buffer.concat(parts);
}

const flate = (s) => ({ data: zlib.deflateSync(Buffer.from(s, 'latin1')) });

// ---------- simple.pdf ----------
{
  const content = [
    'BT /F1 18 Tf 72 720 Td (Foxwright PDF fixture: simple) Tj ET',
    'BT /F1 12 Tf 72 690 Td 14 TL (The quick brown fox jumps over the lazy dog.) Tj T* (' + esc('A second line with a café and “quotes”.'.replace('“', '\x93').replace('”', '\x94')) + ') Tj ET',
    'BT /F1 12 Tf 72 640 Td (Conservation status: Least Concern.) Tj ET',
  ].join('\n');
  fs.writeFileSync(path.join(out, 'simple.pdf'), build([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding /WinAnsiEncoding >>',
    { dict: '<< >>', data: Buffer.from(content, 'latin1') },
  ]));
}

// ---------- multipage.pdf ----------
{
  // Type0 font: every distinct character gets a 2-byte code; the ToUnicode CMap maps them back.
  const text = {
    p1: ['Page one of the multipage fixture', 'Red foxes live on every continent except Antarctica.'],
    p2: ['Second page: kerning and word gaps'],
    p3: ['Third page heading'],
  };
  const chars = [...new Set(Object.values(text).flat().join('') + 'Unicode: naïve – “ok” ✓ 日本')];
  const code = (s) => '<' + [...s].map(c => (chars.indexOf(c) + 1).toString(16).padStart(4, '0')).join('') + '>';
  const cmap = [
    '/CIDInit /ProcSet findresource begin 12 dict begin begincmap',
    '/CMapName /Foxwright-UCS def /CMapType 2 def',
    '1 begincodespacerange <0000> <FFFF> endcodespacerange',
    `${chars.length} beginbfchar`,
    ...chars.map((c, i) => `<${(i + 1).toString(16).padStart(4, '0')}> <${Buffer.from(c, 'utf16le').swap16().toString('hex')}>`),
    'endbfchar endcmap CMapName currentdict /CMap defineresource pop end end',
  ].join('\n');
  const p1 = [
    `BT /T0 20 Tf 72 720 Td ${code(text.p1[0])} Tj ET`,
    `BT /T0 12 Tf 72 690 Td ${code(text.p1[1])} Tj ET`,
    `BT /T0 12 Tf 72 670 Td ${code('Unicode: naïve – “ok” ✓ 日本')} Tj ET`,
    // two "columns" drawn on the same baseline: must come out separated, not glued
    'BT /F1 11 Tf 72 640 Td (Left column) Tj 250 0 Td (Right column) Tj ET',
  ].join('\n');
  const p2 = [
    `BT /T0 18 Tf 72 720 Td ${code(text.p2[0])} Tj ET`,
    // TJ: big negative numbers are word gaps, small positive ones are kerning
    'BT /F1 12 Tf 72 690 Td [(Words) -350 (separated) -350 (by) -350 (gaps,) -250 (and) 30 ( ) (W) 80 (ell) 60 (-kerned) -300 (text.)] TJ ET',
    'BT /F1 12 Tf 72 660 Td (Population estimate: 4,500 foxes.) Tj ET',
  ].join('\n');
  const p3 = [
    `BT /T0 18 Tf 72 720 Td ${code(text.p3[0])} Tj ET`,
    'q 1 0 0 1 72 600 cm /Fm1 Do Q',
  ].join('\n');
  const form = 'BT /F1 12 Tf 0 50 Td (Text inside a form XObject.) Tj 0 -16 Td (Its second line.) Tj ET';
  fs.writeFileSync(path.join(out, 'multipage.pdf'), build([
    /* 1 */ '<< /Type /Catalog /Pages 2 0 R >>',
    /* 2 */ '<< /Type /Pages /Kids [3 0 R 4 0 R 5 0 R] /Count 3 /Resources << /Font << /T0 6 0 R /F1 9 0 R >> /XObject << /Fm1 13 0 R >> >> /MediaBox [0 0 612 792] >>',
    /* 3 */ '<< /Type /Page /Parent 2 0 R /Contents [10 0 R] >>',
    /* 4 */ '<< /Type /Page /Parent 2 0 R /Contents 11 0 R >>',
    /* 5 */ '<< /Type /Page /Parent 2 0 R /Contents 12 0 R >>',
    /* 6 */ '<< /Type /Font /Subtype /Type0 /BaseFont /ArialUnicodeMS /Encoding /Identity-H /DescendantFonts [7 0 R] /ToUnicode 8 0 R >>',
    /* 7 */ '<< /Type /Font /Subtype /CIDFontType2 /BaseFont /ArialUnicodeMS /CIDSystemInfo << /Registry (Adobe) /Ordering (Identity) /Supplement 0 >> /DW 600 >>',
    /* 8 */ { dict: '<< /Filter /FlateDecode >>', ...flate(cmap) },
    /* 9 */ '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    /* 10 */ { dict: '<< /Filter /FlateDecode >>', ...flate(p1) },
    /* 11 */ { dict: '<< /Filter /FlateDecode >>', ...flate(p2) },
    /* 12 */ { dict: '<< /Filter /FlateDecode >>', ...flate(p3) },
    /* 13 */ { dict: '<< /Type /XObject /Subtype /Form /BBox [0 0 400 100] /Filter /FlateDecode >>', ...flate(form) },
  ]));
}

// ---------- objstm.pdf (PDF 1.5: object streams + XRef stream) ----------
{
  const content = [
    'BT /F1 16 Tf 72 720 Td (Object stream fixture) Tj ET',
    // codes 1-4 are remapped by /Differences: \001 = fi ligature, \002 = fl, \003 = endash, \004 = eacute
    'BT /F1 12 Tf 72 690 Td (The \\001rst \\002ag \\003 a d\\004j\\340 vu moment.) Tj ET',
    'BT /F1 12 Tf 72 670 Td (Compressed with FlateDecode inside an object stream.) Tj ET',
  ].join('\n');
  // Objects 1-5 live in the object stream (6); 7 is the page content; 8 is the XRef stream.
  const inStm = [
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 7 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica /Encoding 5 0 R >>',
    '<< /Type /Encoding /BaseEncoding /WinAnsiEncoding /Differences [1 /fi /fl /endash /eacute] >>',
  ];
  let body = '', header = '';
  inStm.forEach((o, i) => {
    header += `${i + 1} ${body.length} `;
    body += o + '\n';
  });
  const stm = header + '\n' + body;
  const first = header.length + 1;
  const parts = [Buffer.from('%PDF-1.5\n%\xe2\xe3\xcf\xd3\n', 'latin1')];
  let len = parts[0].length;
  const add = (buf) => {
    const at = len;
    parts.push(buf);
    len += buf.length;
    return at;
  };
  const stmData = zlib.deflateSync(Buffer.from(stm, 'latin1'));
  const off6 = add(Buffer.concat([Buffer.from(`6 0 obj\n<< /Type /ObjStm /N ${inStm.length} /First ${first} /Filter /FlateDecode /Length ${stmData.length} >>\nstream\n`, 'latin1'), stmData, Buffer.from('\nendstream\nendobj\n')]));
  const cData = zlib.deflateSync(Buffer.from(content, 'latin1'));
  const off7 = add(Buffer.concat([Buffer.from(`7 0 obj\n<< /Filter /FlateDecode /Length ${cData.length} >>\nstream\n`, 'latin1'), cData, Buffer.from('\nendstream\nendobj\n')]));
  const off8 = len;
  // XRef stream: W [1 4 2]; type 0 free, 1 = offset, 2 = in object stream
  const rows = [[0, 0, 65535], ...inStm.map((_, i) => [2, 6, i]), [1, off6, 0], [1, off7, 0], [1, off8, 0]];
  const xr = Buffer.alloc(rows.length * 7);
  rows.forEach(([t, a, b], i) => {
    xr.writeUInt8(t, i * 7);
    xr.writeUInt32BE(a, i * 7 + 1);
    xr.writeUInt16BE(b, i * 7 + 5);
  });
  const xrData = zlib.deflateSync(xr);
  add(Buffer.concat([Buffer.from(`8 0 obj\n<< /Type /XRef /Size 9 /W [1 4 2] /Root 1 0 R /Filter /FlateDecode /Length ${xrData.length} >>\nstream\n`, 'latin1'), xrData, Buffer.from('\nendstream\nendobj\n')]));
  add(Buffer.from(`startxref\n${off8}\n%%EOF\n`, 'latin1'));
  fs.writeFileSync(path.join(out, 'objstm.pdf'), Buffer.concat(parts));
}

// ---------- encrypted.pdf ----------
{
  // A Standard security handler dictionary (RC4, 40-bit). The content isn't really encrypted, but
  // a reader must treat the file as encrypted: Foxwright refuses instead of returning garbage.
  const content = 'BT /F1 12 Tf 72 720 Td (Secret text that must not be shown as garbage) Tj ET';
  fs.writeFileSync(path.join(out, 'encrypted.pdf'), build([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /Font << /F1 4 0 R >> >> /Contents 5 0 R >>',
    '<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>',
    { dict: '<< >>', data: Buffer.from(content, 'latin1') },
    `<< /Filter /Standard /V 1 /R 2 /O <${'a1'.repeat(32)}> /U <${'b2'.repeat(32)}> /P -44 >>`,
  ], { trailer: `/Encrypt 6 0 R /ID [<${'0f'.repeat(16)}> <${'0f'.repeat(16)}>] ` }));
}

// ---------- image-only.pdf ----------
{
  const w = 64, h = 64;
  const px = Buffer.alloc(w * h * 3);
  for (let i = 0; i < w * h; i++) {
    const v = ((i % w) ^ Math.floor(i / w)) & 32 ? 40 : 220;
    px.fill(v, i * 3, i * 3 + 3);
  }
  fs.writeFileSync(path.join(out, 'image-only.pdf'), build([
    '<< /Type /Catalog /Pages 2 0 R >>',
    '<< /Type /Pages /Kids [3 0 R] /Count 1 >>',
    '<< /Type /Page /Parent 2 0 R /MediaBox [0 0 612 792] /Resources << /XObject << /Im1 4 0 R >> >> /Contents 5 0 R >>',
    { dict: `<< /Type /XObject /Subtype /Image /Width ${w} /Height ${h} /ColorSpace /DeviceRGB /BitsPerComponent 8 /Filter /FlateDecode >>`, data: zlib.deflateSync(px) },
    { dict: '<< >>', data: Buffer.from('q 400 0 0 400 100 300 cm /Im1 Do Q', 'latin1') },
  ]));
}

console.log('PDF fixtures written to', out);
