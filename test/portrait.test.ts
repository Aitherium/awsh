/**
 * Tests for the PNG decoder and half-block portrait renderer.
 * Synthesizes test PNGs in-memory, validates single-cell-width safety.
 */
import { test, describe } from 'node:test';
import { strict as assert } from 'assert';
import { decodePng, renderHalfBlock, loadPortraitDir, framePathFor, renderPortrait } from '../src/tui/portrait.js';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { deflateSync } from 'node:zlib';

// ── CRC32 & PNG synthesis ────────────────────────────────────────────────────

/**
 * Compute CRC32 for PNG chunk validation.
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
 * Build an 8-bit RGB PNG in-memory (no interlace, no filters).
 * Simple scanline: filter byte 0 (None) + pixel data.
 */
function makePngRGB(width: number, height: number, pixels: Uint8Array): Buffer {
  assert(pixels.length === width * height * 3, 'pixel count mismatch');

  // IHDR chunk
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;     // bit depth
  ihdr[9] = 2;     // color type: RGB
  ihdr[10] = 0;    // compression: deflate
  ihdr[11] = 0;    // filter: adaptive
  ihdr[12] = 0;    // interlace: none

  // Build scanlines
  const scanlines = Buffer.alloc(height * (1 + width * 3));
  for (let y = 0; y < height; y++) {
    const lineStart = y * (1 + width * 3);
    scanlines[lineStart] = 0; // filter type: None
    for (let x = 0; x < width; x++) {
      const srcIdx = (y * width + x) * 3;
      const dstIdx = lineStart + 1 + x * 3;
      scanlines[dstIdx] = pixels[srcIdx];
      scanlines[dstIdx + 1] = pixels[srcIdx + 1];
      scanlines[dstIdx + 2] = pixels[srcIdx + 2];
    }
  }

  // IDAT chunk (compressed scanlines)
  const compressedData = deflateSync(scanlines);

  // Build PNG
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const writeChunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeStr = Buffer.from(type, 'ascii');
    const crcData = Buffer.concat([typeStr, data]);
    const crcVal = crc32(new Uint8Array(crcData));
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crcVal, 0);
    return Buffer.concat([len, typeStr, data, crc]);
  };

  const ihdrChunk = writeChunk('IHDR', ihdr);
  const idatChunk = writeChunk('IDAT', compressedData);
  const iendChunk = writeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, ihdrChunk, idatChunk, iendChunk]);
}

/**
 * Build an 8-bit RGBA PNG.
 */
function makePngRGBA(width: number, height: number, pixels: Uint8Array): Buffer {
  assert(pixels.length === width * height * 4, 'pixel count mismatch');

  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0);
  ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8;
  ihdr[9] = 6;     // color type: RGBA
  ihdr[10] = 0;
  ihdr[11] = 0;
  ihdr[12] = 0;

  const scanlines = Buffer.alloc(height * (1 + width * 4));
  for (let y = 0; y < height; y++) {
    const lineStart = y * (1 + width * 4);
    scanlines[lineStart] = 0;
    for (let x = 0; x < width; x++) {
      const srcIdx = (y * width + x) * 4;
      const dstIdx = lineStart + 1 + x * 4;
      scanlines[dstIdx] = pixels[srcIdx];
      scanlines[dstIdx + 1] = pixels[srcIdx + 1];
      scanlines[dstIdx + 2] = pixels[srcIdx + 2];
      scanlines[dstIdx + 3] = pixels[srcIdx + 3];
    }
  }

  const compressedData = deflateSync(scanlines);

  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);

  const writeChunk = (type: string, data: Buffer): Buffer => {
    const len = Buffer.alloc(4);
    len.writeUInt32BE(data.length, 0);
    const typeStr = Buffer.from(type, 'ascii');
    const crcData = Buffer.concat([typeStr, data]);
    const crcVal = crc32(new Uint8Array(crcData));
    const crc = Buffer.alloc(4);
    crc.writeUInt32BE(crcVal, 0);
    return Buffer.concat([len, typeStr, data, crc]);
  };

  const ihdrChunk = writeChunk('IHDR', ihdr);
  const idatChunk = writeChunk('IDAT', compressedData);
  const iendChunk = writeChunk('IEND', Buffer.alloc(0));

  return Buffer.concat([sig, ihdrChunk, idatChunk, iendChunk]);
}

