/**
 * fleet-recover.ts -- the targeted fleet-host recovery behind `/docker recover`.
 *
 * The old recovery ran `wsl --shutdown` and taskkilled vmmem / wslservice.exe. Every
 * WSL distro shares ONE utility VM, so on a host whose fleet runs in a WSL distro
 * (awnix since 2026-09-27) either one kills the whole fleet AND detaches its data
 * disk -- `wsl --mount --bare` does not survive a VM cycle -- and the fleet then
 * boots with empty data dirs. The targeted shape:
 *   1. `wsl --terminate <fleet distro>` (that distro only),
 *   2. `schtasks /run /tn AitherOS-AttachFleetData` (re-mounts the data disk and
 *      holds the distro up; idempotent),
 *   3. probe `systemctl is-system-running` inside the fleet distro.
 *
 * The distro is resolved by the same rule as AitherOS/lib/core/fleet_distro.py
 * (env AITHER_FLEET_DISTRO, AITHER_WSL_DISTRO, FLEET_DISTRO, AWDESK_FLEET_DISTRO;
 * then nodes.<debian-fleet>.fleet_distro in AitherOS/config/nodes.yaml; then
 * "awnix"). awsh ships standalone, so this is a stdlib copy, not an import.
 */
import { existsSync, readFileSync } from 'node:fs';
import { join } from 'node:path';

export const DEFAULT_FLEET_DISTRO = 'awnix';
export const FLEET_ATTACH_TASK = 'AitherOS-AttachFleetData';
const ENV_VARS = ['AITHER_FLEET_DISTRO', 'AITHER_WSL_DISTRO', 'FLEET_DISTRO', 'AWDESK_FLEET_DISTRO'];
const NAME_RE = /^[A-Za-z0-9._-]{1,64}$/;
/** `degraded` is the fleet's normal state; `starting` is a boot a recovery must not interrupt. */
const UP_STATES = new Set(['running', 'degraded', 'starting', 'initializing']);

type Env = Record<string, string | undefined>;

/** nodes.<debian-fleet>.fleet_distro from a nodes.yaml text, or null. Same line scan as the Python resolver. */
export function readNodesFleetDistro(text: string): string | null {
  let indent = -1;
  for (const line of text.replace(/^\uFEFF/, '').split(/\r?\n/)) {
    if (indent < 0) {
      const m = /^(\s*)debian-fleet:\s*(#.*)?$/.exec(line);
      if (m) indent = m[1].length;
      continue;
    }
    const t = line.trim();
    if (!t || t.startsWith('#')) continue;
    if (line.length - line.replace(/^\s+/, '').length <= indent) return null;
    const k = /^\s*fleet_distro:\s*(.*)$/.exec(line);
    if (k) {
      let v = k[1].trim();
      if (v[0] === '"' || v[0] === "'") {
        const end = v.indexOf(v[0], 1);
        v = end > 0 ? v.slice(1, end) : v.slice(1);
      } else {
        v = v.split(' #')[0].split('\t#')[0].trim();
      }
      return NAME_RE.test(v) ? v : null;
    }
  }
  return null;
}

/** The fleet distro name: env chain, then nodes.yaml, then "awnix". */
export function resolveFleetDistro(env: Env = process.env): string {
  for (const v of ENV_VARS) {
    const val = String(env[v] ?? '').trim();
    if (val) return val;
  }
  const candidates = [
    String(env.AITHER_NODES_YAML ?? '').trim(),
    env.AITHEROS_ROOT ? join(env.AITHEROS_ROOT, 'AitherOS', 'config', 'nodes.yaml') : '',
    'C:\\AitherOS-Fresh\\AitherOS\\config\\nodes.yaml',
  ].filter(Boolean);
  for (const p of candidates) {
    if (!existsSync(p)) continue;
    try {
      const n = readNodesFleetDistro(readFileSync(p, 'utf-8'));
      if (n) return n;
    } catch { /* unreadable: fall through to the default */ }
    break;
  }
  return DEFAULT_FLEET_DISTRO;
}

/** argv that asks the fleet host whether systemd is up. */
export function fleetProbeArgv(env: Env = process.env): string[] {
  return ['wsl', '-d', resolveFleetDistro(env), '-u', 'root', '--', 'systemctl', 'is-system-running'];
}

/** The recovery as labelled argv steps. Pure: never a global shutdown, never a VM kill. */
export function fleetRecoverPlan(env: Env = process.env): Array<[string, string[]]> {
  const d = resolveFleetDistro(env);
  const task = String(env.AITHER_FLEET_ATTACH_TASK ?? '').trim() || FLEET_ATTACH_TASK;
  return [
    [`[1/3] Terminating the fleet distro only (${d})...`, ['wsl', '--terminate', d]],
    [`[2/3] Re-attaching fleet data (${task})...`, ['schtasks', '/run', '/tn', task]],
    ['[3/3] Probing systemd in the fleet host...', fleetProbeArgv(env)],
  ];
}

/** The last line of `systemctl is-system-running` output (NULs stripped), or 'unreachable'. */
export function parseFleetState(raw: string | null | undefined): string {
  const t = String(raw ?? '').replace(/\u0000/g, '').trim();
  if (!t) return 'unreachable';
  const lines = t.split(/\r?\n/);
  return lines[lines.length - 1].trim();
}

/** True for a fleet host that must be left alone (up, or mid-boot). */
export function fleetStateIsUp(state: string): boolean {
  return UP_STATES.has(state);
}
