/**
 * next-action.ts — the ONE thing to do next, computed from data the surface already has.
 *
 * Adapted from the i-have-adhd doctrine (MIT, Copyright (c) 2026 Ayoub Ghriss; fork
 * wizzense/i-have-adhd), law 1 "lead with the next action" and law 3 "restate state".
 * The failure it fixes, measured 2026-11-01 from the owner's awsh screenshot: the TUI
 * could say `10 down`, `130 waiting` and `(+25, 130 open)` and still leave the reader to
 * work out what to type. A count is a fact; an action is the only thing a person with a
 * small working memory can start from.
 *
 * This module is PURE — no IO, no chalk, no imports — so the full-screen TUI and the
 * inline `PS> awsh` boot compute their line from the same function and cannot drift.
 * Callers pass what they already fetched: `gatherStatus()` (down/total),
 * `rankBeam(fetchBeamCards())` (asks), `postureBarSegment()` (the house's next edge).
 */

/** One waiting ask, as the ranker already knows it. */
export interface NextAsk {
  id: string;
  title: string;
  /** Seconds since it was raised; the longest wait is the strongest tie-break. */
  ageSec: number;
  /** RED — a credential/blocked card, or critical/high urgency. */
  hot: boolean;
}

export interface NextInput {
  /** Names of the probed services that did not answer. */
  down: string[];
  /** How many services were probed at all. */
  total: number;
  /** Ranked asks, newest/hottest first (the order `rankBeam().fresh` gives). */
  asks: NextAsk[];
  /** Every ask still waiting, including ones too old to be headlined. */
  askCount: number;
  /** Pending CRITICAL cards from ActionHub, when that was measured. */
  critical?: { total: number; titles: string[] };
  /** The house's next scheduled edge (`postureView().next`), when measured. */
  postureNext?: string;
}

export type NextVerb = 'answer' | 'run' | 'review' | 'none';

export interface NextPlan {
  /** One line, imperative, already carrying the command that acts on it. */
  line: string;
  verb: NextVerb;
  /** At most NEXT_VISIBLE asks, numbered from 1 — the SHOWN tail of the list. */
  items: { n: number; label: string }[];
  /** How many asks the list below does NOT show. Cap presentation, never data. */
  more: number;
}

/** Law 4: cap the VISIBLE list at five; the rest is counted, never dropped. */
export const NEXT_VISIBLE = 5;

const DASH = ' — ';

/** The ask that leads: a HOT one if any, otherwise the one that has waited longest. */
function leadAsk(asks: readonly NextAsk[]): NextAsk | null {
  if (!asks.length) return null;
  const hottest = asks.filter((a) => a.hot).sort((a, b) => b.ageSec - a.ageSec)[0];
  if (hottest) return hottest;
  return asks.slice().sort((a, b) => b.ageSec - a.ageSec)[0];
}

/**
 * Priority is by what UNBLOCKS the most: a person waiting on you, then a fleet that is
 * down, then critical cards, then the house's own schedule, and only then nothing.
 *
 * Every branch leads with the verb, so the line reads as an instruction rather than a
 * status ("answer d-ts7e — Election Day is Tuesday", "10 down — run /doctor: ...").
 */
export function computeNextAction(i: NextInput): NextPlan {
  const asks = Array.isArray(i.asks) ? i.asks : [];
  const askCount = Math.max(asks.length, Math.max(0, Number(i.askCount) || 0));
  const items = asks.slice(0, NEXT_VISIBLE)
    .map((a, n) => ({ n: n + 1, label: `${a.id} ${a.title}`.trim() }));
  const more = Math.max(0, askCount - items.length);

  const lead = leadAsk(asks);
  if (lead) {
    return { line: `answer ${lead.id}${DASH}${lead.title}`.trimEnd(), verb: 'answer', items, more };
  }

  const down = (Array.isArray(i.down) ? i.down : []).filter(Boolean);
  if (down.length) {
    // Never a bare failure: the remedy rides the same line, named for the first three.
    return { line: `${down.length} down${DASH}run /doctor: ${down.slice(0, 3).join(', ')}`, verb: 'run', items, more };
  }

  if (i.critical && i.critical.total > 0) {
    return { line: `/actions — ${i.critical.total} critical`, verb: 'run', items, more };
  }

  // Asks older than the 24h window are not headlined by `rankBeam`, but they are
  // still people waiting and they still have a list to open. Saying "nothing
  // waiting" while the strip beside it says `130 waiting` is the contradiction the
  // owner screenshotted. They rank BELOW a broken fleet (a down service is a
  // concrete repair) but above the house's schedule.
  if (askCount > 0) {
    return { line: `${askCount} waiting${DASH}/decide`, verb: 'run', items, more };
  }

  const next = String(i.postureNext || '').trim();
  if (next) return { line: `${next} — /posture`, verb: 'review', items, more };

  return { line: 'nothing waiting — describe the task', verb: 'none', items, more };
}
