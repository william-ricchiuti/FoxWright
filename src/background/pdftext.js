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
//
// The file comes from a web site and is parsed in the extension's background page, so nothing in
// it may hang that page or exhaust its memory: every loop is bounded by the limits below, the
// work is spread over many event-loop turns, and the only error that leaves this module is a
// PdfError. test/pdf-fuzz.mjs holds the hostile files this was hardened against.

export class PdfError extends Error {
  constructor(code, message) {
    super(message);
    this.code = code;
  }
}

export const PDF_LIMITS = {
  timeMs: 20000, // one extraction, start to finish
  fileBytes: 100 * 1048576, // the file itself (get_page_text downloads at most 60 MB)
  nesting: 100, // arrays and dictionaries inside each other
  objects: 1000000, // "n g obj" definitions in the file
  streamBytes: 64 * 1048576, // one stream after decoding (after each filter)
  decodedBytes: 512 * 1048576, // everything decoded during one extraction
  cacheBytes: 64 * 1048576, // decoded streams kept for reuse
  cmapTokens: 700000, // tokens read from one ToUnicode CMap
  cmapEntries: 200000, // codes one font's ToUnicode CMap may map
  cmapTarget: 256, // bytes of text one code may map to
  codespaces: 64, // codespace ranges per CMap
  widths: 200000, // glyph widths per font
  pages: 100000,
  trailers: 1000,
};

const mb = (n) => Math.round(n / 1048576);

/** Errors that end the whole extraction (the others cost one stream or one page). */
const isFatal = (e) => e instanceof PdfError && (e.code === 'timeout' || e.code === 'toolarge');
/** Use in a catch that is meant to shrug off a damaged object: limits still get through. */
function rethrowFatal(e) {
  if (isFatal(e))
    throw e;
}
/** Thrown for one stream or object that is over a limit: it is left out, the rest is still read. */
const skip = (what) => new PdfError('skip', what);

/** Time and size limits of one extraction. */
class Budget {
  constructor(timeMs) {
    this.timeMs = timeMs;
    this.deadline = Date.now() + timeMs;
    this.count = 0;
    this.decoded = 0;
    this.lastYield = Date.now();
  }

  expired() {
    return Date.now() > this.deadline;
  }

  check() {
    if (Date.now() > this.deadline)
      throw new PdfError('timeout', `This PDF takes too long to read: Foxwright's built-in PDF reader stops after ${Math.round(this.timeMs / 1000)} s. It may be very large, or built to be slow to read. Take screenshots of the PDF viewer instead.`);
  }

  /** Call from every loop that depends on the file; looks at the clock every few thousand units of work. */
  tick(n = 1) {
    if ((this.count += n) >= 4096) {
      this.count = 0;
      this.check();
    }
  }

  /** Bytes produced by decoding a stream. */
  spend(bytes) {
    this.decoded += bytes;
    if (this.decoded > PDF_LIMITS.decodedBytes)
      throw new PdfError('toolarge', `This PDF expands to more data than Foxwright's built-in PDF reader handles (over ${mb(PDF_LIMITS.decodedBytes)} MB once decompressed). Take screenshots of the PDF viewer instead.`);
  }

  /** Where waiting is possible: let the rest of the extension (messages, the Stop button) run now and then. */
  async breathe() {
    const now = Date.now();
    if (now > this.deadline)
      this.check();
    if (now - this.lastYield > 40) {
      await new Promise(r => setTimeout(r, 0));
      this.lastYield = Date.now();
    }
  }
}

/** Decoded bytes, growing as needed up to a maximum. */
class ByteOut {
  constructor(max, budget, hint = 4096) {
    this.max = max;
    this.budget = budget;
    this.b = new Uint8Array(Math.max(16, Math.min(max, hint)));
    this.n = 0;
  }

  room(k) {
    const need = this.n + k;
    if (need <= this.b.length)
      return;
    if (need > this.max) {
      this.budget.spend(this.n);
      throw skip(`a stream is larger than ${mb(this.max)} MB once decoded`);
    }
    let cap = this.b.length;
    while (cap < need)
      cap *= 2;
    const nb = new Uint8Array(Math.min(cap, this.max));
    nb.set(this.b.subarray(0, this.n));
    this.b = nb;
    this.budget.tick(64);
  }

  push(v) {
    if (this.n === this.b.length)
      this.room(1);
    this.b[this.n++] = v;
  }

  fill(v, k) {
    this.room(k);
    this.b.fill(v, this.n, this.n + k);
    this.n += k;
  }

