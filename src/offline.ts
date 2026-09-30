/**
 * offline.ts -- config layers and the offline switch.
 *
 * On a machine image (awnix) the vendor ships defaults that the user never edits, and an
 * operator overrides them per machine. So the config is layered, lowest first:
 *
 *   /usr/lib/awsh/shell.yaml < /usr/lib/awsh/shell.d/*.yaml (name order)
 *   < /etc/awsh/shell.yaml < ~/.aither/shell.yaml < environment
 *
 * Every layer is flat `key: value`; CRLF is tolerated. On Windows the system paths do not
 * exist, so only the user file applies -- exactly the old behaviour.
 *
 * `offline: true` (or AITHER_OFFLINE=1) means awsh never tries a cloud endpoint: no cloud
 * rung at startup, no mid-turn cloud failover, no pinned remote api_url, no identity lookup
 * off the box (`whoami`), no crash report (Genesis or `gh issue create`). An explicit
 * AITHER_OFFLINE=0 turns it off. Callers outside the resolver ask `shellIsOffline()`.
 */

import { existsSync, readdirSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

export interface ConfigLayer {
  path: string;
  present: boolean;
  keys: string[];
}

export interface LayeredConfig {
  /** Merged file values (environment NOT applied; callers read env per key). */
  values: Record<string, string>;
  /** key -> the file that set it. */
  sources: Record<string, string>;
  layers: ConfigLayer[];
  /** Layers that exist but could not be read. Non-empty = could not judge. */
  unreadable: string[];
}

/** Flat `key: value` lines -- the grammar shell.yaml has always used. */
export function parseFlatConfig(content: string): Record<string, string> {
  const out: Record<string, string> = {};
  // Split on /\r?\n/: a CRLF file split on '\n' keeps a '\r' that '.' never matches,
  // which silently dropped every line on Windows once.
  for (const line of content.split(/\r?\n/)) {
    const match = line.match(/^(\w+):\s*(.+)$/);
    if (match) out[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
  }
  return out;
}

/** Paths of every layer, lowest precedence first. `root` prefixes the system paths. */
export function systemConfigLayers(opts: { home: string; root?: string }): string[] {
  const root = opts.root ?? '/';
  const vendor = join(root, 'usr', 'lib', 'awsh');
  const paths = [join(vendor, 'shell.yaml')];
  const dropDir = join(vendor, 'shell.d');
  try {
    if (existsSync(dropDir)) {
      for (const name of readdirSync(dropDir).filter((n) => n.endsWith('.yaml')).sort()) {
        paths.push(join(dropDir, name));
      }
    }
  } catch { /* an unreadable drop dir is reported by the doctor, not here */ }
  paths.push(join(root, 'etc', 'awsh', 'shell.yaml'));
  paths.push(join(opts.home, '.aither', 'shell.yaml'));
  return paths;
}

/** Read and merge the file layers. Never throws. */
export function loadLayeredConfig(opts: { home: string; root?: string }): LayeredConfig {
  const values: Record<string, string> = {};
  const sources: Record<string, string> = {};
  const layers: ConfigLayer[] = [];
  const unreadable: string[] = [];
  for (const path of systemConfigLayers(opts)) {
    if (!existsSync(path)) {
      layers.push({ path, present: false, keys: [] });
      continue;
    }
    let parsed: Record<string, string>;
    try {
      parsed = parseFlatConfig(readFileSync(path, 'utf-8'));
    } catch {
      unreadable.push(path);
      layers.push({ path, present: true, keys: [] });
      continue;
    }
    layers.push({ path, present: true, keys: Object.keys(parsed).sort() });
    for (const [k, v] of Object.entries(parsed)) {
      values[k] = v;
      sources[k] = path;
    }
  }
  return { values, sources, layers, unreadable };
}

const TRUE = new Set(['1', 'true', 'yes', 'on']);
const FALSE = new Set(['0', 'false', 'no', 'off']);

/** Is this shell offline? Environment wins in both directions; otherwise the file says. */
export function isOffline(env: NodeJS.ProcessEnv, fileCfg: Record<string, string>): boolean {
  const e = (env.AITHER_OFFLINE || '').trim().toLowerCase();
  if (TRUE.has(e)) return true;
  if (FALSE.has(e)) return false;
  return TRUE.has((fileCfg.offline || '').trim().toLowerCase());
}

/** Offline right now, from the environment and every config layer. Never throws: an
 *  unreadable layer counts as not setting `offline` (the doctor reports it). */
export function shellIsOffline(env: NodeJS.ProcessEnv = process.env,
  opts?: { home?: string; root?: string }): boolean {
  let values: Record<string, string> = {};
  try {
    values = loadLayeredConfig({ home: opts?.home ?? homedir(), root: opts?.root }).values;
  } catch { /* env alone decides */ }
  return isOffline(env, values);
}

/** Loopback only: 127.0.0.0/8, ::1, localhost. A LAN address is NOT loopback here --
 *  on an air-gapped box a LAN listener is still an open port. */
export function isLoopbackUrl(url: string): boolean {
  try {
    const h = new URL(url).hostname.replace(/^\[|\]$/g, '').toLowerCase();
    return h === 'localhost' || h.endsWith('.localhost') || h === '::1' || /^127\./.test(h);
  } catch { return false; }
}
