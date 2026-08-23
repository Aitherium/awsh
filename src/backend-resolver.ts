/**
 * backend-resolver.ts — "just work" backend selection for AitherShell.
 *
 * The shell must NEVER be dead just because local Genesis/AitherOS is down. It
 * taps local services when they're up and transparently falls over to the public
 * cloud gateway (mcp.aitherium.com — raw /v1 inference + /mcp tools) when they're
 * not. This is the startup half; mid-turn failover lives in client.ts.
 *
 * Priority chain (only when the endpoint is NOT explicitly pinned and
 * AITHERSHELL_USE_ADK != '0'):
 *   1. ADK daemon (sovereign local agent)   (127.0.0.1:9001) — local-first, stateless
 *   2. Local Genesis / standalone node      (127.0.0.1:8001) — full stack, free, private
 *   3. Cloud gateway                        (mcp.aitherium.com) — always-on fallback
 *
 * An explicitly pinned endpoint (AITHER_API_URL / config file / --gateway) is
 * honored verbatim — we probe it for the banner but never override the user's
 * choice. AITHERSHELL_USE_ADK=0 disables the adk daemon preference (force genesis).
 */

import { existsSync, readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { spawn } from 'node:child_process';
import { CLOUD_URL, applyCloudFallback, type ShellConfig } from './config.js';
import { probeHealth } from './status-banner.js';

export interface ResolvedBackend {
  /** Which rung of the chain we landed on. */
  chosen: 'pinned' | 'adk' | 'local' | 'cloud';
  /** The API base URL now in config. */
  url: string;
  /** True if we moved OFF the default local endpoint onto the cloud fallback. */
  switched: boolean;
  /** Whether the chosen endpoint answered a health probe. */
  reachable: boolean;
}

const strip = (u: string) => u.replace(/\/+$/, '');

/** ADK daemon sovereign agent server (stateless, local-first). */
/** Where the local adk daemon is. DISCOVERED, not hardcoded: the daemon publishes its real
 *  address to ~/.aither/daemon.json on startup (adk/daemon_endpoint.py). This used to be a
 *  literal in three separate files that had to agree, so a port change silently dropped the
 *  shell back onto the slow genesis path with no error anywhere. */
const ADK_DEFAULT_URL = 'http://127.0.0.1:9001';

function adkDaemonUrl(): string {
  const explicit = (process.env.ADK_DAEMON_URL || '').trim();
  if (explicit) return explicit.replace(/\/+$/, '');
  try {
    const file = join(homedir(), '.aither', 'daemon.json');
    const url = String(JSON.parse(readFileSync(file, 'utf8')).url || '').trim();
    if (url) return url.replace(/\/+$/, '');
  } catch { /* not running / not published yet — fall through to the default */ }
  return ADK_DEFAULT_URL;
}

/** Candidate daemon addresses, best first, WITHOUT duplicates.
 *
 *  The published file is a hint, not a fact: a daemon killed with SIGKILL/Stop-Process
 *  never runs its shutdown hook, so its entry outlives it. Measured 2026-07-29 — the file
 *  named :9101 (a dead test daemon) while the real daemon served :9001. Trusting the file
 *  alone would have skipped a healthy local daemon and dropped the shell onto the slow
 *  genesis path with no error anywhere, which is precisely the silent degradation this
 *  discovery mechanism was introduced to eliminate. So try the published address first,
 *  then the well-known default before giving up on local. */
function adkDaemonCandidates(): string[] {
  const published = adkDaemonUrl();
  return published === ADK_DEFAULT_URL ? [published] : [published, ADK_DEFAULT_URL];
}

/** Start the daemon if it is not already up, so the sovereign loop comes with the shell
 *  instead of needing a separate manual launch. Detached and best-effort: a failure here
 *  just means we fall through to the existing genesis/cloud resolution. */
function tryStartAdkDaemon(): void {
  if (process.env.AITHERSHELL_AUTOSTART_ADK === '0') return;
  try {
    const script = 'D:\\AitherOS-Fresh\\awdk\\adk-daemon-start.cmd';
    if (!existsSync(script)) return;
    spawn('cmd', ['/c', 'start', '', script], {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
  } catch { /* best-effort only */ }
}

/**
 * Resolve the best reachable backend and mutate `config` in place.
 *
 * Fast path: a healthy local endpoint returns after ONE probe, so the
 * common case adds negligible startup latency. If NOTHING answers we still
 * point at cloud — that's the honest state (offline box → the reachable-if-internet edge),
 * and it lets the REPL open and surface a real "sign in / check network" hint instead of
 * silently hammering a dead 127.0.0.1.
 *
 * The ADK daemon is preferred over Genesis (faster inference turnaround, sovereign),
 * but can be disabled with AITHERSHELL_USE_ADK=0.
 */
export async function resolveBackend(config: ShellConfig): Promise<ResolvedBackend> {
  // 1. Pinned endpoint (env / file / --gateway) — honor it, just report health.
  if (config.endpointPinned) {
    const reachable = await probeHealth(`${strip(config.genesisUrl)}/health`, 3000);
    return { chosen: 'pinned', url: config.genesisUrl, switched: false, reachable };
  }

  // 2. Try ADK daemon first (if not disabled via AITHERSHELL_USE_ADK=0).
  const useAdk = process.env.AITHERSHELL_USE_ADK !== '0';
  if (useAdk) {
    const candidates = adkDaemonCandidates();
    for (const candidate of candidates) {
      if (await probeHealth(`${strip(candidate)}/health`, 2500)) {
        return { chosen: 'adk', url: candidate, switched: false, reachable: true };
      }
    }
    const adkUrl = candidates[candidates.length - 1];
    // Not up — kick off a start, but do NOT block on it. A cold daemon takes ~30-60s to
    // boot (it loads packs and attaches ~1200 gateway tools), so the previous 6s wait was
    // guaranteed to expire on a cold start: the user paid 6 seconds, still got the fallback,
    // and a daemon warmed invisibly in the background. The short grace below only catches
    // the case where it was ALREADY starting; otherwise we fall through immediately and the
    // daemon is ready for the next launch.
    tryStartAdkDaemon();
    for (let i = 0; i < 2; i++) {
      await new Promise((r) => setTimeout(r, 1000));
      if (await probeHealth(`${strip(adkUrl)}/health`, 1500)) {
        return { chosen: 'adk', url: adkUrl, switched: false, reachable: true };
      }
    }
    // Say so, rather than silently landing on a slower backend.
    process.stderr.write(
      '  ⧗ local agent daemon is starting in the background — it will serve the next launch\n',
    );
  }

  // 3. Try local Genesis.
  const localUrl = config.genesisUrl; // the 127.0.0.1:8001 default
  if (await probeHealth(`${strip(localUrl)}/health`, 2500)) {
    return { chosen: 'local', url: localUrl, switched: false, reachable: true };
  }

  // 4. Local is down → fail over to the cloud gateway.
  applyCloudFallback(config, CLOUD_URL);
  const reachable = await probeHealth(`${strip(CLOUD_URL)}/health`, 4000);
  return { chosen: 'cloud', url: CLOUD_URL, switched: true, reachable };
}