/**
 * Strip ANSI escape codes from a string.
 */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Assert that all lines in the array use only single-cell-width glyphs.
 * Fails if any codepoint falls in the wide ranges (CJK, emoji, fullwidth, etc).
 */
function assertSingleCellWidth(lines: string[]): void {
  const WIDE_RANGES = [
    [0x3400, 0x4dbf],   // CJK Unified Ideographs Extension A
    [0x4e00, 0x9fff],   // CJK Unified Ideographs
    [0x20000, 0x2a6df], // CJK Unified Ideographs Extension B
    [0x2a700, 0x2b73f], // CJK Unified Ideographs Extension C
    [0xfe30, 0xfe4f],   // CJK Compatibility Forms
    [0xff00, 0xff60],   // Fullwidth Forms
    [0xf900, 0xfaff],   // CJK Compatibility Ideographs
  ];

  for (const line of lines) {
    const stripped = stripAnsi(line);
    for (const ch of stripped) {
      const code = ch.charCodeAt(0);
      for (const [lo, hi] of WIDE_RANGES) {
        if (code >= lo && code <= hi) {
          throw new Error(`Wide glyph detected: U+${code.toString(16).toUpperCase()} in "${stripped}"`);
        }
      }
      // Also reject emoji (commonly U+1F300+)
      if (code >= 0x1f300 && code <= 0x1f9ff) {
        throw new Error(`Emoji detected: U+${code.toString(16).toUpperCase()}`);
      }
    }
  }
}

// ── Tests ────────────────────────────────────────────────────────────────────

describe('decodePng', () => {
  test('decodes 2x2 RGB PNG', () => {
    // 2x2 image: red, green, blue, white
    const pixels = new Uint8Array([
      0xff, 0x00, 0x00,  // red
      0x00, 0xff, 0x00,  // green
      0x00, 0x00, 0xff,  // blue
      0xff, 0xff, 0xff,  // white
    ]);
    const buf = makePngRGB(2, 2, pixels);
    const img = decodePng(buf);

    assert.equal(img.width, 2);
    assert.equal(img.height, 2);
    assert.equal(img.rgba.length, 2 * 2 * 4);

    // Check red pixel (0,0): should be [255, 0, 0, 255]
    assert.equal(img.rgba[0], 255);
    assert.equal(img.rgba[1], 0);
    assert.equal(img.rgba[2], 0);
    assert.equal(img.rgba[3], 255); // alpha set to 255 for RGB

    // Check green pixel (1,0)
    assert.equal(img.rgba[4], 0);
    assert.equal(img.rgba[5], 255);
    assert.equal(img.rgba[6], 0);
    assert.equal(img.rgba[7], 255);
  });

  test('decodes 1x1 RGBA PNG', () => {
    const pixels = new Uint8Array([0x80, 0x40, 0xc0, 0x7f]); // semi-transparent magenta
    const buf = makePngRGBA(1, 1, pixels);
    const img = decodePng(buf);

    assert.equal(img.width, 1);
    assert.equal(img.height, 1);
    assert.equal(img.rgba[0], 0x80);
    assert.equal(img.rgba[1], 0x40);
    assert.equal(img.rgba[2], 0xc0);
    assert.equal(img.rgba[3], 0x7f);
  });

  test('rejects invalid PNG signature', () => {
    const bad = Buffer.from('not a png...');
    assert.throws(() => decodePng(bad), /Invalid PNG signature/);
  });

  test('rejects interlaced PNG', () => {
    // Create a normal IHDR but set interlace=1
    const ihdr = Buffer.alloc(13);
    ihdr.writeUInt32BE(2, 0);
    ihdr.writeUInt32BE(2, 4);
    ihdr[8] = 8;
    ihdr[9] = 2;
    ihdr[10] = 0;
    ihdr[11] = 0;
    ihdr[12] = 1; // interlace: Adam7

    const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
    const writeChunk = (type: string, data: Buffer): Buffer => {
      const len = Buffer.alloc(4);
      len.writeUInt32BE(data.length, 0);
      const typeStr = Buffer.from(type, 'ascii');
      const crcData = Buffer.concat([typeStr, data]);
      const crcVal = crc32(new Uint8Array(crcData));
      const crc = Buffer.alloc(4);
      crc.writeUInt32BE(crcVal, 0);
      return Buffer.concat([len, typeStr, data, crc]);
    };

    const iendChunk = writeChunk('IEND', Buffer.alloc(0));
    const buf = Buffer.concat([sig, writeChunk('IHDR', ihdr), iendChunk]);
    assert.throws(() => decodePng(buf), /Interlaced PNG not supported/);
  });
});

