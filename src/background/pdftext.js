// A small PDF text extractor, for get_page_text on tabs that show Firefox's built-in PDF viewer
// (extensions can't read that page, so the background fetches the PDF and reads it here).
//
// Handles what most PDFs from office suites, LaTeX, browsers and report generators use:
//  - objects found by scanning the file (so broken or incremental xref tables don't matter),
//    plus objects inside compressed object streams (PDF 1.5+)
//  - FlateDecode (via DecompressionStream, with PNG/TIFF predictors), LZW, ASCIIHex, ASCII85, RunLength
//  - the page tree with inherited resources, Form XObjects, q/Q/cm and text positioning, so lines
//    and word gaps come out right
//  - fonts: ToUnicode CMaps (bfchar/bfrange, 1- and 2-byte codes), simple fonts with WinAnsi,
//    MacRoman or Standard encoding and /Differences glyph names, UCS-2 CMaps
// Not handled (a clear error or note says so): encrypted PDFs (even ones that open without a
// password), scanned pages (images of text, which need OCR), CID fonts without a Unicode map,
// and vertical writing. Reading order is the order text is drawn in, which for multi-column
// layouts is usually, not always, the reading order.

export class PdfError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

class PName { constructor(n) { this.n = n; } }
class PRef { constructor(num, gen) { this.num = num; this.gen = gen; } }
class PStr { constructor(bytes) { this.bytes = bytes; } }
class POp { constructor(op) { this.op = op; } }
class PStream { constructor(dict, raw) { this.dict = dict; this.raw = raw; } }

const WS = new Uint8Array(256);
for (const c of [0, 9, 10, 12, 13, 32]) WS[c] = 1;
const DELIM = new Uint8Array(256);
for (const c of '()<>[]{}/%') DELIM[c.charCodeAt(0)] = 1;

// ---------- lexer / object parser ----------

class Lexer {
  constructor(bytes, pos = 0, end = bytes.length) {
    this.b = bytes;
    this.pos = pos;
    this.end = end;
  }

  skipWs() {
    const b = this.b;
    while (this.pos < this.end) {
      const c = b[this.pos];
      if (WS[c]) {
        this.pos++;
      } else if (c === 37) { // % comment
        while (this.pos < this.end && b[this.pos] !== 10 && b[this.pos] !== 13)
          this.pos++;
      } else {
        break;
      }
    }
  }

  /** Next token: number, PName, PStr, POp (keywords/operators and '[' ']' '<<' '>>' '{' '}'), or null at end. */
  token() {
    this.skipWs();
    const b = this.b;
    if (this.pos >= this.end)
      return null;
    const c = b[this.pos];
    if (c === 47) { // /Name
      let s = '';
      this.pos++;
      while (this.pos < this.end && !WS[b[this.pos]] && !DELIM[b[this.pos]]) {
        if (b[this.pos] === 35 && this.pos + 2 < this.end) { // #xx
          s += String.fromCharCode(parseInt(String.fromCharCode(b[this.pos + 1], b[this.pos + 2]), 16) || 0);
          this.pos += 3;
        } else {
          s += String.fromCharCode(b[this.pos++]);
        }
      }
      return new PName(s);
    }
    if (c === 40) // (string)
      return this.literal();
    if (c === 60) {
      if (b[this.pos + 1] === 60) {
        this.pos += 2;
        return new POp('<<');
      }
      return this.hex();
    }
    if (c === 62 && b[this.pos + 1] === 62) {
      this.pos += 2;
      return new POp('>>');
    }
    if (c === 91 || c === 93 || c === 123 || c === 125) {
      this.pos++;
      return new POp(String.fromCharCode(c));
    }
    if (c === 41 || c === 62) { // stray delimiter: skip it
      this.pos++;
      return this.token();
    }
    // number or keyword
    const start = this.pos;
    while (this.pos < this.end && !WS[b[this.pos]] && !DELIM[b[this.pos]])
      this.pos++;
    if (this.pos === start) {
      this.pos++;
      return this.token();
    }
    let s = '';
    for (let i = start; i < this.pos; i++)
      s += String.fromCharCode(b[i]);
    if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s))
      return parseFloat(s);
    if (/^[+-]?\d*\.\d*[+-]\d*$/.test(s)) // malformed numbers like "0.-5" seen in the wild
      return parseFloat(s) || 0;
    return new POp(s);
  }

  literal() {
    const b = this.b;
    const out = [];
    let depth = 1;
    this.pos++;
    while (this.pos < this.end) {
      let c = b[this.pos++];
      if (c === 92) { // backslash
        c = b[this.pos++];
        const map = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12 };
        if (map[c] !== undefined) {
          out.push(map[c]);
        } else if (c >= 48 && c <= 55) {
          let v = c - 48;
          for (let i = 0; i < 2 && b[this.pos] >= 48 && b[this.pos] <= 55; i++)
            v = v * 8 + (b[this.pos++] - 48);
          out.push(v & 255);
        } else if (c === 13) {
          if (b[this.pos] === 10)
            this.pos++;
        } else if (c !== 10) {
          out.push(c);
        }
        continue;
      }
      if (c === 40)
        depth++;
      else if (c === 41 && --depth === 0)
        break;
      out.push(c);
    }
    return new PStr(Uint8Array.from(out));
  }

  hex() {
    const b = this.b;
    this.pos++;
    const digits = [];
    while (this.pos < this.end && b[this.pos] !== 62) {
      const c = b[this.pos++];
      const v = c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1;
      if (v >= 0)
        digits.push(v);
    }
    this.pos++;
    if (digits.length % 2)
      digits.push(0);
    const out = new Uint8Array(digits.length / 2);
    for (let i = 0; i < out.length; i++)
      out[i] = digits[2 * i] * 16 + digits[2 * i + 1];
    return new PStr(out);
  }

  /** Parse one object (with "n g R" references), or return the operator token as POp. */
  object(tok = this.token()) {
    if (tok instanceof POp) {
      if (tok.op === '[') {
        const arr = [];
        for (;;) {
          const t = this.token();
          if (t === null || (t instanceof POp && t.op === ']'))
            break;
          arr.push(this.object(t));
        }
        return arr;
      }
      if (tok.op === '<<') {
        const d = Object.create(null);
        for (;;) {
          const k = this.token();
          if (k === null || (k instanceof POp && k.op === '>>'))
            break;
          if (!(k instanceof PName))
            continue;
          d[k.n] = this.object();
        }
        return d;
      }
      if (tok.op === 'true')
        return true;
      if (tok.op === 'false')
        return false;
      if (tok.op === 'null')
        return null;
      return tok;
    }
    if (typeof tok === 'number' && Number.isInteger(tok)) {
      // "n g R"?
      const save = this.pos;
      const t2 = this.token();
      if (typeof t2 === 'number' && Number.isInteger(t2)) {
        const t3 = this.token();
        if (t3 instanceof POp && t3.op === 'R')
          return new PRef(tok, t2);
      }
      this.pos = save;
    }
    return tok;
  }
}

