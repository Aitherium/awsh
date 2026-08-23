/**
 * image-preview.ts — Render raster images INLINE in the terminal as Unicode
 * half-blocks (▀) with 24-bit colour.
 *
 * Why half-blocks instead of sixel / iTerm2 / kitty graphics: those protocols
 * each work in only SOME terminals (sixel needs Windows Terminal ≥1.22, iTerm2's
 * OSC-1337 needs iTerm2/WezTerm, kitty needs kitty) and several need the image
 * re-encoded. The half-block trick — print '▀' with the FOREGROUND set to the top
 * pixel and the BACKGROUND to the bottom pixel, so one character cell shows TWO
 * vertical pixels — works in EVERY 24-bit-colour terminal, including the Windows
 * Terminal the fleet runs on. Decoding uses node's built-in zlib (no new deps),
 * so PNG (the format ComfyUI/AitherCanvas emit) renders for real; other formats
 * fall back to the OS viewer at the call site.
 */

import { readFileSync } from 'node:fs';
import { inflateSync } from 'node:zlib';

export interface DecodedImage {
  width: number;
  height: number;
  /** RGBA, 4 bytes per pixel, row-major. */
  rgba: Uint8Array;
}

/** Paeth predictor (PNG filter type 4). */
function paeth(a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  if (pa <= pb && pa <= pc) return a;
  if (pb <= pc) return b;
  return c;
}

/**
 * Minimal PNG decoder — enough for the 8-bit images the fleet produces:
 * colour types 0 (grey), 2 (RGB), 3 (palette), 6 (RGBA), and all 5 scanline
 * filters. Returns null for anything it can't handle (interlaced, 16-bit, etc.)
 * so the caller can fall back to the OS viewer.
 */
export function decodePNG(buf: Buffer): DecodedImage | null {
  // Signature.
  const SIG = [137, 80, 78, 71, 13, 10, 26, 10];
  for (let i = 0; i < 8; i++) if (buf[i] !== SIG[i]) return null;

  let pos = 8;
  let width = 0, height = 0, bitDepth = 0, colorType = 0, interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;
  const idat: Buffer[] = [];

  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos); pos += 4;
    const type = buf.toString('ascii', pos, pos + 4); pos += 4;
    const data = buf.subarray(pos, pos + len); pos += len;
    pos += 4; // CRC — skip.
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      interlace = data[12];
    } else if (type === 'PLTE') {
      palette = new Uint8Array(data);
    } else if (type === 'tRNS') {
      trns = new Uint8Array(data);
    } else if (type === 'IDAT') {
      idat.push(Buffer.from(data));
    } else if (type === 'IEND') {
      break;
    }
  }

  if (!width || !height) return null;
  if (bitDepth !== 8) return null;       // 1/2/4/16-bit unsupported (keep it small)
  if (interlace !== 0) return null;      // Adam7 unsupported

  const channels = colorType === 2 ? 3 : colorType === 6 ? 4 : colorType === 0 ? 1 : colorType === 3 ? 1 : 0;
  if (channels === 0) return null;

  let raw: Buffer;
  try { raw = inflateSync(Buffer.concat(idat)); } catch { return null; }

  const stride = width * channels;
  const out = new Uint8Array(width * height * 4);
  const line = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  let rp = 0;

  for (let y = 0; y < height; y++) {
    const filter = raw[rp++];
    for (let x = 0; x < stride; x++) {
      const rawByte = raw[rp++];
      const a = x >= channels ? line[x - channels] : 0;
      const b = prev[x];
      const c = x >= channels ? prev[x - channels] : 0;
      let val: number;
      switch (filter) {
        case 0: val = rawByte; break;
        case 1: val = rawByte + a; break;
        case 2: val = rawByte + b; break;
        case 3: val = rawByte + ((a + b) >> 1); break;
        case 4: val = rawByte + paeth(a, b, c); break;
        default: val = rawByte; break;
      }
      line[x] = val & 0xff;
    }
    // Expand the scanline into RGBA.
    for (let x = 0; x < width; x++) {
      const o = (y * width + x) * 4;
      if (colorType === 2) {           // RGB
        out[o] = line[x * 3]; out[o + 1] = line[x * 3 + 1]; out[o + 2] = line[x * 3 + 2]; out[o + 3] = 255;
      } else if (colorType === 6) {    // RGBA
        out[o] = line[x * 4]; out[o + 1] = line[x * 4 + 1]; out[o + 2] = line[x * 4 + 2]; out[o + 3] = line[x * 4 + 3];
      } else if (colorType === 0) {    // grey
        const g = line[x]; out[o] = g; out[o + 1] = g; out[o + 2] = g; out[o + 3] = 255;
      } else if (colorType === 3 && palette) { // palette
        const idx = line[x];
        out[o] = palette[idx * 3]; out[o + 1] = palette[idx * 3 + 1]; out[o + 2] = palette[idx * 3 + 2];
        out[o + 3] = trns && idx < trns.length ? trns[idx] : 255;
      }
    }
    prev.set(line);
  }

  return { width, height, rgba: out };
}

