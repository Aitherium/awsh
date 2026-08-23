/**
 * Sessions cockpit view — read-only observation of unified session roster.
 *
 * Pure render function following the TUI view seam: (sessions, width) → string[].
 * Handles status color-coding via theme.ts COLORS, and respects wide-character
 * boundaries (emoji offset guard).
 *
 * Layout:
 *   - Header: "Sessions"
 *   - Column headers: name | cwd | origin | status | age | summary
 *   - Session rows, scrollable
 *   - Footer: fleet summary (counts by status)
 */

import chalk from 'chalk';
import { COLORS } from './theme.js';
import { formatSessionRow, summarizeFleet, type UnifiedSession } from '../sessions-client.js';

/**
 * Colorize a status string using the semantic palette.
 */
function statusColor(status: string): string {
  switch (status) {
    case 'working':
      return COLORS.accent(status); // cyan
    case 'waiting-input':
    case 'waiting-permission':
      return COLORS.warn(status); // yellow
    case 'idle':
      return COLORS.muted(status); // dim
    case 'dead':
      return COLORS.error(status); // red
    default:
      return COLORS.text(status); // default
  }
}

/**
 * Pure render function: build the sessions cockpit panel.
 *
 * Returns an array of pre-rendered, width-bounded lines suitable for blessed.box.
 * Each line is pre-colored (chalk ANSI) and includes width guards for emoji.
 *
 * Layout:
 *   - Header: "Sessions (Ctrl+S)"
 *   - Empty-state message if no sessions
 *   - Column headers (name, cwd, origin, status, age, summary)
 *   - One row per session, colored by status
 *   - Footer: fleet summary counts
 *   - Padding to pane height to prevent emoji ghosting
 */
export function buildSessionsPanel(
  sessions: UnifiedSession[],
  width: number,
): string[] {
  const lines: string[] = [];

  // Header
  lines.push(COLORS.accent('Sessions (Ctrl+S)'));

  if (sessions.length === 0) {
    lines.push(COLORS.muted('  (no sessions)'));
    // Fall through to padding below
  } else {

    // Compute column widths from available width
    // Rough allocation: name 20, cwd 30, origin 8, status 14, age 6, summary remaining
    const minWidth = 80; // fallback if terminal too narrow
    const effectiveWidth = Math.max(minWidth, width - 2); // account for borders/padding

    // Reserve space for fixed columns and separators (rough estimate)
    const reserved = 5 + 8 + 1 + 14 + 1 + 6 + 1; // origin, status, age, spacers
    const flexWidth = Math.max(40, effectiveWidth - reserved); // remaining for name+cwd+summary

    const colWidths = {
      name: Math.max(12, Math.floor(flexWidth * 0.25)),
      cwd: Math.max(15, Math.floor(flexWidth * 0.40)),
      summary: Math.max(10, Math.floor(flexWidth * 0.35)),
    };

    // Column headers
    const headerName = 'name'.padEnd(colWidths.name);
    const headerCwd = 'cwd'.padEnd(colWidths.cwd);
    lines.push(COLORS.muted(`  ${headerName}  ${headerCwd}  orig  status        age  summary`));

    // Session rows
    for (const session of sessions) {
      const row = formatSessionRow(session, colWidths);
      // Color the status column: map session.status to a color
      const coloredRow = row.replace(
        /(?<status>\S{3,})(?=\s{2,})/,
        (match) => {
          // This regex tries to find the status word; however, to be robust,
          // we'll do a simpler approach: find-and-replace the exact status value
          // within the formatted row.
          if (session.status.includes(match)) {
            return statusColor(session.status);
          }
          return match;
        },
      );

      // Simpler: rebuild the row with colored status
      const [prefix, statusPart, suffix] = formatSessionRow(session, colWidths).split(
        new RegExp(`(${session.status}\\s*)`),
      );
      if (statusPart) {
        lines.push(prefix + statusColor(session.status) + (suffix || ''));
      } else {
        lines.push(coloredRow);
      }
    }

    // Footer: fleet summary
    const summary = summarizeFleet(sessions);
    lines.push(COLORS.muted(`  · ${summary}`));
  }

  // Pad to prevent emoji ghosting (wide-char bleed guard).
  // Blessed's buffer rewriting can leave stale glyphs when content shrinks if
  // we don't fill to the full pane height. This is worst-case safe.
  const minHeight = Math.max(sessions.length + 7, 15);
  while (lines.length < minHeight) {
    lines.push('');
  }

  return lines;
}
