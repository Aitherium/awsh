/**
 * Zero-dependency PNG decoder + truecolor half-block terminal renderer.
 * Decodes PNG using only node:zlib + manual chunk parsing.
 * Renders as terminal cells using UPPER HALF BLOCK (U+2580) with fg/bg color pairs.
 *
 * Supports: 8-bit RGB (type 2) and RGBA (type 6), non-interlaced.
 * Filters: None, Sub, Up, Average, Paeth.
 *
 * All output is SINGLE-CELL-WIDTH glyphs (no emoji, no CJK-wide).
 */
import { inflateSync } from 'node:zlib';
import { readFileSync, existsSync } from 'node:fs';
import { Chalk } from 'chalk';

// ── PNG chunk parsing & CRC32 ────────────────────────────────────────────────

/**
 * Compute CRC32 for PNG chunk validation.
 * PNG uses the standard polynomial (reflected form).
 */
function crc32(data: Uint8Array): number {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

/**
 * PNG scanline filter predictor functions (PNG spec, section 9.2).
 */
function filterNone(x: number, _a: number, _b: number, _c: number): number {
  return x;
}

function filterSub(x: number, a: number, _b: number, _c: number): number {
  return (x + a) & 0xff;
}

function filterUp(x: number, _a: number, b: number, _c: number): number {
  return (x + b) & 0xff;
}

function filterAverage(x: number, a: number, b: number, _c: number): number {
  return (x + Math.floor((a + b) / 2)) & 0xff;
}

function filterPaeth(x: number, a: number, b: number, c: number): number {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  return (x + pr) & 0xff;
}

const FILTER_FUNCS = [filterNone, filterSub, filterUp, filterAverage, filterPaeth];

// ── PNG decoding ─────────────────────────────────────────────────────────────

export interface PngImage {
  width: number;
  height: number;
  rgba: Uint8Array; // row-major, 4 bytes per pixel (r, g, b, a)
}

/**
 * Decode a PNG buffer. Supports 8-bit RGB (type 2) and RGBA (type 6), non-interlaced.
 * Throws on unsupported formats (palette, 16-bit, interlaced, etc).
 */
export function decodePng(buf: Buffer): PngImage {
  // PNG signature
  const sig = buf.slice(0, 8);
  if (sig[0] !== 0x89 || sig[1] !== 0x50 || sig[2] !== 0x4e || sig[3] !== 0x47
    || sig[4] !== 0x0d || sig[5] !== 0x0a || sig[6] !== 0x1a || sig[7] !== 0x0a) {
    throw new Error('Invalid PNG signature');
  }

  let width = 0;
  let height = 0;
  let bitDepth = 0;
  let colorType = 0;
  let compression = 0;
  let filter = 0;
  let interlace = 0;

  let idatData = Buffer.alloc(0);
  let pos = 8;

  // Parse chunks
  while (pos < buf.length) {
    const lenBuf = buf.slice(pos, pos + 4);
    const len = lenBuf.readUInt32BE(0);
    const type = buf.slice(pos + 4, pos + 8).toString('ascii');
    const data = buf.slice(pos + 8, pos + 8 + len);
    const crcBuf = buf.slice(pos + 8 + len, pos + 12 + len);
    const crcExpected = crcBuf.readUInt32BE(0);
    pos += 12 + len;

    // Verify CRC over type + data
    const crcData = Buffer.concat([Buffer.from(type), data]);
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
      if (colorType !== 2 && colorType !== 6) {
        throw new Error(`Unsupported colour type: ${colorType} (only RGB/RGBA supported)`);
      }
      if (compression !== 0) throw new Error(`Unsupported compression: ${compression}`);
      if (filter !== 0) throw new Error(`Unsupported filter: ${filter}`);
      if (interlace !== 0) throw new Error('Interlaced PNG not supported');
    } else if (type === 'IDAT') {
      idatData = Buffer.concat([idatData, data]);
    } else if (type === 'IEND') {
      break;
    }
  }

  if (!width || !height) throw new Error('Missing IHDR chunk');

  // Decompress IDAT
  const pixelData = inflateSync(idatData);

  // Filter reconstruction
  const bytesPerPixel = colorType === 6 ? 4 : 3;
  const scanlineLen = 1 + width * bytesPerPixel;
  const rgba = new Uint8Array(width * height * 4);

  let pixIdx = 0;
  for (let y = 0; y < height; y++) {
    const scanlineStart = y * scanlineLen;
    const filterType = pixelData[scanlineStart];
    const scanline = new Uint8Array(width * bytesPerPixel);

    for (let x = 0; x < width; x++) {
      const byteIdx = scanlineStart + 1 + x * bytesPerPixel;
      for (let b = 0; b < bytesPerPixel; b++) {
        const left = x > 0 ? scanline[(x - 1) * bytesPerPixel + b] : 0;
        const up = y > 0 ? rgba[(y - 1) * width * 4 + x * 4 + b] : 0;
        const upLeft = y > 0 && x > 0 ? rgba[(y - 1) * width * 4 + (x - 1) * 4 + b] : 0;
        const raw = pixelData[byteIdx + b];
        const func = FILTER_FUNCS[filterType] || filterNone;
        scanline[x * bytesPerPixel + b] = func(raw, left, up, upLeft);
      }
    }

    // Write scanline to RGBA output
    for (let x = 0; x < width; x++) {
      rgba[pixIdx + 0] = scanline[x * bytesPerPixel + 0]; // R
      rgba[pixIdx + 1] = scanline[x * bytesPerPixel + 1]; // G
      rgba[pixIdx + 2] = scanline[x * bytesPerPixel + 2]; // B
      rgba[pixIdx + 3] = colorType === 6 ? scanline[x * bytesPerPixel + 3] : 255; // A
      pixIdx += 4;
    }
  }

  return { width, height, rgba };
}

