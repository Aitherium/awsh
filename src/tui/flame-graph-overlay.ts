/**
 * Pure flame-graph overlay renderer for context_flame_graph SSE events.
 *
 * Renders a compact overlay showing per-layer flame bars (width-scaled by
 * execution time or token count) with a header summarizing quality metrics.
 *
 * All output is SINGLE-CELL-WIDTH glyphs only (no emoji, no wide chars).
 * Pure render function: (data) => string[] with no side effects.
 */

import { renderFlameBar, heat } from './sparkline.js';

/**
 * Input data structure from a context_flame_graph SSE event.
 * All fields are optional for graceful null-handling.
 */
export interface FlameData {
  stages?: Record<string, { tokens?: number; ms?: number; elapsed_ms?: number }> | null;
  layers?: string[] | null;
  neurons_fired?: number;
  quality_score?: number;
  total_tokens?: number;
  cache_warm?: boolean;
  evictions?: number;
  elapsed_ms?: number;
}

/**
 * Strip ANSI color codes from a string for width calculations.
 * Used to ensure lines don't exceed the target width.
 */
function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/**
 * Truncate a line to fit within a target width, accounting for ANSI codes.
 * Appends "…" if truncated.
 */
function fitLine(line: string, maxWidth: number): string {
  const stripped = stripAnsi(line);
  if (stripped.length <= maxWidth) return line;
  // Rough truncation: find the ANSI-stripped position that fits
  let pos = 0;
  let stripped_pos = 0;
  while (pos < line.length && stripped_pos < maxWidth - 1) {
    if (line[pos] === '\x1b') {
      // Skip ANSI escape sequence
      const m = /\x1b\[[0-9;]*m/.exec(line.slice(pos));
      if (m) {
        pos += m[0].length;
        continue;
      }
    }
    pos++;
    stripped_pos++;
  }
  // Rebuild: original chars up to pos + ANSI resets + "…"
  let result = line.slice(0, pos);
  // Count how many color codes are still "open" and close them
  const openCodes = (result.match(/\x1b\[[\d;]*m/g) || [])
    .filter(code => !code.includes('0') && !code.includes('39') && !code.includes('49'));
  if (openCodes.length > 0) {
    result += '\x1b[0m'; // reset
  }
  result += '…';
  return result;
}

/**
 * Build the flame-graph overlay lines for display.
 * Returns an array of rendered lines, each <= width characters (before ANSI).
 *
 * @param data - Flame-graph data from context_flame_graph SSE event
 * @param width - Terminal width in columns
 * @returns Array of display lines (may include color codes)
 */
export function buildFlameGraph(data: FlameData | null, width: number): string[] {
  const lines: string[] = [];

  // Graceful null/empty handling
  if (!data || (!data.layers && !data.stages)) {
    return [
      'Context Flame - no flame graph captured yet (context_flame_graph not emitted this turn)',
    ];
  }

  // Build header with metrics
  const headerParts: string[] = [];
  headerParts.push('Context Flame');

  if (data.total_tokens != null) {
    headerParts.push(`${data.total_tokens} tok`);
  }

  if (data.quality_score != null) {
    const qs = Math.round(data.quality_score * 100);
    headerParts.push(`q${qs}`);
  }

  if (data.neurons_fired != null) {
    headerParts.push(`${data.neurons_fired}n`);
  }

  // Cache status: warm / cold
  if (data.cache_warm != null) {
    headerParts.push(data.cache_warm ? 'cache ok' : 'cache cold');
  }

  if (data.evictions != null && data.evictions > 0) {
    headerParts.push(`${data.evictions} evict`);
  }

  if (data.elapsed_ms != null) {
    const sec = (data.elapsed_ms / 1000).toFixed(2);
    headerParts.push(`${sec}s`);
  }

  const headerLine = headerParts.join(' · ');
  lines.push(headerLine);

  // Render one flame bar per layer
  const layers = data.layers || [];
  if (layers.length === 0) return lines; // just header

  // Find max ms/tokens for scaling
  let maxValue = 1;
  for (const layer of layers) {
    const stage = data.stages?.[layer];
    if (stage) {
      const val = stage.elapsed_ms ?? stage.ms ?? stage.tokens ?? 0;
      if (val > maxValue) maxValue = val;
    }
  }

  // Render each layer as a flame bar
  const labelWidth = Math.min(16, Math.max(8, width / 6));
  const barWidth = Math.max(4, width - labelWidth - 12);

  for (const layer of layers) {
    const stage = data.stages?.[layer];
    let value = 0;
    let annotation = '';

    if (stage) {
      // Prefer elapsed_ms, then ms, then tokens for sizing
      value = stage.elapsed_ms ?? stage.ms ?? stage.tokens ?? 0;

      // Annotation: show what metric we used
      if (stage.elapsed_ms != null) {
        annotation = `${stage.elapsed_ms}ms`;
      } else if (stage.ms != null) {
        annotation = `${stage.ms}ms`;
      } else if (stage.tokens != null) {
        annotation = `${stage.tokens}t`;
      }
    }

    const fraction = maxValue > 0 ? value / maxValue : 0;
    let barLine = renderFlameBar(
      layer,
      value,
      maxValue,
      barWidth,
      annotation,
      Math.floor(labelWidth),
    );

    // Color the bar by heat
    barLine = heat(fraction, barLine);

    // Ensure it fits
    barLine = fitLine(barLine, width);
    lines.push(barLine);
  }

  return lines;
}
