/**
 * status-banner.ts — Live fleet/backend status for the connect banner AND the
 * in-TUI welcome header.
 *
 * The boxed connect banner (main.ts `showBanner`) prints to the normal terminal
 * BEFORE the blessed alt-screen takes over, so inside the TUI it scrolls away and
 * the user is left with a bare "AitherShell · url" header. `gatherStatus()` +
 * `formatStatusLines()` let the TUI render the same live picture — services up,
 * which backend (local vs Genesis/cloud), and the orchestrator + reasoning models
 * actually loaded — right inside the output pane.
 *
 * The low-level probe/model helpers live here (rather than main.ts) so both the
 * connect banner and the TUI share one implementation.
 */

import { spawnSync } from 'node:child_process';
import chalk, { Chalk } from 'chalk';
import type { GenesisClient } from './client.js';
import type { ShellConfig } from './config.js';

// The palette/gradient/accent primitives now live in the SHARED design system
// (theme.ts) so the boot header, the banner, and the stream can never drift into
// two visual languages again (that drift is what made the shell read as dated).
// TC is re-exported from theme for the remaining local rgb() chrome below.
import { TC, accent, gradient } from './theme.js';

export interface WelcomeParams {
  host: string;
  user?: string;
  resumedMsg?: string;
}

/** The boot header: a letter-spaced gradient wordmark, a thin rule, and ONE compact
 *  subtitle. The full keymap lives under `?` — the boot screen stays quiet. */
export function formatWelcomeHeader(p: WelcomeParams): string[] {
  const cols = process.stdout.columns || 100;
  const ruleW = Math.max(24, Math.min(52, Math.floor(cols * 0.55)));
  const rule = TC.rgb(38, 66, 110)('╶' + '─'.repeat(ruleW - 2) + '╴');
  const sub = [
    TC.rgb(120, 180, 230)(p.host),
    p.user ? chalk.dim(p.user) : null,
    chalk.dim('? keys'),
  ].filter(Boolean).join(chalk.dim('  ·  '));
  const lines = [
    '',
    '  ' + chalk.dim('⟪ ') + gradient('A I T H E R S H E L L') + chalk.dim(' ⟫'),
    '  ' + rule,
    '  ' + sub,
  ];
  if (p.resumedMsg) lines.push('  ' + chalk.green(p.resumedMsg));
  return lines;
}

/** Loopback/private hosts serve the internal self-signed CA. Bun's `fetch`
 *  ignores NODE_EXTRA_CA_CERTS (set in main.ts), so an https probe to an internal
 *  service — notably Identity at :8115, which is https-ONLY (http → 400) — fails
 *  cert validation and gets false-flagged DOWN even though it's up. Health probes
 *  carry no secrets, so accept the internal cert for private hosts; PUBLIC remote
 *  endpoints (idp/gateway, real valid certs) keep strict TLS validation. */
function insecureTlsFor(url: string): Record<string, unknown> {
  try {
    const h = new URL(url).hostname;
    const isPrivate =
      h === 'localhost' || h === '127.0.0.1' || h === '::1' ||
      /^10\./.test(h) || /^192\.168\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
      h.endsWith('.local') || h.endsWith('.internal');
    // `tls` is Bun's per-request option (the shipped binary is Bun-compiled);
    // Node's fetch ignores it harmlessly.
    return isPrivate ? { tls: { rejectUnauthorized: false } } : {};
  } catch { return {}; }
}

/** Probe a health endpoint, tolerating http↔https and a single cold-start miss. */
export async function probeHealth(url: string, timeoutMs = 4000): Promise<boolean> {
  const tryFetch = async (u: string) => {
    try {
      const r = await fetch(u, {
        signal: AbortSignal.timeout(timeoutMs),
        ...insecureTlsFor(u),
      });
      return r.ok;
    } catch { return false; }
  };
  if (await tryFetch(url)) return true;
  if (url.startsWith('http://')) {
    if (await tryFetch(url.replace('http://', 'https://'))) return true;
  } else if (url.startsWith('https://')) {
    if (await tryFetch(url.replace('https://', 'http://'))) return true;
  }
  // One lenient retry: heavy compounds can miss a single 4s window at cold connect.
  await new Promise((r) => setTimeout(r, 500));
  return tryFetch(url);
}

