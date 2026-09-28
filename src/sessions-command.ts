/**
 * `aither sessions live` — the unified sessions cockpit as a top-level command.
 *
 * Before this, `aither sessions` went ONLY to the Python adk-shell (the Claude session
 * resume browser), and the cockpit over GET /sessions/unified was reachable solely by
 * Ctrl+S inside the TUI REPL. The Python verbs (browse, search, resume, restore, guard,
 * ingest and their flags) keep their route; `live`, `cockpit`, `--live` and `--watch`
 * render the cockpit here, from the daemon or -- when it is down -- from Claude's own
 * files, exactly like the overlay (same buildSessionsPanel, same fallback).
 */

import { fetchSessionsWithFallback, type SessionsSnapshot } from './sessions-client.js';
import { buildSessionsPanel } from './tui/sessions-view.js';

const COCKPIT_WORDS = new Set(['live', 'cockpit', '--live', '--watch', '-w']);

/**
 * Pure: does `aither sessions <args>` mean the cockpit (true) or the Python shell?
 * Only the FIRST argument decides: `sessions ingest --watch` (the D-42 auto-sync verb)
 * and `sessions search live` belong to the Python verbs and must never be captured.
 */
export function wantsSessionsCockpit(args: string[]): boolean {
  const first = args[0];
  return typeof first === 'string' && COCKPIT_WORDS.has(first.toLowerCase());
}

export interface SessionsCockpitDeps {
  snapshot?: () => Promise<SessionsSnapshot>;
  write?: (text: string) => void;
  width?: number;
  /** Test seam: stop a --watch loop after N frames. */
  maxFrames?: number;
  intervalMs?: number;
}

/** Render the cockpit once, or every 2 s with --watch/live until Ctrl+C. */
export async function runSessionsCockpit(args: string[], deps: SessionsCockpitDeps = {}): Promise<number> {
  const snapshot = deps.snapshot ?? (() => fetchSessionsWithFallback());
  const write = deps.write ?? ((t: string) => { process.stdout.write(t); });
  const watch = args.some((a) => ['live', '--live', '--watch', '-w'].includes(a.toLowerCase()));
  const frame = async (): Promise<SessionsSnapshot> => {
    const snap = await snapshot();
    const width = deps.width ?? (process.stdout.columns || 120);
    const lines = buildSessionsPanel(snap.sessions, width, { source: snap.source, daemonError: snap.daemonError })
      .map((l) => l.replace('Sessions (Ctrl+S)', 'Sessions'));
    while (lines.length && lines[lines.length - 1] === '') lines.pop();
    write(lines.join('\n') + '\n');
    return snap;
  };
  if (!watch) {
    await frame();
    return 0;
  }
  const max = deps.maxFrames ?? Infinity;
  for (let n = 0; n < max; n++) {
    write('\x1b[2J\x1b[H');
    await frame();
    if (n + 1 < max) await new Promise((r) => setTimeout(r, deps.intervalMs ?? 2000));
  }
  return 0;
}
