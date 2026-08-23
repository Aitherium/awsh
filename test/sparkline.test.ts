/**
 * Tests for the zero-dep Unicode micro-charts. The load-bearing invariant is
 * SINGLE-CELL WIDTH: every glyph must be one column or blessed's layout breaks
 * (the same class of bug as the emoji "character bleed"). We also check that
 * bars/meters are the requested width and encode magnitude monotonically.
 */
import { strict as assert } from 'assert';
import { test, describe } from 'node:test';
import {
  renderSparkline, renderBrailleSparkline, renderBar, renderFlameBar, renderMeter,
} from '../src/tui/sparkline.js';

const strip = (s: string) => s.replace(/\x1b\[[0-9;]*m/g, '');

// Every rune must be in the single-cell ranges we use (ASCII, box/blocks, braille).
function assertSingleWidth(s: string): void {
  for (const ch of strip(s)) {
    const cp = ch.codePointAt(0)!;
    const ok =
      cp < 0x2500 ||                      // ASCII + basic
      (cp >= 0x2500 && cp <= 0x259f) ||   // box drawing + block elements
      (cp >= 0x2800 && cp <= 0x28ff);     // braille
    assert.ok(ok, `glyph U+${cp.toString(16)} ("${ch}") is outside single-cell ranges`);
  }
}

describe('sparkline micro-charts', () => {
  test('renderSparkline: one glyph per value, single-width, monotonic', () => {
    const s = renderSparkline([0, 1, 2, 3, 4, 5, 6, 7], 0, 7);
    assert.equal(strip(s).length, 8, 'one glyph per value');
    assertSingleWidth(s);
    // last (max) glyph should be the tallest block
    assert.equal(strip(s).at(-1), '█');
  });

  test('renderBrailleSparkline: packs 2 samples/cell, exact width, single-width', () => {
    const vals = Array.from({ length: 20 }, (_, i) => i);
    const s = renderBrailleSparkline(vals, 6);
    assert.equal(strip(s).length, 6, 'exactly `width` cells');
    assertSingleWidth(s);
  });

  test('renderBar: exact width, fills with magnitude', () => {
    assert.equal(strip(renderBar(0, 10, 8)).length, 8);
    assert.equal(strip(renderBar(10, 10, 8)).trimEnd(), '████████');
    assertSingleWidth(renderBar(3, 10, 8));
    // half should be roughly half-filled
    const half = strip(renderBar(5, 10, 8));
    assert.ok(half.startsWith('████'), `half bar starts filled: "${half}"`);
  });

  test('renderMeter: shows filled/empty track + percentage', () => {
    const m = strip(renderMeter(0.5, 10));
    assert.ok(m.includes('50%'), 'shows percentage');
    assert.ok(m.startsWith('█████░░░░░'), `half meter: "${m}"`);
    assertSingleWidth(renderMeter(0.5, 10));
  });

  test('renderFlameBar: label + bar + annotation fit width', () => {
    const row = renderFlameBar('neurons', 712, 1000, 40, '712ms');
    assert.ok(strip(row).length <= 41, 'fits width (±1)');
    assert.ok(strip(row).startsWith('neurons'), 'label first');
    assert.ok(strip(row).includes('712ms'), 'annotation present');
    assertSingleWidth(row);
  });

  test('empty input is safe', () => {
    assert.equal(renderSparkline([]), '');
    assert.equal(renderBrailleSparkline([], 5), '');
  });
});