// ---------- stream filters ----------

async function inflate(data) {
  for (const fmt of ['deflate', 'deflate-raw']) {
    let ds;
    try {
      ds = new DecompressionStream(fmt);
    } catch {
      continue;
    }
    const writer = ds.writable.getWriter();
    writer.write(data).catch(() => {});
    writer.close().catch(() => {});
    const reader = ds.readable.getReader();
    const chunks = [];
    let total = 0;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done)
          break;
        chunks.push(value);
        total += value.length;
        if (total > 256 * 1024 * 1024)
          break;
      }
    } catch { /* corrupt or trailing junk: keep what was decoded */ }
    if (total)
      return concat(chunks, total);
  }
  return null;
}

function concat(chunks, total = chunks.reduce((n, c) => n + c.length, 0)) {
  const out = new Uint8Array(total);
  let o = 0;
  for (const c of chunks) {
    out.set(c, o);
    o += c.length;
  }
  return out;
}

function unpredict(data, parms) {
  const pred = num(parms?.Predictor, 1);
  if (pred < 2)
    return data;
  const colors = num(parms.Colors, 1), bpc = num(parms.BitsPerComponent, 8), cols = num(parms.Columns, 1);
  const bpp = Math.max(1, Math.ceil(colors * bpc / 8));
  const rowLen = Math.ceil(colors * bpc * cols / 8);
  if (pred === 2) { // TIFF (8-bit only)
    const out = Uint8Array.from(data);
    for (let r = 0; r + rowLen <= out.length; r += rowLen)
      for (let i = bpp; i < rowLen; i++)
        out[r + i] = (out[r + i] + out[r + i - bpp]) & 255;
    return out;
  }
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  const prev = new Uint8Array(rowLen);
  for (let r = 0; r < rows; r++) {
    const type = data[r * (rowLen + 1)];
    const row = data.subarray(r * (rowLen + 1) + 1, (r + 1) * (rowLen + 1));
    const cur = out.subarray(r * rowLen, (r + 1) * rowLen);
    for (let i = 0; i < rowLen; i++) {
      const a = i >= bpp ? cur[i - bpp] : 0, b = prev[i], c = i >= bpp ? prev[i - bpp] : 0;
      let v = row[i];
      if (type === 1) v += a;
      else if (type === 2) v += b;
      else if (type === 3) v += (a + b) >> 1;
      else if (type === 4) {
        const p = a + b - c, pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
        v += pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
      }
      cur[i] = v & 255;
    }
    prev.set(cur);
  }
  return out;
}

function asciiHex(data) {
  return new Lexer(Uint8Array.from([60, ...data.filter(c => c !== 62), 62])).hex().bytes;
}

function ascii85(data) {
  const out = [];
  let tuple = 0, n = 0;
  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    if (c === 126) // ~> end
      break;
    if (WS[c])
      continue;
    if (c === 122 && n === 0) { // z
      out.push(0, 0, 0, 0);
      continue;
    }
    if (c < 33 || c > 117)
      continue;
    tuple = tuple * 85 + (c - 33);
    if (++n === 5) {
      out.push((tuple >>> 24) & 255, (tuple >>> 16) & 255, (tuple >>> 8) & 255, tuple & 255);
      tuple = 0;
      n = 0;
    }
  }
  if (n > 1) {
    for (let i = n; i < 5; i++)
      tuple = tuple * 85 + 84;
    for (let i = 0; i < n - 1; i++)
      out.push((tuple >>> (24 - 8 * i)) & 255);
  }
  return Uint8Array.from(out);
}

