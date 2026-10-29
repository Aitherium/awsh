/**
 * The attention beam: WHICH ask is waiting on the owner, on one line, at the top.
 *
 * Owner, 2026-10-28: "I need to have multiplexed information and also have it
 * compressed into a laser beam right in front of my eyes." And of the status line
 * that showed `inbox 129 (14d)`: "why is the claude code status still so useless
 * and not properly getting my attention on this shit across all sessions?"
 *
 * The failure it fixes, measured that day: an approval card (publish the Election
 * Day brief) was raised and could not be found — #29 of 132 open cards, because
 * the ranker broke ties OLDEST first, and eight "Claude Code needs you" cards from
 * sessions that had ended days earlier sat pinned above everything real.
 *
 * This module is the pure half (rank + format), shared by the status bar and its
 * tests. The IO half lives in decisions-client.ts; the wiring in repl-tui.ts.
 */

export interface BeamOption {
  key: string;
  label?: string;
}

export interface BeamCard {
  id: string;
  title: string;
  kind: string;
  urgency: string;
  createdAt: number;
  options?: BeamOption[];
  /** `cc-waiting:<session>:<stamp>` for a Claude Code "needs you" card. */
  dedupeKey?: string;
  /** `source.session_id` — the Claude session a needs-you card belongs to. */
  sourceSessionId?: string;
}

/** An ask is NEW for a day; after that it is counted, never headlined. */
export const FRESH_SECONDS = 24 * 3600;
/** How many asks the beam names when there is room. */
export const BEAM_MAX = 3;

const URGENCY_RANK: Record<string, number> = { critical: 0, high: 1, normal: 2, low: 3 };
const FIRST_KINDS = new Set(['credential', 'blocked']);

/** A card that WAITS on a person: it offers choices, or it is a secret/lock. */
export function isAsk(card: BeamCard): boolean {
  return (card.options?.length ?? 0) > 0 || FIRST_KINDS.has(String(card.kind || '').toLowerCase());
}

export function ageSeconds(card: BeamCard, nowSec: number): number {
  const at = Number(card.createdAt) || 0;
  return at ? Math.max(0, nowSec - at) : 0;
}

/**
 * A "Claude Code needs you" card counts only while its session is alive and not
 * busy. Its resolve hook fires when the owner next types in THAT session, so a
 * session that ended while waiting leaves a card open forever — eight of them,
 * up to 13 days old, on 2026-10-28.
 *
 * `liveSessionIds` is null when liveness is unknown (not measured): then every
 * card counts. That direction is deliberate: an unknown must not hide a real ask.
 */
export function stillWaiting(card: BeamCard, liveSessionIds: ReadonlySet<string> | null): boolean {
  const key = String(card.dedupeKey || '');
  if (!key.startsWith('cc-waiting:')) return true;
  if (liveSessionIds === null) return true;
  const sid = card.sourceSessionId || key.split(':')[1] || '';
  return liveSessionIds.has(sid);
}

/** credential/blocked first, then urgency, then NEWEST first (the 2026-10-28 fix). */
export function askRank(card: BeamCard, nowSec: number): [number, number, number, string] {
  const kind = String(card.kind || '').toLowerCase();
  const urgency = URGENCY_RANK[String(card.urgency || '').toLowerCase()];
  return [
    FIRST_KINDS.has(kind) ? 0 : 1,
    urgency === undefined ? 2 : urgency,
    ageSeconds(card, nowSec),
    card.id,
  ];
}

export interface Beam {
  /** Asks raised in the last day, ranked; the head of this is "what needs you now". */
  fresh: BeamCard[];
  /** Every ask still waiting (fresh or not). */
  open: number;
  /** The oldest waiting ask, in seconds — the count line's age. */
  oldestAge: number;
}

