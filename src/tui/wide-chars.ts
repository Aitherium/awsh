/**
 * wide-chars.ts — teach neo-blessed that emoji occupy TWO terminal cells.
 *
 * THE BUG THIS FIXES (measured 2026-07-29)
 * neo-blessed's `lib/unicode.js` carries a ~2010 East-Asian-Width table. It has
 * NO entry above 0x1F000, so every emoji measures as width 1:
 *
 *     unicode.strWidth('\u{1F60A}')  ->  1     (Windows Terminal renders 2)
 *     unicode.strWidth('中')          ->  2     (correct)
 *
 * Windows Terminal — and every other modern terminal — advances TWO cells for an
 * emoji-presentation codepoint. So the instant an answer contains one, blessed's
 * model of the cursor column is off by one for the rest of that physical line.
 * Its renderer then diffs against `olines` and rewrites only the cells it believes
 * changed, at positions one column left of reality, leaving the previous paint's
 * glyphs alive in the gaps. On screen that reads as scrambled prose:
 *
 *     "Tell me something you'd like me to remember"
 *  -> "T ll me something you'd like me eobremember"
 *
 * plus a ghost line of scattered characters above it. It is NOT a model defect and
 * NOT a markdown defect: emoji-free answers render pristine, which is exactly the
 * tell. A headless repro CANNOT see it — blessed's own cell buffer is internally
 * self-consistent; the desync is between blessed and the terminal. Verify with
 * `strWidth`, not with a rendered-buffer readback.
 *
 * SCOPE — deliberately narrow. Only the astral (>= 0x1F000) emoji-presentation
 * ranges below are widened. Every BMP glyph is left EXACTLY as neo-blessed had it,
 * because the whole TUI chrome is BMP (✓ ⚡ ♪ ⬢ ◉ ╭ ─ ▀ …) and that chrome is
 * currently aligned. Some BMP symbols (⚡ U+26A1, ⚠ U+26A0) are formally
 * emoji-presentation and arguably width 2, but widening them would shift panes
 * that render correctly today — so they stay untouched until measured against the
 * real terminal. Narrow-but-right beats broad-and-regressing.
 *
 * Ranges are Unicode East_Asian_Width=Wide over the emoji blocks (the same set
 * every wcwidth implementation uses).
 */
import { createRequire } from 'node:module';

const nodeRequire = createRequire(import.meta.url);

/**
 * GENERATED, not hand-written — regenerate rather than edit by hand:
 *
 *   python -c "import wcwidth; \
 *     print([hex(c) for c in range(0x1F000,0x1FB00) if wcwidth.wcwidth(chr(c))==2])"
 *
 * The first cut of this table WAS hand-typed and cross-validation against
 * `wcwidth` found two classes of error in it, which is why it is generated now:
 *   - 15 codepoints MISSED (newer emoji: U+1F6D8, U+1F6DC, U+1FA89-8A, U+1FA8E-8F,
 *     U+1FABE, U+1FAC6, U+1FAC8, U+1FACD, U+1FADC, U+1FADF, U+1FAE9-EA, U+1FAEF)
 *     — those would have kept garbling.
 *   - 5 codepoints OVER-widened: the range `[0x1f3f8, 0x1f43e]` swallowed
 *     U+1F3FB-U+1F3FF, the skin-tone modifiers, which are **zero** width. Widening
 *     a zero-width combining modifier to 2 introduces fresh misalignment on
 *     sequences like 👍🏽 — i.e. the hand-typed fix carried the very defect class
 *     it was written to remove.
 */
