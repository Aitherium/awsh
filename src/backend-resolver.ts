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
 *   3. Local model server (raw /v1)         llm_url if loopback, then MicroScheduler
 *                                           (https://127.0.0.1:8150/v1) — free, private
 *   4. Cloud gateway                        (mcp.aitherium.com) — always-on fallback
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
import { SPINE_URL, isSpineUrl, normalizeSpineUrl, spineFetch } from './client.js';

/** How long the resolver waits for a daemon IT just launched, and how often it looks.
 *  Pure, so the test can pin it. Measured 2026-09-19: a cold daemon binds in ~13 s
 *  once its boot no longer blocks on the gateway attach; 25 s covers a slow disk. The
 *  old 2 x 1 s wait was guaranteed to expire, so every cold start paid the probe AND
 *  landed on the cloud rung -- which then demanded a sign-in the owner never needed.
 *  2026-10-25: with the default agent's tool packs loading (aither identity), a cold
 *  daemon took ~95 s, so 25 s sent the first line after every restart to the cloud
 *  rung. 120 s covers it; the dots keep printing so the wait is never silent. */
export function bootWaitPlan(env: NodeJS.ProcessEnv = process.env): { waitMs: number; pollMs: number } {
  const text = (env.AITHERSHELL_ADK_BOOT_WAIT_S || '').trim();
  const raw = Number(text);
  const waitS = text !== '' && Number.isFinite(raw) && raw >= 0 ? raw : 120;
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
  /** Which rung of the chain we landed on. 'local-llm' = offline, raw inference against
   *  the machine's own model server; 'offline' = offline and nothing local answered (the
   *  cloud rung was refused, never tried). */
  chosen: 'pinned' | 'adk' | 'local' | 'local-llm' | 'offline' | 'cloud';
  /** The API base URL now in config. */
  url: string;
  /** True if we moved OFF the default local endpoint onto the cloud fallback. */
  switched: boolean;
  /** Whether the chosen endpoint answered a health probe. */
  reachable: boolean;
}

const strip = (u: string) => u.replace(/\/+$/, '');

/** The awnix user unit for the local agent daemon (see awnix-awsh(8)). */
const AWSH_AGENT_UNIT = '/usr/lib/systemd/user/awsh-agent.service';

/** Does an OpenAI-compatible server at `llmUrl` (…/v1) list at least one model? */
export async function probeModels(llmUrl: string, timeoutMs = 2500): Promise<string | null> {
  try {
    // The spine is dialled verified against the AitherNet CA (client.ts spineFetch); a
    // bare fetch() only reached it while main.ts had relaxed TLS for loopback.
    const url = `${strip(llmUrl)}/models`;
    const init = { signal: AbortSignal.timeout(timeoutMs) };
    const r = await (isSpineUrl(url) ? spineFetch(url, init) : fetch(url, init));
    if (!r.ok) return null;
    const body = await r.json() as { data?: { id?: string }[] };
    const id = Array.isArray(body?.data) && body.data.length > 0 ? body.data[0]?.id : undefined;
    return id ? String(id) : null;
  } catch { return null; }
}

/** MicroScheduler's well-known loopback address: every AitherOS model call routes
 *  through it, and on a fleet host (awnix) it is the healthy local lane. https; its
 *  certificate chains to the AitherNet CA, which spineFetch (client.ts) verifies per
 *  request. Nothing here relaxes TLS for it. */
export const LOCAL_MICROSCHEDULER_URL = `${SPINE_URL}/v1`;

/** Loopback model servers worth one probe before the cloud rung, best first and without
 *  duplicates: the configured llm_url (only if loopback), then MicroScheduler. Pure.
 *  A configured spine in a dead spelling (http://localhost:8150/v1) becomes
 *  https://127.0.0.1:8150/v1: plain http hangs the TLS listener and localhost reaches
 *  ::1, which the spine refuses.
 *  AITHERSHELL_LOCAL_LLM=0 drops the MicroScheduler guess (the configured url stays). */
export function localModelCandidates(llmUrl: string | undefined, env: NodeJS.ProcessEnv = process.env): string[] {
  const out: string[] = [];
  const add = (u: string | undefined): void => {
    const s = strip(normalizeSpineUrl(strip((u || '').trim()), env));
    if (s && isLoopbackUrl(s) && !out.includes(s)) out.push(s);
  };
  add(llmUrl);
  if ((env.AITHERSHELL_LOCAL_LLM || '').trim() !== '0') add(LOCAL_MICROSCHEDULER_URL);
  return out;
}

/** Try each local model server; on the first that lists a model, move `config` onto
 *  raw inference against it. `setModel` adopts the listed id when none is configured
 *  (offline: the box's own server is the only authority on names); online, MicroScheduler
 *  routes the shell's default agent name itself, so the configured default stands. */
export async function tryLocalModelServer(
  config: ShellConfig,
  opts: { setModel: boolean; probe?: (llmUrl: string) => Promise<string | null> },
): Promise<ResolvedBackend | null> {
  const probe = opts.probe ?? ((u: string) => probeModels(u));
  for (const llm of localModelCandidates(config.llmUrl, process.env)) {
    const model = await probe(llm);
    if (!model) continue;
    config.llmUrl = llm;
    config.inferenceMode = 'raw';
    config.backendType = 'adk';
    config.backendName = 'local model';
    if (opts.setModel && !config.model) config.model = model;
    return { chosen: 'local-llm', url: llm, switched: false, reachable: true };
  }
  return null;
}

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
  // A machine image (awnix) ships the agent as a systemd USER unit. Ask systemd, so the
  // daemon runs with the unit's env (offline, loopback, the image's model url) rather
  // than whatever this shell happens to have.
  if (process.platform === 'linux' && existsSync(AWSH_AGENT_UNIT)) {
    try {
      spawn('systemctl', ['--user', 'start', '--no-block', 'awsh-agent.service'], {
        detached: true,
        stdio: 'ignore',
      }).unref();
      return true;
    } catch { return false; }
  }
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

export interface DaemonProbe { url: string; up: boolean; tools: boolean }

/** Pick the daemon to talk to: the first healthy one whose platform tool lane is up
 *  (`gateway_mcp_connected`), else the first healthy one, else null. Pure.
 *  Measured 2026-11-16: ~/.aither/daemon.json had been overwritten by a second
 *  `adk.server --port 9177` with gateway_mcp_connected:false, while the watchdog's :9001
 *  had it true -- trusting the file first sent every turn to the daemon WITHOUT mail,
 *  fleet or Discord tools ("Unknown tool: fleet_status"). */
export function pickDaemon(rows: readonly DaemonProbe[]): string | null {
  return rows.find((r) => r.up && r.tools)?.url ?? rows.find((r) => r.up)?.url ?? null;
}

async function probeDaemon(url: string): Promise<DaemonProbe> {
  try {
    const r = await fetch(`${strip(url)}/health`, { signal: AbortSignal.timeout(2500) });
    if (!r.ok) return { url, up: false, tools: false };
    const b = await r.json().catch(() => ({})) as Record<string, unknown>;
    return { url, up: true, tools: b.gateway_mcp_connected === true };
  } catch {
    return { url, up: await probeHealth(`${strip(url)}/health`, 2500), tools: false };
  }
}

async function bestDaemon(candidates: readonly string[]): Promise<string | null> {
  return pickDaemon(await Promise.all(candidates.map(probeDaemon)));
}

/** The healthiest local agent daemon, or null. client.ts calls this (via a dynamic
 *  import, the two modules import each other) when a REMOTE endpoint dies mid-turn. */
export async function findLocalAgentDaemon(): Promise<string | null> {
  return bestDaemon(adkDaemonCandidates());
}

/** Does a /health body describe the bare edge gateway (OpenAI /v1 only, no agent
 *  pipeline)? Same test client.ts detectBackend uses to pick the toolless path. Pure. */
export function isBareGatewayHealth(body: unknown): boolean {
  if (!body || typeof body !== 'object') return false;
  const b = body as Record<string, unknown>;
  if (b.agent !== undefined || b.llm_backend !== undefined) return false;
  if (b.generation_ready !== undefined || b.tracked_services !== undefined || b.service === 'AitherGenesis') return false;
  return typeof b.service === 'string' && /gateway/i.test(b.service);
}

/** May a remote pin be traded for the local agent daemon? Not when the user asked for a
 *  thin client (inference_mode raw / --gateway), disabled the daemon, or said keep it. Pure. */
export function shouldPreferLocalAgent(
  config: Pick<ShellConfig, 'inferenceMode' | 'offline'>, env: NodeJS.ProcessEnv,
): boolean {
  if ((env.AWSH_HONOR_REMOTE_PIN || '').trim() === '1') return false;
  if (env.AITHERSHELL_USE_ADK === '0') return false;
  if (config.inferenceMode === 'raw') return false;
  return true;
}

async function isBareGateway(url: string): Promise<boolean> {
  try {
    const r = await fetch(`${strip(url)}/health`, {
      headers: { Accept: 'application/json' }, signal: AbortSignal.timeout(3000),
    });
    if (!r.ok) return false;
    return isBareGatewayHealth(await r.json());
  } catch { return false; }
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
  // Offline, a REMOTE pin is refused before it is probed: the user's own api_url does not
  // outrank `offline: true`, and the pin is cleared so client.ts failover cannot use it.
  if (config.endpointPinned && config.offline && !isLoopbackUrl(config.genesisUrl)) {
    process.stderr.write(
      `  ! offline: pinned api_url ${config.genesisUrl} is not loopback - not dialed\n`,
    );
    config.endpointPinned = false;
    config.genesisUrl = 'http://127.0.0.1:8001';
  }
  if (config.endpointPinned) {
    const reachable = await probeHealth(`${strip(config.genesisUrl)}/health`, 3000);
    // A REMOTE pin that is only the bare edge gateway (OpenAI /v1, no persona, no tools,
    // no memory) does not outrank a healthy LOCAL agent daemon. Measured 2026-11-16 on the
    // owner's desktop: a User-scope AITHER_API_URL=https://mcp.aitherium.com pinned every
    // turn to the toolless /v1 path, so aither-orchestrator told him to "run docker ps",
    // did not know DarkMatter and said it had no Discord -- while :9001 sat healthy with
    // 68 platform tools attached. The switch is said out loud; AWSH_HONOR_REMOTE_PIN=1 or
    // inference_mode: raw keeps the edge (a deliberate thin client).
    if (reachable && !isLoopbackUrl(config.genesisUrl)
        && shouldPreferLocalAgent(config, process.env)
        && await isBareGateway(config.genesisUrl)) {
      const candidate = await bestDaemon(adkDaemonCandidates());
      if (candidate) {
        {
          process.stderr.write(
            `  ! pinned ${config.genesisUrl} is the bare edge gateway (no tools, no memory);
` +
            `    using the local agent daemon ${candidate} instead (AWSH_HONOR_REMOTE_PIN=1 keeps the pin)
`,
          );
          config.endpointPinned = false;
          config.genesisUrl = candidate;
          return { chosen: 'adk', url: candidate, switched: true, reachable: true };
        }
      }
    }
    // A DEAD remote pin with a healthy local agent daemon: the internet is gone, not the
    // user's choice. Measured 2026-11-17: the desktop NIC came up without DHCP after a crash
    // reboot, api_url pinned https://mcp.aitherium.com, and every turn died "fetch failed"
    // while :9001 sat healthy. Same gate as the bare-gateway trade above; said out loud.
    if (!reachable && !isLoopbackUrl(config.genesisUrl)
        && shouldPreferLocalAgent(config, process.env)) {
      const candidate = await bestDaemon(adkDaemonCandidates());
      if (candidate) {
        process.stderr.write(
          `  ! pinned ${config.genesisUrl} is unreachable (network down?);\n` +
          `    using the local agent daemon ${candidate} instead (AWSH_HONOR_REMOTE_PIN=1 keeps the pin)\n`,
        );
        config.endpointPinned = false;
        config.genesisUrl = candidate;
        if (config.llmUrl && !isLoopbackUrl(config.llmUrl)) config.llmUrl = '';
        return { chosen: 'adk', url: candidate, switched: true, reachable: true };
      }
    }
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
    const best = await bestDaemon(candidates);
    if (best) {
      const candidate = best;
      {
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
    // Only when something WAS launched: with autostart off (or no start script) the
    // "still starting" line described a daemon that nobody started.
    if (launched) {
      config.localDaemonBooting = { url: adkUrl, since };
      noteLocalDaemonBooting({ url: adkUrl, since });
      process.stderr.write(
        '  ⧗ local agent daemon is still starting in the background — retry in a moment, or it will serve the next launch\n',
      );
    }
  }

  // 3. Try local Genesis.
  const localUrl = config.genesisUrl; // the 127.0.0.1:8001 default
  if (await probeHealth(`${strip(localUrl)}/health`, 2500)) {
    config.genesisUrl = localUrl;
    return { chosen: 'local', url: localUrl, switched: false, reachable: true };
  }

  // 4. Offline: the cloud rung is REFUSED, not tried. Last local chance is the machine's
  //    own model server (raw /v1 inference, no agent loop); then say plainly that
  //    nothing local answered. An air-gapped box never dials a public edge.
  if (config.offline) {
    const local = await tryLocalModelServer(config, { setModel: true });
    if (local) return local;
    applyCloudFallback(config, CLOUD_URL); // records the refusal; changes nothing else
    process.stderr.write(
      '  ! offline: no local backend answered (agent :9001, genesis, model server). ' +
      'The cloud gateway is disabled offline.\n' +
      '    Check the machine with `awsh doctor` (awnix: `awnix awsh doctor`).\n',
    );
    return { chosen: 'offline', url: config.genesisUrl, switched: false, reachable: false };
  }

  // 5. Online, a healthy local model server still beats the cloud. Measured 2026-11-09
  //    on an awnix fleet host: no agent daemon, no published Genesis, MicroScheduler
  //    healthy on :8150 -- and awsh picked the cloud gateway, then refused every turn with
  //    "Cloud gateway requires sign-in". Local, free and already authorised wins.
  const local = await tryLocalModelServer(config, { setModel: false });
  if (local) return local;

  // 6. Local is down → fail over to the cloud gateway.
  applyCloudFallback(config, CLOUD_URL);
  const reachable = await probeHealth(`${strip(CLOUD_URL)}/health`, 4000);
  return { chosen: 'cloud', url: CLOUD_URL, switched: true, reachable };
}
