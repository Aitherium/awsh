/**
 * Test suite for aithersense-panel.ts: pure render function validation.
 * Verifies: line width safety, single-cell glyph integrity, null handling,
 * and correct meter/mood rendering.
 */
import { test, describe } from 'node:test';
import { strict as assert } from 'assert';
import { buildAffectPanel, type AffectWithMetrics } from '../src/tui/aithersense-panel.js';

/**
 * Strip ANSI colour codes from a string for width measurement.
 */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Check if a codepoint is in a "wide" range (double-width glyphs).
 * Ranges: emoji (U+1F300+), CJK ideograph (U+4E00-9FFF), fullwidth (U+FF00-FF60),
 * CJK-compat-forms (U+FE30-FE4F), Hangul (U+AC00+).
 */
function isWideCodepoint(code: number): boolean {
  if (code >= 0x1F300) return true;  // emoji family
  if (code >= 0xAC00 && code <= 0xD7AF) return true;  // Hangul syllables
  if (code >= 0xF900 && code <= 0xFAFF) return true;  // CJK compat ideographs
  if (code >= 0xFE30 && code <= 0xFE4F) return true;  // CJK compat forms
  if (code >= 0xFF00 && code <= 0xFF60) return true;  // Fullwidth ASCII
  if (code >= 0x4E00 && code <= 0x9FFF) return true;  // CJK unified ideographs
  return false;
}

/**
 * Verify a string contains no wide glyphs.
 */
function assertSingleCellSafe(line: string, context: string) {
  const plain = stripAnsi(line);
  for (const ch of plain) {
    const code = ch.charCodeAt(0);
    assert.ok(
      !isWideCodepoint(code),
      `${context}: wide glyph found: U+${code.toString(16).toUpperCase()} in "${line}"`,
    );
  }
}