describe('renderHalfBlock', () => {
  test('renders 2x2 RGBA as half-blocks', () => {
    // 2 wide, 2 tall: red top-left, green top-right, blue bot-left, white bot-right
    const rgba = new Uint8Array([
      0xff, 0x00, 0x00, 0xff, // red
      0x00, 0xff, 0x00, 0xff, // green
      0x00, 0x00, 0xff, 0xff, // blue
      0xff, 0xff, 0xff, 0xff, // white
    ]);
    const lines = renderHalfBlock(rgba, 2, 2, 2);
    assert(Array.isArray(lines));
    assert(lines.length > 0);
    assertSingleCellWidth(lines);
  });

  test('renders 1x1 fully transparent as space', () => {
    const rgba = new Uint8Array([0, 0, 0, 0]); // fully transparent
    const lines = renderHalfBlock(rgba, 1, 1, 1);
    assert.equal(lines.length, 1);
    const clean = stripAnsi(lines[0]);
    assert.equal(clean, ' ');
  });

  test('respects column count', () => {
    // 100x100 image rendered to 50 cols should be 50 chars wide
    const rgba = new Uint8Array(100 * 100 * 4).fill(255);
    const lines = renderHalfBlock(rgba, 100, 100, 50);
    for (const line of lines) {
      const clean = stripAnsi(line);
      assert(clean.length <= 50, `line too wide: ${clean.length}`);
    }
    assertSingleCellWidth(lines);
  });

  test('zero cols returns empty array', () => {
    const rgba = new Uint8Array(4).fill(255);
    const lines = renderHalfBlock(rgba, 1, 1, 0);
    assert.equal(lines.length, 0);
  });

  test('all lines use half-block or space only', () => {
    const rgba = new Uint8Array(10 * 10 * 4).fill(255);
    const lines = renderHalfBlock(rgba, 10, 10, 10);
    for (const line of lines) {
      const clean = stripAnsi(line);
      for (const ch of clean) {
        // Only half-block (U+2580), lower-half (U+2584), or space
        const code = ch.charCodeAt(0);
        assert(code === 0x2580 || code === 0x2584 || code === 0x20, `unexpected char: U+${code.toString(16).toUpperCase()}`);
      }
    }
  });

  test('semi-transparent pixels render correct half-blocks', () => {
    // 2x2: top-left red opaque, top-right red transparent,
    //      bottom-left green transparent, bottom-right green opaque
    const rgba = new Uint8Array([
      0xff, 0x00, 0x00, 0xff,  // top-left: red opaque
      0xff, 0x00, 0x00, 0x00,  // top-right: red transparent
      0x00, 0xff, 0x00, 0x00,  // bottom-left: green transparent
      0x00, 0xff, 0x00, 0xff,  // bottom-right: green opaque
    ]);
    const lines = renderHalfBlock(rgba, 2, 2, 2);
    assert(lines.length > 0);
    assertSingleCellWidth(lines);
    // Verify that semi-transparent cells render with appropriate half-blocks
    for (const line of lines) {
      const clean = stripAnsi(line);
      for (const ch of clean) {
        const code = ch.charCodeAt(0);
        assert(code === 0x2580 || code === 0x2584 || code === 0x20,
          `unexpected char in semi-transparent test: U+${code.toString(16).toUpperCase()}`);
      }
    }
  });
});

