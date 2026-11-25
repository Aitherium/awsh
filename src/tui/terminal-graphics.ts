/**
 * terminal-graphics.ts — Multi-protocol terminal avatar & image rendering engine.
 *
 * Brings REAL avatars back to the terminal across every modern terminal emulator,
 * with zero external dependencies:
 *
 *   1. Kitty Graphics Protocol  (Kitty, Ghostty, WezTerm)  — pixel-perfect PNG + alpha + in-place frame replace
 *   2. iTerm2 Inline Images     (iTerm2, WezTerm, Mintty)  — OSC 1337 native inline PNG
 *   3. Sixel Graphics           (Windows Terminal 1.22+, foot, mlterm, xterm, Contour) — DCS q true-pixel raster
 *   4. Area-Averaged Half-Block (Universal 24-bit fallback, tmux, SSH, VS Code) — crisp U+2580/U+2584 truecolor
 *
 * Override anytime via `AWSH_AVATAR_PROTOCOL=auto|kitty|sixel|iterm2|halfblock` or `/avatar protocol <p>`.
 */
import { existsSync, readFileSync, readdirSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import {
  computePortraitCrop,
  decodePng,
  encodePng,
  renderHalfBlock,
  resampleRgba,
  type PngImage,
  type PortraitCropMode,
} from './portrait.js';

export type GraphicsProtocol = 'kitty' | 'iterm2' | 'sixel' | 'halfblock';
export type ProtocolPreference = 'auto' | GraphicsProtocol;

export const GRAPHICS_PROTOCOLS: readonly ProtocolPreference[] = [
  'auto', 'kitty', 'sixel', 'iterm2', 'halfblock',
];

export interface ProtocolDetection {
  protocol: GraphicsProtocol;
  reason: string;
  explicit: boolean;
}

/**
 * Pure: detect the best native terminal graphics protocol for `env`.
 * Inside tmux/screen without passthrough, safely degrades to `halfblock` so escape
 * sequences never corrupt the multiplexer.
 */
export function detectGraphicsProtocol(
  env: NodeJS.ProcessEnv = process.env,
  preferred?: ProtocolPreference | string,
): ProtocolDetection {
  const rawPref = (env.AWSH_AVATAR_PROTOCOL || preferred || 'auto').trim().toLowerCase();
  if (rawPref === 'kitty' || rawPref === 'sixel' || rawPref === 'iterm2' || rawPref === 'halfblock') {
    return { protocol: rawPref, reason: 'explicit setting', explicit: true };
  }

  // Inside tmux/screen, native graphics passthrough is off by default — half-blocks always survive.
  if ((env.TMUX || env.STY) && env.AWSH_TMUX_PASSTHROUGH !== '1') {
    return { protocol: 'halfblock', reason: 'multiplexer (tmux/screen) — halfblock safe', explicit: false };
  }

  const term = (env.TERM || '').toLowerCase();
  const termProg = (env.TERM_PROGRAM || '').toLowerCase();

  // Kitty, Ghostty, and WezTerm natively support Kitty Graphics Protocol (best quality + alpha + frame IDs).
  if (env.KITTY_WINDOW_ID || term.includes('kitty')) {
    return { protocol: 'kitty', reason: 'Kitty terminal detected', explicit: false };
  }
  if (env.GHOSTTY_RESOURCES_DIR || term.includes('ghostty') || termProg === 'ghostty') {
    return { protocol: 'kitty', reason: 'Ghostty terminal detected', explicit: false };
  }
  if (env.WEZTERM_EXECUTABLE || env.WEZTERM_PANE || termProg === 'wezterm') {
    return { protocol: 'kitty', reason: 'WezTerm detected (Kitty protocol)', explicit: false };
  }

  // iTerm2 inline image protocol (OSC 1337).
  if (termProg === 'iterm.app' || env.ITERM_SESSION_ID) {
    return { protocol: 'iterm2', reason: 'iTerm2 detected', explicit: false };
  }

  // Windows Terminal 1.22+ and known Sixel terminals.
  // Note: WT_SESSION is set in Windows Terminal; Windows Terminal 1.22+ supports Sixel,
  // while older builds ignore DCS q cleanly — users on older WT can switch to halfblock,
  // and in TUI docked mode we default WT to Sixel when AWSH_WT_SIXEL=1 or halfblock for
  // universal blessed compatibility unless explicitly requested.
  if (env.AWSH_WT_SIXEL === '1' && env.WT_SESSION) {
    return { protocol: 'sixel', reason: 'Windows Terminal (Sixel enabled)', explicit: false };
  }
  if (term.startsWith('foot') || term.includes('mlterm') || termProg === 'contour' || termProg === 'mintty') {
    return { protocol: 'sixel', reason: `${env.TERM_PROGRAM || env.TERM} Sixel support`, explicit: false };
  }

  return {
    protocol: 'halfblock',
    reason: env.WT_SESSION
      ? 'Windows Terminal (24-bit half-block; set AWSH_AVATAR_PROTOCOL=sixel for WT 1.22+ Sixel)'
      : 'universal 24-bit truecolor half-block',
    explicit: false,
  };
}

// ── Kitty Graphics Protocol (APC G ... ST) ───────────────────────────────────

export interface KittyEncodeOpts {
  cols: number;
  rows: number;
  imageId?: number;
  placementId?: number;
  /** Keep cursor stationary (C=1) so docked TUI positioning never shifts. */
  noCursorMove?: boolean;
}

/**
 * Encode a PNG buffer as Kitty Graphics Protocol APC chunks (`\x1b_G...;\x1b\\`).
 * Uses `q=2` (suppress terminal ack noise so stdin/readline/blessed never receives
 * stray escape responses) and optional fixed `i=<imageId>` for flicker-free animation.
 */
export function encodeKittyPng(pngBuf: Buffer, opts: KittyEncodeOpts): string {
  const b64 = pngBuf.toString('base64');
  const CHUNK = 4096;
  const parts: string[] = [];
  const baseCtrl: string[] = [
    'a=T',
    'f=100',
    'q=2',
    `c=${Math.max(1, Math.floor(opts.cols))}`,
    `r=${Math.max(1, Math.floor(opts.rows))}`,
  ];
  if (opts.imageId != null) baseCtrl.push(`i=${Math.max(1, Math.floor(opts.imageId))}`);
  if (opts.placementId != null) baseCtrl.push(`p=${Math.max(1, Math.floor(opts.placementId))}`);
  if (opts.noCursorMove) baseCtrl.push('C=1');

  for (let i = 0; i < b64.length; i += CHUNK) {
    const slice = b64.slice(i, i + CHUNK);
    const more = i + CHUNK < b64.length ? 1 : 0;
    const ctrl = i === 0 ? `${baseCtrl.join(',')},m=${more}` : `m=${more}`;
    parts.push(`\x1b_G${ctrl};${slice}\x1b\\`);
  }
  return parts.join('');
}

/** Delete a previously placed Kitty image by id (used when hiding/detaching avatar pane). */
export function clearKittyImage(imageId: number): string {
  return `\x1b_Ga=d,d=I,i=${Math.max(1, Math.floor(imageId))},q=2;\x1b\\`;
}

// ── iTerm2 Inline Image Protocol (OSC 1337) ──────────────────────────────────

export function encodeITerm2Png(pngBuf: Buffer, cols: number, rows: number): string {
  const b64 = pngBuf.toString('base64');
  const c = Math.max(1, Math.floor(cols));
  const r = Math.max(1, Math.floor(rows));
  return `\x1b]1337;File=inline=1;size=${pngBuf.length};width=${c};height=${r};preserveAspectRatio=1:${b64}\x07`;
}

// ── Sixel Graphics Encoder (DCS q ... ST) ────────────────────────────────────

/**
 * Quantize RGBA pixels to a crisp 216-color RGB cube (6x6x6) + 16 greyscale ramp
 * (232 colors total, fitting comfortably inside the 256-register Sixel spec)
 * and RLE-encode into a compact Sixel byte stream (`\x1bPq...\x1b\\`).
 *
 * Transparent pixels (alpha < 32) are skipped so the terminal background shows through!
 */
export function encodeSixelRgba(img: PngImage): string {
  const { width, height, rgba } = img;
  if (width <= 0 || height <= 0) return '';

  // Map each opaque pixel to a palette slot (0..231) and track used slots.
  const total = width * height;
  const indices = new Int16Array(total);
  const used = new Uint8Array(232);
  const paletteRgb = new Uint8Array(232 * 3);

  // Build 6x6x6 color cube (0..215) + 16 grey levels (216..231).
  for (let r = 0; r < 6; r++) {
    for (let g = 0; g < 6; g++) {
      for (let b = 0; b < 6; b++) {
        const idx = r * 36 + g * 6 + b;
        paletteRgb[idx * 3] = Math.round((r * 255) / 5);
        paletteRgb[idx * 3 + 1] = Math.round((g * 255) / 5);
        paletteRgb[idx * 3 + 2] = Math.round((b * 255) / 5);
      }
    }
  }
  for (let k = 0; k < 16; k++) {
    const idx = 216 + k;
    const v = Math.round(((k + 1) * 255) / 17);
    paletteRgb[idx * 3] = v;
    paletteRgb[idx * 3 + 1] = v;
    paletteRgb[idx * 3 + 2] = v;
  }

  for (let p = 0; p < total; p++) {
    const o = p * 4;
    if (rgba[o + 3] < 32) {
      indices[p] = -1;
      continue;
    }
    const r = rgba[o], g = rgba[o + 1], b = rgba[o + 2];
    const maxC = Math.max(r, g, b);
    const minC = Math.min(r, g, b);
    let idx: number;
    if (maxC - minC <= 10 && r > 12 && r < 243) {
      // Near-neutral grey → use greyscale ramp for smooth skin/hair shading.
      const grey = Math.round(((r + g + b) / 3) * 15 / 255);
      idx = 216 + Math.max(0, Math.min(15, grey));
    } else {
      const ri = Math.round((r * 5) / 255);
      const gi = Math.round((g * 5) / 255);
      const bi = Math.round((b * 5) / 255);
      idx = ri * 36 + gi * 6 + bi;
    }
    indices[p] = idx;
    used[idx] = 1;
  }

  // Emit header: P2=1 keeps transparent areas untouched (terminal bg shows through).
  const out: string[] = [`\x1bP0;1;0q"1;1;${width};${height}`];
  for (let idx = 0; idx < 232; idx++) {
    if (!used[idx]) continue;
    const rPct = Math.round((paletteRgb[idx * 3] * 100) / 255);
    const gPct = Math.round((paletteRgb[idx * 3 + 1] * 100) / 255);
    const bPct = Math.round((paletteRgb[idx * 3 + 2] * 100) / 255);
    out.push(`#${idx};2;${rPct};${gPct};${bPct}`);
  }

  const rleEncode = (bits: Uint8Array, len: number): string => {
    let s = '';
    let i = 0;
    while (i < len) {
      const ch = String.fromCharCode(bits[i] + 63);
      let run = 1;
      while (i + run < len && bits[i + run] === bits[i]) run++;
      if (run >= 4) s += `!${run}${ch}`;
      else s += ch.repeat(run);
      i += run;
    }
    return s;
  };

  const bandBits = new Uint8Array(width);
  const bandColors = new Uint8Array(232);

  for (let bandY = 0; bandY < height; bandY += 6) {
    bandColors.fill(0);
    const maxDy = Math.min(6, height - bandY);
    for (let dy = 0; dy < maxDy; dy++) {
      const row = (bandY + dy) * width;
      for (let x = 0; x < width; x++) {
        const c = indices[row + x];
        if (c >= 0) bandColors[c] = 1;
      }
    }

    let firstInBand = true;
    for (let c = 0; c < 232; c++) {
      if (!bandColors[c]) continue;
      let lastNonZero = -1;
      for (let x = 0; x < width; x++) {
        let mask = 0;
        for (let dy = 0; dy < maxDy; dy++) {
          if (indices[(bandY + dy) * width + x] === c) mask |= 1 << dy;
        }
        bandBits[x] = mask;
        if (mask !== 0) lastNonZero = x;
      }
      if (lastNonZero < 0) continue;
      if (!firstInBand) out.push('$'); // graphics carriage return (same 6-row band)
      firstInBand = false;
      out.push(`#${c}${rleEncode(bandBits, lastNonZero + 1)}`);
    }
    if (bandY + 6 < height) out.push('-'); // graphics newline (advance 6 pixels)
  }

  out.push('\x1b\\');
  return out.join('');
}

// ── High-level rendered frame (unified across all protocols) ─────────────────

export interface RenderedAvatarFrame {
  protocol: GraphicsProtocol;
  cols: number;
  rows: number;
  /** Half-block ANSI lines (always populated as universal fallback / metrics). */
  lines: string[];
  /** Native escape payload (Kitty APC / iTerm2 OSC / Sixel DCS), null for halfblock. */
  nativePayload: string | null;
}

export interface RenderAvatarFrameOpts {
  cols: number;
  maxRows?: number;
  crop?: PortraitCropMode;
  protocol?: GraphicsProtocol;
  imageId?: number;
  noCursorMove?: boolean;
}

/**
 * Decode a PNG file and render it for `opts.protocol` (default halfblock).
 * Returns BOTH half-block lines and (for Kitty/iTerm2/Sixel) the native escape payload
 * sized to the exact same cell geometry `(cols, rows)`.
 */
export function renderAvatarFile(
  filePath: string,
  opts: RenderAvatarFrameOpts,
): RenderedAvatarFrame | null {
  try {
    if (!existsSync(filePath)) return null;
    const rawBuf = readFileSync(filePath);
    const decoded = decodePng(rawBuf);
    return renderAvatarImage(decoded, opts);
  } catch {
    return null;
  }
}

export function renderAvatarImage(
  decoded: PngImage,
  opts: RenderAvatarFrameOpts,
): RenderedAvatarFrame {
  const protocol = opts.protocol ?? 'halfblock';
  const cropMode = opts.crop ?? 'bust';
  const crop = cropMode === 'bust' ? computePortraitCrop(decoded, 'bust') : undefined;
  const effW = crop ? crop.width : decoded.width;
  const effH = crop ? crop.height : decoded.height;
  const aspect = effW / effH;

  let outCols = Math.max(4, Math.floor(opts.cols));
  let outRows = Math.max(2, Math.round(outCols / (aspect * 2)));
  if (opts.maxRows && outRows > opts.maxRows) {
    outRows = Math.max(2, Math.floor(opts.maxRows));
    outCols = Math.max(4, Math.min(outCols, Math.round(outRows * 2 * aspect)));
  }

  const lines = renderHalfBlock(decoded.rgba, decoded.width, decoded.height, outCols, {
    maxRows: outRows,
    crop: cropMode,
  });
  const actualRows = Math.max(1, lines.length);

  if (protocol === 'halfblock') {
    return { protocol, cols: outCols, rows: actualRows, lines, nativePayload: null };
  }

  // Target crisp pixel dimensions for native graphics (~10x20 px per cell, capped at 320px).
  const pxW = Math.min(320, Math.max(64, outCols * 10));
  const pxH = Math.min(400, Math.max(64, actualRows * 20));
  const resized = resampleRgba(decoded, pxW, pxH, crop);

  if (protocol === 'kitty') {
    const png = encodePng(resized);
    const nativePayload = encodeKittyPng(png, {
      cols: outCols,
      rows: actualRows,
      imageId: opts.imageId,
      noCursorMove: opts.noCursorMove,
    });
    return { protocol, cols: outCols, rows: actualRows, lines, nativePayload };
  }

  if (protocol === 'iterm2') {
    const png = encodePng(resized);
    const nativePayload = encodeITerm2Png(png, outCols, actualRows);
    return { protocol, cols: outCols, rows: actualRows, lines, nativePayload };
  }

  // Sixel: keep width/height modest (<= 240px) so RLE emission stays fast & crisp.
  const sixelW = Math.min(240, Math.max(64, outCols * 8));
  const sixelH = Math.min(300, Math.max(64, actualRows * 16));
  const sixelImg = (sixelW === resized.width && sixelH === resized.height)
    ? resized
    : resampleRgba(decoded, sixelW, sixelH, crop);
  const nativePayload = encodeSixelRgba(sixelImg);
  return { protocol, cols: outCols, rows: actualRows, lines, nativePayload };
}

// ── Multi-root avatar asset discovery (custom → full dev → bundled npm) ──────

/**
 * Candidate roots containing `<name>-portrait/` directories, in precedence order:
 *   1. `~/.aither/avatars`          (user-installed / awdesk-exported custom avatars)
 *   2. `<pkg>/assets`               (full-res dev monorepo assets when present)
 *   3. `<pkg>/assets-bundled`       (compact bundled portraits shipped inside npm package)
 */
export function avatarAssetRoots(home: string = homedir()): string[] {
  const pkgRoot = join(dirname(fileURLToPath(import.meta.url)), '..', '..');
  return [
    join(home, '.aither', 'avatars'),
    join(pkgRoot, 'assets'),
    join(pkgRoot, 'assets-bundled'),
  ];
}

/** Resolve `<name>-portrait` across all avatar roots, or null if none exists. */
export function resolveAvatarDir(name: string, roots: readonly string[] = avatarAssetRoots()): string | null {
  const clean = name.trim().toLowerCase().replace(/-portrait$/, '');
  if (!clean) return null;
  for (const root of roots) {
    const candidate = join(root, `${clean}-portrait`);
    if (existsSync(candidate)) return candidate;
  }
  return null;
}

/** Deduplicated sorted list of all available character avatar names across all roots. */
export function listAvailableAvatars(roots: readonly string[] = avatarAssetRoots()): string[] {
  const found = new Set<string>();
  for (const root of roots) {
    if (!existsSync(root)) continue;
    try {
      for (const entry of readdirSync(root, { withFileTypes: true })) {
        if (entry.isDirectory() && entry.name.endsWith('-portrait')) {
          found.add(entry.name.replace(/-portrait$/, ''));
        }
      }
    } catch { /* unreadable root — skip */ }
  }
  return Array.from(found).sort();
}

/**
 * Pick the best PNG file path for `(dir, emotion)` — checking:
 *   `<dir>/<emotion>/frame_00.png` → `<dir>/<emotion>.png` → `<dir>/idle/frame_00.png` → `<dir>/neutral.png`.
 */
export function pickAvatarStillPath(dir: string, emotion = 'neutral'): string | null {
  const e = (emotion || 'neutral').toLowerCase();
  const candidates = [
    ...(e !== 'neutral' ? [join(dir, e, 'frame_00.png'), join(dir, `${e}.png`)] : []),
    join(dir, 'idle', 'frame_00.png'),
    join(dir, 'neutral.png'),
  ];
  for (const c of candidates) {
    if (existsSync(c)) return c;
  }
  return null;
}
