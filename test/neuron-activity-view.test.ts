/**
 * Test suite for neuron-activity-view.ts
 *
 * Covers:
 * - State initialization and accumulation
 * - Per-source aggregation (multiple sources)
 * - Event routing (neuron_fire, neurons_start, neurons_done)
 * - Panel rendering with width constraints
 * - Single-cell glyph safety
 * - Empty state handling
 */

import { test, describe } from 'node:test';
import { strict as assert } from 'assert';
import {
  emptyNeuronState,
  accumulateNeuron,
  buildNeuronPanel,
  type NeuronState,
} from '../src/tui/neuron-activity-view.js';

/**
 * Helper: strip ANSI color codes to measure glyph widths.
 */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Helper: assert all characters in a string are single-cell width.
 * Fails on wide ranges: emoji (U+1F300+), CJK ideographs (U+4E00+),
 * fullwidth (U+FF00-FF60), Hangul (U+AC00+), CJK compat (U+FE30-FE4F).
 */
function assertSingleCellWidth(s: string, context?: string): void {
  const stripped = stripAnsi(s);
  const codepoints = [...stripped].map(ch => ch.charCodeAt(0));
  for (const cp of codepoints) {
    // Reject wide ranges
    if (cp >= 0x1f300) {
      throw new Error(
        `${context || 'string'}: emoji at U+${cp.toString(16).toUpperCase()} ("${String.fromCharCode(cp)}")`
      );
    }
    if (cp >= 0xac00) {
      throw new Error(
        `${context || 'string'}: Hangul/ideograph at U+${cp.toString(16).toUpperCase()}`
      );
    }
    if (cp >= 0xff00 && cp <= 0xff60) {
      throw new Error(
        `${context || 'string'}: fullwidth at U+${cp.toString(16).toUpperCase()}`
      );
    }
    if (cp >= 0xfe30 && cp <= 0xfe4f) {
      throw new Error(
        `${context || 'string'}: CJK compat at U+${cp.toString(16).toUpperCase()}`
      );
    }
    if (cp >= 0x4e00 && cp <= 0x9fff) {
      throw new Error(
        `${context || 'string'}: CJK ideograph at U+${cp.toString(16).toUpperCase()}`
      );
    }
  }
}