const WIDE_EMOJI: ReadonlyArray<readonly [number, number]> = [
  [0x1f004, 0x1f004], [0x1f0cf, 0x1f0cf], [0x1f18e, 0x1f18e], [0x1f191, 0x1f19a],
  [0x1f200, 0x1f202], [0x1f210, 0x1f23b], [0x1f240, 0x1f248], [0x1f250, 0x1f251],
  [0x1f260, 0x1f265], [0x1f300, 0x1f320], [0x1f32d, 0x1f335], [0x1f337, 0x1f37c],
  [0x1f37e, 0x1f393], [0x1f3a0, 0x1f3ca], [0x1f3cf, 0x1f3d3], [0x1f3e0, 0x1f3f0],
  [0x1f3f4, 0x1f3f4], [0x1f3f8, 0x1f3fa], [0x1f400, 0x1f43e], [0x1f440, 0x1f440],
  [0x1f442, 0x1f4fc], [0x1f4ff, 0x1f53d], [0x1f54b, 0x1f54e], [0x1f550, 0x1f567],
  [0x1f57a, 0x1f57a], [0x1f595, 0x1f596], [0x1f5a4, 0x1f5a4], [0x1f5fb, 0x1f64f],
  [0x1f680, 0x1f6c5], [0x1f6cc, 0x1f6cc], [0x1f6d0, 0x1f6d2], [0x1f6d5, 0x1f6d8],
  [0x1f6dc, 0x1f6df], [0x1f6eb, 0x1f6ec], [0x1f6f4, 0x1f6fc], [0x1f7e0, 0x1f7eb],
  [0x1f7f0, 0x1f7f0], [0x1f90c, 0x1f93a], [0x1f93c, 0x1f945], [0x1f947, 0x1f9ff],
  [0x1fa70, 0x1fa7c], [0x1fa80, 0x1fa8a], [0x1fa8e, 0x1fac6], [0x1fac8, 0x1fac8],
  [0x1facd, 0x1fadc], [0x1fadf, 0x1faea], [0x1faef, 0x1faf8],
];

/**
 * Emoji modifiers (Fitzpatrick skin tones). ZERO width: they compose onto the
 * preceding emoji, so 👍🏽 occupies 2 cells total, not 4. neo-blessed's combining
 * table predates them and reports 1, which is its own (smaller) desync.
 */
const ZERO_WIDTH_EMOJI: ReadonlyArray<readonly [number, number]> = [
  [0x1f3fb, 0x1f3ff],
];

function inRanges(point: number, rs: ReadonlyArray<readonly [number, number]>): boolean {
  for (const [lo, hi] of rs) if (point >= lo && point <= hi) return true;
  return false;
}

/** True when `point` is an emoji-presentation codepoint that renders two cells wide. */
export function isWideEmoji(point: number): boolean {
  if (point < 0x1f000 || point > 0x1faff) return false;
  return inRanges(point, WIDE_EMOJI);
}

/** True when `point` composes onto the previous glyph and occupies no cell. */
export function isZeroWidthEmoji(point: number): boolean {
  if (point < 0x1f000 || point > 0x1faff) return false;
  return inRanges(point, ZERO_WIDTH_EMOJI);
}

let patched = false;

/**
 * Wrap neo-blessed's `charWidth` so emoji report 2. `strWidth` delegates to
 * `charWidth`, so both are corrected by this one override. Idempotent, and a
 * failure to patch is non-fatal — a scrambled emoji line is far better than a
 * shell that won't start.
 */
export function patchBlessedWideChars(): boolean {
  if (patched) return true;
  try {
    const unicode: any = nodeRequire('neo-blessed/lib/unicode.js');
    if (!unicode || typeof unicode.charWidth !== 'function') return false;
    const original = unicode.charWidth.bind(unicode);
    // Same dual call signature as the original: a codepoint, or (str, index).
    unicode.charWidth = function (str: string | number, i?: number): number {
      const point = typeof str === 'number' ? str : unicode.codePointAt(str, i || 0);
      if (isZeroWidthEmoji(point)) return 0;   // must precede the wide check
      if (isWideEmoji(point)) return 2;
      return original(str, i);
    };
    patched = true;
    return true;
  } catch {
    return false;  // never block startup over glyph metrics
  }
}

patchBlessedWideChars();
