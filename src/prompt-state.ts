/**
 * prompt-state.ts — what the PROMPT itself remembers, so the reader never has to.
 *
 * Adapted from the i-have-adhd doctrine (MIT, Copyright (c) 2026 Ayoub Ghriss; fork
 * wizzense/i-have-adhd), law 3 "restate state every turn": the prompt is the one line
 * the eye returns to before typing, so it is the cheapest place to say what is pending.
 *
 * Both REPLs read it — `repl.ts` folds `promptLabel()` into `awsh[...] > `, and the TUI's
 * idle status strip does the same — from ONE module, so the two surfaces cannot disagree
 * about how much is waiting (measured 2026-11-01: the TUI said `130 waiting` on one row
 * and `⚡ 3 asking — /decide` on another, both true and neither actionable).
 *
 * Deliberately tiny state with no IO: the caller that already has the facts (the status
 * refresh) pushes them here; nothing here fetches.
 */

export interface PromptFacts {
  /** Asks still waiting on the owner (`rankBeam().open`). */
  asks?: number;
  /** Services that did not answer. */
  down?: number;
  /** Services probed at all. */
  total?: number;
}

let facts: PromptFacts = {};

/** Replace the prompt facts. Absent keys clear — never inherit a stale count. */
export function setPromptFacts(f: PromptFacts): void {
  facts = { ...(f || {}) };
}

/** The facts currently being restated (read-only escape hatch for callers that render them). */
export function promptFacts(): Readonly<PromptFacts> {
  return facts;
}

const count = (v: unknown): number => {
  const n = Number(v);
  return Number.isFinite(n) && n > 0 ? Math.floor(n) : 0;
};

/**
 * The suffix the prompt shows: `3?` while three asks wait, `10/11` while ten of eleven
 * services are down, `''` when there is nothing to carry.
 *
 * A person waiting on you outranks a fleet that is down: an ask is the only one of the
 * two that someone else is blocked by.
 */
export function promptLabel(): string {
  const asks = count(facts.asks);
  if (asks > 0) return `${asks}?`;
  const down = count(facts.down);
  const total = count(facts.total);
  if (down > 0 && total > 0) return `${down}/${total}`;
  return '';
}
