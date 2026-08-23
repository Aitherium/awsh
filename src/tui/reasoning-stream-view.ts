/**
 * Pure reasoning overlay renderer for thought SSE events.
 *
 * Renders a compact reasoning panel showing iterations of thought with:
 * - Iteration number and confidence meter
 * - Summary and full reasoning text (wrapped, indented)
 * - Search queries as bullet points
 *
 * All output is SINGLE-CELL-WIDTH glyphs only (no emoji, no wide chars).
 * Pure render function: (data) => string[] with no side effects.
 */

import { renderMeter, heat } from './sparkline.js';
import { COLORS } from './theme.js';

/**
 * A single thought within the reasoning stream, with camelCase field names.
 * Fields correspond to incoming SSE thought event data.
 */
export interface Thought {
  iteration?: number;        // iteration number (e.g. 1, 2, 3)
  confidence?: number;       // 0..1 confidence score
  haveEnough?: boolean;      // flag: do we have enough reasoning?
  reasoning?: string;        // full reasoning text
  summary?: string;          // summary of this thought
  searchQueries?: string[];  // list of search queries to execute
}

/**
 * Parse raw SSE thought data into a Thought interface.
 * Converts snake_case keys to camelCase, tolerant of missing fields.
 */
export function parseThought(data: Record<string, any> | null): Thought {
  if (!data) return {};

  return {
    iteration: data.iteration != null ? Number(data.iteration) : undefined,
    confidence: data.confidence != null ? Number(data.confidence) : undefined,
    haveEnough: data.have_enough != null ? Boolean(data.have_enough) : undefined,
    reasoning: data.reasoning ? String(data.reasoning) : undefined,
    summary: data.summary ? String(data.summary) : undefined,
    searchQueries: Array.isArray(data.search_queries)
      ? data.search_queries.map(String)
      : undefined,
  };
}

/**
 * Strip ANSI color codes from a string for width calculations.
 */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Check if a single character is single-cell width.
 * Rejects wide-char & emoji ranges per spec:
 * U+FE30-FE4F, U+FF00-FF60, U+1100-115F, U+2E80-A4CF, U+AC00-D7A3, U+F900-FAFF, U+1F000+
 */
function isSingleCell(ch: string): boolean {
  const code = ch.charCodeAt(0);
  // Hangul Jamo (U+1100-115F)
  if (code >= 0x1100 && code <= 0x115f) return false;
  // CJK Radicals + all CJK + Hangul Jamo Compat (U+2E80-A4CF)
  if (code >= 0x2e80 && code <= 0xa4cf) return false;
  // CJK Compatibility Ideographs (U+F900-FAFF)
  if (code >= 0xf900 && code <= 0xfaff) return false;
  // CJK Compatibility Forms (U+FE30-FE4F)
  if (code >= 0xfe30 && code <= 0xfe4f) return false;
  // Fullwidth Forms (U+FF00-FF60)
  if (code >= 0xff00 && code <= 0xff60) return false;
  // Emoji planes (U+1F000 and beyond)
  if (code >= 0x1f000) return false;
  // Surrogate pairs (multi-unit)
  if (code >= 0xd800 && code <= 0xdfff) return false;
  return true;
}

/**
 * Wrap text to fit within a target width, ensuring single-cell glyphs only.
 * Returns an array of lines, each fitting within maxWidth (before ANSI codes).
 */
function wrapText(text: string, maxWidth: number): string[] {
  if (!text) return [];

  const lines: string[] = [];
  const paragraphs = text.split('\n');

  for (const para of paragraphs) {
    if (!para.trim()) {
      lines.push('');
      continue;
    }

    // Break into words and rewrap
    const words = para.split(/\s+/);
    let currentLine = '';

    for (const word of words) {
      // Check if word contains multi-cell characters
      for (const ch of word) {
        if (!isSingleCell(ch)) {
          console.warn(`⚠ multi-cell character in reasoning text: U+${ch.charCodeAt(0).toString(16)}`);
        }
      }

      const testLine = currentLine ? `${currentLine} ${word}` : word;
      if (stripAnsi(testLine).length <= maxWidth) {
        currentLine = testLine;
      } else {
        if (currentLine) lines.push(currentLine);
        currentLine = word;
      }
    }

    if (currentLine) lines.push(currentLine);
  }

  return lines;
}