/** One container as `docker ps` sees it. `hostPort` is the PUBLISHED port — the only one
 *  reachable from the host, and routinely different from the container's own. */
export interface DiscoveredService {
  name: string;
  running: boolean;
  health?: 'healthy' | 'unhealthy' | 'starting';
  hostPort?: string;
}

/**
 * Parse `docker ps --format '{{.Names}}\t{{.Status}}\t{{.Ports}}'`.
 *
 * Takes the PUBLISHED (left) side of `127.0.0.1:8490->8090/tcp`. Probing the right side is
 * what made the banner lie: `aitheros-node` publishes 8490->8090, was probed on :8090, and
 * therefore rendered DOWN forever while being perfectly healthy — a red row that trains you
 * to ignore the banner. Malformed rows yield a not-running entry rather than being dropped,
 * so a name that appears is never silently lost.
 */
export function parseDockerPs(text: string): Map<string, DiscoveredService> {
  const out = new Map<string, DiscoveredService>();
  for (const raw of String(text ?? '').split(/\r?\n/)) {
    const line = raw.trimEnd();
    if (!line.trim()) continue;
    const [name, status = '', ports = ''] = line.split('\t');
    const key = name.trim();
    if (!key) continue;
    const health: DiscoveredService['health'] =
      /\(healthy\)/.test(status) ? 'healthy'
      : /\(unhealthy\)/.test(status) ? 'unhealthy'
      : /\(health: starting\)/.test(status) ? 'starting'
      : undefined;
    // `0.0.0.0:8490->8090/tcp`, `127.0.0.1:8490->8090/tcp` and bare `8490->8090/tcp`.
    const published = ports.match(/(?:^|[\s,])(?:[\d.:\[\]a-f]*:)?(\d+)->\d+\/tcp/i);
    out.set(key, {
      name: key,
      running: /^Up\b/.test(status.trim()),
      health,
      hostPort: published ? published[1] : undefined,
    });
  }
  return out;
}

/**
 * Ask docker what is actually running here, or null when it cannot be asked.
 *
 * null is deliberately distinct from an empty map: "docker is not reachable" must fall back
 * to static ports, whereas "docker answered and listed nothing" really does mean no fleet.
 * Collapsing the two would blank the banner on any host without docker.
 */
export function discoverLocalServices(): Map<string, DiscoveredService> | null {
  try {
    const r = spawnSync('docker', ['ps', '-a', '--format', '{{.Names}}\t{{.Status}}\t{{.Ports}}'],
      { encoding: 'utf-8', timeout: 3000, windowsHide: true });
    if (r.status !== 0 || typeof r.stdout !== 'string') return null;
    return parseDockerPs(r.stdout);
  } catch { return null; }
}

/** The local fleet probe set: which container backs each row, and on what scheme. */
const LOCAL_PROBES: {
  name: string; port: string; scheme: 'http' | 'https'; path?: string;
  container?: string; hostProcess?: boolean;
}[] = [
  // The genesis LB terminates TLS and serves PLAIN http on the host — probing https here
  // costs a failed connect on every banner refresh (see the dispatch rule's rung 2).
  { name: 'Genesis',        container: 'aitheros-genesis-lb',      port: '8001', scheme: 'http' },
  { name: 'Node',           container: 'aitheros-node',            port: '8490', scheme: 'https' },
  { name: 'Pulse',          container: 'aitheros-pulse',           port: '8081', scheme: 'https' },
  { name: 'MicroScheduler', container: 'aitheros-microscheduler',  port: '8150', scheme: 'https' },
  { name: 'Identity',       container: 'aitheros-security-core-lb', port: '8115', scheme: 'https' },
  { name: 'Secrets',        container: 'aitheros-secrets',         port: '8111', scheme: 'https' },
  { name: 'Chronicle',      container: 'aitheros-chronicle',       port: '8121', scheme: 'https' },
  { name: 'Strata',         container: 'aitheros-strata',          port: '8136', scheme: 'https' },
  { name: 'Perception',     container: 'aitheros-perception-media', port: '8140', scheme: 'https' },
  { name: 'ComfyUI',        container: 'aither-comfyui-dgx-worker', port: '8188', scheme: 'https', path: '/system_stats' },
  // A HOST process, not a container — docker knows nothing about it, so never gate it.
  { name: 'MediaForge',     hostProcess: true,                     port: '8200', scheme: 'http', path: '/' },
];