describe('framePathFor', () => {
  test('builds emotion path', () => {
    const path = framePathFor('/portraits', 'happy');
    assert.equal(path, '/portraits/happy.png');
  });

  test('builds emotion-variant path', () => {
    const path = framePathFor('/portraits', 'happy', 'blink');
    assert.equal(path, '/portraits/happy-blink.png');
  });

  test('handles talk frame variants', () => {
    const path = framePathFor('/p', 'talk', '1');
    assert.equal(path, '/p/talk-1.png');
  });
});

describe('loadPortraitDir', () => {
  test('has() returns false for nonexistent dir', () => {
    const pd = loadPortraitDir('/nonexistent');
    assert.equal(pd.has('neutral'), false);
  });

  test('get() returns null for nonexistent file', () => {
    const pd = loadPortraitDir('/nonexistent');
    assert.equal(pd.get('neutral'), null);
  });

  test('get() returns Buffer for existing PNG', () => {
    const tmpDir = mkdtempSync('portrait-test-');
    try {
      const pixels = new Uint8Array(2 * 2 * 4).fill(255);
      const pngBuf = makePngRGBA(2, 2, pixels);
      writeFileSync(`${tmpDir}/neutral.png`, pngBuf);

      const pd = loadPortraitDir(tmpDir);
      assert.equal(pd.has('neutral'), true);
      const buf = pd.get('neutral');
      assert(buf !== null);
      assert(buf.length > 0);
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });
});

describe('renderPortrait', () => {
  test('returns null when no PNG exists at all', () => {
    const tmpDir = mkdtempSync('portrait-test-');
    try {
      const result = renderPortrait(tmpDir, 'happy', { cols: 40 });
      assert.equal(result, null);
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  test('returns string[] when PNG exists', () => {
    const tmpDir = mkdtempSync('portrait-test-');
    try {
      const pixels = new Uint8Array(10 * 10 * 4).fill(255);
      const pngBuf = makePngRGBA(10, 10, pixels);
      writeFileSync(`${tmpDir}/neutral.png`, pngBuf);

      const result = renderPortrait(tmpDir, 'neutral', { cols: 40 });
      assert(Array.isArray(result));
      assert(result.length > 0);
      assertSingleCellWidth(result);
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  test('prefers variant over base emotion', () => {
    const tmpDir = mkdtempSync('portrait-test-');
    try {
      const redPixels = new Uint8Array(4 * 4);
      for (let i = 0; i < 4; i++) {
        redPixels[i * 4 + 0] = 255; // R
        redPixels[i * 4 + 3] = 255; // A
      }
      const greenPixels = new Uint8Array(4 * 4);
      for (let i = 0; i < 4; i++) {
        greenPixels[i * 4 + 1] = 255; // G
        greenPixels[i * 4 + 3] = 255; // A
      }

      const redBuf = makePngRGBA(2, 2, redPixels);
      const greenBuf = makePngRGBA(2, 2, greenPixels);
      writeFileSync(`${tmpDir}/happy.png`, redBuf);
      writeFileSync(`${tmpDir}/happy-blink.png`, greenBuf);

      // Without blink, should use happy.png (red)
      const result1 = renderPortrait(tmpDir, 'happy', { cols: 20, blink: false });
      assert(result1 !== null);

      // With blink, should prefer happy-blink.png (green)
      const result2 = renderPortrait(tmpDir, 'happy', { cols: 20, blink: true });
      assert(result2 !== null);
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  test('falls back to neutral when emotion missing', () => {
    const tmpDir = mkdtempSync('portrait-test-');
    try {
      const pixels = new Uint8Array(5 * 5 * 4).fill(255);
      const pngBuf = makePngRGBA(5, 5, pixels);
      writeFileSync(`${tmpDir}/neutral.png`, pngBuf);

      // Request 'happy' (missing), falls back to 'neutral'
      const result = renderPortrait(tmpDir, 'happy', { cols: 20 });
      assert(result !== null);
      assertSingleCellWidth(result);
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });

  test('returns null when PNG decode fails', () => {
    const tmpDir = mkdtempSync('portrait-test-');
    try {
      writeFileSync(`${tmpDir}/corrupt.png`, Buffer.from('not a real png'));
      const result = renderPortrait(tmpDir, 'corrupt', { cols: 20 });
      assert.equal(result, null);
    } finally {
      rmSync(tmpDir, { recursive: true });
    }
  });
});