// ── Half-block rendering ─────────────────────────────────────────────────────

const HALF_BLOCK = '▀'; // U+2580: UPPER HALF BLOCK
const LOWER_HALF_BLOCK = '▄'; // U+2584: LOWER HALF BLOCK
// FORCE 24-bit truecolor (level 3) so every pixel emits a real 38;2;r;g;b / 48;2
// sequence, regardless of chalk's auto-detected level (0 in a pipe, 2/256 in some
// terminals). Without this the portrait renders in washed-out 256-color or not at all.
const tc = new Chalk({ level: 3 });

interface RenderHalfBlockOpts {
  aspectRatio?: number; // width / height of original (for aspect preservation)
}

/**
 * Render RGBA image as terminal cells using half-blocks.
 * Each cell shows 2 vertical pixels: top (fg) and bottom (bg).
 * Downscales to fit `cols` columns; fully transparent pixels (alpha<8) become spaces.
 */
export function renderHalfBlock(
  rgba: Uint8Array,
  width: number,
  height: number,
  cols: number,
  opts?: RenderHalfBlockOpts,
): string[] {
  if (cols <= 0) return [];

  // Downscale: preserve aspect ratio if given
  const rows = opts?.aspectRatio ? Math.round(cols / (opts.aspectRatio * 0.5)) : Math.round(height / (width / cols) * 0.5);
  if (rows <= 0) return [];

  const scaleX = width / cols;
  const scaleY = height / rows;

  const lines: string[] = [];
  for (let r = 0; r < rows; r++) {
    let line = '';
    for (let c = 0; c < cols; c++) {
      // Sample top and bottom pixels for this cell
      const topY = Math.floor(r * scaleY * 2);
      const botY = Math.floor((r * scaleY * 2) + 1);
      const x = Math.floor(c * scaleX);

      const getPixel = (px: number, py: number): [number, number, number, number] => {
        if (px >= width || py >= height) return [0, 0, 0, 0];
        const idx = (py * width + px) * 4;
        return [rgba[idx], rgba[idx + 1], rgba[idx + 2], rgba[idx + 3]];
      };

      const [tr, tg, tb, ta] = getPixel(x, topY);
      const [br, bg, bb, ba] = getPixel(x, botY);

      // Fully transparent: render as space
      if (ta < 8 && ba < 8) {
        line += ' ';
        continue;
      }

      // Build the cell: top pixel as fg, bottom as bg
      let cell = HALF_BLOCK;
      if (ta < 8) {
        // Top transparent, bottom opaque: show bottom color in bottom half
        cell = LOWER_HALF_BLOCK;
        line += tc.rgb(br, bg, bb)(cell);
      } else if (ba < 8) {
        // Bottom transparent, top opaque: show top color in top half
        cell = HALF_BLOCK; // UPPER HALF BLOCK
        line += tc.rgb(tr, tg, tb)(cell);
      } else {
        // Both opaque: top=fg, bottom=bg
        line += tc.rgb(tr, tg, tb).bgRgb(br, bg, bb)(cell);
      }
    }
    lines.push(line);
  }

  return lines;
}

// ── Portrait frame management ────────────────────────────────────────────────

/**
 * A portrait frame directory handler.
 * Loads emotion-keyed PNG frames: dir/emotion.png, dir/emotion-variant.png.
 */
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

/**
 * Compute the file path for an emotion frame.
 * e.g., dir/neutral.png, dir/neutral-blink.png, dir/talk-1.png
 */
export function framePathFor(dir: string, emotion: string, variant?: string): string {
  const name = variant ? `${emotion}-${variant}` : emotion;
  return `${dir}/${name}.png`;
}

interface RenderPortraitOpts {
  cols: number;
  blink?: boolean;
  mouthFrame?: number;
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

  // Try: emotion + variant, then emotion, then 'neutral'
  let buf: Buffer | null = null;

  if (opts.blink) {
    buf = pd.get(emotion, 'blink');
  }
  if (!buf && opts.mouthFrame != null) {
    buf = pd.get(emotion, `talk-${opts.mouthFrame}`);
  }
  if (!buf) {
    buf = pd.get(emotion);
  }
  if (!buf && emotion !== 'neutral') {
    buf = pd.get('neutral');
  }

  if (!buf) return null; // No art at all

  try {
    const img = decodePng(buf);
    return renderHalfBlock(img.rgba, img.width, img.height, opts.cols, { aspectRatio: img.width / img.height });
  } catch {
    return null; // Decode failed, fall back to ASCII avatar
  }
}

/** Decode + render a single PNG file to truecolor half-block lines (for playing
 *  an animation frame sequence, e.g. the AnimateDiff idle loop). Null on failure. */
export function renderPngFile(path: string, cols: number): string[] | null {
  try {
    if (!existsSync(path)) return null;
    const img = decodePng(readFileSync(path));
    return renderHalfBlock(img.rgba, img.width, img.height, cols, { aspectRatio: img.width / img.height });
  } catch {
    return null;
  }
}
