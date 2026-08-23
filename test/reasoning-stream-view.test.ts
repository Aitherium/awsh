/**
 * Tests for reasoning-stream-view: parseThought, buildReasoningPanel, single-cell safety.
 */

import { test, describe } from 'node:test';
import { strict as assert } from 'assert';
import {
  parseThought, buildReasoningPanel, type Thought,
} from '../src/tui/reasoning-stream-view.js';

/**
 * Strip ANSI codes for length calculation and inspection.
 */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Check if a string contains only single-cell-width characters
 * (after stripping ANSI). Matches spec: U+FE30-FE4F, U+FF00-FF60,
 * U+1100-115F, U+2E80-A4CF, U+AC00-D7A3, U+F900-FAFF, U+1F000+
 */
function isSingleCellOnly(s: string): boolean {
  const stripped = stripAnsi(s);
  for (const ch of stripped) {
    const code = ch.charCodeAt(0);
    // Hangul Jamo (U+1100-115F)
    if (code >= 0x1100 && code <= 0x115f) return false;
    // CJK Radicals + all CJK + Hangul Compat (U+2E80-A4CF)
    if (code >= 0x2e80 && code <= 0xa4cf) return false;
    // CJK Compatibility Ideographs (U+F900-FAFF)
    if (code >= 0xf900 && code <= 0xfaff) return false;
    // CJK Compatibility Forms (U+FE30-FE4F)
    if (code >= 0xfe30 && code <= 0xfe4f) return false;
    // Fullwidth Forms (U+FF00-FF60)
    if (code >= 0xff00 && code <= 0xff60) return false;
    // Emoji planes (U+1F000 and beyond)
    if (code >= 0x1f000) return false;
    // Surrogate pairs
    if (code >= 0xd800 && code <= 0xdfff) return false;
  }
  return true;
}

describe('parseThought', () => {
  test('converts snake_case to camelCase', () => {
    const raw = {
      iteration: 2,
      confidence: 0.85,
      have_enough: true,
      summary: 'test summary',
      reasoning: 'test reasoning',
      search_queries: ['query1', 'query2'],
    };
    const result = parseThought(raw);
    assert.strictEqual(result.iteration, 2);
    assert.strictEqual(result.confidence, 0.85);
    assert.strictEqual(result.haveEnough, true);
    assert.strictEqual(result.summary, 'test summary');
    assert.strictEqual(result.reasoning, 'test reasoning');
    assert.deepStrictEqual(result.searchQueries, ['query1', 'query2']);
  });

  test('tolerates missing fields', () => {
    const raw = { iteration: 1 };
    const result = parseThought(raw);
    assert.strictEqual(result.iteration, 1);
    assert.strictEqual(result.confidence, undefined);
    assert.strictEqual(result.haveEnough, undefined);
    assert.strictEqual(result.summary, undefined);
  });

  test('handles null input', () => {
    const result = parseThought(null);
    assert.deepStrictEqual(result, {});
  });

  test('coerces types: confidence to number, have_enough to boolean', () => {
    const raw = { confidence: '0.95', have_enough: 1 };
    const result = parseThought(raw);
    assert.strictEqual(result.confidence, 0.95);
    assert.strictEqual(result.haveEnough, true);
  });

  test('converts search_queries strings', () => {
    const raw = { search_queries: [123, 'text', true] };
    const result = parseThought(raw);
    assert.deepStrictEqual(result.searchQueries, ['123', 'text', 'true']);
  });

  test('handles non-array search_queries gracefully', () => {
    const raw = { search_queries: 'not an array' };
    const result = parseThought(raw);
    assert.strictEqual(result.searchQueries, undefined);
  });
});

