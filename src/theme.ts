/**
 * AitherShell design system — ONE visual language for every surface.
 *
 * Why this file exists: the boot header (status-banner.ts) had already moved to a
 * modern language (forced 24-bit truecolor, an electric-blue→cyan gradient
 * wordmark, hairline rules, violet accents) while renderer.ts still drew a flat
 * cyan ASCII box with `UP:`/`DN:` caps. Two languages in one shell is what makes
 * it read as dated/inconsistent, so the palette + primitives live HERE and every
 * surface imports them.
 *
 * The 11-theme system (dark-glass, midnight-ocean, neon-cyberpunk, etc.) defines
 * accent, status colors (ok/warn/bad), text, rule, and muted for each theme.
 * Truecolor is FORCED (chalk under-detects in some pipes); `plain()` degrades
 * gracefully when colour is genuinely unavailable.
 */

import chalk from 'chalk';

/** Forced 24-bit truecolor. Windows Terminal renders real 38;2;r;g;b.
 *  NOT `new Chalk({level:3})`: under this package's module resolution the named
 *  `Chalk` export resolves as a TYPE only, so constructing it is a compile error.
 *  Setting `.level` on the default instance forces truecolor identically and works
 *  across chalk majors (v4 exposes `chalk.Instance`, v5 the `Chalk` class). */
export const TC = chalk;
TC.level = 3;

/** Is real colour available (respects NO_COLOR / dumb terminals / pipes)? */
export const COLOR_OK: boolean =
  !process.env.NO_COLOR && chalk.level > 0;

/** Should we emit cursor-movement ANSI (clear-line, reprint)? Only on a TTY —
 *  piped/headless output must stay byte-clean for `aither -p ... | jq`. */
export const TTY: boolean = Boolean(process.stdout.isTTY);

// ── Theme Definitions ──────────────────────────────────────────────────────

export interface ThemePalette {
  accent: [number, number, number];   // Primary UI accent
  accentAlt: [number, number, number]; // Secondary accent
  blue: [number, number, number];      // Gradient start
  cyan: [number, number, number];      // Gradient end
  text: [number, number, number];      // Primary text
  textMuted: [number, number, number]; // Secondary text
  rule: [number, number, number];      // Hairline rules
  ok: [number, number, number];        // Success/healthy
  warn: [number, number, number];      // Warning/attention
  bad: [number, number, number];       // Error/degraded
}

const themes: Record<string, ThemePalette> = {
  'dark-glass': {
    accent: [124, 111, 196],    // #7c6fc4
    accentAlt: [178, 130, 255], // violet
    blue: [64, 132, 255],
    cyan: [82, 226, 255],
    text: [228, 228, 239],      // #e4e4ef
    textMuted: [136, 136, 160], // #8888a0
    rule: [38, 66, 110],
    ok: [86, 222, 160],
    warn: [255, 196, 92],
    bad: [255, 108, 124],
  },

  'midnight-ocean': {
    accent: [45, 212, 191],     // teal
    accentAlt: [34, 197, 230],  // cyan
    blue: [15, 118, 179],       // deep blue
    cyan: [45, 212, 191],       // teal
    text: [237, 242, 247],
    textMuted: [148, 163, 184],
    rule: [30, 58, 138],        // dark blue
    ok: [34, 197, 230],
    warn: [251, 191, 36],
    bad: [244, 63, 94],
  },

  'neon-cyberpunk': {
    accent: [232, 121, 249],    // fuchsia
    accentAlt: [236, 72, 153],  // pink
    blue: [109, 40, 217],       // violet
    cyan: [232, 121, 249],      // fuchsia
    text: [243, 244, 246],
    textMuted: [107, 114, 128],
    rule: [88, 28, 135],        // purple
    ok: [34, 197, 230],
    warn: [251, 146, 60],
    bad: [248, 113, 113],
  },

  'forest-depth': {
    accent: [74, 222, 128],     // green
    accentAlt: [52, 211, 153],  // emerald
    blue: [20, 83, 45],         // dark green
    cyan: [74, 222, 128],       // green
    text: [237, 242, 247],
    textMuted: [156, 163, 175],
    rule: [34, 197, 107],       // green
    ok: [74, 222, 128],
    warn: [251, 191, 36],
    bad: [239, 68, 68],
  },

  'sunset-horizon': {
    accent: [245, 158, 11],     // amber
    accentAlt: [251, 146, 60],  // orange
    blue: [180, 83, 9],         // orange-dark
    cyan: [245, 158, 11],       // amber
    text: [243, 244, 246],
    textMuted: [156, 163, 175],
    rule: [217, 119, 6],        // orange
    ok: [34, 197, 107],
    warn: [251, 146, 60],
    bad: [248, 113, 113],
  },

  'arctic-nord': {
    accent: [191, 219, 254],    // light blue
    accentAlt: [176, 190, 197], // slate blue
    blue: [30, 58, 138],        // dark blue
    cyan: [191, 219, 254],      // light blue
    text: [243, 244, 246],
    textMuted: [148, 163, 184],
    rule: [71, 85, 105],        // slate
    ok: [34, 197, 107],
    warn: [251, 146, 60],
    bad: [239, 68, 68],
  },

  'monokai-pro': {
    accent: [253, 216, 102],    // yellow
    accentAlt: [189, 147, 249], // purple
    blue: [161, 140, 108],      // brown
    cyan: [253, 216, 102],      // yellow
    text: [248, 248, 242],
    textMuted: [117, 113, 94],
    rule: [61, 61, 52],         // dark
    ok: [166, 226, 46],         // green
    warn: [253, 216, 102],      // yellow
    bad: [249, 38, 114],        // pink
  },

  'rose-gold': {
    accent: [249, 168, 212],    // rose
    accentAlt: [244, 114, 182], // pink
    blue: [159, 18, 57],        // dark rose
    cyan: [249, 168, 212],      // rose
    text: [243, 244, 246],
    textMuted: [156, 163, 175],
    rule: [190, 24, 93],        // rose-dark
    ok: [34, 197, 107],
    warn: [251, 191, 36],
    bad: [248, 113, 113],
  },

  'crimson-night': {
    accent: [248, 113, 113],    // red
    accentAlt: [244, 63, 94],   // rose
    blue: [153, 27, 27],        // dark red
    cyan: [248, 113, 113],      // red
    text: [243, 244, 246],
    textMuted: [148, 163, 184],
    rule: [127, 29, 29],        // red-dark
    ok: [34, 197, 107],
    warn: [251, 191, 36],
    bad: [248, 113, 113],
  },

  'solar-flare': {
    accent: [251, 191, 36],     // amber
    accentAlt: [251, 146, 60],  // orange
    blue: [180, 83, 9],         // orange-dark
    cyan: [251, 191, 36],       // amber
    text: [243, 244, 246],
    textMuted: [156, 163, 175],
    rule: [217, 119, 6],        // orange
    ok: [34, 197, 107],
    warn: [251, 191, 36],
    bad: [248, 113, 113],
  },

  'matrix-green': {
    accent: [34, 197, 94],      // green
    accentAlt: [16, 185, 129],  // emerald
    blue: [5, 46, 22],          // dark green
    cyan: [34, 197, 94],        // green
    text: [34, 197, 94],        // green text
    textMuted: [132, 204, 22],  // lime
    rule: [20, 83, 45],         // forest
    ok: [34, 197, 94],
    warn: [251, 191, 36],
    bad: [248, 113, 113],
  },
};