function lzw(data, early = 1) {
  const out = [];
  let dict = [];
  const reset = () => {
    dict = [];
    for (let i = 0; i < 256; i++) dict.push([i]);
    dict.push(null, null); // 256 clear, 257 EOD
  };
  reset();
  let bits = 9, buf = 0, nbuf = 0, prev = null;
  for (let i = 0; i < data.length; i++) {
    buf = (buf << 8) | data[i];
    nbuf += 8;
    while (nbuf >= bits) {
      const code = (buf >>> (nbuf - bits)) & ((1 << bits) - 1);
      nbuf -= bits;
      if (code === 256) {
        reset();
        bits = 9;
        prev = null;
        continue;
      }
      if (code === 257)
        return Uint8Array.from(out);
      let entry = dict[code];
      if (!entry && prev)
        entry = [...prev, prev[0]];
      if (!entry)
        return Uint8Array.from(out);
      out.push(...entry);
      if (prev)
        dict.push([...prev, entry[0]]);
      prev = entry;
      if (dict.length + early >= (1 << bits) && bits < 12)
        bits++;
    }
  }
  return Uint8Array.from(out);
}

function runLength(data) {
  const out = [];
  for (let i = 0; i < data.length;) {
    const n = data[i++];
    if (n === 128)
      break;
    if (n < 128) {
      for (let j = 0; j <= n && i < data.length; j++) out.push(data[i++]);
    } else {
      const v = data[i++];
      for (let j = 0; j < 257 - n; j++) out.push(v);
    }
  }
  return Uint8Array.from(out);
}

const IMAGE_FILTERS = new Set(['DCTDecode', 'DCT', 'JPXDecode', 'JBIG2Decode', 'CCITTFaxDecode', 'CCF']);

function num(v, d = 0) {
  return typeof v === 'number' && isFinite(v) ? v : d;
}

// ---------- glyph names and encodings ----------

const GLYPHS = {
  space: ' ', exclam: '!', quotedbl: '"', numbersign: '#', dollar: '$', percent: '%', ampersand: '&', quotesingle: "'",
  parenleft: '(', parenright: ')', asterisk: '*', plus: '+', comma: ',', hyphen: '-', period: '.', slash: '/',
  zero: '0', one: '1', two: '2', three: '3', four: '4', five: '5', six: '6', seven: '7', eight: '8', nine: '9',
  colon: ':', semicolon: ';', less: '<', equal: '=', greater: '>', question: '?', at: '@', bracketleft: '[',
  backslash: '\\', bracketright: ']', asciicircum: '^', underscore: '_', grave: '`', braceleft: '{', bar: '|',
  braceright: '}', asciitilde: '~', quoteleft: '‘', quoteright: '’', quotedblleft: '“', quotedblright: '”',
  quotesinglbase: '‚', quotedblbase: '„', guilsinglleft: '‹', guilsinglright: '›', guillemotleft: '«', guillemotright: '»',
  endash: '–', emdash: '—', bullet: '•', ellipsis: '…', dagger: '†', daggerdbl: '‡', perthousand: '‰', section: '§',
  paragraph: '¶', copyright: '©', registered: '®', trademark: '™', degree: '°', plusminus: '±', multiply: '×',
  divide: '÷', minus: '−', periodcentered: '·', Euro: '€', sterling: '£', yen: '¥', cent: '¢', florin: 'ƒ',
  exclamdown: '¡', questiondown: '¿', ordfeminine: 'ª', ordmasculine: 'º', mu: 'µ', germandbls: 'ß', AE: 'Æ', ae: 'æ',
  OE: 'Œ', oe: 'œ', Oslash: 'Ø', oslash: 'ø', Lslash: 'Ł', lslash: 'ł', dotlessi: 'ı', Eth: 'Ð', eth: 'ð', Thorn: 'Þ',
  thorn: 'þ', fi: 'fi', fl: 'fl', ff: 'ff', ffi: 'ffi', ffl: 'ffl', nbspace: ' ', sfthyphen: '­', brokenbar: '¦',
  logicalnot: '¬', macron: '¯', acute: '´', cedilla: '¸', dieresis: '¨', circumflex: 'ˆ', tilde: '˜', ring: '˚',
  caron: 'ˇ', breve: '˘', dotaccent: '˙', hungarumlaut: '˝', ogonek: '˛', onehalf: '½', onequarter: '¼',
  threequarters: '¾', onesuperior: '¹', twosuperior: '²', threesuperior: '³', currency: '¤', fraction: '⁄',
  arrowright: '→', arrowleft: '←', arrowup: '↑', arrowdown: '↓', infinity: '∞', notequal: '≠', lessequal: '≤',
  greaterequal: '≥', approxequal: '≈', summation: '∑', product: '∏', radical: '√', integral: '∫', partialdiff: '∂',
  Delta: 'Δ', Omega: 'Ω', pi: 'π', lozenge: '◊', checkmark: '✓', uni00A0: ' ',
};
const ACCENTS = { acute: '́', grave: '̀', circumflex: '̂', dieresis: '̈', tilde: '̃', ring: '̊', cedilla: '̧', caron: '̌', macron: '̄', breve: '̆', ogonek: '̨', dotaccent: '̇', hungarumlaut: '̋' };

function glyphToUnicode(name) {
  if (!name)
    return '';
  const base = name.split('.')[0].split('_')[0];
  if (GLYPHS[base] !== undefined)
    return GLYPHS[base];
  if (/^[A-Za-z]$/.test(base))
    return base;
  let m = /^uni((?:[0-9A-F]{4})+)$/.exec(base);
  if (m)
    return m[1].match(/.{4}/g).map(h => String.fromCharCode(parseInt(h, 16))).join('');
  m = /^u([0-9A-F]{4,6})$/.exec(base);
  if (m)
    return String.fromCodePoint(parseInt(m[1], 16));
  m = /^([A-Za-z])(acute|grave|circumflex|dieresis|tilde|ring|cedilla|caron|macron|breve|ogonek|dotaccent|hungarumlaut)$/.exec(base);
  if (m)
    return (m[1] + ACCENTS[m[2]]).normalize('NFC');
  return '';
}

