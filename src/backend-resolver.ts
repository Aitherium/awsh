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
import { fileURLToPath } from 'node:url';
import { spawn } from 'node:child_process';
import { CLOUD_URL, applyCloudFallback, noteLocalDaemonBooting, type ShellConfig } from './config.js';
import { probeHealth } from './status-banner.js';

/** How long the resolver waits for a daemon IT just launched, and how often it looks.
 *  Pure, so the test can pin it. Measured 2026-09-19: a cold daemon binds in ~13 s
 *  once its boot no longer blocks on the gateway attach; 25 s covers a slow disk. The
 *  old 2 x 1 s wait was guaranteed to expire, so every cold start paid the probe AND
 *  landed on the cloud rung -- which then demanded a sign-in the owner never needed. */
export function bootWaitPlan(env: NodeJS.ProcessEnv = process.env): { waitMs: number; pollMs: number } {
  const text = (env.AITHERSHELL_ADK_BOOT_WAIT_S || '').trim();
  const raw = Number(text);
  const waitS = text !== '' && Number.isFinite(raw) && raw >= 0 ? raw : 25;
  return { waitMs: Math.round(waitS * 1000), pollMs: 1000 };
}

/** The daemon launchers this box knows, best first. Pure: every path is an argument.
 *  ONE spec wins when it exists -- the hidden scheduled-task payload
 *  (`~/.aither/bin/hidden-tasks/AitherOS-AdkDaemon.cmd`: AITHER_OFFLINE=1, log redirect,
 *  runs from the canonical tree) is what the watchdog itself launches. Measured
 *  2026-09-19: this shell launched `awdk/adk-daemon-start.cmd` (a DIFFERENT env:
 *  --backend vllm, no log redirect, a visible console) while the watchdog launched the
 *  hidden one every tick -- three launchers fighting over :9001 with two configs. */
export function daemonStartCandidates(opts: {
  home: string; here: string; root: string; explicit: string;
}): { script: string; hidden: boolean }[] {
  const out: { script: string; hidden: boolean }[] = [];
  if (opts.explicit) out.push({ script: opts.explicit, hidden: false });
  out.push({ script: join(opts.home, '.aither', 'bin', 'hidden-tasks', 'AitherOS-AdkDaemon.cmd'), hidden: true });
  out.push({ script: join(opts.here, '..', '..', '..', '..', '..', 'awdk', 'adk-daemon-start.cmd'), hidden: false });
  if (opts.root) out.push({ script: join(opts.root, 'awdk', 'adk-daemon-start.cmd'), hidden: false });
  return out;
}

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

/** Does this URL name a process on THIS box? config.ts keeps a private copy of this; a pin
 *  is only overridable when it is loopback, so the test has to live on this side too. */
function isLoopbackUrl(u: string): boolean {
  try {
    const h = new URL(u).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' || h === '0.0.0.0' || h.endsWith('.localhost');
  } catch { return false; }
}

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

/** Where the daemon start script actually is.
 *
 *  This was a hardcoded absolute path on the D: drive. Measured 2026-09-10: that path does
 *  not exist on this box (the tree is on C:), so existsSync was false on EVERY launch and
 *  the autostart returned silently -- the self-heal that exists precisely so a dead daemon
 *  repairs itself had been a no-op for as long as the repo lived on C:. A wrong drive letter
 *  must not be indistinguishable from 'nothing to do', so derive the first candidate from
 *  THIS file's own location and only then fall back to fixed guesses.
 *
 *  The fixed guess that used to sit here -- a literal absolute path into our own checkout -- is
 *  GONE, and it should never come back in any spelling. It was two defects wearing one line:
 *
 *    - It disclosed an absolute monorepo path inside the package strangers install
 *      (`check_adk_publishable.py` AWS001, pinned baseline 0), which is what failed the
 *      awsh publish lane on every run from 2026-09-11 onward -- so no awsh fix reached npm
 *      at all, including the ones meant to repair this file.
 *    - It could never have helped the only people who run a published awsh. A stranger
 *      installing from npm has no `awdk/` tree, so the candidate was dead weight that read
 *      as a working fallback -- the same "wrong path looks like nothing to do" silence the
 *      docstring above exists to describe.
 *
 *  The derivation on the line below covers the real case (this file inside the monorepo),
 *  and AITHEROS_ROOT covers a relocated tree. Nothing else is knowable from here. */
function adkStartScript(): { script: string; hidden: boolean } | null {
  const here = fileURLToPath(import.meta.url); // .../.PRODUCTS/.AITHERSHELL/cli/{src,dist}/x.js
  const candidates = daemonStartCandidates({
    home: homedir(),
    here,
    root: (process.env.AITHEROS_ROOT || '').trim(),
    explicit: (process.env.ADK_DAEMON_START || '').trim(),
  });
  for (const c of candidates) { try { if (existsSync(c.script)) return c; } catch { /* keep looking */ } }
  return null;
}

/** Start the daemon if it is not already up, so the sovereign loop comes with the shell
 *  instead of needing a separate manual launch. Detached and best-effort: a failure here
 *  just means we fall through to the existing genesis/cloud resolution. */