/** Get current theme (defaults to dark-glass) */
export function getTheme(themeId?: string): ThemePalette {
  return themes[themeId || 'dark-glass'] || themes['dark-glass'];
}

/** Set active theme (persisted to env var for child processes) */
export let activeTheme = 'dark-glass';

export function setTheme(themeId: string): void {
  if (themes[themeId]) {
    activeTheme = themeId;
    process.env.AITHERSHELL_THEME = themeId;
  }
}

// ── Palette (dynamic) ──────────────────────────────────────────────────────
function getPalette(): ThemePalette {
  return getTheme(process.env.AITHERSHELL_THEME || activeTheme);
}

/** Current theme palette (default dark-glass) */
export const C = themes['dark-glass'];

const paint = (color: [number, number, number]) => (s: string) =>
  COLOR_OK ? TC.rgb(color[0], color[1], color[2])(s) : s;

// Theme-aware color functions: get current theme's palette and paint
export function accent(s: string): string {
  return paint(getPalette().accent)(s);
}

export function accentAlt(s: string): string {
  return paint(getPalette().accentAlt)(s);
}

export function violet(s: string): string {
  return paint(getPalette().accentAlt)(s);
}

export function ok(s: string): string {
  return paint(getPalette().ok)(s);
}

export function warn(s: string): string {
  return paint(getPalette().warn)(s);
}

export function bad(s: string): string {
  return paint(getPalette().bad)(s);
}

export function ruleColor(s: string): string {
  return paint(getPalette().rule)(s);
}

export const muted = (s: string): string => (COLOR_OK ? chalk.dim(s) : s);
export const dim = (s: string): string => (COLOR_OK ? chalk.dim(s) : s);

/** Interpolate gradient across a string (start → end of current theme) */
export function gradient(s: string): string {
  if (!COLOR_OK) return s;
  const pal = getPalette();
  const chars = [...s];
  const n = Math.max(1, chars.length - 1);
  return chars
    .map((ch, i) => {
      const t = i / n;
      const r = Math.round(pal.blue[0] + (pal.cyan[0] - pal.blue[0]) * t);
      const g = Math.round(pal.blue[1] + (pal.cyan[1] - pal.blue[1]) * t);
      const b = Math.round(pal.blue[2] + (pal.cyan[2] - pal.blue[2]) * t);
      return ch === ' ' ? ch : TC.rgb(r, g, b)(ch);
    })
    .join('');
}

// ── Primitives ─────────────────────────────────────────────────────────────

/** The letter-spaced gradient wordmark, in bracket chrome. */
export function wordmark(text = 'A W S H'): string {
  return dim('⟪ ') + gradient(text) + dim(' ⟫');
}

/** A hairline rule that scales with the terminal, with end caps. */
export function rule(fraction = 0.55, min = 24, max = 52): string {
  const cols = process.stdout.columns || 100;
  const w = Math.max(min, Math.min(max, Math.floor(cols * fraction)));
  return ruleColor('╶' + '─'.repeat(Math.max(1, w - 2)) + '╴');
}

/** Status dot — replaces the old `UP:` / `DN:` caps with a glyph the eye parses
 *  instantly (● healthy, ○ degraded). */
export function dot(up: boolean): string {
  return up ? ok('●') : bad('○');
}

/** Join metadata with the house separator. */
export function metaJoin(parts: (string | null | undefined)[]): string {
  return parts.filter(Boolean).join(dim('  ·  '));
}

/** Glyphs — one set, so every surface speaks the same shorthand. */
export const G = {
  answer: '◈',      // an answer segment begins
  continue: '↳',    // continuing a standing answer
  refine: '↻',      // refining after grounding
  step: '·',        // a pipeline step (was a noisy gear)
  agent: '⬢',
  next: '→',
};

/** Clear the current line — ONLY on a TTY, so piped output stays clean. */
export function clearLine(): string {
  return TTY ? '\r\x1b[2K' : '';
}
