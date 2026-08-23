/**
 * Animated agent-loop strip renderer for the trace pane.
 * Shows the current pipeline stages with live spinner, status glyphs, and optional flame bars.
 *
 * Pure render function: stages + width + frame → string[].
 * Single-cell glyphs only; deterministic animation based on frame number.
 */

import type { TraceStage } from './event-schema.js';
import { COLORS } from './theme.js';
import { renderBar } from './sparkline.js';

/**
 * Spinner glyphs cycling on frame (4-phase, single-cell width).
 */
const SPINNER = ['◐', '◓', '◑', '◒'];

/**
 * Canonical stage order in the agent loop.
 */
const CANONICAL_ORDER: TraceStage['kind'][] = [
  'context',
  'memory',
  'neurons',
  'think',
  'plan',
  'tools',
  'llm',
  'orchestration',
  'verdict',
  'error',
  // 'other' (pre-model pipeline chatter: progress/model_select/…) is intentionally
  // omitted — the strip shows the agent LOOP, not the misc bucket.
];

/**
 * Map stage.kind → short label (5 chars or less for compact display).
 */
function stageLabel(kind: TraceStage['kind']): string {
  const labels: Record<TraceStage['kind'], string> = {
    context: 'ctx',
    memory: 'mem',
    neurons: 'nrn',
    think: 'think',
    plan: 'plan',
    tools: 'tools',
    llm: 'llm',
    orchestration: 'orch',
    verdict: 'done',
    error: 'err',
    other: 'dot',
  };
  return labels[kind];
}

/**
 * Get the status glyph for a stage (spinner if running, filled circle if done,
 * error circle if error, empty circle if pending).
 */
function statusGlyph(status: 'running' | 'done' | 'error', frame: number): string {
  if (status === 'running') {
    return SPINNER[frame % SPINNER.length];
  }
  if (status === 'done') {
    return '●';
  }
  if (status === 'error') {
    return '●';
  }
  // pending or other
  return '○';
}

/**
 * Render a single stage cell: glyph + label, with optional colour.
 */
function renderStageCell(stage: TraceStage, frame: number, isActive: boolean): string {
  const glyph = statusGlyph(stage.status, frame);
  const label = stageLabel(stage.kind);

  // Colour logic:
  // - running + active (last running): accent colour
  // - done: success colour
  // - error: error colour
  // - pending: muted colour
  let cell = `${glyph} ${label}`;

  if (stage.status === 'running' && isActive) {
    cell = COLORS.accent(cell);
  } else if (stage.status === 'done') {
    cell = COLORS.success(cell);
  } else if (stage.status === 'error') {
    cell = COLORS.error(cell);
  } else {
    cell = COLORS.muted(cell);
  }

  return cell;
}

/**
 * Find the index of the last running stage (if any) to highlight it.
 */
function findActiveStageIndex(stages: TraceStage[]): number {
  for (let i = stages.length - 1; i >= 0; i--) {
    if (stages[i].status === 'running') {
      return i;
    }
  }
  return -1;
}

/**
 * Render the pipeline animator: 1-2 lines showing the agent-loop stages.
 *
 * Line 1: horizontal stage strip in canonical order, only present stages.
 *         Status glyph + short label joined by " -> ".
 *         Active (last running) stage coloured with accent.
 *
 * Line 2: (only if width >= 24) flame bars showing per-stage timing.
 *
 * @param stages array of pipeline stages
 * @param width available terminal width
 * @param frame animation frame number (for spinner)
 * @returns array of rendered lines (1-2 elements)
 */
export function renderPipeline(stages: TraceStage[], width: number, frame: number): string[] {
  if (!stages.length) {
    return [];
  }

  // Filter and sort stages in canonical order.
  const presentStages = CANONICAL_ORDER
    .map(kind => stages.find(s => s.kind === kind))
    .filter((s): s is TraceStage => s != null);

  if (!presentStages.length) {
    return [];
  }

  // Find the active (last running) stage for accent colouring.
  const activeIdx = findActiveStageIndex(presentStages);

  // Build the stage strip: glyph + label, joined by " -> ".
  const cells = presentStages.map((stage, idx) =>
    renderStageCell(stage, frame, idx === activeIdx)
  );
  const stripLine = cells.join(' → ');

  // If width is too narrow, return just the strip.
  if (width < 24) {
    return [stripLine];
  }

  // Build the flame bar line (per-stage timing).
  // Find max ms across all stages for scaling.
  const maxMs = Math.max(...presentStages.map(s => s.metrics.ms ?? 0), 1);

  // Each stage gets a tiny bar (3-4 chars) with its duration.
  const flameSegments = presentStages.map(stage => {
    const ms = stage.metrics.ms ?? 0;
    const barWidth = 3;
    const bar = renderBar(ms, maxMs, barWidth);
    const label = stageLabel(stage.kind);
    // Simple heat gradient: dim for low, accent for medium, warn for high.
    const frac = maxMs > 0 ? ms / maxMs : 0;
    let heatBar = bar;
    if (frac < 0.3) heatBar = COLORS.muted(bar);
    else if (frac < 0.7) heatBar = COLORS.accent(bar);
    else heatBar = COLORS.warn(bar);
    return `${label} ${heatBar}`;
  });
  const flameLine = flameSegments.join(' ');

  return [stripLine, flameLine];
}