describe('neuron-activity-view', () => {
  // ── Initialization ────────────────────────────────────────────────────────
  test('emptyNeuronState returns a zero-initialized state', () => {
    const state = emptyNeuronState();
    assert.strictEqual(state.totalFired, 0);
    assert.strictEqual(state.totalTokens, 0);
    assert.deepStrictEqual(state.sources, []);
    assert.deepStrictEqual(state.history, []);
  });

  // ── Accumulation: single source ────────────────────────────────────────────
  test('accumulateNeuron(neuron_fire) increments totalFired and adds to history', () => {
    const state = emptyNeuronState();
    accumulateNeuron(state, 'neuron_fire', {
      source: 'llm_a',
      total_tokens: 150,
    });

    assert.strictEqual(state.totalFired, 1);
    assert.strictEqual(state.totalTokens, 150);
    assert.deepStrictEqual(state.history, [150]);
    assert.strictEqual(state.sources.length, 1);
    assert.strictEqual(state.sources[0].name, 'llm_a');
    assert.strictEqual(state.sources[0].count, 1);
    assert.strictEqual(state.sources[0].tokens, 150);
  });

  // ── Accumulation: multiple events, single source ─────────────────────────────
  test('accumulateNeuron aggregates multiple events from same source', () => {
    const state = emptyNeuronState();
    accumulateNeuron(state, 'neuron_fire', { source: 'tool_x', total_tokens: 100 });
    accumulateNeuron(state, 'neuron_fire', { source: 'tool_x', total_tokens: 50 });

    assert.strictEqual(state.totalFired, 2);
    assert.strictEqual(state.totalTokens, 150);
    assert.deepStrictEqual(state.history, [100, 50]);
    assert.strictEqual(state.sources.length, 1);
    assert.strictEqual(state.sources[0].count, 2);
    assert.strictEqual(state.sources[0].tokens, 150);
  });

  // ── Accumulation: multiple sources ────────────────────────────────────────────
  test('accumulateNeuron tracks multiple sources independently', () => {
    const state = emptyNeuronState();
    accumulateNeuron(state, 'neuron_fire', { source: 'llm_a', total_tokens: 200 });
    accumulateNeuron(state, 'neuron_fire', { source: 'llm_b', total_tokens: 300 });
    accumulateNeuron(state, 'neuron_fire', { source: 'llm_a', total_tokens: 100 });

    assert.strictEqual(state.totalFired, 3);
    assert.strictEqual(state.totalTokens, 600);
    assert.deepStrictEqual(state.history, [200, 300, 100]);
    assert.strictEqual(state.sources.length, 2);

    const sourceA = state.sources.find(s => s.name === 'llm_a');
    const sourceB = state.sources.find(s => s.name === 'llm_b');
    assert(sourceA);
    assert(sourceB);
    assert.strictEqual(sourceA.count, 2);
    assert.strictEqual(sourceA.tokens, 300);
    assert.strictEqual(sourceB.count, 1);
    assert.strictEqual(sourceB.tokens, 300);
  });

  // ── Accumulation: unknown source ──────────────────────────────────────────────
  test('accumulateNeuron defaults to "unknown" source when source is missing', () => {
    const state = emptyNeuronState();
    accumulateNeuron(state, 'neuron_fire', { total_tokens: 42 });

    assert.strictEqual(state.sources.length, 1);
    assert.strictEqual(state.sources[0].name, 'unknown');
    assert.strictEqual(state.sources[0].tokens, 42);
  });

  // ── Event routing: neurons_start ──────────────────────────────────────────────
  test('neurons_start event resets state', () => {
    const state = emptyNeuronState();
    accumulateNeuron(state, 'neuron_fire', { source: 'test', total_tokens: 100 });
    assert.strictEqual(state.totalFired, 1);

    accumulateNeuron(state, 'neurons_start', {});
    assert.strictEqual(state.totalFired, 0);
    assert.strictEqual(state.totalTokens, 0);
    assert.deepStrictEqual(state.sources, []);
    assert.deepStrictEqual(state.history, []);
  });

  // ── Event routing: neurons_done ───────────────────────────────────────────────
  test('neurons_done event overrides totals', () => {
    const state = emptyNeuronState();
    accumulateNeuron(state, 'neuron_fire', { source: 'a', total_tokens: 100 });
    accumulateNeuron(state, 'neuron_fire', { source: 'b', total_tokens: 50 });

    // neurons_done overrides
    accumulateNeuron(state, 'neurons_done', {
      neurons_fired: 999,
      total_tokens: 9999,
    });

    assert.strictEqual(state.totalFired, 999);
    assert.strictEqual(state.totalTokens, 9999);
    // Per-source and history are NOT reset by neurons_done
    assert.strictEqual(state.sources.length, 2);
    assert.deepStrictEqual(state.history, [100, 50]);
  });

  // ── Rendering: empty state ────────────────────────────────────────────────────
  test('buildNeuronPanel gracefully renders empty state', () => {
    const state = emptyNeuronState();
    const lines = buildNeuronPanel(state, 80);

    assert(Array.isArray(lines));
    assert(lines.length > 0);
    assert(lines[0].includes('Neurons'));
    // Should include "no activity" message
    const hasNoActivity = lines.some(line => stripAnsi(line).includes('no activity'));
    assert(hasNoActivity, 'empty state should mention no activity');

    // All lines must be single-cell safe
    for (const line of lines) {
      assertSingleCellWidth(line, `empty panel line: "${stripAnsi(line)}"`);
    }
  });

  // ── Rendering: populated state ────────────────────────────────────────────────
  test('buildNeuronPanel renders header, sparkline, and source rows', () => {
    const state = emptyNeuronState();
    accumulateNeuron(state, 'neuron_fire', { source: 'llm_a', total_tokens: 500 });
    accumulateNeuron(state, 'neuron_fire', { source: 'llm_b', total_tokens: 300 });
    accumulateNeuron(state, 'neuron_fire', { source: 'llm_a', total_tokens: 200 });

    const lines = buildNeuronPanel(state, 80);

    assert(Array.isArray(lines));
    assert(lines.length > 3, 'should have header, sparkline, and source rows');

    // First line should be header with fire count and token count
    const header = stripAnsi(lines[0]);
    assert(header.includes('3 fired'), `header should show "3 fired", got: ${header}`);
    assert(header.includes('1000 tok'), `header should show "1000 tok", got: ${header}`);

    // Should have a sparkline line (check for braille chars or ASCII fallback)
    const hasSparkline = lines.some(line => {
      const s = stripAnsi(line);
      return s.includes('▁') || s.includes('▂') || s.includes('█') || s.length > 4;
    });
    assert(hasSparkline, 'should have sparkline');

    // Should have source rows (at least 2, one per unique source)
    const sourceCount = state.sources.length;
    assert(lines.length >= 2 + sourceCount, 'should have rows for all sources');

    // All lines must be single-cell safe
    for (const line of lines) {
      assertSingleCellWidth(line, `panel line: "${stripAnsi(line)}"`);
    }
  });

  // ── Rendering: sources sorted by tokens descending ──────────────────────────────
  test('buildNeuronPanel sorts sources by tokens descending', () => {
    const state = emptyNeuronState();
    accumulateNeuron(state, 'neuron_fire', { source: 'small', total_tokens: 10 });
    accumulateNeuron(state, 'neuron_fire', { source: 'huge', total_tokens: 10000 });
    accumulateNeuron(state, 'neuron_fire', { source: 'medium', total_tokens: 500 });

    const lines = buildNeuronPanel(state, 80);

    // Extract source lines (skip header + sparkline)
    const sourceLines = lines.slice(2);

    // Sources should appear in order: huge, medium, small
    assert(sourceLines.length >= 3, 'should have at least 3 source lines');

    const hugeIdx = sourceLines.findIndex(l => stripAnsi(l).includes('huge'));
    const mediumIdx = sourceLines.findIndex(l => stripAnsi(l).includes('medium'));
    const smallIdx = sourceLines.findIndex(l => stripAnsi(l).includes('small'));

    assert(hugeIdx >= 0 && mediumIdx >= 0 && smallIdx >= 0, 'all sources should be present');
    assert(
      hugeIdx < mediumIdx && mediumIdx < smallIdx,
      `sources should be sorted by tokens desc; got order: huge(${hugeIdx}), medium(${mediumIdx}), small(${smallIdx})`
    );
  });

  // ── Rendering: width constraint ───────────────────────────────────────────────
  test('buildNeuronPanel respects width constraint', () => {
    const state = emptyNeuronState();
    for (let i = 0; i < 5; i++) {
      accumulateNeuron(state, 'neuron_fire', {
        source: `very_long_source_name_${i}`,
        total_tokens: 100 * (i + 1),
      });
    }

    const narrowWidth = 40;
    const lines = buildNeuronPanel(state, narrowWidth);

    // All lines should fit within the width constraint
    for (const line of lines) {
      const stripped = stripAnsi(line);
      assert(
        stripped.length <= narrowWidth + 2, // +2 for potential visual margin
        `line "${stripped}" exceeds width ${narrowWidth}`
      );
    }
  });

  // ── Rendering: single-cell safety ─────────────────────────────────────────────
  test('buildNeuronPanel output is single-cell safe (no emoji, no wide chars)', () => {
    const state = emptyNeuronState();
    accumulateNeuron(state, 'neuron_fire', { source: 'emoji_test_😀', total_tokens: 100 });
    accumulateNeuron(state, 'neuron_fire', { source: 'cjk_test_中文', total_tokens: 200 });
    accumulateNeuron(state, 'neuron_fire', { source: 'normal_source', total_tokens: 300 });

    const lines = buildNeuronPanel(state, 80);

    // All lines must be single-cell safe, even if sources have wide chars
    // (they should be truncated or replaced)
    for (const line of lines) {
      try {
        assertSingleCellWidth(line, `output line: "${stripAnsi(line)}"`);
      } catch (e) {
        // Some lines may have been sanitized, so we just ensure no wide chars slip through
        // If assertSingleCellWidth throws, it means we have wide chars — fail the test
        throw new Error(
          `Single-cell safety violation: ${(e as Error).message}`
        );
      }
    }
  });

  // ── Rendering: annotation format ──────────────────────────────────────────────
  test('buildNeuronPanel source rows include count and token annotation', () => {
    const state = emptyNeuronState();
    accumulateNeuron(state, 'neuron_fire', { source: 'test_src', total_tokens: 250 });
    accumulateNeuron(state, 'neuron_fire', { source: 'test_src', total_tokens: 150 });

    const lines = buildNeuronPanel(state, 80);
    const sourceLines = lines.slice(2); // skip header and sparkline

    // Should have annotation "2x 400tok" (2 events, 400 total tokens)
    const hasAnnotation = sourceLines.some(line => {
      const s = stripAnsi(line);
      return s.includes('2x') && s.includes('400');
    });
    assert(hasAnnotation, `should include annotation "2x 400tok" in source row`);
  });

  // ── Integration: full event flow ──────────────────────────────────────────────
  test('full event flow: neurons_start -> neuron_fire -> neurons_done -> render', () => {
    const state = emptyNeuronState();

    // Start
    accumulateNeuron(state, 'neurons_start', {});
    assert.strictEqual(state.totalFired, 0);

    // Fire events from multiple sources
    accumulateNeuron(state, 'neuron_fire', { source: 'llm', total_tokens: 300 });
    accumulateNeuron(state, 'neuron_fire', { source: 'tool', total_tokens: 200 });
    accumulateNeuron(state, 'neuron_fire', { source: 'llm', total_tokens: 100 });

    assert.strictEqual(state.totalFired, 3);
    assert.strictEqual(state.totalTokens, 600);

    // Done
    accumulateNeuron(state, 'neurons_done', { neurons_fired: 3, total_tokens: 600 });

    // Render
    const lines = buildNeuronPanel(state, 80);
    assert(lines.length > 3);
    const header = stripAnsi(lines[0]);
    assert(header.includes('3 fired'));
    assert(header.includes('600 tok'));

    // All output must be single-cell safe
    for (const line of lines) {
      assertSingleCellWidth(line);
    }
  });
});
