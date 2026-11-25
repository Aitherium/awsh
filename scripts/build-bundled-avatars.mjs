#!/usr/bin/env node
/**
 * build-bundled-avatars.mjs — Build compact, bust-cropped, area-averaged PNG avatar
 * packs in `assets-bundled/` from full-res `assets/<char>-portrait/` so `@aitherium/awsh`
 * ships real animated terminal avatars inside the npm tarball (< 1.5 MB total instead of
 * 239 MB of raw 480x832 frames — which previously caused `assets/` to be omitted from
 * package.json `files`, leaving installed builds with zero portraits).
 *
 * Zero external dependencies: uses Node's built-in zlib + pure-JS PNG codec.
 */
import { existsSync, mkdirSync, readdirSync, readFileSync, statSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { deflateSync, inflateSync } from 'node:zlib';

const CLI_ROOT = join(dirname(fileURLToPath(import.meta.url)), '..');
const SRC_ASSETS = join(CLI_ROOT, 'assets');
const OUT_ASSETS = join(CLI_ROOT, 'assets-bundled');

// Target bust-cropped portrait size: 88x104 RGBA PNG (~12-18 KB each).
// Plenty of resolution for 44-col half-blocks AND crisp Kitty/Sixel/iTerm2 terminal avatars!
const TARGET_W = 88;
const TARGET_H = 104;

// Key emotions + frames to bundle per character (compact, expressive, animated).
const EMOTION_DIRS = ['idle', 'happy', 'curious', 'angry', 'sad', 'love', 'surprised', 'tired'];
const FRAMES_PER_DIR = {
  idle: 4,       // gentle breathing/blink loop
  curious: 3,    // thinking loop
  happy: 2,
  angry: 2,
  sad: 2,
  love: 2,
  surprised: 2,
  tired: 2,
};
const TALK_FRAMES = 4; // neutral-talk-0..3.png for lip-sync

const CRC_TABLE = (() => {
  const t = new Uint32Array(256);
  for (let i = 0; i < 256; i++) {
    let c = i;
    for (let k = 0; k < 8; k++) c = (c & 1) ? (0xedb88320 ^ (c >>> 1)) : (c >>> 1);
    t[i] = c >>> 0;
  }
  return t;
})();

function crc32(data) {
  let c = 0xffffffff;
  for (let i = 0; i < data.length; i++) c = CRC_TABLE[(c ^ data[i]) & 0xff] ^ (c >>> 8);
  return (c ^ 0xffffffff) >>> 0;
}

function paeth(a, b, c) {
  const p = a + b - c;
  const pa = Math.abs(p - a), pb = Math.abs(p - b), pc = Math.abs(p - c);
  return pa <= pb && pa <= pc ? a : pb <= pc ? b : c;
}

function decodePng(buf) {
  let width = 0, height = 0, colorType = 0;
  const idat = [];
  let pos = 8;
  while (pos + 12 <= buf.length) {
    const len = buf.readUInt32BE(pos);
    const type = buf.subarray(pos + 4, pos + 8).toString('ascii');
    const data = buf.subarray(pos + 8, pos + 8 + len);
    pos += 12 + len;
    if (type === 'IHDR') {
      width = data.readUInt32BE(0);
      height = data.readUInt32BE(4);
      colorType = data[9];
    } else if (type === 'IDAT') {
      idat.push(data);
    } else if (type === 'IEND') break;
  }
  const raw = inflateSync(Buffer.concat(idat));
  const ch = colorType === 6 ? 4 : 3;
  const stride = width * ch;
  const rgba = new Uint8Array(width * height * 4);
  const curr = new Uint8Array(stride);
  const prev = new Uint8Array(stride);
  for (let y = 0; y < height; y++) {
    const rowOff = y * (1 + stride);
    const ft = raw[rowOff];
    for (let i = 0; i < stride; i++) {
      const a = i >= ch ? curr[i - ch] : 0;
      const b = y > 0 ? prev[i] : 0;
      const c = y > 0 && i >= ch ? prev[i - ch] : 0;
      const v = raw[rowOff + 1 + i];
      if (ft === 0) curr[i] = v;
      else if (ft === 1) curr[i] = (v + a) & 0xff;
      else if (ft === 2) curr[i] = (v + b) & 0xff;
      else if (ft === 3) curr[i] = (v + ((a + b) >> 1)) & 0xff;
      else curr[i] = (v + paeth(a, b, c)) & 0xff;
    }
    const dstBase = y * width * 4;
    if (ch === 4) rgba.set(curr, dstBase);
    else {
      for (let x = 0; x < width; x++) {
        rgba[dstBase + x * 4] = curr[x * 3];
        rgba[dstBase + x * 4 + 1] = curr[x * 3 + 1];
        rgba[dstBase + x * 4 + 2] = curr[x * 3 + 2];
        rgba[dstBase + x * 4 + 3] = 255;
      }
    }
    prev.set(curr);
  }
  return { width, height, rgba };
}

function bustCrop(img) {
  const { width, height, rgba } = img;
  let minX = width, minY = height, maxX = -1, maxY = -1;
  for (let y = 0; y < height; y += 2) {
    for (let x = 0; x < width; x += 2) {
      if (rgba[(y * width + x) * 4 + 3] >= 16) {
        if (x < minX) minX = x;
        if (x > maxX) maxX = x;
        if (y < minY) minY = y;
        if (y > maxY) maxY = y;
      }
    }
  }
  if (maxX < minX || maxY < minY) return { x: 0, y: 0, width, height };
  const bw = maxX - minX + 1;
  const bh = maxY - minY + 1;
  if (bh <= bw * 1.25) {
    const padX = Math.floor(bw * 0.04);
    const padY = Math.floor(bh * 0.04);
    const x0 = Math.max(0, minX - padX);
    const y0 = Math.max(0, minY - padY);
    return { x: x0, y: y0, width: Math.min(width - x0, bw + padX * 2), height: Math.min(height - y0, bh + padY * 2) };
  }
  const cropH = Math.min(height - minY, Math.max(Math.round(bh * 0.56), Math.round(bw * 0.95)));
  const desiredW = Math.min(width, Math.max(bw, Math.round(cropH * (TARGET_W / TARGET_H))));
  const cx = Math.floor((minX + maxX) / 2);
  const x0 = Math.max(0, Math.min(width - desiredW, cx - Math.floor(desiredW / 2)));
  const y0 = Math.max(0, minY - Math.floor(cropH * 0.04));
  return { x: x0, y: y0, width: Math.max(1, Math.min(width - x0, desiredW)), height: Math.max(1, Math.min(height - y0, cropH)) };
}

function resample(img, outW, outH, crop) {
  const { width, height, rgba } = img;
  const out = new Uint8Array(outW * outH * 4);
  const scaleX = crop.width / outW;
  const scaleY = crop.height / outH;
  for (let ty = 0; ty < outH; ty++) {
    const sy0 = Math.max(0, Math.floor(crop.y + ty * scaleY));
    const sy1 = Math.min(height, Math.max(sy0 + 1, Math.ceil(crop.y + (ty + 1) * scaleY)));
    for (let tx = 0; tx < outW; tx++) {
      const sx0 = Math.max(0, Math.floor(crop.x + tx * scaleX));
      const sx1 = Math.min(width, Math.max(sx0 + 1, Math.ceil(crop.x + (tx + 1) * scaleX)));
      let pr = 0, pg = 0, pb = 0, pa = 0, count = 0;
      for (let sy = sy0; sy < sy1; sy++) {
        const ro = sy * width * 4;
        for (let sx = sx0; sx < sx1; sx++) {
          const o = ro + sx * 4;
          const a = rgba[o + 3];
          pa += a; pr += rgba[o] * a; pg += rgba[o + 1] * a; pb += rgba[o + 2] * a;
          count++;
        }
      }
      const dst = (ty * outW + tx) * 4;
      if (count > 0 && pa > 0) {
        out[dst] = Math.round(pr / pa);
        out[dst + 1] = Math.round(pg / pa);
        out[dst + 2] = Math.round(pb / pa);
        out[dst + 3] = Math.round(pa / count);
      }
    }
  }
  return { width: outW, height: outH, rgba: out };
}

function encodePng(img) {
  const { width, height, rgba } = img;
  const sig = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]);
  const chunk = (type, data) => {
    const len = Buffer.alloc(4); len.writeUInt32BE(data.length, 0);
    const t = Buffer.from(type, 'ascii');
    const crc = Buffer.alloc(4); crc.writeUInt32BE(crc32(new Uint8Array(Buffer.concat([t, data]))), 0);
    return Buffer.concat([len, t, data, crc]);
  };
  const ihdr = Buffer.alloc(13);
  ihdr.writeUInt32BE(width, 0); ihdr.writeUInt32BE(height, 4);
  ihdr[8] = 8; ihdr[9] = 6;
  const stride = width * 4;
  const raw = Buffer.alloc(height * (1 + stride));
  for (let y = 0; y < height; y++) {
    const dst = y * (1 + stride), src = y * stride;
    raw[dst] = 1; // Sub filter
    for (let i = 0; i < stride; i++) {
      raw[dst + 1 + i] = (rgba[src + i] - (i >= 4 ? rgba[src + i - 4] : 0)) & 0xff;
    }
  }
  return Buffer.concat([sig, chunk('IHDR', ihdr), chunk('IDAT', deflateSync(raw, { level: 9 })), chunk('IEND', Buffer.alloc(0))]);
}

