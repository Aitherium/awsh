/**
 * fleet-verbs.ts -- the owner's fleet verbs from the `aither` CLI.
 *
 *   /gpu sleep | wake | status          (aliases /gaming, /game; `aither -c "gpu sleep"`)
 *   /fleet sleep | wake | critical | status
 *
 * Owner, 2026-09-27: "all the app surfaces like awdesk and awsh/awdk need to be updated to
 * work with awnix, like GPU sleep and fleet sleep". Before this file `/gaming` stopped Docker
 * Desktop (Switch-GamingMode.ps1) and never reached the podman fleet on awnix. Now every verb
 * runs AitherOS/dev/tools/fleet_verbs.py -- the ONE implementation awdesk's Fleet window,
 * `adk gpu|fleet`, awnode's MCP tools and AitherZero run -- so a verb means one thing on every
 * surface. That tool sequences the in-distro engine, awmodels postures, the MicroScheduler
 * gaming lanes and the gaming lock; it refuses gpu wake when awnix reports "GPU access
 * blocked" and refuses every verb while a WSL maintenance restart holds its lock.
 *
 * A typed slash command is the consent: verbs run with --execute unless --dry-run.
 * awsh ships standalone, so the tool is found on disk (AITHEROS_ROOT, the repo this file sits
 * in, or the default checkout), never imported.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

type Env = Record<string, string | undefined>;

export const FLEET_VERBS_REL = join('AitherOS', 'dev', 'tools', 'fleet_verbs.py');

/** Slash words -> verb. The old /gaming words keep their meaning: off/stop/pause = services
 *  OFF (gpu sleep), on/start/resume = services ON (gpu wake). */
export const GPU_WORDS: Readonly<Record<string, 'sleep' | 'wake' | 'status'>> = Object.freeze({
  sleep: 'sleep', off: 'sleep', stop: 'sleep', pause: 'sleep', light: 'sleep', lite: 'sleep',
  down: 'sleep', quiet: 'sleep', free: 'sleep',
  wake: 'wake', on: 'wake', start: 'wake', resume: 'wake', up: 'wake', back: 'wake',
  status: 'status',
});
export const FLEET_WORDS: Readonly<Record<string, 'sleep' | 'wake' | 'critical' | 'status'>> =
  Object.freeze({ sleep: 'sleep', down: 'sleep', wake: 'wake', up: 'wake', critical: 'critical', status: 'status' });

export class FleetVerbError extends Error {}

/**
 * `/gpu <args>` or `/fleet <args>` -> fleet_verbs.py argv after the script path.
 * `/gpu` alone is gpu sleep (the old `/gaming` meaning: game on); `/fleet` alone is status.
 * Returns null for `/fleet refresh` (the image rebuild, not a verb).
 */
export function fleetVerbArgs(noun: 'gpu' | 'fleet', args: string): string[] | null {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const words = parts.filter((p) => !p.startsWith('--')).map((p) => p.toLowerCase());
  const flags = new Set(parts.filter((p) => p.startsWith('--')));
  if (noun === 'fleet' && words[0] === 'refresh') return null;
  const table: Record<string, string> = noun === 'gpu' ? GPU_WORDS : FLEET_WORDS;
  const word = words[0] ?? (noun === 'gpu' ? 'sleep' : 'status');
  const verb = table[word];
  if (!verb) {
    throw new FleetVerbError(`/${noun} ${word}: one of ${[...new Set(Object.values(table))].join(', ')}`);
  }
  const out = [...(verb === 'status' ? ['status'] : [noun, verb])];
  if (verb !== 'status' && !flags.has('--dry-run')) out.push('--execute');
  if (noun === 'gpu' && verb === 'wake' && flags.has('--force')) out.push('--force');
  if (flags.has('--json')) out.push('--json');
  return out;
}

/** Where fleet_verbs.py lives: AITHEROS_ROOT, the repo this CLI sits in, the default checkout. */
export function findFleetVerbsTool(env: Env = process.env, repoRoot = '', exists = existsSync): string | null {
  const roots = [String(env.AITHEROS_ROOT ?? '').trim(), repoRoot, 'C:\\AitherOS-Fresh'].filter(Boolean);
  for (const r of roots) {
    const p = join(r, FLEET_VERBS_REL);
    if (exists(p)) return p;
  }
  return null;
}

/** The exact process: python <fleet_verbs.py> <args>. */
export function fleetVerbCommand(tool: string, args: string[], env: Env = process.env,
  platform: string = process.platform): { file: string; args: string[] } {
  const py = String(env.AITHER_PYTHON ?? '').trim() || (platform === 'win32' ? 'python' : 'python3');
  return { file: py, args: [tool, ...args] };
}

export const FLEET_VERBS_HELP = [
  '  /gpu sleep            gaming lock, posture gaming (lanes to the Spark), park every 5090 GPU unit',
  '  /gpu wake             GPU units back one at a time, posture + lanes home, lock released',
  '                        (refused while awnix reports GPU access blocked, or a game runs: --force)',
  '  /gpu status           distro, systemd, containers, GPU access, posture, gaming lock, record',
  '  /fleet sleep          stop + mask the whole fleet, recorded (customer-facing set stays up)',
  '  /fleet wake           restore the record, health-gated; GPU only if the GPU is awake',
  '  /fleet critical       only the critical profile + gpu sleep',
  '  /fleet status         same as /gpu status',
  '  --dry-run             print the steps, run nothing',
  '  aliases: /gaming = /gpu (off/stop/pause = sleep, on/start/resume = wake)',
].join('\n');