describe('buildReasoningPanel', () => {
  test('returns graceful message for empty thoughts array', () => {
    const lines = buildReasoningPanel([], 80);
    assert(lines.length > 0);
    assert(stripAnsi(lines[0]).includes('no reasoning trace'));
  });

  test('renders single thought with iteration and confidence meter', () => {
    const thoughts: Thought[] = [
      {
        iteration: 1,
        confidence: 0.85,
        summary: 'Initial thought',
      },
    ];
    const lines = buildReasoningPanel(thoughts, 80);
    assert(lines.length > 0);
    // First line should have iteration and meter
    const firstLine = stripAnsi(lines[0]);
    assert(firstLine.includes('#1'), `Expected '#1' in first line, got: ${firstLine}`);
    assert(firstLine.includes('%'), `Expected percentage in first line, got: ${firstLine}`);
  });

  test('renders multiple thoughts with separators', () => {
    const thoughts: Thought[] = [
      { iteration: 1, confidence: 0.7, summary: 'First thought' },
      { iteration: 2, confidence: 0.9, summary: 'Second thought' },
    ];
    const lines = buildReasoningPanel(thoughts, 80);
    assert(lines.length > 4);
    // Check for both iterations
    const text = lines.map(stripAnsi).join('\n');
    assert(text.includes('#1'));
    assert(text.includes('#2'));
  });

  test('includes summary and reasoning text', () => {
    const thoughts: Thought[] = [
      {
        iteration: 1,
        confidence: 0.8,
        summary: 'This is my summary',
        reasoning: 'This is detailed reasoning about the problem',
      },
    ];
    const lines = buildReasoningPanel(thoughts, 80);
    const text = lines.map(stripAnsi).join('\n');
    assert(text.includes('This is my summary'));
    assert(text.includes('This is detailed reasoning about the problem'));
  });

  test('renders search queries as bullet points', () => {
    const thoughts: Thought[] = [
      {
        iteration: 1,
        confidence: 0.75,
        searchQueries: ['how to solve', 'reference materials'],
      },
    ];
    const lines = buildReasoningPanel(thoughts, 80);
    const text = lines.map(stripAnsi).join('\n');
    assert(text.includes('» how to solve'));
    assert(text.includes('» reference materials'));
  });

  test('renders haveEnough flag when present', () => {
    const thoughtsDone: Thought[] = [
      { iteration: 1, confidence: 0.95, haveEnough: true, summary: 'Done thinking' },
    ];
    const linesWithDone = buildReasoningPanel(thoughtsDone, 80);
    const textWithDone = linesWithDone.map(stripAnsi).join('\n');
    assert(textWithDone.includes('+'), `Expected done indicator (+) in: ${textWithDone}`);

    const thoughtsNeedMore: Thought[] = [
      { iteration: 1, confidence: 0.5, haveEnough: false, summary: 'Need more' },
    ];
    const linesWithMore = buildReasoningPanel(thoughtsNeedMore, 80);
    const textWithMore = linesWithMore.map(stripAnsi).join('\n');
    assert(textWithMore.includes('-'), `Expected indicator (-) in: ${textWithMore}`);
  });

  test('respects width constraints', () => {
    const thoughts: Thought[] = [
      {
        iteration: 1,
        summary: 'This is a very long summary that should wrap to multiple lines if the width is narrow enough',
      },
    ];
    const width = 30;
    const lines = buildReasoningPanel(thoughts, width);
    for (const line of lines) {
      const stripped = stripAnsi(line);
      assert(
        stripped.length <= width,
        `Line exceeds width ${width}: "${stripped}" (len=${stripped.length})`,
      );
    }
  });

  test('enforces single-cell-width glyph safety', () => {
    const thoughts: Thought[] = [
      {
        iteration: 1,
        confidence: 0.8,
        summary: 'Test with safe ASCII chars',
        reasoning: 'More safe text',
        searchQueries: ['query 1', 'query 2'],
      },
    ];
    const lines = buildReasoningPanel(thoughts, 80);
    for (const line of lines) {
      assert(
        isSingleCellOnly(line),
        `Line contains multi-cell characters: "${line}"`,
      );
    }
  });

  test('handles long search queries with wrapping', () => {
    const thoughts: Thought[] = [
      {
        iteration: 1,
        searchQueries: [
          'This is a very long search query that should probably wrap to multiple lines',
        ],
      },
    ];
    const lines = buildReasoningPanel(thoughts, 50);
    const text = lines.map(stripAnsi).join('\n');
    // All lines should be short due to wrapping
    for (const line of lines) {
      const stripped = stripAnsi(line);
      assert(stripped.length <= 50, `Line too long: "${stripped}"`);
    }
  });

  test('handles thoughts with all optional fields undefined', () => {
    const thoughts: Thought[] = [{}];
    const lines = buildReasoningPanel(thoughts, 80);
    // Should not crash, produce some output
    assert(lines.length > 0);
  });

  test('preserves confidence meter for different values', () => {
    const testCases = [
      { iteration: 1, confidence: 0.1, desc: 'low confidence' },
      { iteration: 2, confidence: 0.5, desc: 'medium confidence' },
      { iteration: 3, confidence: 0.95, desc: 'high confidence' },
    ];
    for (const tc of testCases) {
      const thoughts: Thought[] = [tc];
      const lines = buildReasoningPanel(thoughts, 80);
      const text = stripAnsi(lines.join('\n'));
      assert(text.includes(`#${tc.iteration}`), `Missing iteration ${tc.iteration} in ${tc.desc}`);
      assert(text.includes('%'), `Missing percentage meter in ${tc.desc}`);
    }
  });

  test('renders multi-paragraph reasoning with blank lines preserved', () => {
    const thoughts: Thought[] = [
      {
        iteration: 1,
        reasoning: 'First paragraph\n\nSecond paragraph',
      },
    ];
    const lines = buildReasoningPanel(thoughts, 80);
    // Should have content from both paragraphs
    const text = lines.map(stripAnsi).join('\n');
    assert(text.includes('First paragraph'));
    assert(text.includes('Second paragraph'));
  });
});

