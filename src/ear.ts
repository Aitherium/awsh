/**
 * The ear, and the rule about the mouth.
 *
 * awsh could speak (`/voice`) and could not hear. The capture itself lives in `awvoice`
 * (Python, PortAudio) rather than here on purpose — the same posture as `tui/voice.ts`,
 * which shells out to an OS player rather than taking an audio npm dependency. This module
 * is the thin shell-out plus the two decisions that are genuinely awsh's to make:
 *
 *  1. WHO SPEAKS. The owner's ruling is "awdesk only, always": when the desk is up it owns
 *     the mouth, because two surfaces reading the same answer aloud is not twice as useful,
 *     it is an echo. awsh speaks only when the desk is not there to.
 *  2. WHERE THE WORDS GO. A transcript is steered at ONE session, and `awvoice` publishes
 *     it as a `human` actor — the only actor a running session accepts into its keyboard.
 *
 * Everything below the spawn is pure and unit-tested; the spawn itself is injectable.
 */
import { spawnSync } from 'node:child_process';

/** Seconds of audio per push — long enough for a sentence, short enough to feel immediate. */
export const DEFAULT_SECONDS = 6;

export interface ListenResult {
  ok: boolean;
  heard: string;
  steered?: string;
  seq?: number;
  error?: string;
}

/**
 * Should awsh speak this answer itself?
 *
 * `deskUp` is the awdesk bridge answering on :47931. The desk has a body, a voice and
 * lip-sync; awsh has a terminal. When both are present the desk wins, and awsh staying
 * quiet is the feature, not a degradation. `/voice` remains the manual override for someone
 * who wants the terminal to read along anyway.
 */
export function ownsMouth(deskUp: boolean, manualOverride = false): boolean {
  return manualOverride || !deskUp;
}

/** argv for `awvoice listen`. Pure so the flags cannot drift from the docs silently. */
export function listenArgs(opts: { seconds?: number; steer?: string; surface?: string } = {}): string[] {
  const args = ['listen', '--json'];
  args.push('--seconds', String(opts.seconds ?? DEFAULT_SECONDS));
  args.push('--surface', opts.surface || 'awsh');
  if (opts.steer) args.push('--steer', opts.steer);
  return args;
}

/**
 * Read `awvoice listen --json` output.
 *
 * A non-zero exit with a message on stderr is the INTERESTING case and the one that used to
 * read as "nothing was said": the microphone being held by the desk, or PortAudio missing,
 * both produce an empty transcript otherwise. They are surfaced as errors, while a genuinely
 * silent room returns ok with an empty string — "I heard nothing" is a true answer.
 */
export function parseListen(stdout: string, stderr: string, code: number): ListenResult {
  if (code !== 0) {
    const msg = (stderr || stdout || '').trim().split('\n').pop() || `awvoice exited ${code}`;
    return { ok: false, heard: '', error: msg.replace(/^awvoice:\s*/, '') };
  }
  try {
    const j = JSON.parse((stdout || '').trim().split('\n').pop() || '{}');
    return {
      ok: true,
      heard: String(j.heard || ''),
      steered: j.steered || undefined,
      seq: typeof j.seq === 'number' && j.seq > 0 ? j.seq : undefined,
    };
  } catch {
    return { ok: false, heard: '', error: 'awvoice did not return JSON' };
  }
}

export type Spawner = (cmd: string, args: string[]) => { stdout: string; stderr: string; status: number | null };

const realSpawn: Spawner = (cmd, args) => {
  const r = spawnSync(cmd, args, { encoding: 'utf8', timeout: 180_000 });
  return { stdout: r.stdout || '', stderr: r.stderr || '', status: r.status };
};

/**
 * Record once and return what was heard.
 *
 * Tries the console script first and falls back to `python -m awvoice.cli`, because an
 * application-control policy can block a pip-generated .exe while the module runs fine —
 * measured on this host for the sibling bricks, and the reason every aw* CLI carries a
 * `__main__`. A missing awvoice is reported as itself, never as silence.
 */
export function listenOnce(
  opts: { seconds?: number; steer?: string; surface?: string } = {},
  spawner: Spawner = realSpawn,
): ListenResult {
  const args = listenArgs(opts);
  let r = spawner('awvoice', args);
  const shimMissing = r.status === null || /ENOENT|not recognized|cannot find/i.test(r.stderr || '');
  if (shimMissing) r = spawner('python', ['-m', 'awvoice.cli', ...args]);
  if (r.status === null) {
    return { ok: false, heard: '', error: 'awvoice is not installed (pip install "awvoice[mic]")' };
  }
  return parseListen(r.stdout, r.stderr, r.status);
}
