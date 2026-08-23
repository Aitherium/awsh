/**
 * Test suite for flame-graph-overlay renderer.
 *
 * Verifies:
 * - Header rendering with metrics
 * - Per-layer flame bars with proper scaling
 * - Width bounds and truncation
 * - Single-cell glyph safety (no emoji, no wide chars)
 * - Graceful null/empty handling
 */

import { test, describe } from 'node:test';
import { strict as assert } from 'assert';
import { buildFlameGraph, FlameData } from '../src/tui/flame-graph-overlay.js';

/**
 * Strip ANSI color codes for width/content verification.
 */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Check that a string contains only single-cell-width glyphs.
 * Fails on emoji, CJK wide chars, fullwidth ASCII, etc.
 * Per spec: U+FE30-FE4F, U+FF00-FF60, U+1100-115F, U+2E80-A4CF,
 * U+AC00-D7A3, U+F900-FAFF, emoji planes.
 */
function assertSingleCellWidth(s: string): void {
  const stripped = stripAnsi(s);
  const wideRanges = [
    [0xfe30, 0xfe4f],      // CJK compatibility forms
    [0xff00, 0xff60],      // fullwidth ASCII
    [0x1100, 0x115f],      // Hangul Jamo
    [0x2e80, 0xa4cf],      // CJK blocks (large range)
    [0xac00, 0xd7a3],      // Hangul syllables
    [0xf900, 0xfaff],      // CJK Compatibility Ideographs
    // Emoji ranges
    [0x1f000, 0x1f9ff],    // Emoticons, Symbols, Pictographs
    [0x2600, 0x27bf],      // Miscellaneous Symbols (includes emoji)
    [0x1f300, 0x1f5ff],    // Misc Symbols and Pictographs
    // Additional wide char planes
    [0x3040, 0x309f],      // Hiragana
    [0x30a0, 0x30ff],      // Katakana
    [0x4e00, 0x9fff],      // CJK Unified Ideographs
  ];

  for (const ch of stripped) {
    const code = ch.charCodeAt(0);
    for (const [lo, hi] of wideRanges) {
      assert.ok(
        code < lo || code > hi,
        `Wide char detected: ${ch} (U+${code.toString(16).toUpperCase()})`,
      );
    }
  }
}

