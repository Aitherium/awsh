/**
 * AitherSense affect overlay (Ctrl+S): renders mood, emotional metrics, sensations,
 * and mood-state text in a clean columnar layout.
 *
 * Pure render function: (affect, width) → string[]. All lines are single-cell-width
 * safe and fit within the given width (pad/wrap as needed). Returns a graceful
 * fallback when affect is null.
 */
import { COLORS } from './theme.js';
import { renderMeter, heat } from './sparkline.js';
import type { Affect } from './affect.js';

/**
 * Affect may include optional backend fields beyond the core schema.
 * These represent additional emotional/cognitive dimensions.
 */
/**
 * The Affect interface from our module already includes all these fields,
 * so we can use it directly as our metrics interface.
 */
export type AffectWithMetrics = Affect;

/**
 * Word-wrap text to a given width, breaking on spaces when possible.
 * Strips ANSI codes before measuring, so coloured text wraps correctly.
 */
function wrapText(text: string, width: number): string[] {
  if (!text || width <= 0) return [''];
  // Strip ANSI codes for width calculation
  const plain = text.replace(/\x1b\[[0-9;]*m/g, '');
  if (plain.length <= width) return [text];

  const lines: string[] = [];
  let remaining = text;
  while (remaining.length > 0) {
    // Find the last space within the width limit (accounting for ANSI codes)
    let plainPos = 0;
    let textPos = 0;
    while (textPos < remaining.length && plainPos < width) {
      const ch = remaining[textPos];
      if (ch === '\x1b') {
        // Skip ANSI code
        const end = remaining.indexOf('m', textPos);
        textPos = end >= 0 ? end + 1 : textPos + 1;
      } else {
        plainPos++;
        textPos++;
      }
    }

    // If we're at the end or the character is a space, cut here
    if (textPos >= remaining.length) {
      lines.push(remaining);
      break;
    }

    // Backtrack to the last space within the width
    let cutPos = textPos;
    while (cutPos > 0 && remaining[cutPos] !== ' ') cutPos--;
    if (cutPos === 0) cutPos = textPos;  // No space found; cut at width
    else cutPos++;  // Skip the space itself

    lines.push(remaining.slice(0, cutPos).trimEnd());
    remaining = remaining.slice(cutPos).trimStart();
  }

  return lines;
}

/**
 * Render a labelled meter: `label · [████░░] 75%` with optional heat coloring.
 * Returns exactly the same format regardless of value, so meters align vertically.
 */
function renderMeteredLine(
  label: string,
  value: number | undefined,
  width: number,
  showSign = false,
): string {
  if (value === undefined) return `${label} · (unavailable)`;

  const clamped = Math.max(0, Math.min(1, value));
  let displayVal = clamped;
  let suffix = '';
  if (showSign && value < 0) {
    displayVal = Math.abs(value);
    suffix = ' (negative)';
  } else if (showSign) {
    suffix = ' (positive)';
  }

  const meter = renderMeter(displayVal, width);
  const line = `${label} · ${meter}${suffix}`;
  return heat(clamped, line);
}

/**
 * Build the AitherSense panel: title, metrics grid, dominant sensation, prompt modifier.
 * Ensures every line fits within `width` columns (strip ANSI for measurement).
 * Returns an empty-graceful message when affect is null.
 */
export function buildAffectPanel(affect: AffectWithMetrics | null, width: number): string[] {
  const lines: string[] = [];

  // Null case: single graceful line
  if (!affect) {
    return ['AitherSense unavailable'];
  }

  const moodLabel = affect.mood ? `${affect.mood}` : 'unspecified';
  lines.push(COLORS.accent(`AitherSense - ${moodLabel}`));
  lines.push('');  // spacer

  // Metrics grid: label · [meter] value%
  // Map valence from -1..1 to 0..1 for meter display
  const valence01 = (affect.valence + 1) / 2;  // valence is always defined
  const meterWidth = Math.max(8, width - 30);  // meter bar width, leaving room for label + value

  lines.push(renderMeteredLine('valence', valence01, meterWidth, false));
  lines.push(renderMeteredLine('arousal', affect.arousal, meterWidth, false));
  lines.push(renderMeteredLine('confidence', affect.confidence, meterWidth, false));
  lines.push(renderMeteredLine('openness', affect.openness, meterWidth, false));
  lines.push(renderMeteredLine('existential depth', affect.existentialDepth, meterWidth, false));

  lines.push('');  // spacer

  // Dominant sensation + active count
  const sensation = affect.dominantSensation || '(none)';
  const activeCount = affect.activeCount ?? 0;
  const sensationLine = `dominant: ${sensation}  · active: ${activeCount}`;
  lines.push(COLORS.muted(sensationLine));

  // Prompt modifier text, word-wrapped
  if (affect.promptModifier) {
    lines.push('');  // spacer
    const wrapped = wrapText(affect.promptModifier, width);
    for (const line of wrapped) {
      lines.push(COLORS.muted(line));
    }
  }

  return lines;
}