  done() {
    this.budget.spend(this.n);
    return this.b.subarray(0, this.n);
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
const ESCAPES = { 110: 10, 114: 13, 116: 9, 98: 8, 102: 12 };
const TOKEN_CHARS = 64; // names and keywords longer than this are cut (nothing real is longer)

// ---------- lexer / object parser ----------

class Lexer {
  constructor(bytes, budget, pos = 0, end = bytes.length) {
    this.b = bytes;
    this.budget = budget;
    // A position that isn't a whole number inside the data (it can come from numbers in the file) reads nothing.
    this.pos = Number.isInteger(pos) && pos >= 0 ? pos : end;
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
    const b = this.b;
    for (;;) {
      this.budget.tick();
      this.skipWs();
      if (this.pos >= this.end)
        return null;
      const c = b[this.pos];
      if (c === 47) { // /Name
        let s = '';
        this.pos++;
        while (this.pos < this.end && !WS[b[this.pos]] && !DELIM[b[this.pos]]) {
          let ch = b[this.pos++];
          if (ch === 35 && this.pos + 1 < this.end) { // #xx
            ch = parseInt(String.fromCharCode(b[this.pos], b[this.pos + 1]), 16) || 0;
            this.pos += 2;
          }
          if (s.length < TOKEN_CHARS)
            s += String.fromCharCode(ch);
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
        continue;
      }
      // number or keyword
      const start = this.pos;
      while (this.pos < this.end && !WS[b[this.pos]] && !DELIM[b[this.pos]])
        this.pos++;
      if (this.pos === start) {
        this.pos++;
        continue;
      }
      let s = '';
      for (let i = start; i < this.pos && i < start + TOKEN_CHARS; i++)
        s += String.fromCharCode(b[i]);
      if (/^[+-]?(\d+\.?\d*|\.\d+)$/.test(s))
        return parseFloat(s);
      if (/^[+-]?\d*\.\d*[+-]\d*$/.test(s)) // malformed numbers like "0.-5" seen in the wild
        return parseFloat(s) || 0;
      return new POp(s);
    }
  }

  literal() {
    const b = this.b;
    // Find the closing parenthesis first, so the bytes go straight into an array of the right size.
    let depth = 1, p = this.pos + 1;
    while (p < this.end) {
      const c = b[p++];
      if (c === 92)
        p++;
      else if (c === 40)
        depth++;
      else if (c === 41 && --depth === 0)
        break;
    }
    const stop = Math.min(p, this.end);
    this.budget.tick((stop - this.pos) >> 6);
    const out = new Uint8Array(stop - this.pos);
    let n = 0;
    depth = 1;
    this.pos++;
    while (this.pos < stop) {
      let c = b[this.pos++];
      if (c === 92) { // backslash
        c = b[this.pos++];
        if (ESCAPES[c] !== undefined) {
          out[n++] = ESCAPES[c];
        } else if (c >= 48 && c <= 55) {
          let v = c - 48;
          for (let i = 0; i < 2 && b[this.pos] >= 48 && b[this.pos] <= 55; i++)
            v = v * 8 + (b[this.pos++] - 48);
          out[n++] = v & 255;
        } else if (c === 13) {
          if (b[this.pos] === 10)
            this.pos++;
        } else if (c !== 10 && c !== undefined) {
          out[n++] = c;
        }
        continue;
      }
      if (c === 40)
        depth++;
      else if (c === 41 && --depth === 0)
        break;
      out[n++] = c;
    }
    this.pos = stop;
    return new PStr(out.subarray(0, n));
  }

  hex() {
    const b = this.b;
    this.pos++;
    let close = this.pos;
    while (close < this.end && b[close] !== 62)
      close++;
    this.budget.tick((close - this.pos) >> 6);
    const out = new Uint8Array((close - this.pos + 1) >> 1);
    let n = 0, hi = -1;
    for (; this.pos < close; this.pos++) {
      const c = b[this.pos];
      const v = c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1;
      if (v < 0)
        continue;
      if (hi < 0) {
        hi = v;
      } else {
        out[n++] = hi * 16 + v;
        hi = -1;
      }
    }
    if (hi >= 0)
      out[n++] = hi * 16;
    this.pos = close + 1;
    return new PStr(out.subarray(0, n));
  }

  /** Parse one object (with "n g R" references), or return the operator token as POp. */
  object(tok = this.token(), depth = 0) {
    if (tok instanceof POp) {
      if ((tok.op === '[' || tok.op === '<<') && depth >= PDF_LIMITS.nesting)
        throw skip('arrays or dictionaries are nested too deeply');
      if (tok.op === '[') {
        const arr = [];
        for (;;) {
          const t = this.token();
          if (t === null || (t instanceof POp && t.op === ']'))
            break;
          arr.push(this.object(t, depth + 1));
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
          d[k.n] = this.object(this.token(), depth + 1);
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

/** Inflate at most `max` bytes. The input goes in small pieces, so a "zip bomb" is stopped while it is still small. */
async function inflate(data, budget, max) {
  for (const fmt of ['deflate', 'deflate-raw']) {
    let ds;
    try {
      ds = new DecompressionStream(fmt);
    } catch {
      continue;
    }
    const writer = ds.writable.getWriter();
    const reader = ds.readable.getReader();
    let stop = false;
    const feed = (async () => {
      try {
        for (let i = 0; i < data.length && !stop; i += 32768)
          await writer.write(data.subarray(i, i + 32768));
        if (!stop)
          await writer.close();
      } catch { /* corrupt data, or cancelled below */ }
    })();
    const chunks = [];
    let total = 0, over = false;
    try {
      for (;;) {
        const { done, value } = await reader.read();
        if (done)
          break;
        chunks.push(value);
        total += value.length;
        if (total > max || budget.expired()) {
          over = true;
          break;
        }
      }
    } catch { /* corrupt or trailing junk: keep what was decoded */ }
    stop = true;
    if (over) {
      reader.cancel().catch(() => {});
      writer.abort().catch(() => {});
    }
    await feed;
    budget.spend(total);
    budget.check();
    if (over)
      throw skip(`a stream is larger than ${mb(max)} MB once decompressed`);
    await budget.breathe();
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

function unpredict(data, parms, budget) {
  const pred = num(parms?.Predictor, 1);
  if (pred < 2)
    return data;
  const colors = Math.floor(num(parms.Colors, 1)), bpc = Math.floor(num(parms.BitsPerComponent, 8)), cols = Math.floor(num(parms.Columns, 1));
  // Nonsense parameters (zero or negative sizes, rows longer than the data): leave the data as it is.
  if (!(colors >= 1 && colors <= 256 && bpc >= 1 && bpc <= 32 && cols >= 1 && cols <= 0x7fffffff))
    return data;
  const bpp = Math.max(1, Math.ceil(colors * bpc / 8));
  const rowLen = Math.ceil(colors * bpc * cols / 8);
  if (!(rowLen >= 1 && rowLen <= data.length))
    return data;
  if (pred === 2) { // TIFF (8-bit only)
    const out = Uint8Array.from(data);
    for (let r = 0; r + rowLen <= out.length; r += rowLen) {
      budget.tick(1 + (rowLen >> 6));
      for (let i = bpp; i < rowLen; i++)
        out[r + i] = (out[r + i] + out[r + i - bpp]) & 255;
    }
    return out;
  }
  const rows = Math.floor(data.length / (rowLen + 1));
  const out = new Uint8Array(rows * rowLen);
  const prev = new Uint8Array(rowLen);
  for (let r = 0; r < rows; r++) {
    budget.tick(1 + (rowLen >> 6));
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

function asciiHex(data, budget) {
  const out = new Uint8Array((data.length + 1) >> 1); // never larger than half the input
  let n = 0, hi = -1;
  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    if (c === 62) // > end
      break;
    const v = c >= 48 && c <= 57 ? c - 48 : c >= 65 && c <= 70 ? c - 55 : c >= 97 && c <= 102 ? c - 87 : -1;
    if (v < 0)
      continue;
    if (hi < 0) {
      hi = v;
    } else {
      out[n++] = hi * 16 + v;
      hi = -1;
    }
  }
  if (hi >= 0)
    out[n++] = hi * 16;
  budget.tick(data.length >> 6);
  budget.spend(n);
  return out.subarray(0, n);
}

function ascii85(data, budget, max) {
  const out = new ByteOut(max, budget, data.length);
  let tuple = 0, n = 0;
  for (let i = 0; i < data.length; i++) {
    const c = data[i];
    if (c === 126) // ~> end
      break;
    if (WS[c])
      continue;
    if (c === 122 && n === 0) { // z
      out.fill(0, 4);
      continue;
    }
    if (c < 33 || c > 117)
      continue;
    tuple = tuple * 85 + (c - 33);
    if (++n === 5) {
      out.room(4);
      out.push((tuple >>> 24) & 255);
      out.push((tuple >>> 16) & 255);
      out.push((tuple >>> 8) & 255);
      out.push(tuple & 255);
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
  budget.tick(data.length >> 6);
  return out.done();
}

function lzw(data, early, budget, max) {
  const out = new ByteOut(max, budget, data.length * 2);
  // The table: entry i is entry prefix[i] followed by byte suffix[i]. At most 4096 entries (12-bit codes).
  const prefix = new Int16Array(4096).fill(-1), suffix = new Uint8Array(4096), first = new Uint8Array(4096), len = new Uint16Array(4096);
  for (let i = 0; i < 256; i++) {
    suffix[i] = first[i] = i;
    len[i] = 1;
  }
  const emit = (code) => {
    const l = len[code];
    out.room(l);
    let p = out.n + l;
    for (let c = code; c >= 0; c = prefix[c])
      out.b[--p] = suffix[c];
    out.n += l;
  };
  let next = 258, bits = 9, buf = 0, nbuf = 0, prev = -1;
  for (let i = 0; i < data.length; i++) {
    budget.tick();
    buf = (buf << 8) | data[i];
    nbuf += 8;
    while (nbuf >= bits) {
      const code = (buf >>> (nbuf - bits)) & ((1 << bits) - 1);
      nbuf -= bits;
      if (code === 256) {
        next = 258;
        bits = 9;
        prev = -1;
        continue;
      }
      if (code === 257)
        return out.done();
      let cur = code;
      if (code < next && len[code]) {
        emit(code);
      } else if (prev >= 0 && next < 4096) { // the entry being defined right now: prev + its own first byte
        emit(prev);
        out.push(first[prev]);
        cur = next;
      } else {
        return out.done(); // not a code this table has
      }
      if (prev >= 0 && next < 4096) {
        prefix[next] = prev;
        suffix[next] = first[cur === next ? prev : cur];
        first[next] = first[prev];
        len[next] = len[prev] + 1;
        next++;
      }
      prev = cur;
      if (next + early >= (1 << bits) && bits < 12)
        bits++;
    }
  }
  return out.done();
}

function runLength(data, budget, max) {
  const out = new ByteOut(max, budget, data.length * 2);
  for (let i = 0; i < data.length;) {
    budget.tick();
    const n = data[i++];
    if (n === 128)
      break;
    if (n < 128) {
      for (let j = 0; j <= n && i < data.length; j++) out.push(data[i++]);
    } else {
      out.fill(data[i++] ?? 0, 257 - n);
    }
  }
  return out.done();
}

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
  if (m) {
    const cp = parseInt(m[1], 16);
    return cp <= 0x10FFFF ? String.fromCodePoint(cp) : '';
  }
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

/** A character code from a CMap: 1 to 4 bytes (so it is always a whole number that can be counted). */
const isCode = (t) => t instanceof PStr && t.bytes.length >= 1 && t.bytes.length <= 4;
/** The text a code maps to, at most PDF_LIMITS.cmapTarget bytes of it. */
const target = (t) => (t instanceof PStr ? utf16be(t.bytes.length > PDF_LIMITS.cmapTarget ? t.bytes.subarray(0, PDF_LIMITS.cmapTarget) : t.bytes) : t instanceof PName ? glyphToUnicode(t.n) : '');

function parseCMap(data, budget) {
  const lex = new Lexer(data, budget);
  const map = new Map();
  const spaces = []; // [len, lo, hi]
  const toks = [];
  for (let t = lex.token(); t !== null; t = lex.token()) {
    toks.push(t);
    if (toks.length >= PDF_LIMITS.cmapTokens)
      break;
  }
  // Counts every entry written, also ones that overwrite an earlier one: the work is what is limited.
  let written = 0;
  const full = () => written >= PDF_LIMITS.cmapEntries;
  for (let i = 0; i < toks.length && !full(); i++) {
    const t = toks[i];
    if (!(t instanceof POp))
      continue;
    if (t.op === 'begincodespacerange') {
      for (i++; i + 1 < toks.length && toks[i] instanceof PStr; i += 2) {
        if (isCode(toks[i]) && isCode(toks[i + 1]) && spaces.length < PDF_LIMITS.codespaces)
          spaces.push([toks[i].bytes.length, bytesToInt(toks[i].bytes), bytesToInt(toks[i + 1].bytes)]);
      }
    } else if (t.op === 'beginbfchar') {
      for (i++; i + 1 < toks.length && toks[i] instanceof PStr && !full(); i += 2) {
        budget.tick();
        if (isCode(toks[i])) {
          written++;
          map.set(`${toks[i].bytes.length}:${bytesToInt(toks[i].bytes)}`, target(toks[i + 1]));
        }
      }
    } else if (t.op === 'beginbfrange') {
      for (i++; i + 2 < toks.length && toks[i] instanceof PStr && !full(); i += 3) {
        const usable = isCode(toks[i]) && isCode(toks[i + 1]);
        const len = toks[i].bytes.length;
        const lo = usable ? bytesToInt(toks[i].bytes) : 0;
        // How many codes after lo the range covers: a whole number, so the loops below always end.
        const more = usable ? Math.min(65535, bytesToInt(toks[i + 1].bytes) - lo) : -1;
        const dst = toks[i + 2];
        if (dst instanceof POp && dst.op === '[') { // array form
          const arr = [];
          for (i += 3; i < toks.length && !(toks[i] instanceof POp && toks[i].op === ']'); i++)
            arr.push(toks[i]);
          i -= 2; // the loop adds 3; land just past ']'
          for (let k = 0; k <= more && k < arr.length && !full(); k++) {
            budget.tick();
            written++;
            map.set(`${len}:${lo + k}`, arr[k] instanceof PStr ? target(arr[k]) : '');
          }
          continue;
        }
        if (dst instanceof PStr) {
          const base = dst.bytes.length > PDF_LIMITS.cmapTarget ? dst.bytes.subarray(0, PDF_LIMITS.cmapTarget) : dst.bytes;
          for (let k = 0; k <= more && !full(); k++) {
            budget.tick();
            const b = Uint8Array.from(base);
            let carry = k; // add to the last byte(s)
            for (let j = b.length - 1; j >= 0 && carry; j--) {
              const v = b[j] + carry;
              b[j] = v & 255;
              carry = v >> 8;
            }
            written++;
            map.set(`${len}:${lo + k}`, utf16be(b));
          }
        }
      }
    }
  }
  return { map, spaces };
}

// ---------- the document ----------

class Doc {
  constructor(bytes, budget) {
    this.b = bytes;
    this.budget = budget;
    this.offsets = new Map(); // obj num -> byte offset of "n g obj"
    this.inStream = new Map(); // obj num -> [objstm num, index]
    this.cache = new Map();
    this.decoded = new Map(); // stream -> decoded bytes (or null), for streams used again and again
    this.cachedBytes = 0;
    this.skipped = 0; // streams left out because they were over a limit
    this.ends = null; // positions of every "endstream", found on first use
  }

  async scan() {
    // latin1 view for fast keyword search
    const s = latin1(this.b);
    this.s = s;
    const re = /(?:^|[^0-9])(\d{1,10})[ \t\r\n\f\0]+(\d{1,5})[ \t\r\n\f\0]+obj\b/g;
    let m, n = 0;
    while ((m = re.exec(s))) {
      this.offsets.set(+m[1], m.index + m[0].length); // later definitions (incremental updates) win
      if (this.offsets.size > PDF_LIMITS.objects)
        throw new PdfError('toolarge', `This PDF has more than ${PDF_LIMITS.objects.toLocaleString('en-US')} objects, more than Foxwright's built-in PDF reader handles. Take screenshots of the PDF viewer instead.`);
      if (++n % 2000 === 0)
        await this.budget.breathe();
    }
    this.trailers = [];
    const tre = /trailer[\s\0]*<</g;
    while ((m = tre.exec(s))) {
      const lex = new Lexer(this.b, this.budget, m.index + 7);
      try {
        const d = lex.object();
        if (d && typeof d === 'object')
          this.trailers.push(d);
      } catch (e) {
        rethrowFatal(e);
      }
      if (this.trailers.length > PDF_LIMITS.trailers)
        this.trailers.shift(); // the newest ones are the ones that count
      if (++n % 2000 === 0)
        await this.budget.breathe();
    }
  }

  /** Position of the first "endstream" at or after `start` (the end of the file if there is none). */
  endstreamAfter(start) {
    if (!this.ends) {
      this.ends = [];
      for (let k = this.s.indexOf('endstream'); k >= 0; k = this.s.indexOf('endstream', k + 9)) {
        this.ends.push(k);
        this.budget.tick();
      }
    }
    let lo = 0, hi = this.ends.length;
    while (lo < hi) {
      const mid = (lo + hi) >> 1;
      if (this.ends[mid] < start)
        lo = mid + 1;
      else
        hi = mid;
    }
    return lo < this.ends.length ? this.ends[lo] : this.b.length;
  }

  /** Raw object at an offset (just after "obj"). */
  parseAt(pos) {
    const lex = new Lexer(this.b, this.budget, pos);
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
        if (typeof len === 'number' && Number.isInteger(len) && len >= 0 && start + len <= this.b.length) {
          const after = latin1(this.b.subarray(start + len, Math.min(this.b.length, start + len + 20)));
          if (/^[\s\0]*endstream/.test(after))
            end = start + len;
        }
        if (end < 0) {
          end = this.endstreamAfter(start);
          while (end > start && (this.b[end - 1] === 10 || this.b[end - 1] === 13))
            end--;
        }
        return new PStream(obj, this.b.subarray(start, Math.max(start, end)));
      }
      lex.pos = save;
    }
    return obj;
  }

  async loadObjectStreams() {
    for (const [num, off] of this.offsets) {
      await this.budget.breathe();
      let o;
      try {
        o = this.parseAt(off);
      } catch (e) {
        rethrowFatal(e);
        continue;
      }
      this.cache.set(num, o);
      if (!(o instanceof PStream))
        continue;
      const type = o.dict.Type?.n;
      if (type === 'XRef') {
        this.trailers.push(o.dict);
        if (this.trailers.length > PDF_LIMITS.trailers)
          this.trailers.shift();
      }
      if (type !== 'ObjStm')
        continue;
      const data = await this.decode(o);
      if (!data)
        continue;
      const n = num_(o.dict.N), first = num_(o.dict.First);
      const lex = new Lexer(data, this.budget);
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
    this.budget.tick();
    let obj = null;
    try {
      if (this.offsets.has(n)) {
        obj = this.parseAt(this.offsets.get(n));
      } else if (this.inStream.has(n)) {
        const [sn, i] = this.inStream.get(n);
        const st = this.objStmData.get(sn);
        const [, off] = st.entries[i];
        obj = new Lexer(st.data, this.budget, st.first + off).object();
      }
    } catch (e) {
      rethrowFatal(e);
      obj = null;
    }
    if (obj instanceof PRef)
      obj = this.get(obj, depth + 1);
    this.cache.set(n, obj);
    return obj;
  }

  /** A stream's data with its filters undone, or null (image data, an unknown filter, or over a size limit). */
  async decode(stream) {
    if (this.decoded.has(stream))
      return this.decoded.get(stream);
    let filters = this.get(stream.dict.Filter);
    if (!Array.isArray(filters))
      filters = filters ? [filters] : [];
    if (!filters.length)
      return stream.raw; // already in memory: nothing to remember
    let data;
    try {
      data = await this.applyFilters(stream, filters);
    } catch (e) {
      if (!(e instanceof PdfError && e.code === 'skip'))
        throw e;
      this.skipped++;
      data = null;
    }
    this.cachedBytes += data ? data.length : 0;
    if (this.cachedBytes > PDF_LIMITS.cacheBytes) {
      this.decoded.clear();
      this.cachedBytes = data ? data.length : 0;
    }
    this.decoded.set(stream, data);
    return data;
  }

  async applyFilters(stream, filters) {
    const budget = this.budget, max = PDF_LIMITS.streamBytes;
    let data = stream.raw;
    let parms = this.get(stream.dict.DecodeParms ?? stream.dict.DP);
    if (!Array.isArray(parms))
      parms = [parms];
    for (let i = 0; i < filters.length && data && i < 16; i++) {
      const f = this.get(filters[i])?.n;
      const p = this.get(parms[i]);
      if (f === 'FlateDecode' || f === 'Fl')
        data = unpredict(await inflate(data, budget, max) || new Uint8Array(0), p, budget);
      else if (f === 'LZWDecode' || f === 'LZW')
        data = unpredict(lzw(data, num(p?.EarlyChange, 1) ? 1 : 0, budget, max), p, budget);
      else if (f === 'ASCIIHexDecode' || f === 'AHx')
        data = asciiHex(data, budget);
      else if (f === 'ASCII85Decode' || f === 'A85')
        data = ascii85(data, budget, max);
      else if (f === 'RunLengthDecode' || f === 'RL')
        data = runLength(data, budget, max);
      else if (f === 'Crypt' && this.get(p?.Name)?.n === 'Identity')
        continue;
      else
        data = null; // image codecs and unknown filters: not text
      await budget.breathe();
    }
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

  /** Call fn(code, byteLength) for each character code in a string's bytes. */
  eachCode(bytes, fn) {
    const spaces = this.toUni?.spaces;
    const bySpace = !!(spaces && spaces.length);
    for (let i = 0; i < bytes.length;) {
      let len = this.twoByte ? 2 : 1;
      if (bySpace) {
        len = 0;
        let v = 0;
        for (let l = 1; l <= 4 && !len; l++) {
          if (i + l > bytes.length)
            break;
          v = v * 256 + bytes[i + l - 1];
          for (let k = 0; k < spaces.length; k++) {
            if (spaces[k][0] === l && v >= spaces[k][1] && v <= spaces[k][2]) {
              len = l;
              break;
            }
          }
        }
        if (!len)
          len = this.twoByte ? 2 : 1;
      }
      len = Math.min(len, bytes.length - i);
      let code = 0;
      for (let k = 0; k < len; k++)
        code = code * 256 + bytes[i + k];
      fn(code, len);
      i += len;
    }
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

/** A character code as fonts number them: a whole number that is safe to count from. */
const codeNum = (v) => (typeof v === 'number' && Number.isInteger(v) && v >= 0 && v <= 0xffffffff ? v : -1);

async function loadFont(doc, dict) {
  const budget = doc.budget;
  const f = new Font();
  dict = doc.get(dict);
  if (!dict || typeof dict !== 'object')
    return f;
  const subtype = doc.get(dict.Subtype)?.n;
  const tu = doc.get(dict.ToUnicode);
  if (tu instanceof PStream) {
    const data = await doc.decode(tu);
    if (data)
      f.toUni = parseCMap(data, budget);
    await budget.breathe();
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
        let written = 0; // every width set, also ones that overwrite an earlier one
        const full = () => written >= PDF_LIMITS.widths;
        for (let i = 0; i < w.length && !full();) {
          budget.tick();
          const c = codeNum(doc.get(w[i]));
          const n2 = doc.get(w[i + 1]);
          if (Array.isArray(n2)) {
            for (let j = 0; j < n2.length && c >= 0 && !full(); j++, written++)
              f.widths.set(c + j, num(doc.get(n2[j])));
            i += 2;
          } else {
            const wd = num(doc.get(w[i + 2]));
            // Count the codes with a whole number, so the loop ends whatever the file says.
            const more = c >= 0 && codeNum(n2) >= 0 ? Math.min(65535, n2 - c) : -1;
            for (let k = 0; k <= more && !full(); k++, written++)
              f.widths.set(c + k, wd);
            budget.tick(more > 0 ? more : 1);
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
      budget.tick();
      const d = doc.get(d0);
      if (typeof d === 'number')
        code = d;
      else if (d instanceof PName && code >= 0 && code < 256 && Number.isInteger(code))
        f.enc[code++] = glyphToUnicode(d.n);
    }
  }
  const widths = doc.get(dict.Widths);
  if (Array.isArray(widths)) {
    const fc = num(doc.get(dict.FirstChar));
    f.widths = new Map();
    for (let i = 0; i < widths.length && i < PDF_LIMITS.widths; i++)
      f.widths.set(fc + i, num(doc.get(widths[i])));
    f.dw = num(doc.get(fd?.MissingWidth), 500) || 500;
  }
  return f;
}

// ---------- content streams ----------

const mul = (m, n) => [m[0] * n[0] + m[1] * n[2], m[0] * n[1] + m[1] * n[3], m[2] * n[0] + m[3] * n[2], m[2] * n[1] + m[3] * n[3], m[4] * n[0] + m[5] * n[2] + n[4], m[4] * n[1] + m[5] * n[3] + n[5]];
const ID = [1, 0, 0, 1, 0, 0];

/**
 * Collects a page's text. Pieces are kept in a list and joined once at the end, and spaces at the
 * end are only counted until something follows them: so each addition costs the same, however
 * much text there already is.
 */
class TextSink {
  constructor() {
    this.parts = [];
    this.length = 0; // characters so far (without the spaces still waiting at the end)
    this.spaces = 0; // spaces at the very end, not yet in parts
    this.lastWs = false; // the last character in parts is white space
    this.last = null; // { x, y, size } end of the last drawn text, in device space
    this.undecoded = 0;
    this.glyphs = 0;
  }

  add(t) {
    if (!t)
      return;
    let e = t.length;
    while (e > 0 && t.charCodeAt(e - 1) === 32)
      e--;
    if (e > 0) {
      if (this.spaces) {
        this.parts.push(' '.repeat(this.spaces));
        this.length += this.spaces;
        this.spaces = 0;
      }
      this.parts.push(e === t.length ? t : t.slice(0, e));
      this.length += e;
      this.lastWs = /\s/.test(t[e - 1]);
    }
    this.spaces += t.length - e;
  }

  /** Separate from the previous text by a newline or space, depending on where this text starts. */
  place(x, y, size) {
    const l = this.last;
    if (l && (this.length || this.spaces)) {
      const lh = Math.max(1, Math.max(size, l.size));
      const dy = Math.abs(y - l.y);
      if (dy > lh * 0.5) {
        this.spaces = 0; // no spaces before a line break
        const nl = dy > lh * 1.9 ? '\n\n' : '\n';
        this.parts.push(nl);
        this.length += nl.length;
        this.lastWs = true;
      } else if (x - l.x > lh * 0.18 || x < l.x - lh * 4) {
        if (!this.spaces && !this.lastWs)
          this.spaces = 1;
      }
    }
  }

  /** The page's text, tidied: no spaces before line breaks, at most one empty line in a row. */
  text() {
    const lines = (this.parts.join('') + ' '.repeat(this.spaces)).split('\n');
    const out = [];
    let empty = 0;
    for (let line of lines) {
      let e = line.length;
      while (e > 0 && (line.charCodeAt(e - 1) === 32 || line.charCodeAt(e - 1) === 9))
        e--;
      if (e < line.length)
        line = line.slice(0, e);
      empty = line ? 0 : empty + 1;
      if (empty <= 1)
        out.push(line);
    }
    return out.join('\n').trim();
  }
}

async function runContent(doc, data, resources, ctm, sink, fontCache, depth, limits) {
  if (depth > 8 || !data)
    return;
  const budget = doc.budget;
  resources = doc.get(resources) || {};
  const lex = new Lexer(data, budget);
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
    font.eachCode(str.bytes, (code, len) => {
      budget.tick();
      const t = font.text(code, len);
      sink.glyphs++;
      if (t === null)
        sink.undecoded++;
      else
        sink.add(t);
      if (sink.length + sink.spaces > limits.maxChars)
        throw new PdfError('limit', 'too much text');
      const w = font.width(code);
      const tx = (w * size + cs + (len === 1 && code === 32 ? ws : 0)) * th;
      tm = [tm[0], tm[1], tm[2], tm[3], tm[4] + tx * tm[0], tm[5] + tx * tm[1]];
    });
    const end = trm();
    sink.last = { x: end[4], y: end[5], size: scaled };
  };
  const nextLine = (tx, ty) => {
    lm = mul([1, 0, 0, 1, tx, ty], lm);
    tm = lm;
  };

  await budget.breathe();
  for (let t = lex.token(); t !== null; t = lex.token()) {
    if (!(t instanceof POp) || t.op === '[' || t.op === '<<') {
      ops.push(lex.object(t));
      if (ops.length > 10000)
        ops.length = 0;
      continue;
    }
    if (++limits.ops % 256 === 0)
      await budget.breathe();
    const op = t.op;
    const a = ops;
    switch (op) {
      case 'BT': tm = lm = ID; break;
      case 'Tf': {
        const name = a[0] instanceof PName ? a[0].n : '';
        size = num(a[1], 1);
        const ref = fontsDict[name];
        // Fonts are usually indirect objects shared between pages and forms: those are loaded once
        // per document. A font written inside the resource dictionary is kept per content stream.
        const cache = ref instanceof PRef ? limits.fonts : fontCache;
        const key = ref instanceof PRef ? ref.num : ref && typeof ref === 'object' ? ref : `n${name}`;
        if (!cache.has(key))
          cache.set(key, await loadFont(doc, ref));
        font = cache.get(key);
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
      case 'q': if (stack.length < 10000) stack.push(ctm); break;
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
            try {
              const fm = doc.get(x.dict.Matrix);
              const m = Array.isArray(fm) && fm.length === 6 ? fm.map(v => num(doc.get(v))) : ID;
              await runContent(doc, await doc.decode(x), x.dict.Resources || resources, mul(m, ctm), sink, new Map(), depth + 1, limits);
            } finally {
              limits.forms.delete(x);
            }
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
        budget.tick((i - lex.pos) >> 6);
        lex.pos = Math.min(i + 2, b.length);
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
 * Returns { pages: string[], pageCount, undecoded, glyphs, images, truncated, stopped, skipped }.
 *   truncated: not all of the text is there. stopped says why, if it wasn't the maxChars limit:
 *     'time' (the time limit ran out) or 'size' (too much data once decompressed).
 *   skipped: streams left out because they alone were over a size limit.
 * Throws only PdfError, with code 'encrypted', 'invalid', 'notext', 'images', 'timeout' or 'toolarge'.
 * Options: maxChars (default 5,000,000), timeMs (default PDF_LIMITS.timeMs).
 */
export async function extractPdfText(bytes, opts = {}) {
  try {
    return await extract(bytes, opts);
  } catch (e) {
    if (e instanceof PdfError && e.code !== 'skip' && e.code !== 'limit')
      throw e;
    // A bug or an unexpected shape in the file: one clear error instead of whatever was thrown.
    throw new PdfError('invalid', `Foxwright's built-in PDF reader couldn't make sense of this PDF; it may be damaged (${String(e?.message || e).slice(0, 120)}). Take screenshots of the PDF viewer instead.`);
  }
}

async function extract(bytes, { maxChars = 5000000, timeMs = PDF_LIMITS.timeMs } = {}) {
  if (!(bytes instanceof Uint8Array))
    bytes = new Uint8Array(bytes);
  const head = latin1(bytes.subarray(0, 1024));
  if (!/%PDF-/.test(head))
    throw new PdfError('invalid', 'This is not a PDF file (no %PDF header).');
  if (bytes.length > PDF_LIMITS.fileBytes)
    throw new PdfError('toolarge', `This PDF is ${mb(bytes.length)} MB, more than Foxwright's built-in PDF reader handles (${mb(PDF_LIMITS.fileBytes)} MB). Take screenshots of the PDF viewer instead.`);
  const budget = new Budget(timeMs);
  const doc = new Doc(bytes, budget);
  await doc.scan();
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
    budget.tick();
    node = doc.get(node);
    if (!node || typeof node !== 'object' || seen.has(node) || depth > 50 || pages.length >= PDF_LIMITS.pages)
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
      budget.tick();
      const o = doc.get(new PRef(n, 0));
      if (o && typeof o === 'object' && o.Type instanceof PName && o.Type.n === 'Page' && pages.length < PDF_LIMITS.pages)
        pages.push({ page: o, res: o.Resources });
    }
  }
  if (!pages.length)
    throw new PdfError('invalid', 'Couldn\'t find any pages in this PDF (it may be damaged or use features Foxwright\'s PDF reader doesn\'t support).');

  const texts = [];
  let undecoded = 0, glyphs = 0, images = 0, total = 0, truncated = false, stopError = null;
  const fonts = new Map(); // fonts that are indirect objects, by object number: loaded once per document
  const fontCache = new Map();
  for (const { page, res } of pages) {
    const sink = new TextSink();
    try {
      await budget.breathe();
      let contents = doc.get(page.Contents);
      if (!Array.isArray(contents))
        contents = contents ? [contents] : [];
      const parts = [];
      let size = 0;
      for (const c of contents) {
        budget.tick();
        const s = doc.get(c);
        if (s instanceof PStream) {
          const d = await doc.decode(s);
          if (d) {
            size += d.length + 1;
            if (size > PDF_LIMITS.streamBytes) {
              doc.skipped++;
              throw skip('a page\'s content is too large');
            }
            parts.push(d, Uint8Array.of(10));
          }
        }
      }
      await runContent(doc, concat(parts, size), res, ID, sink, fontCache, 0, { maxChars: Math.max(0, maxChars - total), forms: new Set(), fonts, ops: 0 });
    } catch (e) {
      if (e instanceof PdfError && e.code === 'limit')
        truncated = true;
      else if (isFatal(e))
        stopError = e;
      // anything else: this page is damaged or over a limit; keep what it gave and go on
    }
    undecoded += sink.undecoded;
    glyphs += sink.glyphs;
    images += sink.images || 0;
    const t = sink.text();
    texts.push(t);
    total += t.length;
    if (stopError || truncated || total >= maxChars) {
      truncated = true;
      break;
    }
  }
  let textChars = 0;
  for (const t of texts) {
    for (let i = 0; i < t.length; i++) {
      const c = t.charCodeAt(i);
      if (c !== 32 && c !== 10 && c !== 9 && c !== 13 && c !== 160)
        textChars++;
    }
  }
  if (!textChars) {
    if (stopError)
      throw stopError;
    if (glyphs && undecoded)
      throw new PdfError('notext', `This PDF draws its text with fonts that have no Unicode mapping, so Foxwright can't turn it back into text (${pages.length} page${pages.length === 1 ? '' : 's'}). Take screenshots of the PDF viewer to read it.`);
    if (images)
      throw new PdfError('images', `This PDF has no text layer: its ${pages.length} page${pages.length === 1 ? ' is an image' : 's are images'} (e.g. a scan). Reading it needs OCR; take screenshots of the PDF viewer instead.`);
    if (doc.skipped)
      throw new PdfError('toolarge', `This PDF's pages are larger than Foxwright's built-in PDF reader handles (over ${mb(PDF_LIMITS.streamBytes)} MB each once decompressed). Take screenshots of the PDF viewer instead.`);
    throw new PdfError('notext', `This PDF has no extractable text (${pages.length} page${pages.length === 1 ? '' : 's'}).`);
  }
  return { pages: texts, pageCount: pages.length, undecoded, glyphs, images, truncated, stopped: stopError ? (stopError.code === 'timeout' ? 'time' : 'size') : undefined, skipped: doc.skipped };
}