/**
 * Build the health-probe set from the configured endpoints.
 *
 * Remote endpoints probe the public authenticated edges they actually use
 * (gateway/identity/mcp) instead of 127.0.0.1, which is unreachable from a real remote node.
 *
 * Locally, pass `live` from parseDockerPs to probe the ports this host ACTUALLY publishes.
 * Three cases, and the distinction between the last two is the point:
 *   - absent from docker  → not deployed here, omit (a permanently-red row teaches nothing)
 *   - present but EXITED  → keep on its static port so it renders RED (that IS the signal)
 *   - running, no publish → unreachable from the host by design, omit
 * `live = null` (docker unreachable) falls back to static ports for everything.
 */
export function buildProbes(
  config: ShellConfig,
  live?: Map<string, DiscoveredService> | null,
): { name: string; url: string }[] {
  const strip = (u: string) => u.replace(/\/+$/, '');
  const isRemote = config.requireAuth || !/127\.0\.0\.1|localhost/.test(config.genesisUrl);
  if (isRemote) {
    const probes = [
      { name: 'Gateway',  url: `${strip(config.genesisUrl)}/health` },
      { name: 'Identity', url: `${strip(config.identityUrl)}/health` },
    ];
    if (config.mcpUrl) probes.push({ name: 'MCP', url: `${strip(config.mcpUrl)}/health` });
    const msUrl = process.env.AITHER_LLM_URL;
    if (msUrl) probes.push({ name: 'MicroScheduler', url: `${strip(msUrl)}/health` });
    return probes;
  }

  const probes: { name: string; url: string }[] = [];
  for (const p of LOCAL_PROBES) {
    let port = p.port;
    if (live && !p.hostProcess) {
      const found = live.get(p.container!);
      if (!found) continue;                                  // not deployed on this host
      if (found.hostPort) port = found.hostPort;
      else if (found.running) continue;                      // running but unreachable
      // exited with no ports → keep the static port so the row goes red
    }
    probes.push({ name: p.name, url: `${p.scheme}://127.0.0.1:${port}${p.path ?? '/health'}` });
  }

  const msUrl = process.env.AITHER_LLM_URL;
  if (msUrl) {
    const ms = probes.find(p => p.name === 'MicroScheduler');
    if (ms) ms.url = `${strip(msUrl)}/health`;
    else probes.push({ name: 'MicroScheduler', url: `${strip(msUrl)}/health` });
  }
  return probes;
}

/** Friendly location label for an LLM backend id (from the MS snapshot). */
const _BACKEND_WHERE: Record<string, string> = {
  vllm: 'vLLM (local)',
  vllm_orchestrator: 'vLLM (local)',
  vllm_coding: 'vLLM (local)',
  vllm_swap: 'vLLM swap (local)',
  vllm_reasoning: 'vLLM reasoning (local)',
  vllm_dgx: 'DGX Spark',
  vllm_dgx_orch: 'DGX Spark',
  vllm_dgx_swap: 'DGX Spark (swap)',
  deepseek_api: 'DeepSeek (cloud)',
};

