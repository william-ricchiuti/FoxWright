// GIF recording of agent sessions (Kitsune's equivalent of Claude in Chrome's gif_creator).
// Frames are the same JPEG screenshots Kitsune already takes; they are decoded, scaled,
// marked with the click position, quantized and encoded only on export.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import jpeg from 'jpeg-js';
import { GIFEncoder, quantize, applyPalette } from 'gifenc';

const MAX_FRAMES = 150;
const recordings = new Map(); // tabId -> { active, frames: [{ jpeg, click?: [x, y], drag?: [x0, y0, x1, y1], label?, at }] }

export const DEFAULT_OPTIONS = { showClickIndicators: true, showDragPaths: true, showActionLabels: true, showProgressBar: true, showWatermark: true, quality: 10 };
/** quality 1 (best, 256 colors) ... 30 (smallest, 32 colors), like Claude in Chrome's scale. */
const colorsFor = (q) => Math.round(256 - (Math.min(30, Math.max(1, q)) - 1) * (224 / 29));

export function startRecording(tabId) {
  recordings.set(tabId, { active: true, frames: [] });
}

export function stopRecording(tabId) {
  const r = recordings.get(tabId);
  if (r)
    r.active = false;
  return r?.frames.length || 0;
}

export function clearRecording(tabId) {
  recordings.delete(tabId);
}

export function isRecording(tabId) {
  return !!recordings.get(tabId)?.active;
}

export function frameCount(tabId) {
  return recordings.get(tabId)?.frames.length || 0;
}

export function addFrame(tabId, jpegBase64, click, { drag, label } = {}) {
  const r = recordings.get(tabId);
  if (!r || !r.active || !jpegBase64)
    return;
  r.frames.push({ jpeg: jpegBase64, click, drag, label, at: Date.now() });
  if (r.frames.length > MAX_FRAMES)
    r.frames.splice(1, 1); // keep the first frame, drop the oldest after it
}

function scaleRGBA(src, sw, sh, dw, dh) {
  const out = new Uint8Array(dw * dh * 4);
  const xr = sw / dw, yr = sh / dh;
  for (let y = 0; y < dh; y++) {
    const sy0 = Math.floor(y * yr), sy1 = Math.min(sh, Math.max(sy0 + 1, Math.floor((y + 1) * yr)));
    for (let x = 0; x < dw; x++) {
      const sx0 = Math.floor(x * xr), sx1 = Math.min(sw, Math.max(sx0 + 1, Math.floor((x + 1) * xr)));
      let r = 0, g = 0, b = 0, n = 0;
      for (let yy = sy0; yy < sy1; yy++) {
        for (let xx = sx0; xx < sx1; xx++) {
          const i = (yy * sw + xx) * 4;
          r += src[i]; g += src[i + 1]; b += src[i + 2]; n++;
        }
      }
      const o = (y * dw + x) * 4;
      out[o] = r / n; out[o + 1] = g / n; out[o + 2] = b / n; out[o + 3] = 255;
    }
  }
  return out;
}

function drawRing(px, w, h, cx, cy, radius, rgb) {
  for (let y = Math.max(0, cy - radius - 2); y <= Math.min(h - 1, cy + radius + 2); y++) {
    for (let x = Math.max(0, cx - radius - 2); x <= Math.min(w - 1, cx + radius + 2); x++) {
      const d = Math.hypot(x - cx, y - cy);
      if (Math.abs(d - radius) <= 1.6 || d <= 2.5) {
        const o = (y * w + x) * 4;
        px[o] = rgb[0]; px[o + 1] = rgb[1]; px[o + 2] = rgb[2];
      }
    }
  }
}

function defaultDir() {
  if (process.env.KITSUNE_GIF_DIR && fs.existsSync(process.env.KITSUNE_GIF_DIR))
    return process.env.KITSUNE_GIF_DIR;
  const dl = path.join(os.homedir(), 'Downloads');
  return fs.existsSync(dl) ? dl : process.cwd();
}

/**
 * Encode the recording to a GIF file. Returns { file, frames, bytes, annotated }.
 * `annotate(frame, spec)` (optional) returns the frame as a JPEG with the overlays drawn, at
 * spec.width; the extension does this with a canvas so labels can use real fonts. Without it (or
 * if it fails) only click indicators are drawn, here.
 */
export async function exportGif(tabId, { filename, width = 800, options = {}, annotate } = {}) {
  const r = recordings.get(tabId);
  if (!r || !r.frames.length)
    throw new Error('Nothing recorded for this tab. Call gif_creator with action "start_recording" first, then act.');
  const o = { ...DEFAULT_OPTIONS, ...Object.fromEntries(Object.entries(options || {}).filter(([, v]) => v !== undefined)) };
  const enc = GIFEncoder();
  let outW = 0, outH = 0, annotated = !!annotate;
  for (let i = 0; i < r.frames.length; i++) {
    const f = r.frames[i];
    let img = null;
    if (annotated) {
      try {
        const spec = {
          width, click: o.showClickIndicators ? f.click : undefined, drag: o.showDragPaths ? f.drag : undefined,
          label: o.showActionLabels ? f.label : undefined, progress: o.showProgressBar ? (i + 1) / r.frames.length : undefined,
          watermark: !!o.showWatermark,
        };
        img = jpeg.decode(Buffer.from(await annotate(f.jpeg, spec), 'base64'), { useTArray: true, formatAsRGBA: true });
      } catch {
        annotated = false; // e.g. an older extension: fall back to plain frames for the whole GIF
        img = null;
      }
    }
    img = img || jpeg.decode(Buffer.from(f.jpeg, 'base64'), { useTArray: true, formatAsRGBA: true });
    const scale = Math.min(1, width / img.width);
    const w = outW || Math.round(img.width * scale), h = outH || Math.round(img.height * scale);
    outW = w;
    outH = h;
    const px = scaleRGBA(img.data, img.width, img.height, w, h);
    if (!annotated && f.click && o.showClickIndicators) {
      const cx = Math.round(f.click[0] * (w / img.width)), cy = Math.round(f.click[1] * (h / img.height));
      drawRing(px, w, h, cx, cy, 11, [214, 64, 36]);
      drawRing(px, w, h, cx, cy, 13, [255, 255, 255]);
    }
    const palette = quantize(px, colorsFor(o.quality));
    const index = applyPalette(px, palette);
    const next = r.frames[i + 1];
    const delay = i === r.frames.length - 1 ? 2500 : Math.max(500, Math.min(2000, next ? next.at - f.at : 1000));
    enc.writeFrame(index, w, h, { palette, delay });
  }
  enc.finish();
  const bytes = enc.bytes();
  // Only a file name is honoured (no directories), so an agent can't write GIFs over arbitrary files.
  const name = path.basename(filename || `kitsune-${new Date().toISOString().replace(/[:.]/g, '-').slice(0, 19)}.gif`).replace(/[^\w.-]/g, '_');
  let file = path.join(defaultDir(), name.endsWith('.gif') ? name : name + '.gif');
  // 'wx' never follows an existing file or symlink: pick a new name instead of overwriting.
  try {
    fs.writeFileSync(file, bytes, { flag: 'wx' });
  } catch (e) {
    if (e.code !== 'EEXIST')
      throw e;
    file = file.replace(/\.gif$/, `-${Date.now()}.gif`);
    fs.writeFileSync(file, bytes, { flag: 'wx' });
  }
  return { file, frames: r.frames.length, bytes: bytes.length, annotated };
}
