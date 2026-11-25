/**
 * Claude Code hooks, seen from the awsh agent REPL.
 *
 * Measured 2026-11-09 on a harness `claude` session: hooks DO run (ten SessionStart
 * hooks, every one `hook_started` then `hook_response` outcome=success), but the
 * harness forwards them as `notice` events with text `system/hook_*`, and the REPL
 * printed nothing -- so a Stop hook that BLOCKED a turn, or a PreToolUse hook that
 * refused a tool, was invisible. Here a failure prints the moment it arrives (name,
 * exit code, first line of what it said); successes fold into one dim line per turn;
 * `/hooks` shows everything the session has run.
 */

export interface HookOutcome {
  /** SessionStart, PreToolUse, Stop, ... */
  event: string;
  /** e.g. `SessionStart:startup`, `PreToolUse:Bash` */
  name: string;
  ok: boolean;
  exitCode: number;
  outcome: string;
  /** First non-empty line of stderr, else stdout/output, capped. '' on success. */
  detail: string;
}

/** Pure: the hook outcome carried by a harness event, or null when it is not one. */
export function hookOutcome(ev: any): HookOutcome | null {
  if (ev?.kind !== 'notice') return null;
  const p = ev?.data?.payload;
  if (!p || p.subtype !== 'hook_response') return null;
  const exitCode = Number.parseInt(String(p.exit_code ?? '0'), 10);
  const outcome = String(p.outcome || '');
  const ok = outcome === 'success' && (Number.isNaN(exitCode) || exitCode === 0);
  const said = [p.stderr, p.stdout, p.output]
    .map((s) => String(s || '').split(/\r?\n/).find((l) => l.trim()) || '')
    .find(Boolean) || '';
  return {
    event: String(p.hook_event || String(p.hook_name || '').split(':')[0] || 'hook'),
    name: String(p.hook_name || p.hook_event || 'hook'),
    ok,
    exitCode: Number.isNaN(exitCode) ? -1 : exitCode,
    outcome: outcome || 'unknown',
    detail: ok ? '' : said.trim().slice(0, 200),
  };
}

/** Pure: the loud line for a failed or blocking hook. Exit 2 is Claude Code's "block". */
export function formatHookFailure(o: HookOutcome): string {
  const verb = o.exitCode === 2 ? 'blocked (exit 2)'
    : o.outcome === 'success' ? `exit ${o.exitCode}`
      : `${o.outcome} (exit ${o.exitCode})`;
  return `! hook ${o.name} ${verb}${o.detail ? `: ${o.detail}` : ''}`;
}

/** Counts per hook event, in first-seen order. */
export class HookTally {
  private counts = new Map<string, { ok: number; failed: number }>();
  readonly failures: HookOutcome[] = [];

  add(o: HookOutcome): void {
    const c = this.counts.get(o.event) || { ok: 0, failed: 0 };
    if (o.ok) c.ok++; else { c.failed++; this.failures.push(o); }
    this.counts.set(o.event, c);
  }

  get size(): number {
    let n = 0;
    for (const c of this.counts.values()) n += c.ok + c.failed;
    return n;
  }

  /** `hooks: SessionStart 10 ok · Stop 1 ok, 1 failed` ('' when nothing ran). */
  summary(): string {
    if (!this.counts.size) return '';
    const parts = [...this.counts.entries()].map(([event, c]) =>
      `${event} ${c.ok} ok${c.failed ? `, ${c.failed} failed` : ''}`);
    return `hooks: ${parts.join(' · ')}`;
  }
}