/** Pick the model the orchestrator path is actually serving + where, from the
 *  MicroScheduler /llm/backends/snapshot. Prefers the local orchestrator vLLM
 *  and the tuned LoRA (the live default), so the banner names the real model. */
export function pickServingModel(backends: Record<string, any>):
    { model: string; where: string } | null {
  const order = ['vllm', 'vllm_orchestrator', 'vllm_coding', 'vllm_dgx'];
  for (const id of order) {
    const b = backends[id];
    if (b?.healthy && Array.isArray(b.models) && b.models.length) {
      const models: string[] = b.models;
      const model = models.find((m) => /tuned/i.test(m))
        || models.find((m) => /orchestrator/i.test(m))
        || models[0];
      return { model, where: _BACKEND_WHERE[id] || id };
    }
  }
  for (const [id, b] of Object.entries(backends)) {
    if (b?.healthy && Array.isArray(b.models) && b.models.length) {
      return { model: b.models[0], where: _BACKEND_WHERE[id] || id };
    }
  }
  return null;
}

/** One model backend the fleet is serving (deduped by role). */
export interface ModelEntry { role: string; model: string; where: string; healthy: boolean; }

export interface StatusInfo {
  genesisHost: string;
  online: boolean;
  backendType: string;
  backendName: string;
  health?: string;
  version?: string;
  services?: number;
  agents?: number;
  serviceLines: { name: string; up: boolean; port?: string }[];
  models: ModelEntry[];      // ALL model backends, deduped by role
  orchestratorModel?: string;
  reasoningModel?: string;
  profile?: string;
  isLocal?: boolean;     // true = free/local, false = paid/cloud
  serving?: string;      // "model @ where"
  poolFree?: number;
  poolTotal?: number;
  /** Pending CRITICAL human-actionable cards from ActionHub, newest first.
   *
   * Deliberately a COUNT plus a couple of titles, never the list. Measured
   * 2026-07-30 the inbox held 18,087 pending cards (3,118 critical); rendering
   * that into a terminal banner would reproduce the landfill in the one place
   * the operator actually looks. */
  criticalActions?: { total: number; titles: string[] };
}

const ROLE_ORDER = ['orchestrator', 'reasoning', 'perception', 'embeddings', 'fast-context', 'cloud', 'llm'];

/** Classify a MicroScheduler backend (id + its model) into a human role + location. */
function classifyBackend(id: string, model: string): { role: string; where: string } {
  const dgx = /dgx/i.test(id) || /dgx/i.test(model);
  const where = /deepseek|_api/i.test(id) ? 'cloud' : dgx ? 'DGX' : 'local';
  let role = 'llm';
  if (/embed|nomic/i.test(model)) role = 'embeddings';
  else if (/gemma/i.test(model) || /perception|vision/i.test(id)) role = 'perception';
  else if (/fastcontext/i.test(model) || /fastcontext/i.test(id)) role = 'fast-context';
  else if (/orchestrator/i.test(model)) role = 'orchestrator';
  else if (/qwen3\.?6|qwen36/i.test(model)) role = 'reasoning';
  else if (/deepseek/i.test(model) || /_api/i.test(id)) role = 'cloud';
  return { role, where };
}

/** Short family label for a model id (for the compact bar chips). */
function shortFamily(model: string): string {
  if (/orchestrator/i.test(model)) return 'orch';
  if (/embed|nomic/i.test(model)) return 'embed';
  if (/gemma/i.test(model)) return (model.match(/gemma[\d.]*/i)?.[0] || 'gemma').toLowerCase();
  if (/qwen3\.?6|qwen36/i.test(model)) return 'qwen3.6';
  if (/fastcontext/i.test(model)) return 'fastctx';
  if (/deepseek/i.test(model)) return 'deepseek';
  return model.split(/[-_]/)[0].toLowerCase() || 'model';
}