/** Nearest-neighbour sample of the source image at normalised (u,v) → RGBA. */
function sample(img: DecodedImage, u: number, v: number): [number, number, number, number] {
  const x = Math.min(img.width - 1, Math.max(0, Math.floor(u * img.width)));
  const y = Math.min(img.height - 1, Math.max(0, Math.floor(v * img.height)));
  const o = (y * img.width + x) * 4;
  return [img.rgba[o], img.rgba[o + 1], img.rgba[o + 2], img.rgba[o + 3]];
}

/** Composite a pixel over a dark checkerboard so transparency reads correctly. */
function overBg(r: number, g: number, b: number, a: number, dark: boolean): [number, number, number] {
  if (a >= 255) return [r, g, b];
  const bg = dark ? 30 : 45;
  const af = a / 255;
  return [
    Math.round(r * af + bg * (1 - af)),
    Math.round(g * af + bg * (1 - af)),
    Math.round(b * af + bg * (1 - af)),
  ];
}

/**
 * Render a decoded image as half-block ANSI lines scaled to fit `cols` columns
 * (each line is one terminal row = two image rows). Preserves aspect ratio;
 * terminal cells are ~2× tall as wide, which the half-block already accounts for
 * (2 pixels per cell vertically).
 */
export function renderHalfBlock(img: DecodedImage, cols: number, maxRows = 40): string[] {
  const aspect = img.height / img.width;
  let outCols = Math.max(1, Math.min(cols, img.width));
  // rows of CELLS; each cell = 2 vertical pixels, and a cell is ~2× tall as wide.
  let outRows = Math.max(1, Math.round((outCols * aspect) / 2));
  if (outRows > maxRows) { outRows = maxRows; outCols = Math.max(1, Math.round((outRows * 2) / aspect)); }
  outCols = Math.min(outCols, cols);

  const lines: string[] = [];
  for (let ry = 0; ry < outRows; ry++) {
    let line = '';
    for (let cx = 0; cx < outCols; cx++) {
      const u = (cx + 0.5) / outCols;
      const vTop = (ry * 2 + 0.5) / (outRows * 2);
      const vBot = (ry * 2 + 1.5) / (outRows * 2);
      const [tr, tg, tb, ta] = sample(img, u, vTop);
      const [br, bg, bb, ba] = sample(img, u, vBot);
      const [TR, TG, TB] = overBg(tr, tg, tb, ta, true);
      const [BR, BG, BB] = overBg(br, bg, bb, ba, true);
      // '▀' upper half-block: fg = top pixel, bg = bottom pixel.
      line += `\x1b[38;2;${TR};${TG};${TB}m\x1b[48;2;${BR};${BG};${BB}m▀`;
    }
    line += '\x1b[0m';
    lines.push(line);
  }
  return lines;
}

const PNG_EXTS = new Set(['.png', '.apng']);

/**
 * Read an image file and render it inline as half-block ANSI lines, scaled to
 * `cols`. Returns null when the format isn't decodable here (JPEG/GIF/WEBP/…),
 * so the caller can fall back to the OS viewer. Never throws.
 */
export function imageToAnsi(absPath: string, cols: number, maxRows = 40): string[] | null {
  try {
    const dot = absPath.lastIndexOf('.');
    const ext = dot >= 0 ? absPath.slice(dot).toLowerCase() : '';
    if (!PNG_EXTS.has(ext)) return null;       // only PNG decodes without a dep
    const buf = readFileSync(absPath);
    const img = decodePNG(buf);
    if (!img) return null;
    return renderHalfBlock(img, cols, maxRows);
  } catch {
    return null;
  }
}

/** Cheap dimensions probe for the metadata header (PNG only; null otherwise). */
export function imageDimensions(absPath: string): { width: number; height: number } | null {
  try {
    const buf = readFileSync(absPath, { flag: 'r' });
    if (buf.length < 24) return null;
    // PNG: IHDR width/height at bytes 16..24.
    const isPng = buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47;
    if (isPng) return { width: buf.readUInt32BE(16), height: buf.readUInt32BE(20) };
    return null;
  } catch {
    return null;
  }
}
