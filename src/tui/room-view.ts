/**
 * AitherAeon room view — the six pillars, live, in one pane.
 *
 * This is the payoff of the event spine. AitherShell has always been able to RENDER
 * cognition — neuron activity, reasoning streams, MCTS iterations, context flame
 * graphs — but only for a genesis `/chat/stream` turn. Everything else the platform
 * thought (a Claude Code tab, an adk agent loop, the kernel tick, Flux) emitted into
 * nothing anyone could watch. The room merges them all onto one ordered stream, and
 * this view lays that stream out as six lanes so the pillars are a thing you can
 * SEE rather than a diagram in a doc.
 *
 * Pure render function following the TUI view seam: (snapshot, width) → string[].
 * No I/O, no blessed types — same shape as sessions-view.ts, so it drops into the
 * existing screen without touching the framework. (A TUI rewrite was already
 * considered and rejected; this is a view.)
 *
 * The lane vocabulary comes from aither-events.generated.ts, which is generated from
 * AitherEventSpine.py and gated by AE004. It is never hand-listed here.
 */

import { COLORS } from './theme.js';
import { PILLARS, type AitherEvent, type Pillar } from '../aither-events.generated.js';
import {
  bucketByPillar,
  eventDetail,
  summarizeRoom,
  type RoomSnapshot,
} from '../room-client.js';

/** Each lane gets a stable colour so the eye learns the layout. */
function laneColor(pillar: Pillar, s: string): string {
  switch (pillar) {
    case 'intent':
      return COLORS.warn(s);
    case 'context':
      return COLORS.accent(s);
    case 'reasoning':
      return COLORS.success(s);
    case 'orchestration':
      return COLORS.text(s);
    case 'learning':
      return COLORS.accent(s);
    case 'automation':
      return COLORS.muted(s);
    default:
      return COLORS.text(s);
  }
}

/** Actor kind → a short tag, so a row says WHO without spending width on it. */
function actorTag(ev: AitherEvent): string {
  switch (ev.actor?.kind) {
    case 'claude_code':
      return 'cc';
    case 'adk_agent':
      return 'adk';
    case 'sovereign':
      return 'aith';
    case 'kernel':
      return 'krnl';
    case 'service':
      return 'svc';
    case 'human':
      return 'you';
    case 'acp':
      return 'acp';
    case 'a2a':
      return 'a2a';
    default:
      return '?';
  }
}

function truncate(s: string, max: number): string {
  if (max <= 1) return '';
  return s.length <= max ? s : `${s.slice(0, max - 1)}…`;
}

/**
 * Build the room panel.
 *
 * Layout:
 *   - Header with room id and tier mix
 *   - DEGRADED banner when the daemon is unreachable (never a silently empty room)
 *   - Six lanes, each with a count and the most recent rows
 *   - Conversation surface (pillar-less events) in its own section
 *   - Footer: participant roster summary
 *
 * @param snapshot  result of fetchRoomSnapshot()
 * @param width     pane width in columns
 * @param perLane   max rows to show per lane (most recent last)
 */
export function buildRoomPanel(
  snapshot: RoomSnapshot,
  width: number,
  perLane = 4,
): string[] {
  const lines: string[] = [];
  const roomId = snapshot.info?.id || 'main';

  lines.push(COLORS.accent(`AitherAeon · room ${roomId}`));

  // An unreachable daemon must SAY so. An empty room and a dead daemon look
  // identical otherwise, and "no agents are working" is precisely the wrong thing
  // to tell someone whose agents are all working.
  if (!snapshot.ok) {
    lines.push(COLORS.error('  ✗ room unavailable'));
    for (const chunk of wrap(snapshot.reason, Math.max(20, width - 4))) {
      lines.push(COLORS.muted(`    ${chunk}`));
    }
    return pad(lines, 15);
  }

  const { lanes, surface } = bucketByPillar(snapshot.events);
  const counts = snapshot.info?.pillars || {};
  const labelWidth = Math.max(...PILLARS.map((p) => p.length));

  // Derive the detail budget from the ACTUAL row prefix rather than a guessed
  // constant. A row is:
  //   2 indent + labelWidth + 2 gap + 1 tier + 1 sp + 4 tag + 1 sp + TYPE_W + 1 sp
  // Getting this wrong overflows the pane and blessed wraps the row, which corrupts
  // every line beneath it — the same class of damage as an unescaped newline.
  const TYPE_W = 18;
  const rowPrefix = 2 + labelWidth + 2 + 1 + 1 + 4 + 1 + TYPE_W + 1;
  const detailWidth = Math.max(8, width - rowPrefix);

  for (const pillar of PILLARS) {
    const total = counts[pillar] ?? lanes[pillar].length;
    const header = `${pillar.padEnd(labelWidth)}  ${String(total).padStart(4)}`;
    lines.push(laneColor(pillar, `  ${header}`));

    const rows = lanes[pillar].slice(-perLane);
    if (rows.length === 0) {
      // An empty lane is a FACT, not a bug. The learning lane in particular has no
      // shell-side producer at all — it fills from Flux and the kernel — so a blank
      // line here would read as a broken renderer.
      lines.push(COLORS.muted(`  ${' '.repeat(labelWidth)}  ·  (quiet)`));
      continue;
    }
    for (const ev of rows) {
      const tag = actorTag(ev).padEnd(4);
      const type = truncate(ev.type, TYPE_W).padEnd(TYPE_W);
      const detail = truncate(eventDetail(ev), detailWidth);
      const tier = ev.tier === 'fleet' ? COLORS.muted('◇') : COLORS.muted('◆');
      lines.push(
        `  ${' '.repeat(labelWidth)}  ${tier} ${COLORS.muted(tag)} ${type} ${COLORS.muted(detail)}`,
      );
    }
  }

  if (surface.length) {
    lines.push('');
    lines.push(COLORS.muted(`  surface (${surface.length})  · not a pillar`));
    for (const ev of surface.slice(-3)) {
      const detail = truncate(eventDetail(ev) || ev.type, detailWidth);
      lines.push(COLORS.muted(`    ${detail}`));
    }
  }

  lines.push('');
  lines.push(COLORS.muted(`  · ${summarizeRoom(snapshot.info)}`));
  lines.push(COLORS.muted('  · ◆ host  ◇ fleet'));

  // Pad to prevent emoji ghosting when content shrinks (wide-char bleed).
  return pad(lines, 20);
}

function wrap(text: string, width: number): string[] {
  const out: string[] = [];
  let rest = text;
  while (rest.length > width) {
    out.push(rest.slice(0, width));
    rest = rest.slice(width);
  }
  if (rest) out.push(rest);
  return out;
}

function pad(lines: string[], minHeight: number): string[] {
  const out = [...lines];
  while (out.length < minHeight) out.push('');
  return out;
}