/**
 * Build a reasoning panel overlay from a list of thoughts.
 * Each thought is rendered as a block with iteration, confidence meter, summary,
 * reasoning (wrapped), and search queries.
 *
 * @param thoughts - Array of Thought objects
 * @param width - Terminal width in columns
 * @returns Array of display lines (may include color codes)
 */
export function buildReasoningPanel(thoughts: Thought[], width: number): string[] {
  const lines: string[] = [];

  // Graceful empty handling
  if (!thoughts || thoughts.length === 0) {
    return [
      COLORS.muted('  no reasoning trace this turn'),
    ];
  }

  // Content width: account for indentation. Standard indent is 4 chars ("    ").
  // Ensure content fits within width, with a reasonable minimum for readability.
  const baseContentWidth = Math.max(width - 4, 10);  // minimum 10 if width is very small
  const contentWidth = baseContentWidth;

  let hasAnyContent = false;

  for (const thought of thoughts) {
    // ── Iteration header with confidence meter ──
    let iterStr = '';
    if (thought.iteration != null) {
      iterStr = `#${thought.iteration}`;
    }

    let meterStr = '';
    if (thought.confidence != null && thought.confidence >= 0) {
      const meter = renderMeter(thought.confidence, 8);
      // Heat-color by confidence: cool at low, hot at high
      meterStr = heat(thought.confidence, meter);
    }

    let haveEnoughStr = '';
    if (thought.haveEnough === true) {
      haveEnoughStr = COLORS.success('+');
    } else if (thought.haveEnough === false) {
      haveEnoughStr = COLORS.warn('-');
    }

    // Build the header line: #1  [████░░░░] 50%  ✓
    let headerParts: string[] = [];
    if (iterStr) headerParts.push(iterStr);
    if (meterStr) headerParts.push(meterStr);
    if (haveEnoughStr) headerParts.push(haveEnoughStr);

    if (headerParts.length > 0) {
      lines.push('  ' + headerParts.join('  '));
      hasAnyContent = true;
    }

    // ── Summary (if present) ──
    if (thought.summary) {
      const summaryLines = wrapText(thought.summary, contentWidth);
      for (const line of summaryLines) {
        lines.push('    ' + COLORS.text(line));
        hasAnyContent = true;
      }
    }

    // ── Reasoning (if present, indented) ──
    if (thought.reasoning) {
      const reasoningLines = wrapText(thought.reasoning, contentWidth);
      for (const line of reasoningLines) {
        lines.push('    ' + COLORS.muted(line));
        hasAnyContent = true;
      }
    }

    // ── Search queries (bullet list) ──
    if (thought.searchQueries && thought.searchQueries.length > 0) {
      for (const query of thought.searchQueries) {
        const queryLines = wrapText(query, contentWidth - 4);
        const firstLine = queryLines[0] || '';
        lines.push('    ' + COLORS.muted(`» ${firstLine}`));
        // Indent continuation lines
        for (let i = 1; i < queryLines.length; i++) {
          lines.push('      ' + COLORS.muted(queryLines[i]));
        }
        hasAnyContent = true;
      }
    }

    // ── Separator between thoughts ──
    if (thought !== thoughts[thoughts.length - 1]) {
      lines.push('');
    }
  }

  // If no content was rendered at all, return graceful message
  if (!hasAnyContent) {
    return [
      COLORS.muted('  no reasoning trace this turn'),
    ];
  }

  return lines;
}
