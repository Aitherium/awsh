/**
 * Design tokens for the AitherShell TUI rendering layer.
 *
 * Single-cell-width glyphs only (box-drawing + ASCII fallbacks). Disciplined
 * palette (one accent family, status colors only). The signature element is the
 * per-turn live timeline tree in the trace pane — this enables quiet, elegant design.
 */
import chalk from 'chalk';

/**
 * Glyphs: box-drawing characters (single-cell width) with ASCII fallbacks.
 * Detect the terminal at startup: fallback when TERM=dumb or AITHER_ASCII=1.
 */
export type GlyphSet = {
  boxH: string;       // ─
  boxV: string;       // │
  boxTL: string;      // ╭
  boxTR: string;      // ╮
  boxBL: string;      // ╰
  boxBR: string;      // ╯
  boxCross: string;   // ┼
  boxT: string;       // ├
  boxB: string;       // ┤
  bullet: string;     // ●
  circleFilled: string; // ●
  circleEmpty: string;  // ○
  diamond: string;    // ◆
  chevronRight: string; // ▸
  chevronDown: string;  // ▾
  checkmark: string;  // ✓
  cross: string;      // ✗
  dot: string;        // ·
};

const UNICODE_GLYPHS: GlyphSet = {
  boxH: '─',
  boxV: '│',
  boxTL: '╭',
  boxTR: '╮',
  boxBL: '╰',
  boxBR: '╯',
  boxCross: '┼',
  boxT: '├',
  boxB: '┤',
  bullet: '●',
  circleFilled: '●',
  circleEmpty: '○',
  diamond: '◆',
  chevronRight: '▸',
  chevronDown: '▾',
  checkmark: '✓',
  cross: '✗',
  dot: '·',
};

const ASCII_GLYPHS: GlyphSet = {
  boxH: '-',
  boxV: '|',
  boxTL: '+',
  boxTR: '+',
  boxBL: '+',
  boxBR: '+',
  boxCross: '+',
  boxT: '|',
  boxB: '|',
  bullet: '*',
  circleFilled: '*',
  circleEmpty: 'o',
  diamond: 'x',
  chevronRight: '>',
  chevronDown: 'v',
  checkmark: '*',
  cross: 'x',
  dot: '.',
};

/**
 * Detect the terminal capabilities and return the appropriate glyph set.
 * Fallback to ASCII when TERM=dumb or AITHER_ASCII=1.
 */
export function detectGlyphs(): GlyphSet {
  if (process.env.AITHER_ASCII === '1') return ASCII_GLYPHS;
  if (process.env.TERM === 'dumb') return ASCII_GLYPHS;
  // Assume Unicode capable; fallback gracefully if output looks broken
  return UNICODE_GLYPHS;
}

/**
 * Assert that all glyph values are single-cell width (for render layout).
 * This is a development helper; call once at startup.
 */
export function assertSingleWidth(glyphs: GlyphSet): void {
  for (const [key, ch] of Object.entries(glyphs)) {
    // Rough single-cell check: most box-drawing + ASCII are 1 column.
    // Emoji/double-width would be 2+. This is a sanity check only.
    if (ch.length > 1 && !ASCII_GLYPHS[key as keyof GlyphSet]?.includes(ch)) {
      const w = process.stdout.getWindowSize?.()?.[0] ?? 0;
      if (w > 0) { /* width check would require external lib */ }
      console.warn(`⚠ glyph "${key}" may be multi-width: "${ch}"`);
    }
  }
}

/**
 * Semantic color palette. Disciplined: one accent family (cyan, brand),
 * status colors (success, error, warn), muted (gray/dim), text (default).
 * Stage-kind coloring uses accent/muted intensity, not different hues.
 */
export const COLORS = {
  accent: (s: string) => chalk.cyan(s),     // brand identity
  success: (s: string) => chalk.green(s),   // ✓ done, ok
  error: (s: string) => chalk.red(s),       // ✗ error, failed
  warn: (s: string) => chalk.yellow(s),     // ⚠ warning, attention
  muted: (s: string) => chalk.dim(s),       // dimmed, secondary
  text: (s: string) => s,                   // default
};

/**
 * Layout metrics: indent unit, column widths, truncation lengths.
 */
export const LAYOUT = {
  indentUnit: 2,              // 2 spaces per nesting level
  metricGutterWidth: 24,      // right-aligned metrics column (e.g. "· 234 tok · 1.5s")
  labelTruncateWidth: 50,     // truncate stage labels to this many chars + "…"
  jsonCapBytes: 5120,         // cap tool JSON display to 5KB each (args + result)
  tracePaneMinWidth: 30,      // don't render trace if narrower than this
};

export type GlyphProvider = ReturnType<typeof detectGlyphs>;
