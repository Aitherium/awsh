/**
 * Zero-dependency Unicode micro-charts for the trace pane.
 *
 * All output is SINGLE-CELL-WIDTH glyphs only (braille U+28xx, block-elements
 * U+258x/U+2588, box-drawing) so blessed's column maths stays correct — the
 * codebase's emoji "character bleed" bug never applies here. ASCII fallbacks
 * kick in under TERM=dumb / AITHER_ASCII=1.
 *
 * Every function is pure: values in → string out. Colour is applied by the
 * caller (theme COLORS) so these stay testable as plain strings.
 */
import { COLORS } from './theme.js';

const ASCII = process.env.AITHER_ASCII === '1' || process.env.TERM === 'dumb';

// ── block bars ────────────────────────────────────────────────────────────
// 9 levels: empty + ▁▂▃▄▅▆▇█. Used for filled bars and per-cell partials.
const BLOCKS = ['', '▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
const BLOCKS_ASCII = ['', '.', ':', '-', '=', '+', '*', '#', '#'];

// ── vertical sparkline (one glyph per value, height encoded) ────────────────
const SPARK = ['▁', '▂', '▃', '▄', '▅', '▆', '▇', '█'];
const SPARK_ASCII = ['_', '.', '.', '-', '-', '=', '*', '#'];

// ── braille sparkline (2 columns × 4 rows per cell = denser history) ────────
// Braille dot bit layout (Unicode): col0 = bits 0,1,2,6 (top→bottom),
// col1 = bits 3,4,5,7. We light dots from the bottom up to encode magnitude.
const BRAILLE_BASE = 0x2800;
const BRAILLE_COL = [
  [0x40, 0x04, 0x02, 0x01], // left column, bottom→top
  [0x80, 0x20, 0x10, 0x08], // right column, bottom→top
];

function clamp01(x: number): number {
  return x < 0 ? 0 : x > 1 ? 1 : x;
}

function range(values: number[], min?: number, max?: number): [number, number] {
  const lo = min ?? Math.min(...values, 0);
  const hi = max ?? Math.max(...values, 1);
  return hi > lo ? [lo, hi] : [lo, lo + 1];
}

/**
 * A block sparkline: one ▁-█ glyph per value. Compact, exact per-sample.
 * Good for short series (per-source token counts, iteration confidences).
 */
export function renderSparkline(values: number[], min?: number, max?: number): string {
  if (!values.length) return '';
  const set = ASCII ? SPARK_ASCII : SPARK;
  const [lo, hi] = range(values, min, max);
  return values
    .map(v => set[Math.round(clamp01((v - lo) / (hi - lo)) * (set.length - 1))])
    .join('');
}

/**
 * A braille sparkline packing `2 × width` samples into `width` cells — twice
 * the horizontal density of the block sparkline. Ideal for token-throughput
 * history where you want a lot of samples in a narrow gutter.
 */
export function renderBrailleSparkline(values: number[], width: number, min?: number, max?: number): string {
  if (!values.length || width <= 0) return '';
  if (ASCII) return renderSparkline(values.slice(-width), min, max);
  const [lo, hi] = range(values, min, max);
  const norm = values.map(v => clamp01((v - lo) / (hi - lo)));
  // Take the last (2*width) samples so the newest data is shown.
  const slice = norm.slice(-width * 2);
  const cells: string[] = [];
  for (let c = 0; c < width; c++) {
    const a = slice[c * 2];
    const b = slice[c * 2 + 1];
    if (a == null && b == null) { cells.push(' '); continue; }
    let bits = 0;
    for (const [col, val] of [[0, a], [1, b]] as const) {
      if (val == null) continue;
      const lit = Math.round(val * 4); // 0..4 dots lit from the bottom
      for (let d = 0; d < lit; d++) bits |= BRAILLE_COL[col][d];
    }
    cells.push(String.fromCharCode(BRAILLE_BASE + bits));
  }
  return cells.join('');
}

/**
 * A horizontal filled bar of `width` cells representing `value/total`, with
 * sub-cell precision via the block-element glyphs. Returns exactly `width`
 * columns (space-padded), so bars in a column align.
 */
export function renderBar(value: number, total: number, width: number): string {
  if (width <= 0) return '';
  const set = ASCII ? BLOCKS_ASCII : BLOCKS;
  const frac = total > 0 ? clamp01(value / total) : 0;
  const exact = frac * width;
  const full = Math.floor(exact);
  const rem = exact - full;
  const partialIdx = Math.round(rem * (set.length - 1));
  const fullCh = ASCII ? '#' : '█';
  let bar = fullCh.repeat(Math.min(full, width));
  if (full < width && partialIdx > 0) bar += set[partialIdx];
  return bar.padEnd(width, ASCII ? ' ' : ' ');
}

/**
 * A labelled "flame" row: `label` (left, padded to labelWidth) + a bar sized to
 * value/total + a right-hand annotation (e.g. "712ms"). The whole thing fits in
 * `width` columns. Colour is applied by the caller.
 */
export function renderFlameBar(
  label: string,
  value: number,
  total: number,
  width: number,
  annotation = '',
  labelWidth = 10,
): string {
  const lbl = label.length > labelWidth ? label.slice(0, labelWidth - 1) + '…' : label.padEnd(labelWidth);
  const ann = annotation ? ` ${annotation}` : '';
  const barWidth = Math.max(4, width - lbl.length - ann.length - 1);
  const bar = renderBar(value, total, barWidth);
  return `${lbl} ${bar}${ann}`;
}

/**
 * A confidence/percentage meter: [██████▒▒▒▒] with a right-hand percentage.
 * `score` is 0..1. Filled cells use the block char; empty cells use a light
 * shade so the track is always visible.
 */
export function renderMeter(score: number, width = 10): string {
  const s = clamp01(score);
  const fillCh = ASCII ? '#' : '█';
  const emptyCh = ASCII ? '.' : '░';
  const filled = Math.round(s * width);
  const bar = fillCh.repeat(filled) + emptyCh.repeat(Math.max(0, width - filled));
  return `${bar} ${Math.round(s * 100)}%`;
}

/**
 * Colour a bar/meter string by magnitude on a cool→hot ramp
 * (dim → cyan → green → yellow → red). Used for flame layers + confidence.
 */
export function heat(fraction: number, s: string): string {
  const f = clamp01(fraction);
  if (f < 0.2) return COLORS.muted(s);
  if (f < 0.45) return COLORS.accent(s);
  if (f < 0.7) return COLORS.success(s);
  if (f < 0.88) return COLORS.warn(s);
  return COLORS.error(s);
}
