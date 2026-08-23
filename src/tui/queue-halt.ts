/**
 * Queue-halt classification for the chat drain loop.
 *
 * A multi-line paste into the TUI submits one message per line: the first starts a
 * turn, the rest queue. If the backend is down or the session is signed out, the
 * drain loop used to replay EVERY queued line into the dead endpoint — the "endless
 * red waterfall" (30 lines → 30 identical failures). runChatDraining now halts the
 * whole queue on the first hard failure and shows one line with the right next step.
 *
 * These helpers are pure and exported so that behaviour is testable without standing
 * up the blessed TUI — the drain loop imports them, and so does queue-halt.test.ts.
 */

/** True when the failure reason means "not signed in", so the halt message should
 *  point the user at /login rather than at waiting for the backend. */
export function haltNeedsLogin(reason: string): boolean {
  return /sign[- ]?in|log[- ]?in|authenticat|unauthor|401|403/i.test(reason);
}

/** The single line shown when a hard failure halts the remaining queued messages. */
export function haltMessage(remaining: number, reason: string): string {
  const next = haltNeedsLogin(reason)
    ? 'not signed in — run /login, then re-send.'
    : 'backend unreachable — re-send when it returns.';
  return `⏹ Halted ${remaining} more queued message(s): ${next}`;
}