function tryStartAdkDaemon(): boolean {
  if (process.env.AITHERSHELL_AUTOSTART_ADK === '0') return false;
  try {
    const found = adkStartScript();
    if (!found) return false;
    // The hidden payload is launched the way its own watchdog launches it: through
    // run-hidden.vbs so no console window appears and the process outlives this
    // shell. Anything else keeps the old `start` (it may need a window of its own).
    const vbs = join(homedir(), '.aither', 'bin', 'run-hidden.vbs');
    const useVbs = found.hidden && existsSync(vbs);
    const argv = useVbs
      ? ['//B', '//Nologo', vbs, found.script]
      : ['/c', 'start', '', found.script];
    spawn(useVbs ? 'wscript' : 'cmd', argv, {
      detached: true,
      stdio: 'ignore',
      windowsHide: true,
    }).unref();
    return true;
  } catch { return false; /* best-effort only */ }
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
  // 1. Pinned endpoint (env / config file / --gateway).
  //
  // A REACHABLE pin is honored verbatim. An UNREACHABLE pin is still honored when it names a
  // REMOTE host: the user chose that endpoint deliberately, and quietly shipping their traffic
  // somewhere else is worse than an error. A LOOPBACK pin is a different thing -- it names a
  // local process, and local processes die. Measured 2026-09-10: ~/.aither/shell.yaml carried
  // `api_url: http://127.0.0.1:9001`, the daemon behind it had been killed without running its
  // shutdown hook, and this rung returned {chosen:'pinned', reachable:false} -- skipping the
  // daemon autostart, local Genesis AND the cloud gateway. Every turn then died on
  // ECONNREFUSED with one line naming a port and nothing about the backends it never tried.
  // One line in a config file silently disabled the entire never-dead guarantee. So a dead
  // loopback pin falls through to the rest of the ladder, out loud.
  if (config.endpointPinned) {
    const reachable = await probeHealth(`${strip(config.genesisUrl)}/health`, 3000);
    if (reachable || !isLoopbackUrl(config.genesisUrl)) {
      return { chosen: 'pinned', url: config.genesisUrl, switched: false, reachable };
    }
    process.stderr.write(
      `  ! pinned local backend ${config.genesisUrl} is not answering - trying the rest of the ladder
` +
      `    (to stop pinning it, remove the api_url line from ~/.aither/shell.yaml)
`,
    );
    // Clear the pin so mid-turn failover in client.ts is allowed to work too.
    config.endpointPinned = false;
  }

  // 2. Try ADK daemon first (if not disabled via AITHERSHELL_USE_ADK=0).
  const useAdk = process.env.AITHERSHELL_USE_ADK !== '0';
  if (useAdk) {
    const candidates = adkDaemonCandidates();
    for (const candidate of candidates) {
      if (await probeHealth(`${strip(candidate)}/health`, 2500)) {
        // Move the CONFIG onto the rung we chose, not just the return value. Measured
        // 2026-09-10: this rung reported the daemon it found and left config.genesisUrl
        // pointing at the endpoint it had just rejected, so the client dialed the dead
        // one anyway. The adk path only ever worked because shell.yaml happened to pin
        // the same port -- discovery was decorative.
        config.genesisUrl = candidate;
        return { chosen: 'adk', url: candidate, switched: false, reachable: true };
      }
    }
    const adkUrl = candidates[candidates.length - 1];
    // Not up -- launch it and WAIT for it, bounded. The daemon binds :9001 in ~13 s now
    // that its boot no longer awaits the gateway attach (adk/server.py lifespan,
    // 2026-09-19); the previous 2 x 1 s grace was guaranteed to expire on any cold
    // start, so the owner paid the probe, landed on the cloud rung, and was told to
    // /login for a backend they never asked for. One bounded wait with a visible
    // countdown is the honest version: the owner sees WHY the first turn is slow, once.
    const launched = tryStartAdkDaemon();
    const plan = bootWaitPlan();
    const since = Date.now();
    if (launched && plan.waitMs > 0) {
      process.stderr.write(`  ⧗ local agent daemon is booting (waiting up to ${Math.round(plan.waitMs / 1000)}s)`);
      while (Date.now() - since < plan.waitMs) {
        await new Promise((r) => setTimeout(r, plan.pollMs));
        process.stderr.write('.');
        if (await probeHealth(`${strip(adkUrl)}/health`, 1500)) {
          process.stderr.write(' up\n');
          config.genesisUrl = adkUrl;
          config.localDaemonBooting = undefined;
          noteLocalDaemonBooting(undefined);
          return { chosen: 'adk', url: adkUrl, switched: false, reachable: true };
        }
      }
      process.stderr.write(' still booting\n');
    }
    // Say so, rather than silently landing on a slower backend -- and remember it, so a
    // cloud 401 a moment later names the booting daemon instead of demanding a sign-in.
    if (launched) {
      config.localDaemonBooting = { url: adkUrl, since };
      noteLocalDaemonBooting({ url: adkUrl, since });
    }
    process.stderr.write(
      '  ⧗ local agent daemon is still starting in the background — retry in a moment, or it will serve the next launch\n',
    );
  }

  // 3. Try local Genesis.
  const localUrl = config.genesisUrl; // the 127.0.0.1:8001 default
  if (await probeHealth(`${strip(localUrl)}/health`, 2500)) {
    config.genesisUrl = localUrl;
    return { chosen: 'local', url: localUrl, switched: false, reachable: true };
  }

  // 4. Local is down → fail over to the cloud gateway.
  applyCloudFallback(config, CLOUD_URL);
  const reachable = await probeHealth(`${strip(CLOUD_URL)}/health`, 4000);
  return { chosen: 'cloud', url: CLOUD_URL, switched: true, reachable };
}
