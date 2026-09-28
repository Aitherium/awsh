/**
 * Sessions cockpit view — read-only observation of unified session roster.
 *
 * Pure render function following the TUI view seam: (sessions, width) → string[].
 * Handles status color-coding via theme.ts COLORS, and respects wide-character
 * boundaries (emoji offset guard).
 *
 * Layout:
 *   - Header: "Sessions"
 *   - Column headers: name | cwd | branch | orig | cap | status | age | tok | summary
 *   - Session rows, scrollable
 *   - Footer: fleet summary (counts by status)
 */

import { COLORS } from './theme.js';
import { BRANCH_WIDTH, formatSessionRow, summarizeFleet, type UnifiedSession } from '../sessions-client.js';

/** Semantic tone for a status word. */
export type StatusTone = 'accent' | 'warn' | 'muted' | 'error' | 'text';

/**
 * Map a status word to its tone. Covers the vocabulary the daemon actually
 * emits (session_directory.py: `blocked?` for an unanswered tool call, `exited`
 * for a stopped/failed session) as well as the legacy words, so an exited or
 * possibly-blocked row is never rendered in the neutral default colour -- those
 * are exactly the two rows an operator must not miss.
 */
export function sessionStatusTone(status: string): StatusTone {
  switch (status) {
    case 'working':
      return 'accent';
    case 'waiting-input':
    case 'waiting-permission':
    case 'blocked?':
      return 'warn';
    case 'idle':
      return 'muted';
    case 'exited':
    case 'failed':
    case 'dead':
      return 'error';
    default:
      return 'text';
  }
}

/**
 * Colorize a status string using the semantic palette.
 */
function statusColor(status: string): string {
  return COLORS[sessionStatusTone(status)](status);
}

/** Fixed characters per row besides name/cwd/summary: indent, separators,
 *  orig(4), cap(4), status(14), age(4). */
const BASE_RESERVED = 2 + 2 + 2 + 4 + 2 + 4 + 2 + 14 + 2 + 4 + 2;
/** Cost of each optional column including its separator. */
const TOKENS_COST = 6 + 2;
const BRANCH_COST = BRANCH_WIDTH + 2;
/** Optional columns are only shown while name+cwd+summary keep this much room,
 *  so a 100-column terminal still shows a 15+ character session title. */
const MIN_FLEX = 60;

export interface SessionsColumnLayout {
  widths: { name: number; cwd: number; summary: number; branch: number; tokens: boolean };
}

/**
 * Width budget for the sessions table. Pure: (terminal width) -> column widths.
 * The optional tok and branch columns collapse (in that order of priority:
 * tok survives longer than branch) before the name column is squeezed.
 */
export function sessionsColumnLayout(width: number): SessionsColumnLayout {
  const effectiveWidth = Math.max(80, width - 2); // account for borders/padding
  let flex = effectiveWidth - BASE_RESERVED;
  let tokens = false;
  let branch = 0;
  if (flex - TOKENS_COST >= MIN_FLEX) {
    tokens = true;
    flex -= TOKENS_COST;
  }
  if (flex - BRANCH_COST >= MIN_FLEX) {
    branch = BRANCH_WIDTH;
    flex -= BRANCH_COST;
  }
  // The title is what an operator scans for, so it is sized first with a floor
  // of 15; cwd and summary split what is left and the three sum to `flex`, so a
  // row never overruns the pane (flex >= 40 because the pane floor is 80).
  const name = Math.max(15, Math.floor(flex * 0.30));
  const cwd = Math.floor((flex - name) / 2);
  return {
    widths: {
      name,
      cwd,
      summary: flex - name - cwd,
      branch,
      tokens,
    },
  };
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
  opts: { source?: 'daemon' | 'local'; daemonError?: string } = {},
): string[] {
  const lines: string[] = [];

  // Header
  lines.push(COLORS.accent('Sessions (Ctrl+S)'));
  if (opts.source === 'local') {
    // Offline fallback: read from Claude's own files. Say so -- a row that
    // cannot be steered must not look like one that can.
    lines.push(COLORS.warn('  daemon not reachable - read from ~/.claude directly (view only; cap = none)'));
    lines.push(COLORS.muted('  start the daemon to steer:  adk harness serve'));
  }

  if (sessions.length === 0) {
    lines.push(COLORS.muted('  (no sessions)'));
    // Fall through to padding below
  } else {

    const layout = sessionsColumnLayout(width);
    const colWidths = layout.widths;

    // Column headers -- built from the same widths/toggles as the rows.
    const headerBranch = colWidths.branch > 0 ? 'branch'.padEnd(colWidths.branch) + '  ' : '';
    const headerTok = colWidths.tokens ? '   tok  ' : '';
    lines.push(COLORS.muted(
      `  ${'name'.padEnd(colWidths.name)}  ${'cwd'.padEnd(colWidths.cwd)}  ${headerBranch}`
      + `orig  cap   ${'status'.padEnd(14)}  age   ${headerTok}summary`,
    ));

    // Session rows: the formatter colours the status cell itself, so a title
    // that contains the status word can no longer swallow the columns after it.
    for (const session of sessions) {
      lines.push(formatSessionRow(session, colWidths, { colorStatus: statusColor }));
    }

    // Footer: fleet summary
    const summary = summarizeFleet(sessions);
    lines.push(COLORS.muted(`  · ${summary}`));
    lines.push(COLORS.muted('  /sessions focus <n|id> tails one session live'));
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
