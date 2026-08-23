/**
 * Neuron activity tracker and renderer for the TUI overlay (Ctrl+N).
 *
 * Tracks SSE events: neuron_fire, neurons_start, neurons_done.
 * Accumulates per-source statistics and renders a compact flame-graph panel
 * showing throughput history + per-source token distribution.
 *
 * Pure render functions (data → string[]) with single-cell glyphs only.
 */

import { renderBrailleSparkline, renderFlameBar, heat } from './sparkline.js';
import { COLORS } from './theme.js';

/**
 * Sanitize source names: remove wide characters (emoji, CJK, fullwidth)
 * to ensure single-cell layout safety. Replaces with ASCII equivalent or drops.
 */
function sanitizeName(name: string): string {
  return Array.from(name)
    .filter(ch => {
      const cp = ch.charCodeAt(0);
      // Allow ASCII, box-drawing (U+2500-259F), braille (U+2800-28FF),
      // geometric shapes, Latin, misc single-cell
      if (cp < 0x80) return true; // ASCII
      if (cp >= 0x2500 && cp <= 0x28ff) return true; // box-drawing + braille
      // Reject emoji, CJK, fullwidth, Hangul, compat
      if (cp >= 0x1f300) return false; // emoji and later
      if (cp >= 0xac00) return false; // Hangul, CJK ideographs
      if (cp >= 0xff00 && cp <= 0xff60) return false; // fullwidth
      if (cp >= 0xfe30 && cp <= 0xfe4f) return false; // CJK compat
      if (cp >= 0x4e00 && cp <= 0x9fff) return false; // CJK ideographs
      return true;
    })
    .join('')
    .trim() || 'unknown';
}

/**
 * Per-source neuron activity snapshot.
 */
export interface NeuronSource {
  name: string;        // source identifier
  count: number;       // number of neuron_fire events from this source
  tokens: number;      // total tokens from this source
}

/**
 * Accumulated neuron state across a turn or session.
 */
export interface NeuronState {
  totalFired: number;        // total neuron_fire events seen
  totalTokens: number;       // total tokens across all events
  sources: NeuronSource[];   // per-source aggregation, sorted by tokens desc
  history: number[];         // token throughput history (one per neuron_fire event)
}

/**
 * Create an empty neuron state.
 */
export function emptyNeuronState(): NeuronState {
  return {
    totalFired: 0,
    totalTokens: 0,
    sources: [],
    history: [],
  };
}

/**
 * Accumulate a neuron event into the state.
 *
 * - neuron_fire: increment totalFired, aggregate per-source (by source name),
 *   push total_tokens to history.
 * - neurons_start: reset (optional, mostly for bookkeeping).
 * - neurons_done: optionally override totalFired and totalTokens from the event.
 */
export function accumulateNeuron(
  state: NeuronState,
  eventType: string,
  data: Record<string, any>,
): void {
  if (eventType === 'neuron_fire') {
    state.totalFired += 1;

    // Accumulate tokens from this event
    const tokensThisEvent = Number(data.total_tokens ?? 0);
    state.totalTokens += tokensThisEvent;
    state.history.push(tokensThisEvent);

    // Track per-source aggregation (sanitized name for layout safety)
    const sourceName = sanitizeName(data.source ?? 'unknown');
    const existingSource = state.sources.find(s => s.name === sourceName);
    if (existingSource) {
      existingSource.count += 1;
      existingSource.tokens += tokensThisEvent;
    } else {
      state.sources.push({
        name: sourceName,
        count: 1,
        tokens: tokensThisEvent,
      });
    }
  } else if (eventType === 'neurons_start') {
    // Reset state on start signal
    state.totalFired = 0;
    state.totalTokens = 0;
    state.sources = [];
    state.history = [];
  } else if (eventType === 'neurons_done') {
    // Override totals if provided in the event
    if (data.neurons_fired != null) {
      state.totalFired = Number(data.neurons_fired);
    }
    if (data.total_tokens != null) {
      state.totalTokens = Number(data.total_tokens);
    }
  }
}

/**
 * Pure render function: build the neuron activity panel.
 *
 * Returns an array of lines suitable for display in a blessed box widget.
 * Output is width-bounded and uses single-cell glyphs only.
 *
 * Layout:
 * - Header line: "Neurons - <totalFired> fired · <totalTokens> tok"
 * - Token history sparkline (braille, width-aware)
 * - Per-source flame bars, sorted by tokens descending
 * - Graceful "no neuron activity" message if empty
 */
export function buildNeuronPanel(state: NeuronState, width: number): string[] {
  const lines: string[] = [];

  // Guard: graceful empty state
  if (state.totalFired === 0) {
    lines.push('Neurons');
    lines.push(COLORS.muted('  (no activity this turn)'));
    return lines;
  }

  // Header: "Neurons - <totalFired> fired · <totalTokens> tok"
  const headerText = `Neurons - ${state.totalFired} fired · ${state.totalTokens} tok`;
  lines.push(COLORS.accent(headerText));

  // Token throughput sparkline (history)
  if (state.history.length > 0) {
    const sparklineWidth = Math.max(4, width - 4); // reserve 4 for padding/margin
    const sparkline = renderBrailleSparkline(state.history, sparklineWidth);
    if (sparkline) {
      lines.push(`  ${sparkline}`);
    }
  }

  // Per-source flame bars, sorted by tokens descending
  if (state.sources.length > 0) {
    // Sort sources by tokens (descending)
    const sortedSources = [...state.sources].sort((a, b) => b.tokens - a.tokens);

    // Find max tokens for heat scaling
    const maxTokens = Math.max(...sortedSources.map(s => s.tokens), 1);

    // Render each source as a flame bar
    for (const source of sortedSources) {
      const annotation = `${source.count}x ${source.tokens}tok`;
      const flameBar = renderFlameBar(
        source.name,
        source.tokens,
        maxTokens,
        width - 2, // account for indent
        annotation,
        12, // label width
      );

      // Heat color based on fraction of max
      const fraction = maxTokens > 0 ? source.tokens / maxTokens : 0;
      const coloredBar = heat(fraction, flameBar);

      lines.push(`  ${coloredBar}`);
    }
  }

  return lines;
}
