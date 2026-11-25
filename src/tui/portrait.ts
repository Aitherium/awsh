/**
 * Zero-dependency PNG decoder + area-averaged truecolor half-block renderer.
 * Decodes PNG using only node:zlib + manual chunk parsing.
 * Renders as terminal cells using UPPER HALF BLOCK (U+2580) / LOWER HALF BLOCK (U+2584)
 * with 24-bit fg/bg color pairs.
 *
 * Supports: 8-bit Greyscale (0), RGB (2), Indexed Palette (3), Grey+Alpha (4),
 * and RGBA (6), non-interlaced. Filters: None, Sub, Up, Average, Paeth.
 *
 * All half-block output is SINGLE-CELL-WIDTH glyphs (no emoji, no CJK-wide).
 */
import { inflateSync, deflateSync } from 'node:zlib';
import { readFileSync, existsSync } from 'node:fs';
import { Chalk } from 'chalk';

// ── PNG chunk parsing & CRC32 ────────────────────────────────────────────────

const CRC_TABLE = (() => {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
})();

export function crc32(data: Uint8Array): number {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = CRC_TABLE[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

function filterNone(x: number, _a: number, _b: number, _c: number): number { return x; }
function filterSub(x: number, a: number, _b: number, _c: number): number { return (x + a) & 0xff; }
function filterUp(x: number, _a: number, b: number, _c: number): number { return (x + b) & 0xff; }
function filterAverage(x: number, a: number, b: number, _c: number): number { return (x + ((a + b) >> 1)) & 0xff; }
function filterPaeth(x: number, a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  return (x + pr) & 0xff;
}

const FILTER_FUNCS = [filterNone, filterSub, filterUp, filterAverage, filterPaeth];

// ── PNG decoding & encoding ──────────────────────────────────────────────────

export interface PngImage {
  width: number;
  height: number;
  rgba: Uint8Array; // row-major, 4 bytes per pixel (r, g, b, a)
}

/**
 * Decode an 8-bit non-interlaced PNG buffer into RGBA pixels.
 * Supports color types: 0 (grey), 2 (RGB), 3 (palette), 4 (grey+alpha), 6 (RGBA).
 * Throws on invalid signatures, CRC mismatches, interlaced, or non-8-bit PNGs.
 */
export function decodePng(buf: Buffer): PngImage {
  if (buf.length < 8
    || buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47
    || buf[4] !== 0x0d || buf[5] !== 0x0a || buf[6] !== 0x1a || buf[7] !== 0x0a) {
    throw new Error('Invalid PNG signature');
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let compression = 0;
  let filter = 0;
  let interlace = 0;
  let palette: Uint8Array | null = null;
  let trns: Uint8Array | null = null;

  const idatChunks: Buffer[] = [];
  let pos = 8;

  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString('ascii');
    const data = buf.subarray(pos + 8, pos + 8 + len);
    const crcExpected = buf.readUInt32BE(pos + 8 + len);
    pos += 12 + len;

    const crcData = Buffer.concat([Buffer.from(type, 'ascii'), data]);
    const crcActual = crc32(new Uint8Array(crcData));
    if (crcActual !== crcExpected) {
      throw new Error(`CRC mismatch in ${type} chunk`);
    }

    if (type === 'IHDR') {
      if (data.length < 13) throw new Error('IHDR chunk too short');
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      compression = data[10];
      filter = data[11];
      interlace = data[12];

      if (bitDepth !== 8) throw new Error(`Unsupported bit depth: ${bitDepth}`);
      if (![0, 2, 3, 4, 6].includes(colorType)) {
        throw new Error(`Unsupported colour type: ${colorType}`);
      }
      if (compression !== 0) throw new Error(`Unsupported compression: ${compression}`);
      if (filter !== 0) throw new Error(`Unsupported filter: ${filter}`);
      if (interlace !== 0) throw new Error('Interlaced PNG not supported');
    } else if (type === 'PLTE') {
      palette = new Uint8Array(data);
    } else if (type === 'tRNS') {
      trns = new Uint8Array(data);
    } else if (type === 'IDAT') {
      idatChunks.push(data);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (!width || !height) throw new Error('Missing IHDR chunk');
  const pixelData = inflateSync(Buffer.concat(idatChunks));

  const channels = colorType === 6 ? 4 : colorType === 2 ? 3 : colorType === 4 ? 2 : 1;
  const stride = width * channels;
  const scanlineLen = 1 + stride;
  const rgba = new Uint8Array(width * height * 4);
  const curr = new Uint8Array(stride);
  const prev = new Uint8Array(stride);

  for (let y = 0; y < height; y++) {
    const scanlineStart = y * scanlineLen;
    const filterType = pixelData[scanlineStart];
    const fn = FILTER_FUNCS[filterType] || filterNone;

    for (let i = 0; i < stride; i++) {
      const a = i >= channels ? curr[i - channels] : 0;
      const b = y > 0 ? prev[i] : 0;
      const c = y > 0 && i >= channels ? prev[i - channels] : 0;
      curr[i] = fn(pixelData[scanlineStart + 1 + i], a, b, c);
    }

    const rowBase = y * width * 4;
    if (colorType === 6) {
      rgba.set(curr, rowBase);
    } else if (colorType === 2) {
      for (let x = 0; x < width; x++) {
        const dst = rowBase + x * 4;
        const src = x * 3;
        rgba[dst] = curr[src];
        rgba[dst + 1] = curr[src + 1];
        rgba[dst + 2] = curr[src + 2];
        rgba[dst + 3] = 255;
      }
    } else if (colorType === 4) {
      for (let x = 0; x < width; x++) {
        const dst = rowBase + x * 4;
        const g = curr[x * 2];
        rgba[dst] = g; rgba[dst + 1] = g; rgba[dst + 2] = g;
        rgba[dst + 3] = curr[x * 2 + 1];
      }
    } else if (colorType === 0) {
      for (let x = 0; x < width; x++) {
        const dst = rowBase + x * 4;
        const g = curr[x];
        rgba[dst] = g; rgba[dst + 1] = g; rgba[dst + 2] = g;
        rgba[dst + 3] = 255;
      }
    } else if (colorType === 3 && palette) {
      for (let x = 0; x < width; x++) {
        const idx = curr[x];
        const dst = rowBase + x * 4;
        rgba[dst] = palette[idx * 3] ?? 0;
        rgba[dst + 1] = palette[idx * 3 + 1] ?? 0;
        rgba[dst + 2] = palette[idx * 3 + 2] ?? 0;
        rgba[dst + 3] = trns && idx < trns.length ? trns[idx] : 255;
      }
    }
    prev.set(curr);
  }

  return { width, height, rgba };
}

/** Encode an RGBA PngImage back to a valid 8-bit RGBA PNG buffer (zero deps). */
export function encodePng(img: PngImage): Buffer {
  const { width, height, rgba } = img;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const writeChunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeBuf = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crc32(new Uint8Array(Buffer.concat([typeBuf, data]))), 0);
    return Buffer.concat([len, typeBuf, data, crc]);
  };

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6; ihdr[10] = 0; ihdr[11] = 0; ihdr[12] = 0;

  const stride = width * 4;
  const raw = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    const dstRow = y * (1 + stride);
    const srcRow = y * stride;
    // Sub filter (type 1) compresses portraits dramatically better than None.
    raw[dstRow] = 1;
    for (let i = 0; i < stride; i++) {
      const left = i >= 4 ? rgba[srcRow + i - 4] : 0;
      raw[dstRow + 1 + i] = (rgba[srcRow + i] - left) & 0xff;
    }
  }
  const idat = deflateSync(raw, { level: 9 });
  return Buffer.concat([
    sig,
    writeChunk('IHDR', ihdr),
    writeChunk('IDAT', idat),
    writeChunk('IEND', Buffer.alloc(0)),
  ]);
}

// ── Smart portrait framing & box-filter resampling ───────────────────────────

export type PortraitCropMode = 'bust' | 'full';

export interface CropRect {
  x: number;
  y: number;
  width: number;
  height: number;
}

/**
 * Compute a smart bust crop around the character's head & shoulders when the source
 * is a tall full-body portrait (height > width * 1.25). Finds the opaque alpha bounds
 * first so transparent headroom is trimmed and the face fills the terminal pane cleanly.
 * Pure — never mutates the input image.
 */
export function computePortraitCrop(img: PngImage, mode: PortraitCropMode = 'bust'): CropRect {
  if (mode === 'full' || img.width < 4 || img.height < 4) {
    return { x: 0, y: 0, width: img.width, height: img.height };
  }
  const { width, height, rgba } = img;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  // Stride by 2 on large images for speed while staying exact on small ones.
  const step = width > 128 ? 2 : 1;
  for (let y = 0; y < height; y += step) {
    for (let x = 0; x < width; x += step) {
      if (rgba[(y * width + x) * 4 + 3] >= 16) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) {
    return { x: 0, y: 0, width, height };
  }
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  // Only bust-crop tall figures (e.g. 480x832 full-body portraits).
  if (bh <= bw * 1.25) {
    const padX = Math.floor(bw * 0.04);
    const padY = Math.floor(bh * 0.04);
    const x0 = Math.max(0, minX - padX);
    const y0 = Math.max(0, minY - padY);
    return {
      x: x0,
      y: y0,
      width: Math.min(width - x0, bw + padX * 2),
      height: Math.min(height - y0, bh + padY * 2),
    };
  }
  // Frame the upper ~56% of the opaque figure (head + shoulders + chest) with
  // a comfortable portrait aspect ratio (~0.82 w/h) centered on the character.
  const cropH = Math.min(height - minY, Math.max(Math.round(bh * 0.56), Math.round(bw * 0.95)));
  const desiredW = Math.min(width, Math.max(bw, Math.round(cropH * 0.85)));
  const cx = Math.floor((minX + maxX) / 2);
  const x0 = Math.max(0, Math.min(width - desiredW, cx - Math.floor(desiredW / 2)));
  const y0 = Math.max(0, minY - Math.floor(cropH * 0.04));
  return {
    x: x0,
    y: y0,
    width: Math.max(1, Math.min(width - x0, desiredW)),
    height: Math.max(1, Math.min(height - y0, cropH)),
  };
}

/**
 * Area-averaged (box-filter) resample of a crop rectangle into target (outW x outH) RGBA.
 * Uses premultiplied alpha averaging so edges around transparent hair/silhouettes never
 * pick up dark-fringe halos or single-pixel sparkle artifacts.
 */
export function resampleRgba(
  img: PngImage,
  outW: number,
  outH: number,
  crop?: CropRect,
): PngImage {
  const tw = Math.max(1, Math.floor(outW));
  const th = Math.max(1, Math.floor(outH));
  const rx = crop ? crop.x : 0;
  const ry = crop ? crop.y : 0;
  const rw = crop ? crop.width : img.width;
  const rh = crop ? crop.height : img.height;

  const out = new Uint8Array(tw * th * 4);
  const { width, height, rgba } = img;
  const scaleX = rw / tw;
  const scaleY = rh / th;

  for (let ty = 0; ty < th; ty++) {
    const sy0 = Math.max(0, Math.floor(ry + ty * scaleY));
    const sy1 = Math.min(height, Math.max(sy0 + 1, Math.ceil(ry + (ty + 1) * scaleY)));
    for (let tx = 0; tx < tw; tx++) {
      const sx0 = Math.max(0, Math.floor(rx + tx * scaleX));
      const sx1 = Math.min(width, Math.max(sx0 + 1, Math.ceil(rx + (tx + 1) * scaleX)));

      let pr = 0, pg = 0, pb = 0, pa = 0, count = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        const rowOff = sy * width * 4;
        for (let sx = sx0; sx < sx1; sx++) {
          const o = rowOff + sx * 4;
          const a = rgba[o + 3];
          pa += a;
          pr += rgba[o] * a;
          pg += rgba[o + 1] * a;
          pb += rgba[o + 2] * a;
          count++;
        }
      }
      const dst = (ty * tw + tx) * 4;
      if (count === 0 || pa === 0) {
        out[dst] = 0; out[dst + 1] = 0; out[dst + 2] = 0; out[dst + 3] = 0;
      } else {
        out[dst] = Math.round(pr / pa);
        out[dst + 1] = Math.round(pg / pa);
        out[dst + 2] = Math.round(pb / pa);
        out[dst + 3] = Math.round(pa / count);
      }
    }
  }
  return { width: tw, height: th, rgba: out };
}

// ── Half-block rendering ─────────────────────────────────────────────────────

const HALF_BLOCK = '▀';       // U+2580: UPPER HALF BLOCK
const LOWER_HALF_BLOCK = '▄'; // U+2584: LOWER HALF BLOCK
// FORCE 24-bit truecolor (level 3) so every pixel emits real 38;2;r;g;b / 48;2;r;g;b
// regardless of chalk's auto-detected level (0 in a pipe, 2/256 in some terminals).
const tc = new Chalk({ level: 3 });

export interface RenderHalfBlockOpts {
  aspectRatio?: number;      // width / height of original (for aspect preservation)
  maxRows?: number;          // optional terminal row cap
  crop?: PortraitCropMode;   // 'full' (default for raw renderHalfBlock) or 'bust'
}

/**
 * Render RGBA image as terminal cells using area-averaged half-blocks.
 * Each cell shows 2 vertical pixels: top (fg) and bottom (bg).
 * Downscales cleanly to fit `cols` columns; fully transparent pixels (alpha < 16)
 * become spaces or half-transparent upper/lower blocks.
 */
export function renderHalfBlock(
  rgba: Uint8Array,
  width: number,
  height: number,
  cols: number,
  opts?: RenderHalfBlockOpts,
): string[] {
  if (cols <= 0 || width <= 0 || height <= 0) return [];

  const src: PngImage = { width, height, rgba };
  const crop = opts?.crop === 'bust' ? computePortraitCrop(src, 'bust') : undefined;
  const effW = crop ? crop.width : width;
  const effH = crop ? crop.height : height;
  const aspect = (!crop && opts?.aspectRatio) ? opts.aspectRatio : (effW / effH);

  // Each terminal cell is ~2x tall as wide, and holds 2 vertical pixels (top + bottom),
  // so pixel grid is (cols x rows*2) where rows*2 / cols ≈ 1 / aspect → rows ≈ cols / (aspect * 2).
  let rows = Math.max(1, Math.round(cols / (aspect * 2)));
  let outCols = Math.max(1, Math.floor(cols));
  if (opts?.maxRows && rows > opts.maxRows) {
    rows = Math.max(1, Math.floor(opts.maxRows));
    outCols = Math.max(1, Math.min(outCols, Math.round(rows * 2 * aspect)));
  }

  const sampled = resampleRgba(src, outCols, rows * 2, crop);
  const sRgba = sampled.rgba;
  const sw = sampled.width;

  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    let line = '';
    const topRow = (r * 2) * sw * 4;
    const botRow = (r * 2 + 1) * sw * 4;
    for (let c = 0; c < outCols; c++) {
      const to = topRow + c * 4;
      const bo = botRow + c * 4;
      const tr = sRgba[to], tg = sRgba[to + 1], tb = sRgba[to + 2], ta = sRgba[to + 3];
      const br = sRgba[bo], bg = sRgba[bo + 1], bb = sRgba[bo + 2], ba = sRgba[bo + 3];

      if (ta < 16 && ba < 16) {
        line += ' ';
      } else if (ta < 16) {
        line += tc.rgb(br, bg, bb)(LOWER_HALF_BLOCK);
      } else if (ba < 16) {
        line += tc.rgb(tr, tg, tb)(HALF_BLOCK);
      } else {
        line += tc.rgb(tr, tg, tb).bgRgb(br, bg, bb)(HALF_BLOCK);
      }
    }
    lines.push(line);
  }
  return lines;
}