function shrinkOne(srcPath, dstPath) {
  if (!existsSync(srcPath)) return 0;
  const img = decodePng(readFileSync(srcPath));
  const crop = bustCrop(img);
  const aspect = crop.width / crop.height;
  const outH = TARGET_H;
  const outW = Math.max(48, Math.min(TARGET_W, Math.round(outH * aspect)));
  const out = encodePng(resample(img, outW, outH, crop));
  mkdirSync(dirname(dstPath), { recursive: true });
  writeFileSync(dstPath, out);
  return out.length;
}

if (!existsSync(SRC_ASSETS)) {
  console.error('No source assets/ directory found at', SRC_ASSETS);
  process.exit(1);
}

const chars = readdirSync(SRC_ASSETS, { withFileTypes: true })
  .filter((d) => d.isDirectory() && d.name.endsWith('-portrait'))
  .map((d) => d.name)
  .sort();

let totalFiles = 0;
let totalBytes = 0;

for (const charDir of chars) {
  const srcChar = join(SRC_ASSETS, charDir);
  const dstChar = join(OUT_ASSETS, charDir);
  let charBytes = 0;
  let charFiles = 0;

  // neutral.png still
  const nBytes = shrinkOne(join(srcChar, 'neutral.png'), join(dstChar, 'neutral.png'));
  if (nBytes) { charBytes += nBytes; charFiles++; }

  // talk frames (stride across 8 frames → 4 evenly spaced mouth poses)
  for (let i = 0; i < TALK_FRAMES; i++) {
    const srcIdx = i * 2;
    const b = shrinkOne(join(srcChar, `neutral-talk-${srcIdx}.png`), join(dstChar, `neutral-talk-${i}.png`));
    if (b) { charBytes += b; charFiles++; }
  }

  // emotion clips
  for (const emo of EMOTION_DIRS) {
    const srcEmo = join(srcChar, emo);
    if (!existsSync(srcEmo)) continue;
    const pngs = readdirSync(srcEmo).filter((f) => /^frame_\d+\.png$/i.test(f)).sort();
    const want = FRAMES_PER_DIR[emo] || 2;
    const step = Math.max(1, Math.floor(pngs.length / want));
    for (let k = 0; k < want && k * step < pngs.length; k++) {
      const dstName = `frame_${String(k).padStart(2, '0')}.png`;
      const b = shrinkOne(join(srcEmo, pngs[k * step]), join(dstChar, emo, dstName));
      if (b) { charBytes += b; charFiles++; }
    }
  }

  totalFiles += charFiles;
  totalBytes += charBytes;
  console.log(`  ${charDir.padEnd(18)} ${String(charFiles).padStart(3)} files  ${(charBytes / 1024).toFixed(0).padStart(5)} KB`);
}

console.log(`Total bundled avatars: ${totalFiles} PNGs, ${(totalBytes / (1024 * 1024)).toFixed(2)} MB -> ${OUT_ASSETS}`);
