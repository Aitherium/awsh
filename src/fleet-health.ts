/**
 * Fleet health from the container runtime that actually runs the fleet.
 *
 * WHY THIS EXISTS (measured 2026-11-09, awsh 1.18.10 as root in the awnix distro):
 * the banner said `10 down` while `podman ps -a` listed 54 containers and NONE
 * unhealthy. The banner only ever asked `docker`, and awnix has no docker -- the
 * fleet is rootful podman. `docker` failing made discovery return null, null fell
 * back to probing eleven static 127.0.0.1 ports, and every container that does not
 * publish on the distro loopback (most of them, by design) read as DOWN.
 *
 * So: ask docker, then podman, and take the first runtime that answers. Count the
 * whole fleet from the same output, so the header can say `fleet 47/54 up` instead
 * of a down-count over a guessed probe set.
 */

import { spawnSync } from 'node:child_process';

/** Container runtimes in the order they are asked. docker first keeps every host
 *  that has one exactly as before; podman is what the awnix fleet runs. */
export const RUNTIMES = ['docker', 'podman'] as const;
export type Runtime = typeof RUNTIMES[number];

/** The `ps` template both runtimes accept. */
export const PS_FORMAT = '{{.Names}}\t{{.Status}}\t{{.Ports}}';

export interface FleetHealth {
  runtime: Runtime;
  /** Every container the runtime knows, including never-started `Created` ones. */
  total: number;
  running: number;
  healthy: number;
  unhealthy: number;
  starting: number;
  /** Exited with a NON-zero code: a crash, not a finished one-shot job. */
  failed: number;
  /** Exited 0 (finished init jobs) plus `Created` (never started). Not a fault. */
  idle: number;
  unhealthyNames: string[];
  failedNames: string[];
}

/** Classify one `Status` column. Docker says `(health: starting)`, podman `(starting)`. */
export function classifyStatus(status: string): 'healthy' | 'unhealthy' | 'starting' | 'running' | 'failed' | 'idle' {
  const s = status.trim();
  if (/^Up\b/i.test(s)) {
    if (/\(unhealthy\)/i.test(s)) return 'unhealthy';
    if (/\((?:health: )?starting\)/i.test(s)) return 'starting';
    if (/\(healthy\)/i.test(s)) return 'healthy';
    return 'running';
  }
  const exited = s.match(/^Exited \((-?\d+)\)/i);
  if (exited) return Number(exited[1]) === 0 ? 'idle' : 'failed';
  if (/^(Dead|Restarting|Removing)\b/i.test(s)) return 'failed';
  return 'idle';   // Created, Paused, Configured, Stopped (podman), unknown
}

/** Pure: summarise `ps -a --format PS_FORMAT` output. */
export function summarizePs(text: string, runtime: Runtime): FleetHealth {
  const out: FleetHealth = {
    runtime, total: 0, running: 0, healthy: 0, unhealthy: 0, starting: 0,
    failed: 0, idle: 0, unhealthyNames: [], failedNames: [],
  };
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    if (!raw.trim()) continue;
    const [name = '', status = ''] = raw.split('\t');
    if (!name.trim()) continue;
    out.total++;
    const kind = classifyStatus(status);
    if (kind === 'idle') { out.idle++; continue; }
    if (kind === 'failed') { out.failed++; out.failedNames.push(name.trim()); continue; }
    out.running++;
    if (kind === 'healthy') out.healthy++;
    else if (kind === 'unhealthy') { out.unhealthy++; out.unhealthyNames.push(name.trim()); }
    else if (kind === 'starting') out.starting++;
  }
  return out;
}

export type SpawnLike = (cmd: string, args: string[]) => { status: number | null; stdout?: string | null };

const defaultSpawn: SpawnLike = (cmd, args) => {
  try {
    const r = spawnSync(cmd, args, { encoding: 'utf-8', timeout: 4000, windowsHide: true });
    return { status: r.error ? null : r.status, stdout: typeof r.stdout === 'string' ? r.stdout : null };
  } catch {
    return { status: null, stdout: null };
  }
};

/**
 * Raw `ps -a` output from the first runtime that answers, or null when none does.
 * null ("could not ask") stays distinct from "" ("asked, nothing runs here").
 */
export function containerPs(spawn: SpawnLike = defaultSpawn): { runtime: Runtime; text: string } | null {
  for (const runtime of RUNTIMES) {
    const r = spawn(runtime, ['ps', '-a', '--format', PS_FORMAT]);
    if (r.status === 0 && typeof r.stdout === 'string') return { runtime, text: r.stdout };
  }
  return null;
}

/** The fleet as the runtime sees it, or null when no runtime answered. */
export function measureFleet(spawn: SpawnLike = defaultSpawn): FleetHealth | null {
  const ps = containerPs(spawn);
  return ps ? summarizePs(ps.text, ps.runtime) : null;
}

/** `fleet 47/49 up · 2 unhealthy` -- running over everything that is SUPPOSED to run
 *  (running + crashed); finished jobs and never-started containers are not owed. */
export function formatFleet(f: FleetHealth): string {
  const owed = f.running + f.failed;
  const parts = [`fleet ${f.running}/${owed} up`];
  if (f.unhealthy) parts.push(`${f.unhealthy} unhealthy`);
  if (f.failed) parts.push(`${f.failed} crashed`);
  if (f.starting) parts.push(`${f.starting} starting`);
  return parts.join(' · ');
}

/** Names worth acting on, worst first, capped (the reader's working memory is the screen). */
export function fleetProblems(f: FleetHealth, max = 5): string[] {
  const names = [...f.unhealthyNames.map((n) => `${n} (unhealthy)`), ...f.failedNames.map((n) => `${n} (crashed)`)];
  return names.length > max ? [...names.slice(0, max), `+${names.length - max} more`] : names;
}
