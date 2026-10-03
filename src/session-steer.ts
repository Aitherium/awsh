/**
 * Steer the session focused in the cockpit (slice 2 of the sessions cockpit).
 *
 * The focus viewer's input line lands here. It rides the SAME path as the CLI verb
 * `aither harness tell`: a human steering event published to the daemon's room
 * (POST /events, harness-client.tellEvent), then the daemon's `steering_receipt`
 * says what actually happened. One path means the cockpit and the CLI can never
 * disagree about where a line went.
 *
 * What the operator is told BEFORE anything is sent is decided from the row's
 * `actions` (GET /sessions/unified, adk/harnesses/session_verbs.py row_actions): the
 * daemon decides each verb ONCE, next to the rows, with a `why_not` reason for every
 * verb it refuses. The steering event is delivered by the daemon's dispatcher on the
 * pty tier (`input`) or the steering mailbox (`message`), so:
 *   - input true     the line lands now (a daemon-owned pty).
 *   - message true   queued; the session's prompt hook drains it at its next turn.
 *   - neither        refused locally with the daemon's own why_not -- nothing is
 *                    published, because a line queued for a process that will never
 *                    read it is a lie.
 * A row without `actions` (an older daemon, or rows read from disk because the daemon
 * is down) falls back to the legacy `steer_capability` tier.
 */

import { api as daemonApi, tellEvent } from './harness-client.js';
import type { UnifiedSession } from './sessions-client.js';

export type SteerApi = <T>(path: string, init?: RequestInit) => Promise<T>;

export interface SteerPlan {
  allowed: boolean;
  /** When the line should land, per the row's capability tier. */
  when: 'now' | 'turn-boundary' | null;
  /** One line for the operator, shown before (refusal) or with (accept) the send. */
  note: string;
}

/** The daemon's per-row verb decision (session_verbs.row_actions). */
export interface RowActions {
  message?: boolean;
  interrupt?: boolean;
  focus?: boolean;
  input?: boolean;
  why_not?: Record<string, string>;
}

export type SteerRow = Pick<UnifiedSession, 'steer_capability' | 'status'> & { actions?: RowActions | null };

/** Pure: what a steer on this row will do, decided from the daemon's row.actions. */
export function steerPlan(session: SteerRow): SteerPlan {
  const actions = session.actions;
  if (actions && typeof actions === 'object') {
    if (actions.input === true) return { allowed: true, when: 'now', note: 'lands now (daemon-owned pty)' };
    if (actions.message === true) {
      return { allowed: true, when: 'turn-boundary', note: 'queued; delivered at its next prompt' };
    }
    const why = actions.why_not || {};
    return { allowed: false, when: null, note: why.message || why.input || 'the daemon offers no way to message this session' };
  }
  // Legacy: a row without actions (older daemon, or read from disk).
  if (session.status === 'exited' || session.status === 'dead') {
    return { allowed: false, when: null, note: 'session has exited - nothing is reading its input' };
  }
  switch (session.steer_capability) {
    case 'full':
      return { allowed: true, when: 'now', note: 'lands now (daemon-owned pty)' };
    case 'turn-boundary':
      return { allowed: true, when: 'turn-boundary', note: 'delivered at the end of the current turn' };
    default:
      return {
        allowed: false, when: null,
        note: 'view only (cap = none) - start the daemon to steer:  adk harness serve',
      };
  }
}

export interface SteerResult {
  ok: boolean;
  message: string;
}

export interface SteerOptions {
  api?: SteerApi;
  /** How long to wait for the daemon's receipt. */
  receiptTimeoutMs?: number;
  pollMs?: number;
}

/**
 * Send `text` to the focused session. Never throws: the caller is an input line in a
 * TUI overlay, and a stack trace there is worse than a one-line reason.
 */
export async function steerFocusedSession(
  session: Pick<UnifiedSession, 'id' | 'title'> & SteerRow,
  text: string,
  opts: SteerOptions = {},
): Promise<SteerResult> {
  const line = (text || '').trim();
  if (!line) return { ok: false, message: 'nothing to send' };
  const plan = steerPlan(session);
  if (!plan.allowed) return { ok: false, message: `not sent: ${plan.note}` };
  const call: SteerApi = opts.api ?? daemonApi;
  const name = session.title || session.id.slice(0, 12);
  try {
    const published = await call<{ seq?: number }>('/events', {
      method: 'POST',
      body: JSON.stringify(tellEvent(session.id, line)),
    });
    // The receipt is matched by seq ORDER: only a receipt stamped after our event can be
    // ours. Without a numeric seq in the reply there is no floor, and an OLDER receipt for
    // the same target would be reported as this send's -- so claim no receipt at all.
    const floor = typeof published?.seq === 'number' && Number.isFinite(published.seq) ? published.seq : null;
    if (floor === null) {
      return { ok: true, message: `published to ${name} (${plan.note}); receipt not correlatable (daemon reply had no seq)` };
    }
    const deadline = Date.now() + (opts.receiptTimeoutMs ?? 8000);
    const pollMs = opts.pollMs ?? 400;
    for (;;) {
      const ev = await call<{ events?: any[] }>('/rooms/main/events?limit=40');
      const receipt = (ev.events || []).find((e) => e?.type === 'steering_receipt'
        && e.payload?.target === session.id && typeof e.seq === 'number' && e.seq > floor);
      if (receipt) {
        const p = receipt.payload || {};
        if (p.channel === 'none') return { ok: false, message: `not delivered to ${name}: ${p.detail || 'no channel'}` };
        return { ok: true, message: `told ${name} - ${p.channel}${p.landed_now ? ' (landed now)' : ''}: ${p.detail || ''}`.trim() };
      }
      if (Date.now() >= deadline) break;
      await new Promise((r) => setTimeout(r, pollMs));
    }
    return { ok: true, message: `published to ${name} (${plan.note}); no receipt yet` };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return { ok: false, message: `steer failed: ${msg}` };
  }
}