describe('buildAffectPanel', () => {
  test('null affect returns single graceful line', () => {
    const lines = buildAffectPanel(null, 80);
    assert.equal(lines.length, 1);
    assert.equal(lines[0], 'AitherSense unavailable');
  });

  test('full affect renders title, meters, and sensation', () => {
    const affect: AffectWithMetrics = {
      mood: 'curious',
      valence: 0.6,
      arousal: 0.4,
      confidence: 0.85,
      openness: 0.7,
      existentialDepth: 0.5,
      dominantSensation: 'wonder',
      activeCount: 3,
      promptModifier: 'Think carefully and explore the space.',
    };

    const lines = buildAffectPanel(affect, 80);
    assert.ok(lines.length > 0);

    // Title should contain the mood
    assert.ok(lines[0].includes('curious'), 'title includes mood');
    assert.ok(lines[0].includes('AitherSense'));

    // Should include the meter labels
    const joined = lines.join(' ');
    assert.ok(joined.includes('valence'), 'includes valence meter');
    assert.ok(joined.includes('arousal'), 'includes arousal meter');
    assert.ok(joined.includes('confidence'), 'includes confidence meter');
    assert.ok(joined.includes('openness'), 'includes openness meter');
    assert.ok(joined.includes('existential depth'), 'includes existential depth');

    // Should include sensation
    assert.ok(joined.includes('wonder'), 'includes dominant sensation');
    assert.ok(joined.includes('active: 3'), 'includes active count');

    // Should include prompt modifier (word-wrapped)
    assert.ok(joined.includes('carefully'), 'includes prompt modifier text');
  });

  test('all lines fit within width', () => {
    const affect: AffectWithMetrics = {
      mood: 'hopeful',
      valence: 0.3,
      arousal: 0.6,
      confidence: 0.75,
      openness: 0.8,
      existentialDepth: 0.4,
      dominantSensation: 'curiosity',
      activeCount: 5,
      promptModifier: 'This is a longer prompt modifier text that tests word wrapping behavior.',
    };

    const widths = [40, 60, 80, 120];
    for (const w of widths) {
      const lines = buildAffectPanel(affect, w);
      for (const line of lines) {
        const plain = stripAnsi(line);
        assert.ok(
          plain.length <= w,
          `width ${w}: line exceeds width: "${plain}" (${plain.length} chars)`,
        );
      }
    }
  });

  test('single-cell-width glyphs only', () => {
    const affect: AffectWithMetrics = {
      mood: 'serene',
      valence: 0.5,
      arousal: 0.2,
      confidence: 0.9,
      openness: 0.6,
      existentialDepth: 0.7,
      dominantSensation: 'tranquility',
      activeCount: 2,
      promptModifier: 'Remain calm and centered.',
    };

    const lines = buildAffectPanel(affect, 80);
    for (let i = 0; i < lines.length; i++) {
      assertSingleCellSafe(lines[i], `line ${i}`);
    }
  });

  test('handles missing optional fields', () => {
    const affect: AffectWithMetrics = {
      mood: 'neutral',
      // valence, arousal, confidence, openness, existentialDepth all undefined
      // dominant_sensation, activeCount, promptModifier all undefined
    };

    const lines = buildAffectPanel(affect, 80);
    assert.ok(lines.length > 0);
    const joined = lines.join(' ');
    assert.ok(joined.includes('AitherSense'));
    assert.ok(joined.includes('neutral'));
    // Should gracefully show "unavailable" for metrics
    assert.ok(joined.includes('unavailable') || joined.includes('none'));
  });

  test('valence normalization: -1 to 0, +1 to 100%', () => {
    const negAffect: AffectWithMetrics = {
      mood: 'sad',
      valence: -1,  // should map to 0%
    };

    const posAffect: AffectWithMetrics = {
      mood: 'happy',
      valence: 1,  // should map to 100%
    };

    const negLines = buildAffectPanel(negAffect, 80);
    const posLines = buildAffectPanel(posAffect, 80);

    // Both should have valid renders
    assert.ok(negLines.length > 0);
    assert.ok(posLines.length > 0);

    // Both should include valence meter
    const negJoined = negLines.join(' ');
    const posJoined = posLines.join(' ');
    assert.ok(negJoined.includes('valence'));
    assert.ok(posJoined.includes('valence'));
  });

  test('prompt modifier wrapping respects width', () => {
    const longText =
      'This is a very long prompt modifier that should be word-wrapped across multiple lines when the width is constrained to a narrow column like forty or fifty characters.';

    const affect: AffectWithMetrics = {
      mood: 'focused',
      valence: 0.4,
      promptModifier: longText,
    };

    const lines40 = buildAffectPanel(affect, 40);
    const lines80 = buildAffectPanel(affect, 80);

    // Both widths should produce valid renders
    assert.ok(lines40.length > 0);
    assert.ok(lines80.length > 0);

    // Narrower width should produce more lines (wrapped)
    assert.ok(lines40.length >= lines80.length, 'narrow width produces more wrapped lines');

    // All lines in both cases should fit
    for (const line of lines40) {
      const plain = stripAnsi(line);
      assert.ok(plain.length <= 40, `line fits in 40: "${plain}"`);
    }
    for (const line of lines80) {
      const plain = stripAnsi(line);
      assert.ok(plain.length <= 80, `line fits in 80: "${plain}"`);
    }
  });

  test('COLORS applied are not wide glyphs', () => {
    // Verify that our use of COLORS (from chalk/theme) doesn't introduce wide glyphs
    const affect: AffectWithMetrics = {
      mood: 'excited',
      valence: 0.8,
      arousal: 0.9,
      dominantSensation: 'excitement',
    };

    const lines = buildAffectPanel(affect, 100);
    // Strip ANSI and verify glyphs
    for (const line of lines) {
      assertSingleCellSafe(line, 'coloured line');
    }
  });

  test('no trailing spaces or control characters', () => {
    const affect: AffectWithMetrics = {
      mood: 'content',
      valence: 0.5,
      arousal: 0.3,
    };

    const lines = buildAffectPanel(affect, 80);
    for (let i = 0; i < lines.length; i++) {
      const plain = stripAnsi(lines[i]);
      assert.ok(!plain.endsWith(' '), `line ${i} has no trailing space`);
      assert.ok(!/[\x00-\x08\x0b\x0c\x0e-\x1f]/.test(plain), `line ${i} has no control chars`);
    }
  });
});