const WIN_ANSI_HIGH = '€\u0081‚ƒ„…†‡ˆ‰Š‹Œ\u008DŽ\u008F\u0090‘’“”•–—˜™š›œ\u009DžŸ';
const MAC_ROMAN_HIGH = 'ÄÅÇÉÑÖÜáàâäãåçéèêëíìîïñóòôöõúùûü†°¢£§•¶ß®©™´¨≠ÆØ∞±≤≥¥µ∂∑∏π∫ªºΩæø¿¡¬√ƒ≈∆«»… ÀÃÕŒœ–—“”‘’÷◊ÿŸ⁄€‹›ﬁﬂ‡·‚„‰ÂÊÁËÈÍÎÏÌÓÔÒÚÛÙıˆ˜¯˘˙˚¸˝˛ˇ';
const STD_HIGH = { 0xA1: '¡', 0xA2: '¢', 0xA3: '£', 0xA4: '⁄', 0xA5: '¥', 0xA6: 'ƒ', 0xA7: '§', 0xA8: '¤', 0xA9: "'", 0xAA: '“', 0xAB: '«', 0xAC: '‹', 0xAD: '›', 0xAE: 'fi', 0xAF: 'fl', 0xB1: '–', 0xB2: '†', 0xB3: '‡', 0xB4: '·', 0xB6: '¶', 0xB7: '•', 0xB8: '‚', 0xB9: '„', 0xBA: '”', 0xBB: '»', 0xBC: '…', 0xBD: '‰', 0xBF: '¿', 0xC1: '`', 0xC2: '´', 0xC3: 'ˆ', 0xC4: '˜', 0xC5: '¯', 0xC6: '˘', 0xC7: '˙', 0xC8: '¨', 0xCA: '˚', 0xCB: '¸', 0xCD: '˝', 0xCE: '˛', 0xCF: 'ˇ', 0xD0: '—', 0xE1: 'Æ', 0xE3: 'ª', 0xE8: 'Ł', 0xE9: 'Ø', 0xEA: 'Œ', 0xEB: 'º', 0xF1: 'æ', 0xF5: 'ı', 0xF8: 'ł', 0xF9: 'ø', 0xFA: 'œ', 0xFB: 'ß' };

function baseEncoding(name) {
  const t = new Array(256);
  for (let i = 0; i < 256; i++) {
    if (name === 'MacRomanEncoding')
      t[i] = i < 128 ? String.fromCharCode(i) : MAC_ROMAN_HIGH[i - 128];
    else if (name === 'StandardEncoding')
      t[i] = i === 39 ? '’' : i === 96 ? '‘' : i < 128 ? String.fromCharCode(i) : (STD_HIGH[i] || '');
    else // WinAnsi, and the fallback for everything else
      t[i] = i >= 128 && i < 160 ? WIN_ANSI_HIGH[i - 128] : String.fromCharCode(i);
    if (i < 32 && i !== 9 && i !== 10 && i !== 13)
      t[i] = '';
  }
  return t;
}

// ---------- ToUnicode CMaps ----------

function utf16be(bytes) {
  let s = '';
  for (let i = 0; i + 1 < bytes.length; i += 2)
    s += String.fromCharCode((bytes[i] << 8) | bytes[i + 1]);
  if (bytes.length % 2)
    s += String.fromCharCode(bytes[bytes.length - 1]);
  return s;
}

function bytesToInt(bytes) {
  let v = 0;
  for (const b of bytes) v = v * 256 + b;
  return v;
}

function parseCMap(data) {
  const lex = new Lexer(data);
  const map = new Map();
  const spaces = []; // [len, lo, hi]
  const toks = [];
  for (let t = lex.token(); t !== null; t = lex.token()) {
    toks.push(t);
    if (toks.length > 2000000)
      break;
  }
  for (let i = 0; i < toks.length; i++) {
    const t = toks[i];
    if (!(t instanceof POp))
      continue;
    if (t.op === 'begincodespacerange') {
      for (i++; i + 1 < toks.length && toks[i] instanceof PStr; i += 2)
        spaces.push([toks[i].bytes.length, bytesToInt(toks[i].bytes), bytesToInt(toks[i + 1].bytes)]);
    } else if (t.op === 'beginbfchar') {
      for (i++; i + 1 < toks.length && toks[i] instanceof PStr; i += 2) {
        const dst = toks[i + 1];
        map.set(`${toks[i].bytes.length}:${bytesToInt(toks[i].bytes)}`, dst instanceof PStr ? utf16be(dst.bytes) : dst instanceof PName ? glyphToUnicode(dst.n) : '');
      }
    } else if (t.op === 'beginbfrange') {
      for (i++; i + 2 < toks.length && toks[i] instanceof PStr; i += 3) {
        const len = toks[i].bytes.length;
        const lo = bytesToInt(toks[i].bytes), hi = bytesToInt(toks[i + 1].bytes);
        let dst = toks[i + 2];
        if (hi - lo > 65535)
          continue;
        if (dst instanceof POp && dst.op === '[') { // array form
          const arr = [];
          for (i += 3; i < toks.length && !(toks[i] instanceof POp && toks[i].op === ']'); i++)
            arr.push(toks[i]);
          i -= 2; // the loop adds 3; land just past ']'
          for (let c = lo; c <= hi && c - lo < arr.length; c++)
            map.set(`${len}:${c}`, arr[c - lo] instanceof PStr ? utf16be(arr[c - lo].bytes) : '');
          continue;
        }
        if (dst instanceof PStr) {
          const base = dst.bytes;
          for (let c = lo; c <= hi; c++) {
            const b = Uint8Array.from(base);
            let carry = c - lo; // add to the last byte(s)
            for (let k = b.length - 1; k >= 0 && carry; k--) {
              const v = b[k] + carry;
              b[k] = v & 255;
              carry = v >> 8;
            }
            map.set(`${len}:${c}`, utf16be(b));
          }
        }
      }
    }
  }
  return { map, spaces };
}