/** Reduce the raw MS backend snapshot to one entry per role (the real model topology). */
export function modelsFromSnapshot(backends: Record<string, any>): ModelEntry[] {
  const byRole = new Map<string, ModelEntry>();
  for (const [id, b] of Object.entries(backends)) {
    const mlist: string[] = Array.isArray(b?.models) ? b.models : [];
    const model = mlist.find((m) => /tuned/i.test(m)) || mlist[0]
      || (/deepseek|_api/i.test(id) ? 'deepseek' : '');
    if (!model) continue;
    const { role, where } = classifyBackend(id, model);
    // Keep the first backend seen per role; prefer a healthy one if a later dup is healthier.
    const existing = byRole.get(role);
    if (!existing || (!existing.healthy && b?.healthy)) {
      byRole.set(role, { role, model, where, healthy: !!b?.healthy });
    }
  }
  return [...byRole.values()].sort(
    (a, z) => (ROLE_ORDER.indexOf(a.role) + 1 || 99) - (ROLE_ORDER.indexOf(z.role) + 1 || 99));
}

/** Gather a full live status snapshot. Every sub-fetch degrades to null/empty —
 *  never throws — so a partial fleet still produces a useful banner. */
export async function gatherStatus(client: GenesisClient, config: ShellConfig): Promise<StatusInfo> {
  const backend = await client.detectBackend().catch(() => null);
  const host = (() => {
    try { return new URL(config.genesisUrl).host; } catch { return config.genesisUrl; }
  })();

  const info: StatusInfo = {
    genesisHost: host,
    online: !!backend && backend.type !== 'unknown',
    backendType: backend?.type || 'unknown',
    backendName: backend?.name || 'offline',
    services: backend?.services,
    agents: backend?.agents,
    serviceLines: [],
    models: [],
  };

  const portOf = (u: string) => { try { return new URL(u).port || (u.startsWith('https') ? '443' : '80'); } catch { return ''; } };
  const probes = buildProbes(config, discoverLocalServices());
  const [status, reasoning, snapshot, probeResults, actions] = await Promise.all([
    client.getStatus().catch(() => null),
    client.get('/reasoning/status').catch(() => null),
    client.getBackendSnapshot().catch(() => null),
    Promise.all(probes.map(async (p) => ({ name: p.name, up: await probeHealth(p.url), port: portOf(p.url) }))),
    // Joins the EXISTING parallel fetch rather than adding a second round-trip, so
    // it costs nothing on the critical path and a failure cannot delay the banner.
    client.getActions(5, 'pending', 'critical').catch(() => null),
  ]);

  info.serviceLines = probeResults;

  // getActions normalises the envelope AND applies the priority filter client-side
  // (the endpoint has no priority param and silently ignores one), so this is
  // already a plain array of genuinely-critical cards.
  const cards: any[] = actions || [];
  if (cards.length) {
    info.criticalActions = {
      total: cards.length,
      // Two titles maximum. NO EMOJI in this string: neo-blessed measures an emoji
      // as ONE cell while the terminal renders two, which shifts every following
      // column and garbles the bordered banner.
      titles: cards.slice(0, 2).map((c: any) => String(c?.title || 'untitled').slice(0, 58)),
    };
  }

  // Re-probe anything that looked down with a much more patient timeout. At
  // launch the fleet is under cold-start load (model warmup + 250+ services), and
  // heavy compounds — notably SecurityCore serving Identity — routinely miss the
  // first 4s window and get false-flagged DOWN even though they answer a second
  // later. This runs only when something looked down, so an all-up fleet stays fast.
  const downNames = info.serviceLines.filter(s => !s.up).map(s => s.name);
  if (downNames.length) {
    await Promise.all(downNames.map(async (name) => {
      const probe = probes.find(p => p.name === name);
      if (probe && await probeHealth(probe.url, 9000)) {
        const sl = info.serviceLines.find(s => s.name === name);
        if (sl) sl.up = true;
      }
    }));
  }

  // A successful /status (or /reasoning, or the MS snapshot) is PROOF we're
  // connected to a live Genesis — even when detectBackend()'s /health-shape
  // heuristic mis-classifies it as "unknown/offline" (Genesis minimal-mode health
  // doesn't carry generation_ready/tracked_services). Trust the live data over the
  // probe so the header doesn't say "offline" while showing 258 services + models.
  if (status || reasoning || snapshot) {
    info.online = true;
    if (info.backendType === 'unknown') info.backendType = 'genesis';
    if (!info.backendName || info.backendName === 'offline') info.backendName = 'Genesis';
  }

  // The endpoint we're talking to is UP by definition — a concurrent health probe
  // can still flake (cold-start load, http-vs-https first try, the warmup hammering
  // the box), which would otherwise show the absurd "DOWN: Genesis".
  if (info.online) {
    const connectedNames = info.backendType === 'genesis'
      ? ['Genesis', 'Gateway']
      : [info.backendName, 'Gateway'];
    for (const sl of info.serviceLines) {
      if (connectedNames.includes(sl.name)) sl.up = true;
    }
  }
  if (status) {
    info.health = status.health || (info.online ? 'healthy' : undefined);
    info.version = status.version;
    if (info.services == null) info.services = status.tracked_services ?? status.count;
  }
  if (reasoning && !reasoning.error) {
    const slots = (reasoning.routing?.model_slots || {}) as Record<string, string>;
    info.orchestratorModel = slots.model || reasoning.model;
    info.reasoningModel = slots.reasoning_model;
    info.profile = reasoning.display_name || reasoning.active_profile;
    info.isLocal = !(reasoning.cost_per_1k_tokens > 0);
  }
  if (snapshot?.backends) {
    const pick = pickServingModel(snapshot.backends);
    if (pick) info.serving = `${pick.model} @ ${pick.where}`;
    info.models = modelsFromSnapshot(snapshot.backends);
  }
  if (snapshot?.pool) {
    info.poolFree = snapshot.pool.available_for_user ?? snapshot.pool.available;
    info.poolTotal = snapshot.pool.total_slots ?? snapshot.pool.total;
  }

  return info;
}