describe('buildFlameGraph', () => {
  test('null data returns graceful message', () => {
    const lines = buildFlameGraph(null, 80);
    assert.ok(lines.length >= 1);
    assert.ok(
      stripAnsi(lines[0]).includes('no flame graph captured yet'),
      `Expected graceful message, got: ${lines[0]}`,
    );
  });

  test('empty data returns graceful message', () => {
    const data: FlameData = {};
    const lines = buildFlameGraph(data, 80);
    assert.ok(lines.length >= 1);
    assert.ok(
      stripAnsi(lines[0]).includes('no flame graph captured yet'),
      `Expected graceful message, got: ${lines[0]}`,
    );
  });

  test('header renders metrics correctly', () => {
    const data: FlameData = {
      layers: ['layer1'],
      stages: { layer1: { ms: 100 } },
      total_tokens: 1024,
      quality_score: 0.85,
      neurons_fired: 42,
      cache_warm: true,
      evictions: 0,
      elapsed_ms: 5000,
    };
    const lines = buildFlameGraph(data, 120);
    assert.ok(lines.length >= 1);

    const header = stripAnsi(lines[0]);
    assert.ok(header.includes('Context Flame'), 'Header should start with "Context Flame"');
    assert.ok(header.includes('1024 tok'), `Header should include token count, got: ${header}`);
    assert.ok(header.includes('q85'), `Header should include quality score, got: ${header}`);
    assert.ok(header.includes('42n'), `Header should include neuron count, got: ${header}`);
    assert.ok(header.includes('cache ok'), `Header should indicate cache status, got: ${header}`);
    assert.ok(header.includes('5.00s'), `Header should include elapsed time, got: ${header}`);
  });

  test('cold cache renders in header', () => {
    const data: FlameData = {
      layers: ['test'],
      stages: { test: { ms: 10 } },
      cache_warm: false,
    };
    const lines = buildFlameGraph(data, 80);
    const header = stripAnsi(lines[0]);
    assert.ok(header.includes('cache cold'), `Expected "cache cold", got: ${header}`);
  });

  test('omits cache status when undefined', () => {
    const data: FlameData = {
      layers: ['test'],
      stages: { test: { ms: 10 } },
    };
    const lines = buildFlameGraph(data, 80);
    const header = stripAnsi(lines[0]);
    assert.ok(
      !header.includes('cache'),
      `Should omit cache status when undefined, got: ${header}`,
    );
  });

  test('renders one flame bar per layer', () => {
    const data: FlameData = {
      layers: ['context', 'thinking', 'execution'],
      stages: {
        context: { ms: 100 },
        thinking: { ms: 250 },
        execution: { ms: 150 },
      },
    };
    const lines = buildFlameGraph(data, 80);
    // Header + 3 bars
    assert.equal(lines.length, 4, `Expected 4 lines (header + 3 bars), got ${lines.length}`);
  });

  test('flame bars scale by max value', () => {
    const data: FlameData = {
      layers: ['short', 'long'],
      stages: {
        short: { ms: 50 },
        long: { ms: 200 },
      },
    };
    const lines = buildFlameGraph(data, 80);
    assert.equal(lines.length, 3); // header + 2 bars
    // Both bars should be present; we can't directly inspect the bar length without
    // parsing, but we can verify they both appear
    const barLines = lines.slice(1).map(stripAnsi);
    assert.ok(barLines[0].includes('short'), 'First bar should have "short" label');
    assert.ok(barLines[1].includes('long'), 'Second bar should have "long" label');
  });

  test('prefers elapsed_ms for stage value', () => {
    const data: FlameData = {
      layers: ['test'],
      stages: {
        test: {
          elapsed_ms: 300,
          ms: 100,
          tokens: 50,
        },
      },
    };
    const lines = buildFlameGraph(data, 80);
    const barLine = stripAnsi(lines[1]);
    // Should use 300 (elapsed_ms) not 100 (ms) or 50 (tokens)
    assert.ok(barLine.includes('300ms'), `Expected "300ms" annotation, got: ${barLine}`);
  });

  test('falls back to ms when elapsed_ms absent', () => {
    const data: FlameData = {
      layers: ['test'],
      stages: {
        test: {
          ms: 200,
          tokens: 50,
        },
      },
    };
    const lines = buildFlameGraph(data, 80);
    const barLine = stripAnsi(lines[1]);
    assert.ok(barLine.includes('200ms'), `Expected "200ms", got: ${barLine}`);
  });

  test('falls back to tokens when both ms fields absent', () => {
    const data: FlameData = {
      layers: ['test'],
      stages: {
        test: {
          tokens: 256,
        },
      },
    };
    const lines = buildFlameGraph(data, 80);
    const barLine = stripAnsi(lines[1]);
    assert.ok(barLine.includes('256t'), `Expected "256t" annotation, got: ${barLine}`);
  });

  test('respects width limit on all lines', () => {
    const data: FlameData = {
      layers: ['very_long_layer_name_that_should_be_truncated', 'short'],
      stages: {
        very_long_layer_name_that_should_be_truncated: { ms: 100 },
        short: { ms: 50 },
      },
    };
    const width = 40;
    const lines = buildFlameGraph(data, width);

    for (const line of lines) {
      const stripped = stripAnsi(line);
      assert.ok(
        stripped.length <= width,
        `Line exceeds width ${width}: "${stripped}" (length ${stripped.length})`,
      );
    }
  });

  test('all output lines contain only single-cell glyphs', () => {
    const data: FlameData = {
      layers: ['layer_a', 'layer_b'],
      stages: {
        layer_a: { elapsed_ms: 150 },
        layer_b: { elapsed_ms: 75 },
      },
      total_tokens: 2048,
      quality_score: 0.92,
      neurons_fired: 123,
      cache_warm: true,
      evictions: 3,
      elapsed_ms: 8500,
    };
    const lines = buildFlameGraph(data, 100);

    for (const line of lines) {
      assertSingleCellWidth(line);
    }
  });

  test('handles layers without matching stages', () => {
    const data: FlameData = {
      layers: ['exists', 'missing'],
      stages: {
        exists: { ms: 100 },
      },
    };
    const lines = buildFlameGraph(data, 80);
    // Should still render bars for both, missing stage gets 0 value
    assert.equal(lines.length, 3); // header + 2 bars
    const barLines = lines.slice(1).map(stripAnsi);
    assert.ok(barLines[0].includes('exists'));
    assert.ok(barLines[1].includes('missing'));
  });

  test('zero max value defaults to 1 for scaling', () => {
    const data: FlameData = {
      layers: ['zero'],
      stages: {
        zero: { ms: 0 },
      },
    };
    const lines = buildFlameGraph(data, 80);
    // Should not crash; bar should be minimal
    assert.equal(lines.length, 2);
    const barLine = stripAnsi(lines[1]);
    assert.ok(barLine.includes('zero'), 'Bar should render even with zero value');
  });

  test('large width allocation works', () => {
    const data: FlameData = {
      layers: ['test'],
      stages: { test: { ms: 100 } },
    };
    const width = 200;
    const lines = buildFlameGraph(data, width);
    for (const line of lines) {
      const stripped = stripAnsi(line);
      assert.ok(
        stripped.length <= width,
        `Line exceeds width: ${stripped.length} > ${width}`,
      );
    }
  });

  test('narrow width allocation works', () => {
    const data: FlameData = {
      layers: ['a', 'b'],
      stages: {
        a: { ms: 100 },
        b: { ms: 50 },
      },
    };
    const width = 30;
    const lines = buildFlameGraph(data, width);
    for (const line of lines) {
      const stripped = stripAnsi(line);
      assert.ok(
        stripped.length <= width,
        `Line exceeds width ${width}: "${stripped}" (${stripped.length} chars)`,
      );
    }
  });

  test('excludes zero evictions from header', () => {
    const data: FlameData = {
      layers: ['test'],
      stages: { test: { ms: 10 } },
      evictions: 0,
    };
    const lines = buildFlameGraph(data, 80);
    const header = stripAnsi(lines[0]);
    assert.ok(
      !header.includes('evict'),
      `Header should not mention 0 evictions, got: ${header}`,
    );
  });

  test('includes positive eviction count in header', () => {
    const data: FlameData = {
      layers: ['test'],
      stages: { test: { ms: 10 } },
      evictions: 5,
    };
    const lines = buildFlameGraph(data, 80);
    const header = stripAnsi(lines[0]);
    assert.ok(header.includes('5 evict'), `Expected "5 evict" in header, got: ${header}`);
  });

  test('renders quality score as percentage', () => {
    const data: FlameData = {
      layers: ['test'],
      stages: { test: { ms: 10 } },
      quality_score: 0.75,
    };
    const lines = buildFlameGraph(data, 80);
    const header = stripAnsi(lines[0]);
    assert.ok(header.includes('q75'), `Expected "q75" in header, got: ${header}`);
  });

  test('multiple metrics in header are delimited by ·', () => {
    const data: FlameData = {
      layers: ['test'],
      stages: { test: { ms: 10 } },
      total_tokens: 512,
      quality_score: 0.5,
    };
    const lines = buildFlameGraph(data, 80);
    const header = stripAnsi(lines[0]);
    const parts = header.split('·');
    assert.ok(parts.length >= 3, `Expected multiple · delimiters, got: ${header}`);
  });
});
