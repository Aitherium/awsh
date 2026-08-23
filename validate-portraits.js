/**
 * Validate portraits using the PNG decoder and half-block renderer.
 * This is a pure JS version without TypeScript compilation overhead.
 */

import fs from 'fs';
import path from 'path';
import { inflateSync } from 'zlib';

const PORTRAIT_DIR = './assets/aither-portrait';

// CRC32 table (from portrait.ts)
function makeCrc32Table() {
  const table = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) {
      c = (c & 1) ? 0xedb88320 ^ (c >>> 1) : c >>> 1;
    }
    table[i] = c >>> 0;
  }
  return table;
}

const crc32table = makeCrc32Table();

function crc32(data) {
  let crc = 0xffffffff;
  for (let i = 0; i < data.length; i++) {
    crc = crc32table[(crc ^ data[i]) & 0xff] ^ (crc >>> 8);
  }
  return (crc ^ 0xffffffff) >>> 0;
}

// Filter functions
const filterNone = (x, a, b, c) => x;
const filterSub = (x, a, b, c) => (x + a) & 0xff;
const filterUp = (x, a, b, c) => (x + b) & 0xff;
const filterAverage = (x, a, b, c) => (x + Math.floor((a + b) / 2)) & 0xff;
const filterPaeth = (x, a, b, c) => {
  const p = a + b - c;
  const pa = Math.abs(p - a);
  const pb = Math.abs(p - b);
  const pc = Math.abs(p - c);
  const pr = pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
  return (x + pr) & 0xff;
};

const FILTER_FUNCS = [filterNone, filterSub, filterUp, filterAverage, filterPaeth];

function decodePng(buf) {
  // Validate PNG signature
  if (buf[0] !== 0x89 || buf[1] !== 0x50 || buf[2] !== 0x4e || buf[3] !== 0x47
    || buf[4] !== 0x0d || buf[5] !== 0x0a || buf[6] !== 0x1a || buf[7] !== 0x0a) {
    throw new Error('Invalid PNG signature');
  }

  let width = 0, height = 0, bitDepth = 0, colorType = 0;
  let idatData = Buffer.alloc(0);
  let pos = 8;

  // Parse chunks
  while (pos < buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.slice(pos + 4, pos + 8).toString('ascii');
    const data = buf.slice(pos + 8, pos + 8 + len);
    const crcBuf = buf.slice(pos + 8 + len, pos + 12 + len);
    const crcExpected = crcBuf.readUInt32BE(0);
    pos += 12 + len;

    // Verify CRC
    const crcData = Buffer.concat([Buffer.from(type), data]);
    const crcActual = crc32(new Uint8Array(crcData));
    if (crcActual !== crcExpected) {
      throw new Error(`CRC mismatch in ${type} chunk`);
    }

    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      bitDepth = data[8];
      colorType = data[9];
      if (bitDepth !== 8) throw new Error(`Unsupported bit depth: ${bitDepth}`);
      if (colorType !== 2 && colorType !== 6) {
        throw new Error(`Unsupported color type: ${colorType}`);
      }
    } else if (type === 'IDAT') {
      idatData = Buffer.concat([idatData, data]);
    } else if (type === 'IEND') {
      break;
    }
  }

  // Decompress and decode
  const pixelData = inflateSync(idatData);
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

    // Write scanline to RGBA
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

function renderHalfBlock(rgba, width, height, cols) {
  if (cols <= 0) return [];

  const rows = Math.round(height / (width / cols) * 0.5);
  if (rows <= 0) return [];

  const scaleX = width / cols;
  const scaleY = height / rows;

  const lines = [];
  for (let r = 0; r < rows; r++) {
    let line = '';
    for (let c = 0; c < cols; c++) {
      const topY = Math.floor(r * scaleY * 2);
      const botY = Math.floor((r * scaleY * 2) + 1);
      const x = Math.floor(c * scaleX);

      const getPixel = (px, py) => {
        if (px >= width || py >= height) return [0, 0, 0, 0];
        const idx = (py * width + px) * 4;
        return [rgba[idx], rgba[idx + 1], rgba[idx + 2], rgba[idx + 3]];
      };

      const [tr, tg, tb, ta] = getPixel(x, topY);
      const [br, bg, bb, ba] = getPixel(x, botY);

      // Fully transparent
      if (ta < 8 && ba < 8) {
        line += ' ';
        continue;
      }

      // Build cell with truecolor codes
      if (ta < 8) {
        // Bottom only
        line += `\x1b[38;2;${br};${bg};${bb}m▄\x1b[0m`;
      } else if (ba < 8) {
        // Top only
        line += `\x1b[38;2;${tr};${tg};${tb}m▀\x1b[0m`;
      } else {
        // Both: top fg, bottom bg
        line += `\x1b[38;2;${tr};${tg};${tb};48;2;${br};${bg};${bb}m▀\x1b[0m`;
      }
    }
    lines.push(line);
  }

  return lines;
}

function validatePortrait(emotion) {
  console.log(`\nValidating [${emotion}]...`);

  const filepath = path.join(PORTRAIT_DIR, `${emotion}.png`);
  if (!fs.existsSync(filepath)) {
    console.log(`  ERROR: File not found: ${filepath}`);
    return false;
  }

  try {
    const pngBuf = fs.readFileSync(filepath);
    const img = decodePng(pngBuf);
    const rendered = renderHalfBlock(img.rgba, img.width, img.height, 40);

    if (!rendered || rendered.length === 0) {
      console.log(`  ERROR: renderHalfBlock returned empty`);
      return false;
    }

    console.log(`  Dimensions: ${img.width}x${img.height}`);
    console.log(`  Lines: ${rendered.length}`);

    // Check for truecolor codes
    const combined = rendered.join('');
    const hasHalfBlock = combined.includes('▀') || combined.includes('▄');
    const hasTruecolor = combined.includes('38;2') || combined.includes('48;2');

    console.log(`  Half-block chars: ${hasHalfBlock ? 'YES' : 'NO'}`);
    console.log(`  Truecolor codes: ${hasTruecolor ? 'YES' : 'NO'}`);

    // Show first line with escape codes visible
    const firstLine = rendered[0];
    const visible = firstLine.slice(0, 100)
      .replace(/\x1b/g, '\\x1b');
    console.log(`  First line (truncated): ${visible}...`);

    return hasHalfBlock && hasTruecolor;
  } catch (err) {
    console.log(`  ERROR: ${err.message}`);
    return false;
  }
}

function main() {
  console.log('Portrait Validation');
  console.log('==================');
  console.log(`Portrait dir: ${PORTRAIT_DIR}\n`);

  const emotions = ['neutral', 'happy', 'angry', 'thinking'];
  const results = {};

  for (const emotion of emotions) {
    results[emotion] = validatePortrait(emotion);
  }

  console.log('\n' + '='.repeat(40));
  console.log('SUMMARY:');
  for (const [emotion, success] of Object.entries(results)) {
    const status = success ? 'PASS' : 'FAIL';
    console.log(`  [${status}] ${emotion}`);
  }

  const allPass = Object.values(results).every(v => v);
  process.exit(allPass ? 0 : 1);
}

main();