export function rankBeam(
  cards: readonly BeamCard[],
  nowSec: number,
  liveSessionIds: ReadonlySet<string> | null = null,
): Beam {
  const waiting = cards.filter((c) => isAsk(c) && stillWaiting(c, liveSessionIds));
  const fresh = waiting
    .filter((c) => ageSeconds(c, nowSec) < FRESH_SECONDS)
    .sort((a, b) => {
      const ka = askRank(a, nowSec), kb = askRank(b, nowSec);
      return ka[0] - kb[0] || ka[1] - kb[1] || ka[2] - kb[2] || (ka[3] < kb[3] ? -1 : ka[3] > kb[3] ? 1 : 0);
    });
  const oldestAge = waiting.reduce((m, c) => Math.max(m, ageSeconds(c, nowSec)), 0);
  return { fresh, open: waiting.length, oldestAge };
}

/** RED means "now": a fresh ask that is critical/high, a credential, or a lock. */
export function isHot(card: BeamCard): boolean {
  const kind = String(card.kind || '').toLowerCase();
  const urgency = String(card.urgency || '').toLowerCase();
  return FIRST_KINDS.has(kind) || urgency === 'critical' || urgency === 'high';
}

/** Coarse age, the same shapes the status line uses: 42s / 7m / 3h / 2d. */
export function fmtAge(seconds: number): string {
  if (seconds < 60) return `${Math.max(0, Math.floor(seconds))}s`;
  if (seconds < 3600) return `${Math.floor(seconds / 60)}m`;
  if (seconds < 86400) return `${Math.floor(seconds / 3600)}h`;
  return `${Math.floor(seconds / 86400)}d`;
}

export interface BeamSegment {
  key: string;
  text: string;
  plain: string;
}

/** Painting is injected so this module stays pure (and testable without chalk). */
export interface BeamPaint {
  red: (s: string) => string;
  amber: (s: string) => string;
  dim: (s: string) => string;
  bold: (s: string) => string;
}

const IDENTITY: BeamPaint = { red: (s) => s, amber: (s) => s, dim: (s) => s, bold: (s) => s };

/**
 * The bar segments for a beam: one clickable segment per named ask, then a count.
 *
 * Each named ask is `id age title`; a click on it hands `decision:<id>` to the
 * TUI, which opens that card. `width` is the beam's budget on the bar: titles are
 * shortened until the segments fit, and asks that cannot be shown become part of
 * the count — never silently dropped (the bar is one row; overflow would clip the
 * segments after it, which is how the old HUD lost its right edge).
 */
export function formatBeam(beam: Beam, nowSec: number, width: number, paint: BeamPaint = IDENTITY): BeamSegment[] {
  if (!beam.open) return [];
  // Reserve the count line up front: it must survive even when no title fits.
  let budget = Math.max(16, width - 20);
  const shown: BeamSegment[] = [];
  for (const card of beam.fresh.slice(0, BEAM_MAX)) {
    const lead = `${card.id} ${fmtAge(ageSeconds(card, nowSec))} `;
    const title = String(card.title || '').replace(/\s+/g, ' ').trim();
    const room = budget - lead.length - (shown.length ? 3 : 0);
    if (room < 12) break;                      // no useful title fits: let the count carry it
    const clipped = title.length > room ? title.slice(0, room - 3).trimEnd() + '...' : title;
    const paintFn = isHot(card) ? paint.red : paint.amber;
    shown.push({ key: `decision:${card.id}`, text: paintFn(lead + clipped), plain: lead + clipped });
    budget -= lead.length + clipped.length + 3;
  }
  if (!shown.length) {
    const only = `DECIDE ${beam.open} waiting`;
    return [{ key: 'decisions', text: paint.amber(only), plain: only }];
  }
  const suffix = `(+${Math.max(0, beam.fresh.length - shown.length)}, ${beam.open} open)`;
  shown.push({ key: 'decisions', text: paint.dim(suffix), plain: suffix });
  return shown;
}

/** The card's answer options as one line, for the viewer opened from the bar. */
export function formatOptions(card: BeamCard): string {
  const opts = card.options ?? [];
  if (!opts.length) return 'no options — answer with a note';
  return opts.map((o) => o.label ? `${o.key} (${o.label})` : o.key).join(' / ');
}