// ---------- the document ----------

class Doc {
  constructor(bytes) {
    this.b = bytes;
    this.offsets = new Map(); // obj num -> byte offset of "n g obj"
    this.inStream = new Map(); // obj num -> [objstm num, index]
    this.cache = new Map();
    this.decoded = new Map();
  }

  scan() {
    // latin1 view for fast keyword search
    const s = latin1(this.b);
    this.s = s;
    const re = /(?:^|[^0-9])(\d{1,10})[ \t\r\n\f\0]+(\d{1,5})[ \t\r\n\f\0]+obj\b/g;
    let m;
    while ((m = re.exec(s))) {
      const num = +m[1];
      this.offsets.set(num, m.index + m[0].length); // later definitions (incremental updates) win
    }
    this.trailers = [];
    const tre = /trailer[\s\0]*<</g;
    while ((m = tre.exec(s))) {
      const lex = new Lexer(this.b, m.index + 7);
      try {
        const d = lex.object();
        if (d && typeof d === 'object')
          this.trailers.push(d);
      } catch { /* ignore */ }
    }
  }

  /** Raw object at an offset (just after "obj"). */
  parseAt(pos) {
    const lex = new Lexer(this.b, pos);
    const obj = lex.object();
    if (obj && typeof obj === 'object' && !Array.isArray(obj) && !(obj instanceof PName) && !(obj instanceof PStr) && !(obj instanceof PRef) && !(obj instanceof POp)) {
      const save = lex.pos;
      const t = lex.token();
      if (t instanceof POp && t.op === 'stream') {
        let start = lex.pos;
        if (this.b[start] === 13)
          start++;
        if (this.b[start] === 10)
          start++;
        let end = -1;
        const len = obj.Length;
        if (typeof len === 'number' && start + len <= this.b.length) {
          const after = latin1(this.b.subarray(start + len, Math.min(this.b.length, start + len + 20)));
          if (/^[\s\0]*endstream/.test(after))
            end = start + len;
        }
        if (end < 0) {
          const k = this.s.indexOf('endstream', start);
          end = k < 0 ? this.b.length : k;
          while (end > start && (this.b[end - 1] === 10 || this.b[end - 1] === 13))
            end--;
        }
        return new PStream(obj, this.b.subarray(start, end));
      }
      lex.pos = save;
    }
    return obj;
  }

  async loadObjectStreams() {
    for (const [num, off] of this.offsets) {
      let o;
      try {
        o = this.parseAt(off);
      } catch {
        continue;
      }
      this.cache.set(num, o);
      if (!(o instanceof PStream))
        continue;
      const type = o.dict.Type?.n;
      if (type === 'XRef')
        this.trailers.push(o.dict);
      if (type !== 'ObjStm')
        continue;
      const data = await this.decode(o);
      if (!data)
        continue;
      const n = num_(o.dict.N), first = num_(o.dict.First);
      const lex = new Lexer(data);
      const entries = [];
      for (let i = 0; i < n; i++) {
        const on = lex.token(), ob = lex.token();
        if (typeof on !== 'number' || typeof ob !== 'number')
          break;
        entries.push([on, ob]);
      }
      this.objStmData = this.objStmData || new Map();
      this.objStmData.set(num, { data, first, entries });
      entries.forEach(([on], i) => {
        if (!this.offsets.has(on) && !this.inStream.has(on))
          this.inStream.set(on, [num, i]);
      });
    }
  }

  get(v, depth = 0) {
    if (!(v instanceof PRef))
      return v;
    if (depth > 20)
      return null;
    const n = v.num;
    if (this.cache.has(n))
      return this.cache.get(n);
    let obj = null;
    try {
      if (this.offsets.has(n)) {
        obj = this.parseAt(this.offsets.get(n));
      } else if (this.inStream.has(n)) {
        const [sn, i] = this.inStream.get(n);
        const st = this.objStmData.get(sn);
        const [, off] = st.entries[i];
        obj = new Lexer(st.data, st.first + off).object();
      }
    } catch {
      obj = null;
    }
    if (obj instanceof PRef)
      obj = this.get(obj, depth + 1);
    this.cache.set(n, obj);
    return obj;
  }

  async decode(stream) {
    if (this.decoded.has(stream))
      return this.decoded.get(stream);
    let data = stream.raw;
    let filters = this.get(stream.dict.Filter);
    let parms = this.get(stream.dict.DecodeParms ?? stream.dict.DP);
    if (!Array.isArray(filters))
      filters = filters ? [filters] : [];
    if (!Array.isArray(parms))
      parms = [parms];
    for (let i = 0; i < filters.length && data; i++) {
      const f = this.get(filters[i])?.n;
      const p = this.get(parms[i]);
      if (f === 'FlateDecode' || f === 'Fl')
        data = unpredict(await inflate(data) || new Uint8Array(0), p);
      else if (f === 'LZWDecode' || f === 'LZW')
        data = unpredict(lzw(data, num(p?.EarlyChange, 1)), p);
      else if (f === 'ASCIIHexDecode' || f === 'AHx')
        data = asciiHex(data);
      else if (f === 'ASCII85Decode' || f === 'A85')
        data = ascii85(data);
      else if (f === 'RunLengthDecode' || f === 'RL')
        data = runLength(data);
      else if (f === 'Crypt' && this.get(p?.Name)?.n === 'Identity')
        continue;
      else
        data = null; // image codecs and unknown filters: not text
    }
    this.decoded.set(stream, data);
    return data;
  }
}

