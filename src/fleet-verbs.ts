/**
 * fleet-verbs.ts -- the owner's fleet verbs from the `aither` CLI.
 *
 *   /inference on | dgx | off | status  (the inference toggle; status is PROVEN per lane)
 *   /gpu sleep | wake | status          (aliases /gaming, /game; `aither -c "gpu sleep"`)
 *   /fleet sleep | wake | critical | profile <tier> | down | status
 *
 * Owner, 2026-09-27: "all the app surfaces like awdesk and awsh/awdk need to be updated to
 * work with awnix, like GPU sleep and fleet sleep". Before this file `/gaming` stopped Docker
 * Desktop (Switch-GamingMode.ps1) and never reached the podman fleet on awnix. Now every verb
 * runs AitherOS/dev/tools/fleet_verbs.py -- the ONE implementation awdesk's Fleet window,
 * `adk gpu|fleet|inference`, awnode's MCP tools and AitherZero run -- so a verb means one
 * thing on every surface. That tool sequences the in-distro engine, awmodels postures, the
 * MicroScheduler gaming lanes and the gaming lock, and proves an inference mode with one
 * tiny completion per lane through MicroScheduler (served_by checked).
 *
 * 2026-10-15: `/fleet down` is fleet_verbs `game down` (business profile + inference dgx on a
 * host with a paying tenant); the VM-off sleep is only `/fleet sleep`, by name. gpu sleep /
 * gpu wake ARE inference dgx / on.
 *
 * A typed slash command is the consent: verbs run with --execute unless --dry-run.
 * awsh ships standalone, so the tool is found on disk (AITHEROS_ROOT, the repo this file sits
 * in, or the default checkout), never imported.
 */
import { existsSync } from 'node:fs';
import { join } from 'node:path';

type Env = Record<string, string | undefined>;
export type FleetNoun = 'gpu' | 'fleet' | 'inference';

export const FLEET_VERBS_REL = join('AitherOS', 'dev', 'tools', 'fleet_verbs.py');

/** Slash words -> verb. The old /gaming words keep their meaning: off/stop/pause = services
 *  OFF (gpu sleep), on/start/resume = services ON (gpu wake). */
export const GPU_WORDS: Readonly<Record<string, 'sleep' | 'wake' | 'status'>> = Object.freeze({
  sleep: 'sleep', off: 'sleep', stop: 'sleep', pause: 'sleep', light: 'sleep', lite: 'sleep',
  down: 'sleep', quiet: 'sleep', free: 'sleep',
  wake: 'wake', on: 'wake', start: 'wake', resume: 'wake', up: 'wake', back: 'wake',
  status: 'status',
});
export const FLEET_WORDS: Readonly<Record<string, 'sleep' | 'wake' | 'critical' | 'profile' | 'down' | 'status'>> =
  Object.freeze({
    sleep: 'sleep', wake: 'wake', up: 'wake', critical: 'critical', profile: 'profile',
    down: 'down', status: 'status',
  });
/** `/inference <word>` -> mode. `dgx`/`spark`/`game` all mean the desktop GPU serves nothing. */
export const INFERENCE_WORDS: Readonly<Record<string, 'on' | 'dgx' | 'off' | 'status'>> = Object.freeze({
  on: 'on', up: 'on', home: 'on', local: 'on', full: 'on',
  dgx: 'dgx', spark: 'dgx', 'dgx-only': 'dgx', game: 'dgx', gaming: 'dgx',
  off: 'off', none: 'off', stop: 'off',
  status: 'status', check: 'status',
});
export const PROFILE_TIERS = Object.freeze(['business', 'platform', 'critical', 'full'] as const);

export class FleetVerbError extends Error {}

/**
 * `/gpu <args>`, `/fleet <args>` or `/inference <args>` -> fleet_verbs.py argv after the
 * script path. `/gpu` alone is gpu sleep (the old `/gaming` meaning: game on); `/fleet` and
 * `/inference` alone are status. Returns null for `/fleet refresh` (the image rebuild).
 */
export function fleetVerbArgs(noun: FleetNoun, args: string): string[] | null {
  const parts = args.trim().split(/\s+/).filter(Boolean);
  const words = parts.filter((p) => !p.startsWith('--')).map((p) => p.toLowerCase());
  const flags = new Set(parts.filter((p) => p.startsWith('--')));
  if (noun === 'fleet' && words[0] === 'refresh') return null;
  const table: Record<string, string> = noun === 'gpu' ? GPU_WORDS
    : noun === 'inference' ? INFERENCE_WORDS : FLEET_WORDS;
  const word = words[0] ?? (noun === 'gpu' ? 'sleep' : 'status');
  const verb = table[word];
  if (!verb) {
    throw new FleetVerbError(`/${noun} ${word}: one of ${[...new Set(Object.values(table))].join(', ')}`);
  }
  let out: string[];
  if (noun === 'inference') {
    out = ['inference', verb];
  } else if (noun === 'fleet' && verb === 'profile') {
    const tier = words[1] ?? '';
    if (!(PROFILE_TIERS as readonly string[]).includes(tier)) {
      throw new FleetVerbError(`/fleet profile ${tier || '?'}: one of ${PROFILE_TIERS.join(', ')}`);
    }
    out = ['fleet', 'profile', tier];
  } else if (noun === 'fleet' && verb === 'down') {
    out = ['game', 'down'];
  } else {
    out = verb === 'status' ? ['status'] : [noun, verb];
  }
  if (verb !== 'status' && !flags.has('--dry-run')) out.push('--execute');
  if (noun === 'gpu' && verb === 'wake' && flags.has('--force')) out.push('--force');
  if (noun === 'inference' && verb === 'off' && flags.has('--spark')) out.push('--spark');
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
  '  /inference on         desktop GPU lanes home (previous posture), proven per lane',
  '  /inference dgx        desktop GPU serves nothing; lanes on the DGX, proven per lane',
  '  /inference off        every LLM lane refuses at once (--spark: also stop the DGX pool)',
  '  /inference status     one tiny completion per lane: mode on|dgx|off|DEGRADED + drift',
  '  /gpu sleep            = /inference dgx (gaming lock, posture gaming, park every GPU unit)',
  '  /gpu wake             = /inference on (refused while GPU access is blocked or a game runs: --force)',
  '  /gpu status           distro, systemd, containers, GPU access, posture, gaming lock, record',
  '  /fleet profile <tier> business | platform | critical | full (core services never stop)',
  '  /fleet down           business profile + /inference dgx (hosted customer APIs stay up)',
  '  /fleet sleep          turn the fleet VM off: EVERY hosted API goes dark until /fleet wake',
  '  /fleet wake           boot it back, restore the record, health-gated',
  '  /fleet critical       only the critical profile + gpu sleep',
  '  /fleet status         same as /gpu status',
  '  --dry-run             print the steps, run nothing',
  '  aliases: /gaming = /gpu (off/stop/pause = sleep, on/start/resume = wake)',
].join('\n');