/** One clickable segment of the persistent status bar. `text` carries ANSI colour;
 *  `plain` is the same content with no escapes, used for click hit-testing + width. */
export interface BarSegment { key: string; text: string; plain: string; }

/** Compact, single-line segments for the PERSISTENT clickable status bar. This is
 *  the whole fleet picture in one row — no scrolling, no bleeding into the chat. Each
 *  segment has an action key the TUI wires to a click (node/models/fabric → detail
 *  popup, portrait → toggle Aither). */
export function formatStatusBar(info: StatusInfo): BarSegment[] {
  const segs: BarSegment[] = [];
  const push = (key: string, glyphColored: string, glyphPlain: string, styled: string, plain: string) =>
    segs.push({ key, text: glyphColored + ' ' + styled, plain: glyphPlain + ' ' + plain });
  const violet = TC.rgb(178, 130, 255);  // Aither's signature accent for her own segment

  // brand — persistent gradient wordmark; click = command palette (COMPACT)
  push('brand', TC.rgb(64, 132, 255)('◉'), '◉', gradient('AI'), 'AI');

  // node — backend status (one line, minimal details to reduce clutter)
  const dot = info.online ? chalk.green('●') : chalk.red('●');
  const name = (info.backendName || 'genesis').toLowerCase();
  const health = info.online ? 'up' : 'down';
  push('node', dot, '●',
    chalk.bold(name) + chalk.dim(` · ${health}`),
    name + ` · ${health}`);

  // models — ONE representative model (click → full list)
  if (info.models.length) {
    const m = info.models[0];  // just the primary model
    const fam = shortFamily(m.model);
    const status = m.healthy ? '' : chalk.dim(' *');
    push('models', accent('◈'), '◈',
      accent(fam) + status,
      fam + (m.healthy ? '' : ' *'));
  }

  // fabric — service health (compact)
  const total = info.serviceLines.length;
  if (total) {
    const up = info.serviceLines.filter(s => s.up).length;
    const down = total - up;
    const glyphC = down ? chalk.yellow('■') : chalk.green('■');
    push('fabric', glyphC, '■',
      down ? chalk.yellow(`${up}/${total}`) : chalk.green(`${up}/${total}`),
      `${up}/${total}`);
  }

  // Aither — click or Ctrl+P to toggle the inline portrait (keep at end)
  push('portrait', violet('❤'), '❤', violet('portrait'), 'portrait');

  return segs;
}

