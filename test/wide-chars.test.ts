/**
 * Guards the emoji cell-width shim.
 *
 * neo-blessed's East-Asian-Width table stops below 0x1F000, so every emoji
 * measured ONE cell while the terminal advances TWO. One emoji in an answer
 * therefore desynced blessed's cursor model for the rest of that physical line
 * and its dirty-cell diff scrambled the prose ("to remember" -> "eobremember")
 * with a ghost line of scattered characters above it.
 *
 * These assertions are the only cheap oracle for that class: a rendered-buffer
 * readback CANNOT catch it, because blessed's internal buffer is self-consistent
 * — the disagreement is between blessed and the terminal. So assert the WIDTHS.
 */
import test from 'node:test';
import assert from 'node:assert/strict';
import { createRequire } from 'node:module';

import { isWideEmoji, isZeroWidthEmoji, patchBlessedWideChars } from '../src/tui/wide-chars.js';

const nodeRequire = createRequire(import.meta.url);
const unicode: any = nodeRequire('neo-blessed/lib/unicode.js');

// Importing the module already patches; calling again must be a no-op.
patchBlessedWideChars();

test('emoji measure two cells', () => {
  for (const ch of ['\u{1F60A}', '\u{1F680}', '\u{1F4A1}', '\u{1F916}', '\u{1F50D}',
                    '\u{1F3AF}', '\u{1FAA4}', '\u{1F44D}', '\u{1F525}']) {
    assert.equal(unicode.strWidth(ch), 2,
      `U+${ch.codePointAt(0)!.toString(16).toUpperCase()} must be 2 cells`);
  }
});

test('CJK stays two cells (it was already correct)', () => {
  assert.equal(unicode.strWidth('中'), 2);
  assert.equal(unicode.strWidth('日本語'), 6);
});

test('TUI chrome glyphs stay ONE cell — widening them would shift working panes', () => {
  // Every glyph the shell actually draws. If any of these moves to 2, the status
  // bar, trace pane and message frames all mis-wrap.
  const chrome = ['✓', '✗', '⚡', '♪', '⬢', '◉', '◈', '◇', '⬚', '╭', '─', '╰', '│',
                  '▀', '▄', '›', '·', '—', '⟪', '⟫', '▸', '▾', '○', '●', '◒', '⟳',
                  '→', '⚠', '║', '╶', '⌢', '◔'];
  for (const c of chrome) {
    assert.equal(unicode.strWidth(c), 1,
      `${c} (U+${c.codePointAt(0)!.toString(16).toUpperCase()}) must stay 1 cell`);
  }
});

test('plain text arithmetic is unchanged', () => {
  assert.equal(unicode.strWidth('hello'), 5);
  assert.equal(unicode.strWidth(''), 0);
  // h i sp emoji(2) sp y o
  assert.equal(unicode.strWidth('hi \u{1F60A} yo'), 8);
});

test('isWideEmoji covers the emoji planes and nothing outside them', () => {
  assert.equal(isWideEmoji(0x1f60a), true);
  assert.equal(isWideEmoji(0x1f680), true);
  assert.equal(isWideEmoji(0x0041), false);   // 'A'
  assert.equal(isWideEmoji(0x4e2d), false);   // CJK — handled by the real table
  assert.equal(isWideEmoji(0x2713), false);   // ✓ chrome
  assert.equal(isWideEmoji(0x26a1), false);   // ⚡ chrome, deliberately excluded
  assert.equal(isWideEmoji(0x20000), false);  // astral CJK, not an emoji plane
});

test('patch is idempotent', () => {
  const before = unicode.strWidth('\u{1F60A}');
  patchBlessedWideChars();
  patchBlessedWideChars();
  assert.equal(unicode.strWidth('\u{1F60A}'), before);
});

// Both of the following were REAL bugs in the first, hand-typed table, each found
// by cross-validating all 2816 codepoints against python wcwidth. They are locked
// here because a hand-edit of the range list would silently reintroduce either.

test('skin-tone modifiers are ZERO width, not 2 — widening them misaligns 👍🏽', () => {
  for (const cp of [0x1f3fb, 0x1f3fc, 0x1f3fd, 0x1f3fe, 0x1f3ff]) {
    assert.equal(isZeroWidthEmoji(cp), true, `U+${cp.toString(16).toUpperCase()} must be zero-width`);
    assert.equal(isWideEmoji(cp), false, `U+${cp.toString(16).toUpperCase()} must NOT be wide`);
    assert.equal(unicode.charWidth(cp), 0);
  }
  // thumbs-up + modifier composes to 2 cells total, not 3 or 4.
  assert.equal(unicode.strWidth('\u{1F44D}\u{1F3FD}'), 2);
});

test('the 15 newer emoji the hand-typed table missed are covered', () => {
  for (const cp of [0x1f6d8, 0x1f6dc, 0x1fa89, 0x1fa8a, 0x1fa8e, 0x1fa8f, 0x1fabe,
                    0x1fac6, 0x1fac8, 0x1facd, 0x1fadc, 0x1fadf, 0x1fae9, 0x1faea, 0x1faef]) {
    assert.equal(unicode.strWidth(String.fromCodePoint(cp)), 2,
      `U+${cp.toString(16).toUpperCase()} must be 2 cells`);
  }
});

test('the generated table has the expected population (guards a bad regeneration)', () => {
  let wide = 0, zero = 0;
  for (let cp = 0x1f000; cp <= 0x1faff; cp++) {
    if (isWideEmoji(cp)) wide++;
    if (isZeroWidthEmoji(cp)) zero++;
  }
  // Counts come from python wcwidth 0.2.14 over 0x1F000..0x1FAFF.
  assert.equal(wide, 1179, 'wide-emoji count drifted from the reference');
  assert.equal(zero, 5, 'zero-width-emoji count drifted from the reference');
});

test('charWidth still accepts a bare codepoint (neo-blessed calls it both ways)', () => {
  assert.equal(unicode.charWidth(0x1f60a), 2);
  assert.equal(unicode.charWidth(0x0041), 1);
  assert.equal(unicode.charWidth('\u{1F60A}', 0), 2);
});