function num_(v) {
  return typeof v === 'number' ? v : 0;
}

function latin1(bytes) {
  let s = '';
  for (let i = 0; i < bytes.length; i += 0x8000)
    s += String.fromCharCode.apply(null, bytes.subarray(i, i + 0x8000));
  return s;
}

// ---------- fonts ----------

class Font {
  constructor() {
    this.twoByte = false;
    this.toUni = null; // { map, spaces }
    this.enc = null; // 256 strings
    this.widths = null; // code -> width (1/1000 em)
    this.dw = 500;
    this.ucs2 = false;
  }

  /** Split a string's bytes into [code, byteLength] pairs. */
  codes(bytes) {
    const out = [];
    const spaces = this.toUni?.spaces;
    for (let i = 0; i < bytes.length;) {
      let len = this.twoByte ? 2 : 1;
      if (spaces && spaces.length) {
        len = 0;
        for (let l = 1; l <= 4 && !len; l++) {
          if (i + l > bytes.length)
            break;
          const v = bytesToInt(bytes.subarray(i, i + l));
          if (spaces.some(([sl, lo, hi]) => sl === l && v >= lo && v <= hi))
            len = l;
        }
        if (!len)
          len = this.twoByte ? 2 : 1;
      }
      len = Math.min(len, bytes.length - i);
      out.push([bytesToInt(bytes.subarray(i, i + len)), len]);
      i += len;
    }
    return out;
  }

  /** Text for one code, or null if it can't be decoded. */
  text(code, len) {
    if (this.toUni) {
      const t = this.toUni.map.get(`${len}:${code}`);
      if (t !== undefined)
        return t.replace(/\0/g, '');
    }
    if (this.ucs2)
      return String.fromCharCode(code);
    if (this.twoByte)
      return null;
    if (this.enc)
      return this.enc[code] ?? '';
    return code >= 32 ? String.fromCharCode(code) : '';
  }

  width(code) {
    const w = this.widths?.get(code);
    return (typeof w === 'number' ? w : this.dw) / 1000;
  }
}

async function loadFont(doc, dict) {
  const f = new Font();
  dict = doc.get(dict);
  if (!dict || typeof dict !== 'object')
    return f;
  const subtype = doc.get(dict.Subtype)?.n;
  const tu = doc.get(dict.ToUnicode);
  if (tu instanceof PStream) {
    const data = await doc.decode(tu);
    if (data)
      f.toUni = parseCMap(data);
  }
  if (subtype === 'Type0') {
    f.twoByte = true;
    const encName = doc.get(dict.Encoding)?.n || '';
    if (/UCS2|UTF16/.test(encName))
      f.ucs2 = true;
    const desc = doc.get((doc.get(dict.DescendantFonts) || [])[0]);
    if (desc) {
      f.dw = num(doc.get(desc.DW), 1000);
      const w = doc.get(desc.W);
      if (Array.isArray(w)) {
        f.widths = new Map();
        for (let i = 0; i < w.length;) {
          const c = doc.get(w[i]);
          const n2 = doc.get(w[i + 1]);
          if (Array.isArray(n2)) {
            n2.forEach((x, j) => f.widths.set(c + j, num(doc.get(x))));
            i += 2;
          } else {
            const wd = num(doc.get(w[i + 2]));
            for (let k = c; k <= n2 && k - c < 65536; k++)
              f.widths.set(k, wd);
            i += 3;
          }
        }
      }
    }
    return f;
  }
  // Simple font
  const enc = doc.get(dict.Encoding);
  let base = 'WinAnsiEncoding';
  const fd = doc.get(dict.FontDescriptor);
  const symbolic = fd && (num(doc.get(fd.Flags)) & 4) && !(num(doc.get(fd.Flags)) & 32);
  if (!enc && symbolic)
    base = 'Symbolic';
  else if (!enc && subtype === 'Type1')
    base = 'StandardEncoding';
  if (enc instanceof PName)
    base = enc.n;
  else if (enc && typeof enc === 'object' && doc.get(enc.BaseEncoding) instanceof PName)
    base = doc.get(enc.BaseEncoding).n;
  f.enc = base === 'Symbolic' ? null : baseEncoding(base);
  const diffs = enc && typeof enc === 'object' && !(enc instanceof PName) ? doc.get(enc.Differences) : null;
  if (Array.isArray(diffs)) {
    if (!f.enc)
      f.enc = baseEncoding('WinAnsiEncoding');
    let code = 0;
    for (const d0 of diffs) {
      const d = doc.get(d0);
      if (typeof d === 'number')
        code = d;
      else if (d instanceof PName && code < 256)
        f.enc[code++] = glyphToUnicode(d.n);
    }
  }
  const widths = doc.get(dict.Widths);
  if (Array.isArray(widths)) {
    const fc = num(doc.get(dict.FirstChar));
    f.widths = new Map(widths.map((w, i) => [fc + i, num(doc.get(w))]));
    f.dw = num(doc.get(fd?.MissingWidth), 500) || 500;
  }
  return f;
}

// ---------- content streams ----------

const mul = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
const ID = [1, 0, 0, 1, 0, 0];