/** The full FLEET STATUS readout (rendered in the click-to-open viewer): the node
 *  header, EVERY model backend grouped by role + location, and EVERY probed service
 *  endpoint with its port + health. This is the "see all the endpoints" view. */
export function formatStatusLines(info: StatusInfo): string[] {
  const lines: string[] = [];
  const H = (s: string) => accent(chalk.bold(s));
  const whereTag = (w: string) => w === 'DGX' ? TC.rgb(178, 130, 255)('DGX')
    : w === 'cloud' ? chalk.yellow('cloud') : chalk.green('local');

  // ── node header ──
  const dot = info.online ? chalk.green('◉') : chalk.red('◉');
  const health = info.online
    ? (info.health === 'ok' || info.health === 'healthy' ? chalk.green('online') : chalk.yellow(info.health || 'up'))
    : chalk.red('offline');
  lines.push('  ' + dot + ' ' + chalk.bold(info.backendName || 'Genesis') + chalk.dim(' @ ' + info.genesisHost)
    + '   ' + health + (info.version ? chalk.dim(' ' + info.version) : '')
    + (info.services != null ? chalk.dim(`   ·   ${info.services} services`) : '')
    + (info.agents != null ? chalk.dim(`   ·   ${info.agents} agents`) : '')
    + (info.poolTotal != null ? chalk.dim(`   ·   pool ${info.poolFree ?? '?'}/${info.poolTotal}`) : ''));

  // ── models: one row per role, model id + where it runs ──
  if (info.models.length) {
    lines.push('');
    lines.push('  ' + H('MODELS') + chalk.dim(`   ${info.models.length} backends`));
    for (const m of info.models) {
      const d = m.healthy ? chalk.green('●') : chalk.red('○');
      lines.push('     ' + d + ' ' + chalk.dim(m.role.padEnd(13)) + accent(m.model.padEnd(26)) + whereTag(m.where));
    }
  }

  // ── services: every probed endpoint, port + up/down ──
  if (info.serviceLines.length) {
    const up = info.serviceLines.filter(s => s.up).length;
    lines.push('');
    lines.push('  ' + H('SERVICES') + chalk.dim(`   ${up}/${info.serviceLines.length} online`));
    for (const s of info.serviceLines) {
      const d = s.up ? chalk.green('●') : chalk.red('○');
      const namePad = s.name.padEnd(16);
      lines.push('     ' + d + ' ' + (s.up ? namePad : chalk.red(namePad)) + (s.port ? chalk.dim(':' + s.port) : ''));
    }
  }

  // ── Human-actionable cards ───────────────────────────────────────────────
  // Rendered LAST so it is the final thing on screen before the prompt. Omitted
  // entirely when there is nothing pending: a permanent "0 pending" line is noise
  // that trains the eye to skip the whole region, which is the failure mode that
  // made 18,087 real cards invisible in the first place.
  // ASCII-only marker (see the emoji/blessed note in gatherStatus).
  if (info.criticalActions?.total) {
    const n = info.criticalActions.total;
    lines.push('');
    lines.push('  ' + chalk.red.bold('! ACTION REQUIRED') +
      chalk.dim(`   ${n} critical card${n === 1 ? '' : 's'} pending  —  /actions`));
    for (const t of info.criticalActions.titles) {
      lines.push('     ' + chalk.red('-') + ' ' + chalk.yellow(t));
    }
  }

  return lines;
}