describe('single-cell width safety', () => {
  test('all rendered lines are single-cell safe', () => {
    const thoughts: Thought[] = [
      {
        iteration: 1,
        confidence: 0.75,
        summary: 'A summary with numbers 123 and symbols !@#',
        reasoning: 'Reasoning with (parentheses) and [brackets]',
        searchQueries: ['query one', 'query two with spaces'],
        haveEnough: false,
      },
      {
        iteration: 2,
        confidence: 0.95,
        summary: 'Second iteration summary',
        haveEnough: true,
      },
    ];

    const width = 100;
    const lines = buildReasoningPanel(thoughts, width);

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      const stripped = stripAnsi(line);
      assert(
        isSingleCellOnly(line),
        `Line ${i} contains multi-cell: "${stripped}"`,
      );
      assert(
        stripped.length <= width,
        `Line ${i} exceeds width: ${stripped.length} > ${width}`,
      );
    }
  });
});

describe('edge cases', () => {
  test('handles very wide terminal width gracefully', () => {
    const thoughts: Thought[] = [{ iteration: 1, summary: 'test' }];
    const lines = buildReasoningPanel(thoughts, 500);
    assert(lines.length > 0);
    for (const line of lines) {
      assert(isSingleCellOnly(line));
    }
  });

  test('handles very narrow terminal width (minimum enforcement)', () => {
    const thoughts: Thought[] = [
      {
        iteration: 1,
        confidence: 0.8,
        summary: 'A summary',
      },
    ];
    const lines = buildReasoningPanel(thoughts, 20);
    // Should not crash, lines should still be enforced
    assert(lines.length > 0);
    for (const line of lines) {
      const stripped = stripAnsi(line);
      // Width should be at most the specified width (20 chars)
      assert(stripped.length <= 20, `Line exceeds width constraint: "${stripped}" (len=${stripped.length})`);
    }
  });

  test('handles confidence edge values', () => {
    const tests: Thought[] = [
      { iteration: 1, confidence: 0 },   // 0%
      { iteration: 2, confidence: 1 },   // 100%
      { iteration: 3, confidence: -0.5 }, // negative (should clamp)
      { iteration: 4, confidence: 1.5 }, // over 1 (should clamp)
    ];
    const lines = buildReasoningPanel(tests, 80);
    assert(lines.length > 0);
    for (const line of lines) {
      assert(isSingleCellOnly(line));
    }
  });

  test('handles empty strings in fields', () => {
    const thoughts: Thought[] = [
      { iteration: 1, summary: '', reasoning: '', searchQueries: [] },
    ];
    const lines = buildReasoningPanel(thoughts, 80);
    // Should handle gracefully without crashing
    assert(lines.length >= 1);
  });
});