class TextSink {
  constructor() {
    this.out = '';
    this.last = null; // { x, y, size } end of the last drawn text, in device space
    this.undecoded = 0;
    this.glyphs = 0;
  }

  /** Separate from the previous text by a newline or space, depending on where this text starts. */
  place(x, y, size) {
    const l = this.last;
    if (l && this.out) {
      const lh = Math.max(1, Math.max(size, l.size));
      const dy = Math.abs(y - l.y);
      if (dy > lh * 0.5) {
        this.out = this.out.replace(/ +$/, '');
        this.out += dy > lh * 1.9 ? '\n\n' : '\n';
      } else if (x - l.x > lh * 0.18 || x < l.x - lh * 4) {
        if (!/\s$/.test(this.out))
          this.out += ' ';
      }
    }
  }
}

async function runContent(doc, data, resources, ctm, sink, fontCache, depth, limits) {
  if (depth > 8 || !data)
    return;
  resources = doc.get(resources) || {};
  const lex = new Lexer(data);
  const ops = [];
  let tm = ID, lm = ID, font = null, size = 1, leading = 0, cs = 0, ws = 0, th = 1, rise = 0;
  const stack = [];
  const fontsDict = doc.get(resources.Font) || {};
  const xobjs = doc.get(resources.XObject) || {};

  const show = (str) => {
    if (!(str instanceof PStr) || !font)
      return;
    const trm = () => mul([size * th, 0, 0, size, 0, rise], mul(tm, ctm)); // text rendering matrix
    const m = trm();
    const scaled = Math.hypot(m[2], m[3]);
    sink.place(m[4], m[5], scaled);
    for (const [code, len] of font.codes(str.bytes)) {
      const t = font.text(code, len);
      sink.glyphs++;
      if (t === null)
        sink.undecoded++;
      else
        sink.out += t;
      const w = font.width(code);
      const tx = (w * size + cs + (len === 1 && code === 32 ? ws : 0)) * th;
      tm = [tm[0], tm[1], tm[2], tm[3], tm[4] + tx * tm[0], tm[5] + tx * tm[1]];
    }
    const end = trm();
    sink.last = { x: end[4], y: end[5], size: scaled };
    if (sink.out.length > limits.maxChars)
      throw new PdfError('limit', 'too much text');
  };
  const nextLine = (tx, ty) => {
    lm = mul([1, 0, 0, 1, tx, ty], lm);
    tm = lm;
  };

  for (let t = lex.token(); t !== null; t = lex.token()) {
    if (!(t instanceof POp) || t.op === '[' || t.op === '<<') {
      ops.push(lex.object(t));
      if (ops.length > 10000)
        ops.length = 0;
      continue;
    }
    const op = t.op;
    const a = ops;
    switch (op) {
      case 'BT': tm = lm = ID; break;
      case 'Tf': {
        const name = a[0] instanceof PName ? a[0].n : '';
        size = num(a[1], 1);
        const ref = fontsDict[name];
        // Fonts shared between pages are indirect objects: cache those by object number.
        const key = ref instanceof PRef ? `r${ref.num}` : ref && typeof ref === 'object' ? ref : `n${name}`;
        if (!fontCache.has(key))
          fontCache.set(key, await loadFont(doc, ref));
        font = fontCache.get(key);
        break;
      }
      case 'Td': nextLine(num(a[0]), num(a[1])); break;
      case 'TD': leading = -num(a[1]); nextLine(num(a[0]), num(a[1])); break;
      case 'Tm': lm = tm = a.slice(0, 6).map(v => num(v)); if (lm.length < 6) lm = tm = ID; break;
      case 'T*': nextLine(0, -leading); break;
      case 'TL': leading = num(a[0]); break;
      case 'Tc': cs = num(a[0]); break;
      case 'Tw': ws = num(a[0]); break;
      case 'Tz': th = num(a[0], 100) / 100; break;
      case 'Ts': rise = num(a[0]); break;
      case 'Tj': show(a[0]); break;
      case "'": nextLine(0, -leading); show(a[0]); break;
      case '"': ws = num(a[0]); cs = num(a[1]); nextLine(0, -leading); show(a[2]); break;
      case 'TJ': {
        for (const item of Array.isArray(a[0]) ? a[0] : []) {
          if (typeof item === 'number') {
            const tx = -item / 1000 * size * th;
            tm = [tm[0], tm[1], tm[2], tm[3], tm[4] + tx * tm[0], tm[5] + tx * tm[1]];
          } else {
            show(item);
          }
        }
        break;
      }
      case 'q': stack.push(ctm); break;
      case 'Q': if (stack.length) ctm = stack.pop(); break;
      case 'cm': if (a.length >= 6) ctm = mul(a.slice(0, 6).map(v => num(v)), ctm); break;
      case 'Do': {
        const name = a[0] instanceof PName ? a[0].n : '';
        const x = doc.get(xobjs[name]);
        if (x instanceof PStream) {
          const sub = doc.get(x.dict.Subtype)?.n;
          if (sub === 'Image') {
            sink.images = (sink.images || 0) + 1;
          } else if (sub === 'Form' && !limits.forms.has(x)) {
            limits.forms.add(x);
            const fm = doc.get(x.dict.Matrix);
            const m = Array.isArray(fm) && fm.length === 6 ? fm.map(v => num(doc.get(v))) : ID;
            await runContent(doc, await doc.decode(x), x.dict.Resources || resources, mul(m, ctm), sink, new Map(), depth + 1, limits);
            limits.forms.delete(x);
          }
        }
        break;
      }
      case 'BI': {
        // Inline image: skip its binary data up to "EI".
        const b = data;
        let i = lex.pos;
        // find "ID" then the matching "EI"
        for (; i < b.length - 1; i++) {
          if (b[i] === 73 && b[i + 1] === 68 && (WS[b[i + 2]] || i + 2 >= b.length) && (WS[b[i - 1]] || DELIM[b[i - 1]]))
            break;
        }
        for (i += 3; i < b.length - 1; i++) {
          if (b[i] === 69 && b[i + 1] === 73 && WS[b[i - 1]] && (i + 2 >= b.length || WS[b[i + 2]]))
            break;
        }
        lex.pos = i + 2;
        sink.images = (sink.images || 0) + 1;
        break;
      }
      default: break;
    }
    ops.length = 0;
  }
}