// ── Portrait frame management ────────────────────────────────────────────────

export interface PortraitDir {
  has(emotion: string): boolean;
  get(emotion: string, variant?: string): Buffer | null;
}

export function loadPortraitDir(dir: string): PortraitDir {
  return {
    has(emotion: string): boolean {
      return existsSync(framePathFor(dir, emotion));
    },
    get(emotion: string, variant?: string): Buffer | null {
      try {
        const path = framePathFor(dir, emotion, variant);
        if (!existsSync(path)) return null;
        return readFileSync(path);
      } catch {
        return null;
      }
    },
  };
}

export function framePathFor(dir: string, emotion: string, variant?: string): string {
  const name = variant ? `${emotion}-${variant}` : emotion;
  return `${dir}/${name}.png`;
}

export interface RenderPortraitOpts {
  cols: number;
  maxRows?: number;
  blink?: boolean;
  mouthFrame?: number;
  crop?: PortraitCropMode;
}

/**
 * Render a portrait for a given emotion, falling back through variants and finally to 'neutral'.
 * Returns null if no art exists at all; the caller uses ASCII avatar as fallback.
 */
export function renderPortrait(
  dir: string,
  emotion: string,
  opts: RenderPortraitOpts,
): string[] | null {
  const pd = loadPortraitDir(dir);
  let buf: Buffer | null = null;

  if (opts.blink) buf = pd.get(emotion, 'blink');
  if (!buf && opts.mouthFrame != null) buf = pd.get(emotion, `talk-${opts.mouthFrame}`);
  if (!buf) buf = pd.get(emotion);
  if (!buf && emotion !== 'neutral') buf = pd.get('neutral');
  if (!buf) return null;

  try {
    const img = decodePng(buf);
    return renderHalfBlock(img.rgba, img.width, img.height, opts.cols, {
      aspectRatio: img.width / img.height,
      maxRows: opts.maxRows,
      crop: opts.crop,
    });
  } catch {
    return null;
  }
}

/** Decode + render a single PNG file to truecolor half-block lines. Null on failure. */
export function renderPngFile(
  path: string,
  cols: number,
  opts?: { maxRows?: number; crop?: PortraitCropMode },
): string[] | null {
  try {
    if (!existsSync(path)) return null;
    const img = decodePng(readFileSync(path));
    return renderHalfBlock(img.rgba, img.width, img.height, cols, {
      aspectRatio: img.width / img.height,
      maxRows: opts?.maxRows,
      crop: opts?.crop ?? 'bust',
    });
  } catch {
    return null;
  }
}
