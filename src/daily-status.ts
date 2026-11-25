/**
 * `awsh status` -- the three things the owner acts on, in one screen:
 *   1. fleet health counted from the container runtime (fleet-health.ts),
 *   2. the Atlas board (MCP `atlas_board` on the local gateway 127.0.0.1:8182),
 *   3. decision cards waiting on him (harness daemon /decisions), answerable inline.
 *
 * Each source degrades to ONE line naming its remedy; none can blank the others.
 * The old `/status` read Genesis only, which is unreachable from the awnix distro
 * (Genesis publishes no host port), so it printed nothing actionable there.
 */

import type { AtlasBoard } from './atlas-board.js';
import { formatAtlasBoard } from './atlas-board.js';
import type { FleetHealth } from './fleet-health.js';
import { fleetProblems, formatFleet } from './fleet-health.js';

export interface CardOption { key: string; label?: string; recommended?: boolean }
export interface WaitingCard {
  id: string;
  title?: string;
  urgency?: string;
  options?: CardOption[];
  default_key?: string;
  created_at?: number;
  source?: { agent?: string };
}

export interface DailyStatus {
  fleet: FleetHealth | null;
  board: AtlasBoard;
  cards: WaitingCard[] | null;
  cardsError?: string;
}

export interface DailyDeps {
  measureFleet: () => FleetHealth | null;
  fetchBoard: () => Promise<AtlasBoard>;
  fetchCards: () => Promise<WaitingCard[]>;
}

export async function gatherDaily(deps: DailyDeps): Promise<DailyStatus> {
  const [fleet, board, cards] = await Promise.all([
    Promise.resolve().then(deps.measureFleet).catch(() => null),
    deps.fetchBoard().catch((e: any) => ({ error: e?.message || 'board failed' } as AtlasBoard)),
    deps.fetchCards().then((c) => ({ c })).catch((e: any) => ({ e: String(e?.message || e) })),
  ]);
  return {
    fleet,
    board,
    cards: 'c' in cards ? cards.c : null,
    cardsError: 'e' in cards ? cards.e : undefined,
  };
}

const URGENCY_RANK: Record<string, number> = { critical: 0, high: 1, normal: 2 };

/** Pure: cards most-urgent first, then oldest first -- the order they are numbered in. */
export function orderCards(cards: WaitingCard[]): WaitingCard[] {
  return [...cards].sort((x, y) =>
    (URGENCY_RANK[x.urgency || 'normal'] ?? 2) - (URGENCY_RANK[y.urgency || 'normal'] ?? 2)
    || (x.created_at || 0) - (y.created_at || 0));
}

function optionKeys(c: WaitingCard): string {
  const opts = c.options || [];
  if (!opts.length) return '';
  return opts.map((o) => (o.recommended || o.key === c.default_key ? `${o.key}*` : o.key)).join('/');
}

/** Pure: the numbered card lines (max five shown, then `+N more`). */
export function formatCards(cards: WaitingCard[] | null, error?: string, max = 5): string[] {
  if (cards === null) return [`Cards:    unavailable (${error || 'harness daemon'}) -- start it: adk harness serve`];
  if (!cards.length) return ['Cards:    nothing waiting on you'];
  const ordered = orderCards(cards);
  const lines = [`Cards:    ${cards.length} waiting -- answer: /cards answer <n> <option>`];
  ordered.slice(0, max).forEach((c, i) => {
    const urgent = c.urgency && c.urgency !== 'normal' ? ` [${c.urgency}]` : '';
    const keys = optionKeys(c);
    const who = c.source?.agent ? ` (${c.source.agent})` : '';
    lines.push(`  ${i + 1}. ${(c.title || 'untitled').slice(0, 70)}${urgent}${who}${keys ? `  [${keys}]` : ''}`);
  });
  if (ordered.length > max) lines.push(`  +${ordered.length - max} more -- /cards`);
  return lines;
}

/** Pure: the whole screen. */
export function formatDaily(s: DailyStatus): string[] {
  const lines: string[] = [];
  if (s.fleet) {
    lines.push(`Fleet:    ${formatFleet(s.fleet)}  (${s.fleet.runtime}, ${s.fleet.total} containers)`);
    for (const p of fleetProblems(s.fleet)) lines.push(`  ${p}`);
  } else {
    lines.push('Fleet:    no container runtime answered here -- the fleet is podman in awnix: wsl -d awnix -u root awsh status');
  }
  lines.push(...formatAtlasBoard(s.board));
  lines.push(...formatCards(s.cards, s.cardsError));
  return lines;
}

export interface CardAnswer { id: string; key: string; note: string }

/**
 * Pure: `<n|id-prefix> <option> [note...]` -> the card + option to answer, or an error
 * string. `n` is the number `formatCards` printed; the option must be one the card
 * offers (case-insensitive) -- an unknown key is refused, never sent.
 */
export function parseCardAnswer(input: string, cards: WaitingCard[]): CardAnswer | string {
  const [sel = '', key = '', ...note] = input.trim().split(/\s+/);
  if (!sel || !key) return 'usage: /cards answer <n> <option> [note]';
  const ordered = orderCards(cards);
  let card: WaitingCard | undefined;
  if (/^\d+$/.test(sel)) card = ordered[Number(sel) - 1];
  else {
    const hits = ordered.filter((c) => c.id.startsWith(sel));
    if (hits.length > 1) return `"${sel}" matches ${hits.length} cards; use more of the id`;
    card = hits[0];
  }
  if (!card) return `no waiting card ${sel}`;
  const opts = card.options || [];
  const opt = opts.find((o) => o.key.toLowerCase() === key.toLowerCase());
  if (opts.length && !opt) return `card ${sel} has no option "${key}" (options: ${opts.map((o) => o.key).join(', ')})`;
  return { id: card.id, key: opt ? opt.key : key, note: note.join(' ') };
}