// ---------- entry point ----------

/**
 * Extract the text of a PDF, page by page.
 * Returns { pages: string[], pageCount, undecoded, images }. Throws PdfError with code
 * 'encrypted', 'invalid', 'notext' or 'images'.
 */
export async function extractPdfText(bytes, { maxChars = 5000000 } = {}) {
  if (!(bytes instanceof Uint8Array))
    bytes = new Uint8Array(bytes);
  const head = latin1(bytes.subarray(0, 1024));
  if (!/%PDF-/.test(head))
    throw new PdfError('invalid', 'This is not a PDF file (no %PDF header).');
  const doc = new Doc(bytes);
  doc.scan();
  await doc.loadObjectStreams();
  if (doc.trailers.some(t => t.Encrypt !== undefined && t.Encrypt !== null))
    throw new PdfError('encrypted', 'This PDF is encrypted (it may still open without a password in Firefox, which decrypts it; Foxwright\'s built-in PDF reader can\'t).');

  // Catalog -> page tree
  let root = null;
  for (const t of doc.trailers.slice().reverse()) {
    const r = doc.get(t.Root);
    if (r && typeof r === 'object') {
      root = r;
      break;
    }
  }
  if (!root) {
    for (const n of doc.offsets.keys()) {
      const o = doc.get(new PRef(n, 0));
      if (o && typeof o === 'object' && o.Type instanceof PName && o.Type.n === 'Catalog') {
        root = o;
        break;
      }
    }
  }
  const pages = [];
  const seen = new Set();
  const walk = (node, inherited, depth) => {
    node = doc.get(node);
    if (!node || typeof node !== 'object' || seen.has(node) || depth > 50)
      return;
    seen.add(node);
    const res = node.Resources !== undefined ? node.Resources : inherited;
    const kids = doc.get(node.Kids);
    if (Array.isArray(kids)) {
      for (const k of kids)
        walk(k, res, depth + 1);
    } else if (node.Contents !== undefined || node.Type?.n === 'Page') {
      pages.push({ page: node, res });
    }
  };
  if (root)
    walk(root.Pages, undefined, 0);
  if (!pages.length) {
    // No usable page tree: fall back to every page object, in object order.
    for (const n of [...doc.offsets.keys(), ...doc.inStream.keys()].sort((a, b) => a - b)) {
      const o = doc.get(new PRef(n, 0));
      if (o && typeof o === 'object' && o.Type instanceof PName && o.Type.n === 'Page')
        pages.push({ page: o, res: o.Resources });
    }
  }
  if (!pages.length)
    throw new PdfError('invalid', 'Couldn\'t find any pages in this PDF (it may be damaged or use features Foxwright\'s PDF reader doesn\'t support).');

  const texts = [];
  let undecoded = 0, glyphs = 0, images = 0, total = 0, truncated = false;
  const fontCache = new Map();
  for (const { page, res } of pages) {
    const sink = new TextSink();
    let contents = doc.get(page.Contents);
    if (!Array.isArray(contents))
      contents = contents ? [contents] : [];
    const parts = [];
    for (const c of contents) {
      const s = doc.get(c);
      if (s instanceof PStream) {
        const d = await doc.decode(s);
        if (d)
          parts.push(d, Uint8Array.of(10));
      }
    }
    try {
      await runContent(doc, concat(parts), res, ID, sink, fontCache, 0, { maxChars: Math.max(0, maxChars - total), forms: new Set() });
    } catch (e) {
      if (e instanceof PdfError && e.code === 'limit')
        truncated = true;
    }
    undecoded += sink.undecoded;
    glyphs += sink.glyphs;
    images += sink.images || 0;
    const t = sink.out.replace(/[ \t]+\n/g, '\n').replace(/\n{3,}/g, '\n\n').trim();
    texts.push(t);
    total += t.length;
    if (truncated || total >= maxChars) {
      truncated = true;
      break;
    }
  }
  const textChars = texts.join('').replace(/\s/g, '').length;
  if (!textChars) {
    if (glyphs && undecoded)
      throw new PdfError('notext', `This PDF draws its text with fonts that have no Unicode mapping, so Foxwright can't turn it back into text (${pages.length} page${pages.length === 1 ? '' : 's'}). Take screenshots of the PDF viewer to read it.`);
    if (images)
      throw new PdfError('images', `This PDF has no text layer: its ${pages.length} page${pages.length === 1 ? ' is an image' : 's are images'} (e.g. a scan). Reading it needs OCR; take screenshots of the PDF viewer instead.`);
    throw new PdfError('notext', `This PDF has no extractable text (${pages.length} page${pages.length === 1 ? '' : 's'}).`);
  }
  return { pages: texts, pageCount: pages.length, undecoded, glyphs, images, truncated };
}
