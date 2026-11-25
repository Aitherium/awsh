/**
 * AitherShell HTTP + SSE client.
 * Pure Node.js — no browser APIs, no React.
 *
 * Works against any AitherOS-compatible backend:
 *   - Genesis (full AitherOS stack)
 *   - ADK server (standalone agent via the `adk-serve` console script)
 *   - Any server implementing /chat/stream SSE protocol
 *
 * Chat routing is handled by the backend's /chat/stream endpoint.
 * This client is a thin SSE consumer — no trivial intercept,
 * no fallback chains, no Veil dependency.
 */

import { groundingForTurn } from './grounding.js';
import { activeWorkspaceLabel } from './workspace-context.js';
import type { BackendType, ProviderOverride } from './config.js';
import { getActiveConfig, applyCloudFallback, DEFAULT_AGENT, cloudSignInHint, localDaemonBootingNote } from './config.js';
import { ThinkFilter } from './think-filter.js';
import { buildSituation } from './situation.js';
import { readFileSync } from 'node:fs';
import { join, dirname } from 'node:path';
import { homedir } from 'node:os';
import { request as httpsRequest } from 'node:https';
import { Readable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import { formatLaneProgress, type SpineQueueDetail } from './omnibox.js';

/* ── The spine (MicroScheduler) — https://127.0.0.1:8150, AitherNet CA, nothing else ── */

/** Every AitherOS model call routes through the spine. HTTPS only, on the IPv4 loopback:
 *  `localhost` resolves to ::1 first on Windows and the spine refuses there (~2 s lost per
 *  call), and plain http:// into a TLS listener hangs until the socket closes -- the old
 *  candidate list (https on localhost, then plain http, both on port 8150) was one slow refusal
 *  and one hang. */
export const SPINE_URL = 'https://127.0.0.1:8150';
/** Who the spine sees: a person at the desk. Its "desk" prefix is one of the
 *  interactive sources the spine keeps reserved slots for. */
export const SPINE_SOURCE = 'desk:awsh';

const LOOPBACK_NAMES = new Set(['localhost', '127.0.0.1', '::1', '[::1]', '0.0.0.0']);

/** The spine origin: AITHER_LLM_URL when it is an https URL (a remote fleet spine), with a
 *  loopback name pinned to 127.0.0.1; otherwise SPINE_URL. A plain http:// value is never
 *  dialled -- it is the hang this replaces. Any trailing /v1 is dropped. */
export function spineBaseUrl(env: NodeJS.ProcessEnv = process.env): string {
  const raw = (env.AITHER_LLM_URL || '').trim();
  if (!raw) return SPINE_URL;
  try {
    const u = new URL(raw);
    if (u.protocol !== 'https:') return SPINE_URL;
    if (LOOPBACK_NAMES.has(u.hostname.toLowerCase())) u.hostname = '127.0.0.1';
    return u.origin;
  } catch { return SPINE_URL; }
}

/** Does `url` address the spine (any spelling of loopback :8150, or the configured origin)? */
export function isSpineUrl(url: string, env: NodeJS.ProcessEnv = process.env): boolean {
  try {
    const u = new URL(url);
    if (u.port === '8150' && LOOPBACK_NAMES.has(u.hostname.toLowerCase())) return true;
    return u.origin === new URL(spineBaseUrl(env)).origin;
  } catch { return false; }
}

/** `url` with a dead spine spelling (http://, localhost, ::1) moved onto the spine origin.
 *  Path and query are kept; a URL that is not the spine is returned unchanged. */
export function normalizeSpineUrl(url: string, env: NodeJS.ProcessEnv = process.env): string {
  if (!isSpineUrl(url, env)) return url;
  try {
    const u = new URL(url);
    return spineBaseUrl(env) + u.pathname.replace(/\/+$/, '') + u.search;
  } catch { return url; }
}

/** Where the AitherNet CA may be, best first. Pure: every root is an argument. */
export function spineCaCandidates(opts: {
  env?: NodeJS.ProcessEnv; home?: string; here?: string;
} = {}): string[] {
  const env = opts.env ?? process.env;
  const home = opts.home ?? homedir();
  const out: string[] = [];
  const add = (p: string | undefined) => { if (p && !out.includes(p)) out.push(p); };
  add((env.AITHER_CA_BUNDLE || '').trim() || undefined);
  add((env.NODE_EXTRA_CA_CERTS || '').trim() || undefined);
  const root = (env.AITHEROS_ROOT || '').trim();
  if (root) {
    add(join(root, 'Library', 'Data', 'tls', 'ca-chain.pem'));
    add(join(root, 'AitherOS', 'Library', 'Data', 'tls', 'ca-chain.pem'));
  }
  // This file inside the monorepo: .PRODUCTS/.AITHERSHELL/cli/{src,dist}/client.{ts,js}
  if (opts.here) add(join(opts.here, '..', '..', '..', '..', 'AitherOS', 'Library', 'Data', 'tls', 'ca-chain.pem'));
  add(join(home, '.aither', 'tls', 'ca-chain.pem'));
  add('/app/AitherOS/Library/Data/tls/ca-chain.pem');
  return out;
}

function _hereDir(): string | undefined {
  try { return dirname(fileURLToPath(import.meta.url)); } catch { return undefined; }
}

/** Every readable CA PEM among the candidates (de-duplicated), or [] when there is none.
 *  All of them are trusted together: an older copy in ~/.aither/tls must not stop a
 *  current repo CA from validating. */
export function loadSpineCa(candidates: string[] = spineCaCandidates({ here: _hereDir() })): string[] {
  const pems: string[] = [];
  for (const p of candidates) {
    try {
      const pem = readFileSync(p, 'utf-8');
      if (pem.includes('BEGIN CERTIFICATE') && !pems.includes(pem)) pems.push(pem);
    } catch { /* not there */ }
  }
  return pems;
}

/** The runtime's own fetch, captured at load (see spineFetch). */
const NATIVE_FETCH = globalThis.fetch;

export interface SpineInit {
  method?: string;
  headers?: Record<string, string>;
  body?: string;
  signal?: AbortSignal;
}

/**
 * fetch() for the spine, verified against the AitherNet CA. Returns a standard Response
 * (streaming body included), so callers read it exactly like fetch's.
 *
 * Node's global fetch cannot take a CA per request, and NODE_EXTRA_CA_CERTS is read once
 * at process start (main.ts sets it too late to matter), so spine calls only ever worked
 * because main.ts relaxed TLS process-wide for loopback. This verifies instead:
 * rejectUnauthorized is explicit, so NODE_TLS_REJECT_UNAUTHORIZED=0 cannot weaken it, and
 * with no CA on disk it refuses rather than dialling unverified.
 */
export function spineFetch(url: string, init: SpineInit = {},
  ca?: string[]): Promise<Response> {
  // An injected fetch (a test stub, a host that wraps fetch) is honoured, so every
  // suite that stubs globalThis.fetch keeps owning the network. The URL is still moved
  // onto the https spine origin first.
  if (globalThis.fetch !== NATIVE_FETCH) return globalThis.fetch(normalizeSpineUrl(url), init);
  const pems = ca ?? loadSpineCa();
  return new Promise((resolve, reject) => {
    if (!pems.length) {
      reject(new Error(
        'no AitherNet CA found for the spine (set AITHER_CA_BUNDLE, or install ' +
        'ca-chain.pem in ~/.aither/tls/); the spine is never dialled unverified'));
      return;
    }
    let u: URL;
    try { u = new URL(normalizeSpineUrl(url)); } catch (e) { reject(e); return; }
    if (u.protocol !== 'https:') { reject(new Error(`the spine is https-only: ${u.origin}`)); return; }
    const req = httpsRequest({
      protocol: 'https:',
      hostname: u.hostname.replace(/^\[|\]$/g, ''),
      port: u.port || 443,
      path: u.pathname + u.search,
      method: init.method || 'GET',
      headers: init.headers,
      ca: pems,
      rejectUnauthorized: true,
      signal: init.signal,
    }, (res) => {
      const headers = new Headers();
      for (const [k, v] of Object.entries(res.headers)) {
        if (v != null) headers.set(k, Array.isArray(v) ? v.join(', ') : String(v));
      }
      const status = res.statusCode || 502;
      const noBody = status === 204 || status === 304 || (init.method || 'GET') === 'HEAD';
      if (noBody) res.resume();
      resolve(new Response(noBody ? null : (Readable.toWeb(res) as unknown as ReadableStream),
        { status, statusText: res.statusMessage || '', headers }));
    });
    req.on('error', reject);
    if (init.body != null) req.write(init.body);
    req.end();
  });
}

/** What to tell the user when an opt-in direct provider refuses. Never "buy/export a key":
 *  measured 2026-11-12 the DeepSeek account answers 402 Payment Required, and the local
 *  stack (spine -> Bonsai, gemma4, DeepSeek-V4 on the DGX) is the default that works. */
export function providerRefusal(name: string, status: number): string {
  const why = status === 402 ? 'its account has no credit (HTTP 402)'
    : `it refused the credentials (HTTP ${status})`;
  return `${name} did not answer: ${why}. ` +
    'Drop --provider to use the local stack (the spine at https://127.0.0.1:8150).';
}

/** Event types that mean the answer has started: progress stops being useful then. */
const ANSWER_EVENTS = new Set(['token', 'answer', 'final_answer', 'answer_segment', 'message',
  'complete', 'done']);

/**
 * Re-yield `inner`, and while no answer has arrived, ask `probe` every `everyMs` (first
 * after `firstMs`) and yield what it says as a `status` event (phase `spine_queue`).
 * The renderer shows a status message in its spinner, the omnibox in its ticker, so a
 * turn queued behind a full lane says "queued on llamacpp_local (2 of 3)" instead of
 * sitting silent for two minutes. A probe that fails or repeats itself yields nothing.
 */
export async function* withSpineProgress(
  inner: AsyncGenerator<SSEEvent>,
  probe: () => Promise<string | null>,
  opts: { firstMs?: number; everyMs?: number } = {},
): AsyncGenerator<SSEEvent> {
  const firstMs = opts.firstMs ?? 2000;
  const everyMs = opts.everyMs ?? 2000;
  let pending = inner.next();
  let answered = false;
  let finished = false;
  let last = '';
  let nextProbe = Date.now() + firstMs;
  try {
    while (true) {
      if (answered) {
        const r = await pending;
        if (r.done) { finished = true; return; }
        yield r.value;
        pending = inner.next();
        continue;
      }
      let timer: ReturnType<typeof setTimeout> | undefined;
      const tick = new Promise<'tick'>((res) => {
        timer = setTimeout(() => res('tick'), Math.max(0, nextProbe - Date.now()));
      });
      const r = await Promise.race([pending, tick]).finally(() => clearTimeout(timer));
      if (r === 'tick') {
        nextProbe = Date.now() + everyMs;
        const line = await probe().catch(() => null);
        if (line && line !== last) {
          last = line;
          yield { type: 'status', data: { type: 'status', phase: 'spine_queue', message: line } };
        }
        continue;
      }
      if (r.done) { finished = true; return; }
      if (ANSWER_EVENTS.has(r.value.type)) answered = true;
      yield r.value;
      pending = inner.next();
    }
  } finally {
    if (!finished) {
      // The consumer stopped early: close the inner stream; a read still in flight must
      // not surface later as an unhandled rejection.
      pending.catch(() => {});
      inner.return(undefined).catch(() => {});
    }
  }
}

/**
 * The platform's session credential for THIS machine.
 *
 * Measured 2026-08-21: the shell held a 17-character token in ~/.aither/auth.json
 * that the gateway answered 401 to, so every turn ended with "Cloud gateway
 * requires sign-in - run /login" while the header still showed the cached user
 * as signed in. A valid bearer was sitting in the SAME directory the whole time,
 * minted by the platform's own device-flow tool, answering 200 to the exact
 * request that had just been refused. Nothing in this CLI knew the file existed.
 *
 * So a 401 here is not evidence that the user must log in. It is evidence that
 * the token WE chose was rejected -- a different claim -- and telling someone to
 * authenticate when they already are is the worst possible version of it.
 */
function sessionBearer(): string | null {
  try {
    const value = readFileSync(join(homedir(), '.aither', 'session-bearer'), 'utf-8').trim();
    return value || null;
  } catch {
    return null;
  }
}

/** A /proc/net/tcp{,6} address as text; an IPv4-mapped IPv6 address as its IPv4. */
function decodeProcAddr(hex: string): string {
  const v4 = (h: string) => [6, 4, 2, 0].map((i) => parseInt(h.slice(i, i + 2), 16)).join('.');
  if (hex.length === 8) return v4(hex);
  // Four 32-bit words, each in host (little-endian) order.
  const bytes: number[] = [];
  for (let w = 0; w < 32; w += 8) {
    for (const i of [6, 4, 2, 0]) bytes.push(parseInt(hex.slice(w + i, w + i + 2), 16));
  }
  const zeros = (a: number, b: number) => bytes.slice(a, b).every((x) => x === 0);
  if (zeros(0, 10) && bytes[10] === 0xff && bytes[11] === 0xff) return bytes.slice(12).join('.');
  if (zeros(0, 16)) return '::';
  if (zeros(0, 15) && bytes[15] === 1) return '::1';
  const groups: string[] = [];
  for (let i = 0; i < 16; i += 2) groups.push(((bytes[i] << 8) | bytes[i + 1]).toString(16));
  return groups.join(':');
}

/**
 * Every loopback address a client dialling `host` may actually reach, else [] (not
 * loopback). `localhost` is BOTH loopbacks: resolvers try ::1 and 127.0.0.1, and
 * glibc/systemd-resolved answer any `*.localhost` name the same way (RFC 6761). The
 * unspecified addresses dial this machine too: Linux connects 0.0.0.0 to 127.0.0.1
 * and :: to ::1.
 */
export function connectTargets(host: string): string[] {
  host = host.replace(/^\[|\]$/g, '').replace(/\.$/, '').toLowerCase();
  if (host === 'localhost' || host === 'localhost.localdomain' || host.endsWith('.localhost')) {
    return ['127.0.0.1', '::1'];
  }
  if (host === '::1' || host === '::') return ['::1'];
  if (host === '0.0.0.0') return ['127.0.0.1'];
  let v4 = host;
  const mappedHex = /^::ffff:([0-9a-f]{1,4}):([0-9a-f]{1,4})$/.exec(host);
  if (mappedHex) {
    const hi = parseInt(mappedHex[1], 16);
    const lo = parseInt(mappedHex[2], 16);
    v4 = [hi >> 8, hi & 0xff, lo >> 8, lo & 0xff].join('.');
  } else if (host.startsWith('::ffff:')) {
    v4 = host.slice(7);
  }
  return /^127(\.\d{1,3}){3}$/.test(v4) ? [v4] : [];
}

/**
 * The uid of EVERY LISTEN socket on `port` that could take a connection to one of
 * `targets` -- bound to the target itself or to a wildcard (0.0.0.0, ::) -- from tcp
 * and tcp6, IPv4-mapped rows included. [] = no such listener; null = the table could
 * not be read (not Linux).
 */
export function listenerUids(port: number, targets: string[],
  procNet: string = '/proc/net'): number[] | null {
  const v6 = targets.some((t) => t.includes(':'));
  const v4 = targets.some((t) => !t.includes(':'));
  const uids: number[] = [];
  let seen = false;
  for (const name of ['tcp', 'tcp6']) {
    let rows: string[];
    try { rows = readFileSync(join(procNet, name), 'ascii').split('\n').slice(1); } catch { continue; }
    seen = true;
    for (const row of rows) {
      const cols = row.trim().split(/\s+/);
      if (cols.length < 8 || cols[3] !== '0A') continue;
      const at = cols[1].lastIndexOf(':');
      if (parseInt(cols[1].slice(at + 1), 16) !== port) continue;
      const addr = decodeProcAddr(cols[1].slice(0, at));
      const wildcard = (addr === '0.0.0.0' && v4) || (addr === '::' && (v4 || v6));
      if (targets.includes(addr) || wildcard) uids.push(Number(cols[7]));
    }
  }
  return seen ? uids : null;
}

/** The header an awdk agent daemon reads its owner's local credential from. */
export const LOCAL_TOKEN_HEADER = 'X-Aither-Local-Token';

/**
 * The owner's local credential for an awdk daemon on THIS machine -- ONLY when
 * `baseUrl` is loopback, so it can never be sent off the box.
 *
 * awdk's daemon (adk/local_auth.py) mints ~/.aither/daemon-token (0600) and, on an
 * offline box, refuses every caller that cannot present it: "loopback" names a
 * machine, not a person, and any local user's process could otherwise drive the
 * owner's agent. Reading the file proves we run as the owner.
 *
 * A loopback port is first-come: another account can bind it while our daemon is
 * down, or bind the OTHER loopback (`localhost` reaches 127.0.0.1 and ::1). Where the
 * kernel says who listens, EVERY reachable listener must be ours, and no listener at
 * all withholds too. Where it cannot say (not Linux), the loopback rule alone applies.
 */
export function localDaemonToken(baseUrl: string, home: string = homedir(),
  procNet: string = '/proc/net',
  uid: number | null = typeof process.getuid === 'function' ? process.getuid() : null,
): string | null {
  let targets: string[] = [];
  let port = 0;
  try {
    const u = new URL(baseUrl);
    targets = connectTargets(u.hostname);
    port = Number(u.port) || (u.protocol === 'https:' ? 443 : 80);
  } catch { return null; }
  if (targets.length === 0) return null;
  if (uid !== null) {
    const uids = listenerUids(port, targets, procNet);
    if (uids !== null && (uids.length === 0 || uids.some((u) => u !== uid))) return null;
  }
  try {
    const value = readFileSync(join(home, '.aither', 'daemon-token'), 'utf-8').trim();
    return value || null;
  } catch {
    return null;
  }
}

export interface SSEEvent {
  type: string;
  data: Record<string, any>;
}

export interface ClarificationResponse {
  plan_id: string;
  gate_id: string;
  answers: Record<string, string> | string;
}

export interface StreamChatOpts {
  agent?: string;
  /** All @mentioned agents (for group-chat fan-out). */
  mentions?: string[];
  sessionId?: string;
  model?: string;
  signal?: AbortSignal;
  /** LLM scheduling priority: 'user' (foreground), 'background', 'batch'. */
  priority?: 'user' | 'background' | 'batch';
  /** Auto-populated when answering a pending clarification gate. */
  clarificationResponse?: ClarificationResponse;
  /** Previous session context for RLM continuity. */
  sessionContext?: { summary: string; tools_used: string[]; model: string; errors: string[] };
  /** Effort level 1-10 for routing (higher = deeper reasoning / quality). */
  effort?: number;
  /** Safety level override: 'unrestricted' | 'casual' | 'professional'. */
  safetyLevel?: string;
  /** Private mode — hides prompt from logging/training. */
  privateMode?: boolean;
  /** Base64 data URL image attachments for vision analysis. */
  attachments?: string[];
  /** Max effort cap (prevents agentic upgrade at 7+). undefined = uncapped. */
  maxEffort?: number;
  /** Extra SYSTEM content for this turn (a pack prompt, the shell's live
   *  situation block). Appended AFTER the backend's own system prompt so the
   *  stable prefix stays cacheable. */
  systemAdditions?: string[];
  /** Set true to send this turn WITHOUT the shell situation block (tests,
   *  or a caller that already supplied its own). Default: attached. */
  noSituation?: boolean;
  /** Skip the platform grounding block (grounding.ts). */
  noGrounding?: boolean;
  /** Ask the backend to reason before answering (`metadata.enable_thinking`).
   *  The MicroScheduler honours it; a backend that does not simply ignores it. */
  thinking?: boolean;
  /** Model to retry with ONCE when the gateway refuses `model` (400 unknown on
   *  an older gateway, 403 below its tier). Not used on any other failure. */
  fallbackModel?: string;
  /** Explicit LLM role for provider selection: orchestrator (fast/cheap),
   *  reasoning (slow/expensive), perception (vision/multimodal). When set,
   *  uses the role-specific provider config if available. */
  role?: 'orchestrator' | 'reasoning' | 'perception';
}

export interface BackendInfo {
  type: BackendType;
  name: string;
  version?: string;
  agent?: string;
  llmBackend?: string;
  generationReady?: boolean;
  slotsAvailable?: number;
  services?: number;
  agents?: number;
  /** Backend serves the genesis-compatible agent pipeline at /chat/stream
   *  (ADK daemon does; the edge gateway — also typed 'adk' — does not). */
  hasAgentStream?: boolean;
}

/** OpenAI chat content part (text or image). */
export type ContentPart =
  | { type: 'text'; text: string }
  | { type: 'image_url'; image_url: { url: string } };

/** The gateway route that reads images. */
export const VISION_MODEL = 'aither-vision';

/** A user message's content: plain text, or text plus one image part per data URL. */
export function userContent(message: string, attachments?: string[]): string | ContentPart[] {
  if (!attachments?.length) return message;
  return [
    { type: 'text', text: message },
    ...attachments.map((url): ContentPart => ({ type: 'image_url', image_url: { url } })),
  ];
}

export class GenesisClient {
  baseUrl: string;
  private _authToken: string | null = null;
  private _tenantId: string | null = null;
  private _userId: string | null = null;
  private _backend: BackendInfo | null = null;

  constructor(baseUrl: string) {
    this.baseUrl = baseUrl.replace(/\/+$/, '');
  }

  /** Repoint the client (e.g. when --gateway changes the endpoint after
   *  construction). Clears the cached backend so the next call re-detects. */
  setBaseUrl(url: string): void {
    this.baseUrl = url.replace(/\/+$/, '');
    this._backend = null;
  }

  /** Mid-session failover: when a call to a LOCAL/loopback backend fails to
   *  connect, repoint config + client at the public cloud gateway (raw /v1) so
   *  the turn can complete. Returns true if it switched. Guards against loops
   *  (pinned endpoint, already-failed-over, or a non-local base) so it fires at
   *  most once and never against an explicit user choice. */
  private _tryCloudFailover(): boolean {
    const cfg = getActiveConfig();
    // Offline (air-gapped): never fail over to a public edge mid-turn. The turn fails
    // with the local error, which names the local backend that died.
    if (!cfg || cfg.offline || cfg.endpointPinned || cfg.autoFailover) return false;
    let host = '';
    try { host = new URL(this.baseUrl).hostname; } catch { return false; }
    const isLocal =
      host === 'localhost' || host === '127.0.0.1' || host === '::1' ||
      /^10\./.test(host) || /^192\.168\./.test(host) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(host) ||
      host.endsWith('.local') || host.endsWith('.internal');
    if (!isLocal) return false;
    applyCloudFallback(cfg);            // sets raw mode + cloud /v1 + /mcp + autoFailover
    this.setBaseUrl(cfg.genesisUrl);    // clears cached backend
    return true;
  }

  /** Mid-session LOCAL failover: the mirror of _tryCloudFailover. When a call to a
   *  REMOTE endpoint fails to connect (the internet is down, measured 2026-11-17: a
   *  crash reboot left the NIC without DHCP and every turn died "fetch failed" against
   *  mcp.aitherium.com while the local agent daemon :9001 was healthy), repoint at the
   *  local daemon and finish the turn there. Fires at most once per session; never for a
   *  direct provider, raw mode or AWSH_HONOR_REMOTE_PIN=1. */
  private _localFailoverDone = false;
  private async _tryLocalFailover(failedUrl: string): Promise<string | null> {
    const cfg = getActiveConfig();
    if (!cfg || this._localFailoverDone || cfg.provider) return null;
    if ((process.env.AWSH_HONOR_REMOTE_PIN || '').trim() === '1') return null;
    if (process.env.AITHERSHELL_USE_ADK === '0') return null;
    // raw mode chosen by the user is a thin-client choice; raw set by a cloud failover is not.
    if (cfg.inferenceMode === 'raw' && !cfg.autoFailover) return null;
    let host = '';
    try { host = new URL(failedUrl).hostname; } catch { return null; }
    if (host === 'localhost' || host === '127.0.0.1' || host === '::1') return null;
    this._localFailoverDone = true;
    const { findLocalAgentDaemon } = await import('./backend-resolver.js');
    const daemon = await findLocalAgentDaemon();
    if (!daemon) return null;
    cfg.endpointPinned = false;
    cfg.genesisUrl = daemon;
    cfg.llmUrl = '';
    cfg.inferenceMode = 'auto';
    this.setBaseUrl(daemon);
    return daemon;
  }

  /** Probe the backend and detect its type (Genesis vs ADK vs unknown). */
  async detectBackend(): Promise<BackendInfo> {
    if (this._backend) return this._backend;

    const info: BackendInfo = { type: 'unknown', name: 'offline' };

    try {
      const r = await fetch(`${this.baseUrl}/health`, {
        headers: { Accept: 'application/json' },
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) { this._backend = info; return info; }
      const data = await r.json() as Record<string, any>;

      // Genesis health may return generation_ready/tracked_services (rich mode)
      // OR just { status, service: "AitherGenesis", uptime_sec } (minimal mode).
      // ADK health returns agent, llm_backend, version.
      const isGenesis = data.generation_ready !== undefined
        || data.tracked_services !== undefined
        || data.service === 'AitherGenesis';
      if (isGenesis) {
        info.type = 'genesis';
        info.name = 'Genesis';
        info.generationReady = data.generation_ready;
        info.slotsAvailable = data.vllm_slots_available;

        // Fetch richer status from Genesis /status
        try {
          const statusData = await this.getStatus();
          if (statusData) {
            info.services = statusData.tracked_services ?? statusData.count;
          }
        } catch {}

        // Fetch agent count
        try {
          const agentData = await this.getAgents();
          if (agentData?.agents) info.agents = agentData.agents.length;
        } catch {}

        // LLM status
        try {
          const llmData = await this.getLLMStatus();
          if (llmData) info.llmBackend = llmData.model || llmData.default_model;
        } catch {}
      } else if (typeof data.service === 'string' && /gateway/i.test(data.service)) {
        // AitherOS edge gateway (gateway.aitherium.com) — OpenAI-compatible
        // inference at /v1/chat/completions. Reuse the 'adk' code path (which
        // posts there) and default the model to the orchestrator.
        info.type = 'adk';
        info.name = 'AitherGateway';
        info.agent = DEFAULT_AGENT;
        info.llmBackend = DEFAULT_AGENT;
      } else if (data.agent !== undefined || data.llm_backend !== undefined) {
        info.type = 'adk';
        info.name = data.agent || 'agent';
        info.agent = data.agent;
        info.version = data.version;
        info.llmBackend = data.llm_backend;
        // The ADK daemon serves the full agent pipeline (persona, tools, memory,
        // typed SSE) at /chat/stream — genesis-compatible by design. Prefer it
        // over the bare /v1/chat/completions; streamChat falls back if a legacy
        // daemon 404s the route.
        info.hasAgentStream = true;

        // ADK /agents for count
        try {
          const agentData = await this.getAgents();
          if (agentData?.agents) info.agents = agentData.agents.length;
        } catch {}
      } else {
        // Unknown backend that responds to /health
        info.type = 'unknown';
        info.name = data.name || data.service || 'server';
      }
    } catch {
      // Backend unreachable
    }

    this._backend = info;
    return info;
  }

  /** Get cached backend info (call detectBackend first). */
  get backend(): BackendInfo | null { return this._backend; }

  /** Set auth token for all subsequent requests. */
  setAuthToken(token: string | null, tenantId?: string | null, userId?: string | null): void {
    this._authToken = token;
    if (tenantId !== undefined) this._tenantId = tenantId ?? null;
    if (userId !== undefined) this._userId = userId ?? null;
  }

  /** Build auth headers for requests. */
  private authHeaders(): Record<string, string> {
    const headers: Record<string, string> = {};
    if (this._authToken) {
      headers['Authorization'] = `Bearer ${this._authToken}`;
      // PAT/ACTA keys also go in X-API-Key for billing middleware
      if (this._authToken.startsWith('aither_sk_live_') || this._authToken.startsWith('aither_pat_')) {
        headers['X-API-Key'] = this._authToken;
      }
    }
    if (this._tenantId) {
      headers['X-Tenant-ID'] = this._tenantId;
    }
    if (this._userId) {
      headers['X-User-ID'] = this._userId;
    }
    const local = localDaemonToken(this.baseUrl);
    if (local) {
      headers[LOCAL_TOKEN_HEADER] = local;
    }
    return headers;
  }

  /* ── Streaming chat — POST /chat/stream (SSE) ───────────── */

  async *streamChat(message: string, opts: StreamChatOpts = {}): AsyncGenerator<SSEEvent> {
    const cfg = getActiveConfig();
    // A direct provider never touches the spine, and AWSH_SPINE_PROGRESS=0 turns the
    // queue line off; otherwise a slow first token says where the turn is waiting.
    if (cfg?.provider || process.env.AWSH_SPINE_PROGRESS === '0') {
      yield* this._streamChatInner(message, opts);
      return;
    }
    const model = opts.model || cfg?.model || '';
    yield* withSpineProgress(
      this._streamChatInner(message, opts),
      () => this.spineProgressLine({ source: SPINE_SOURCE, model }),
    );
  }

  /** The spine's queue, as one line for this shell's turn ("queued on llamacpp_local
   *  (2 of 3)"), or null when it cannot say. Never throws. */
  async spineProgressLine(mine: { source?: string; model?: string }): Promise<string | null> {
    try {
      const r = await spineFetch(`${spineBaseUrl()}/llm/queue/detail`,
        { signal: AbortSignal.timeout(1500) });
      if (!r.ok) return null;
      return formatLaneProgress(await r.json() as SpineQueueDetail, mine);
    } catch { return null; }
  }

  private async *_streamChatInner(message: string, opts: StreamChatOpts = {}): AsyncGenerator<SSEEvent> {
    // Genesis AND the ADK daemon serve the agent pipeline at /chat/stream
    // (persona, tools, memory, typed SSE — the same protocol). Only the edge
    // gateway and direct providers are limited to the bare OpenAI-compatible
    // /v1/chat/completions, which sends a single contextless user message —
    // no persona, no tools, no history. Route to the rich path whenever the
    // backend has one; the bare path is the fallback, not the default.
    // detectBackend() is cached (showBanner already warmed it).
    //
    // Inference-mode toggle: 'raw' forces the OpenAI path (bypass the agent
    // pipeline → hit the model directly) even if a rich backend is reachable;
    // 'genesis' forces the orchestrated pipeline; 'auto' picks by detected
    // backend. The raw path is what makes the shell portable — it runs
    // anywhere with internet + an aither_sk_live_* key to the gateway.
    const cfg = getActiveConfig();
    // A direct provider (DeepSeek etc) always goes straight to the OpenAI path.
    if (cfg?.provider) { yield* this._streamOpenAI(message, opts); return; }

    // Auto-detect role for per-role provider selection: explicit role, or infer
    // from effort/attachments. This lets the shell route heavy reasoning to an
    // expensive model (e.g. DeepSeek R1) while keeping fast paths cheap (e.g. Gemma).
    const inferredRole = opts.role || (
      opts.attachments?.length ? 'perception' : (
        opts.effort && opts.effort >= 7 ? 'reasoning' : 'orchestrator'
      )
    );
    const roleProvider = cfg?.providers?.[inferredRole];
    if (roleProvider) { yield* this._streamOpenAI(message, opts, roleProvider); return; }

    const mode = cfg?.inferenceMode || 'auto';
    if (mode === 'raw') { yield* this._streamOpenAI(message, opts); return; }
    const backend = await this.detectBackend();
    // Bare path only for 'adk'-typed backends WITHOUT the agent pipeline (the
    // edge gateway). The ADK daemon falls through to /chat/stream below.
    if (mode === 'auto' && backend.type === 'adk' && !backend.hasAgentStream) { yield* this._streamOpenAI(message, opts); return; }

    // UNKNOWN BACKEND -> the STANDARD route, never the proprietary one.
    //
    // detectBackend() gives up after a 5s /health timeout and returns
    // {type:'unknown', name:'offline'}. Falling through from there lands on
    // /chat/stream, which only genesis and the ADK daemon serve -- so against
    // the gateway the request HANGS until the socket closes, and the shell
    // reports "stream ended before completion - the connection closed
    // mid-turn". Measured 2026-08-21: /chat/stream on the local gateway
    // returned 000 after 35s while /v1/chat/completions answered in ~1s, and
    // that is why the interactive shell could not finish a turn while one-shot
    // mode (which takes the OpenAI path) worked all along.
    //
    // A failed health probe is not evidence of a genesis pipeline. It is no
    // evidence at all, and the honest default for no evidence is the shape
    // every OpenAI-compatible endpoint serves -- including genesis itself,
    // which also exposes /v1. Guessing the proprietary route can only pay off
    // when the guess is right and hangs the turn when it is wrong.
    if (mode === 'auto' && backend.type === 'unknown') { yield* this._streamOpenAI(message, opts); return; }

    // A LOADED PACK MUST REACH THIS PATH TOO.
    //
    // The raw OpenAI path injects the pack's system_prompt as its first system
    // message. This one has no such concept -- it carries `persona` as a field
    // -- and until 2026-08-21 the pack reached NEITHER here. Measured against
    // the real config on the owner's machine (backendType unknown, mode auto,
    // no llmUrl), `awsh gobbonet` printed the GobboNet banner and then sent
    //
    //     {"message":"hi","persona":"aither",...}
    //
    // so the pack changed nothing at all on the path actually in use, and the
    // banner was decorative. The launch-time refusal in packs.ts ("a shell that
    // says it loaded a persona and did not is worse than one that refuses")
    // was being honoured on one path out of two.
    //
    // The field is `system_additions`, a LIST, and that is not cosmetic: the
    // first version of this fix sent `system_prompt`, which reads perfectly at
    // the call site and which genesis DROPS -- chat.py pops a fixed set of keys
    // off a raw dict and `system_prompt` is not among them. It would have been
    // wired, shipped, and inert, with the request body looking exactly right in
    // every log. `system_additions` is what the router actually appends to the
    // LLM's system content (it does `body["system_additions"].append(...)`, so
    // a list is also the shape it expects to find).
    //
    // The identity goes separately as `persona` because the two answer
    // different questions: the identity selects a configured agent server-side,
    // the prompt is the pack's own opinions, and a pack may carry either or
    // both. An explicit @mention still beats the pack -- asking demiurge
    // something inside a gobbonet shell should reach demiurge.
    const _packCfg = getActiveConfig();
    // Every turn carries the shell's live situation (clock, cwd, shell, host) as
    // a system addition — see situation.ts for why a shell must never make the
    // agent guess the time. Pack prompt first (identity), situation LAST (it
    // changes every turn; a moving prefix would bust the backend's prompt cache).
    // Platform grounding (grounding.ts): who David is, his products, which tool answers
    // which question, a live loopback snapshot and awm recall. Skipped when a PACK owns
    // the persona (a gobbonet shell is not Aither) or the caller opts out.
    const _ground = (!_packCfg?.packPrompt && !opts.noGrounding)
      ? await groundingForTurn(message, {
        user: _packCfg?.authUser?.display_name || _packCfg?.authUser?.username || null,
        workspace: activeWorkspaceLabel(),
      })
      : [];
    const _additions = [
      ...(_packCfg?.packPrompt ? [_packCfg.packPrompt] : []),
      ..._ground,
      ...(opts.systemAdditions || []),
      ...(opts.noSituation ? [] : [buildSituation()].filter((x): x is string => !!x)),
    ];
    const body = {
      message,
      persona: opts.agent || _packCfg?.packIdentity || 'aither',
      ...(_additions.length ? { system_additions: _additions } : {}),
      ...(opts.mentions && opts.mentions.length > 1 ? { mentions: opts.mentions } : {}),
      session_id: opts.sessionId,
      ...(opts.model ? { model: opts.model } : {}),
      is_local: true,
      llm_priority: opts.priority || 'user',
      ...(opts.clarificationResponse ? { clarification_response: opts.clarificationResponse } : {}),
      ...(opts.sessionContext ? { session_context: opts.sessionContext } : {}),
      ...(opts.effort ? { effort_level: opts.effort } : {}),
      ...(opts.safetyLevel ? { safety_level: opts.safetyLevel } : {}),
      ...(opts.privateMode ? { private_mode: true } : {}),
      ...(opts.attachments?.length ? { attachments: opts.attachments } : {}),
      ...(opts.maxEffort != null ? { max_effort: opts.maxEffort } : {}),
    };

    let response!: Response;
    const MAX_RETRIES = 3;
    const RETRY_DELAY_MS = 2000;

    for (let attempt = 0; attempt <= MAX_RETRIES; attempt++) {
      try {
        response = await fetch(`${this.baseUrl}/chat/stream`, {
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'X-Caller-Type': 'PLATFORM',
            ...this.authHeaders(),
          },
          body: JSON.stringify(body),
          signal: opts.signal,
        });
      } catch (err: any) {
        // Local backend died mid-session → transparently fail over to the cloud
        // gateway and finish THIS turn there (raw /v1). Never leaves the user
        // staring at "Cannot connect to Genesis" when a reachable fallback exists.
        if (this._tryCloudFailover()) {
          yield { type: 'backend_switch', data: { type: 'backend_switch', message: 'Local backend unreachable — switched to the cloud gateway (mcp.aitherium.com).' } };
          yield* this._streamOpenAI(message, opts);
          return;
        }
        const localD = await this._tryLocalFailover(this.baseUrl);
        if (localD) {
          yield { type: 'backend_switch', data: { type: 'backend_switch', message: `Remote backend unreachable — switched to the local agent daemon (${localD}).` } };
          yield* this._streamChatInner(message, opts);
          return;
        }
        throw new Error(`Cannot connect to Genesis: ${err.message}`);
      }

      // Retry on 503 — but distinguish "still starting" from "pool exhausted"
      if (response!.status === 503 && attempt < MAX_RETRIES) {
        const text503 = await response!.text().catch(() => '');
        let parsed503: any = {};
        try { parsed503 = JSON.parse(text503); } catch {}
        if (parsed503.preflight_rejected || parsed503.detail === 'preflight_capacity_zero') {
          // Pool exhausted — don't retry, tell user immediately
          const retryIn = parsed503.retry_after_s || 30;
          throw new Error(
            `\x1b[33mSystem busy\x1b[0m — LLM pool exhausted (0 available slots). ` +
            `Try again in ~${retryIn}s.\n` +
            `  The pool auto-recovers. If this persists, run: /pool reset`
          );
        }
        await new Promise(r => setTimeout(r, RETRY_DELAY_MS));
        continue;
      }
      break;
    }

    if (!response!.ok) {
      // Legacy ADK daemon without /chat/stream — finish this turn on the bare
      // OpenAI path and stop preferring the rich route for this session.
      if (backend.type === 'adk' && (response!.status === 404 || response!.status === 405)) {
        backend.hasAgentStream = false;
        yield* this._streamOpenAI(message, opts);
        return;
      }
      const text = await response!.text().catch(() => '');
      let detail = `HTTP ${response!.status}`;
      let parsed: any = {};
      try { parsed = JSON.parse(text); detail = parsed.detail || parsed.error || detail; } catch { /* use status */ }
      if (response!.status === 503) {
        if (parsed.preflight_rejected || parsed.generation_ready === false) {
          throw new Error(
            `System busy — LLM pool exhausted. Try again in ~${parsed.retry_after_s || 30}s.`
          );
        }
        throw new Error(`Genesis is still starting up — try again in a few seconds (${detail})`);
      }
      throw new Error(detail);
    }

    yield* this.readSSE(response);
  }

  /* ── Session steering — inject input into active session ──── */

  async steer(sessionId: string, message: string, action: 'append' | 'cancel' = 'append'): Promise<{ ok: boolean; error?: string }> {
    try {
      const r = await fetch(`${this.baseUrl}/chat/steer`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Caller-Type': 'PLATFORM', ...this.authHeaders() },
        body: JSON.stringify({ session_id: sessionId, message, action }),
        signal: AbortSignal.timeout(5000),
      });
      return r.ok ? await r.json() : { ok: false, error: `HTTP ${r.status}` };
    } catch (err: any) {
      return { ok: false, error: err?.message || 'steer failed' };
    }
  }

  /* ── Non-streaming chat ───────────────────────────────────── */

  async chat(message: string, opts: { agent?: string; sessionId?: string } = {}): Promise<any> {
    const res = await fetch(`${this.baseUrl}/chat`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Caller-Type': 'PLATFORM',
        ...this.authHeaders(),
      },
      body: JSON.stringify({
        message,
        session_id: opts.sessionId,
        persona: opts.agent,
        include_context: true,
        is_local: true,
        llm_priority: 'user',
      }),
    });
    return res.json();
  }

  /* ── REST endpoints ───────────────────────────────────────── */

  async getStatus(): Promise<any> {
    return this.get('/status');
  }

  async getServices(): Promise<any> {
    return this.get('/services');
  }

  async getAgents(): Promise<any> {
    return this.get('/agents');
  }

  async forgeDispatch(task: string, opts: { agent?: string; effort?: number } = {}): Promise<any> {
    // Forge is a Genesis-only subsystem (ADK/Node have no /forge endpoints).
    if (this._backend?.type === 'adk') {
      return { error: 'Forge requires the Genesis backend — this endpoint is ADK/Node (chat only).' };
    }
    const res = await fetch(`${this.baseUrl}/forge/dispatch/sync`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', ...this.authHeaders() },
      body: JSON.stringify({
        task,
        agent: opts.agent,
        effort_level: opts.effort ?? 5,
        mode: 'execute',
        parent_agent: 'system',
      }),
    });
    return res.json();
  }

  async getLogs(limit = 20, level?: string, service?: string): Promise<any> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (level) params.set('level', level);
    if (service) params.set('service', service);
    return this.get(`/chronicle/logs?${params}`);
  }

  /**
   * Action inbox — pending escalations awaiting a human.
   *
   * Both call sites (`/actions` in commands.ts, the status banner) already
   * `.catch(() => null)` and render "needs the Genesis backend" on null, so a
   * missing endpoint degrades visibly rather than throwing. `get()` is correct
   * here for the same reason: null means "no inbox available", and the callers
   * say so out loud instead of printing an empty list.
   *
   * This method was CALLED by both sites but never declared — two TS2339
   * errors that failed the typecheck and blocked a clean release build.
   */
  async getActions(limit = 10, status?: string, priority?: string): Promise<any> {
    const params = new URLSearchParams({ limit: String(limit) });
    if (status) params.set('status', status);
    if (priority) params.set('priority', priority);
    return this.get(`/actions?${params}`);
  }

  /* ── Cloud Expeditions (durable jobs) ─────────────────────── */

  // NOTE: use getDetailed (NOT get) — get() collapses any error to `null`, which
  // is indistinguishable from "no expeditions". getDetailed preserves {error} so
  // the REPL can show a real diagnostic (genesis down / 404) vs an empty list.

  /** List all expeditions (unified chat jobs, promoted jobs, real expeditions). */
  async listExpeditions(): Promise<any> {
    return this.getDetailed('/expedition/list');
  }

  /** Get expedition status summary. */
  async getExpeditionStatus(id: string): Promise<any> {
    return this.getDetailed(`/expedition/${id}/status`);
  }

  /** Get expedition tasks. */
  async getExpeditionTasks(id: string): Promise<any> {
    return this.getDetailed(`/expedition/${id}/tasks`);
  }

  /** Steer an expedition with a message (append or hint). */
  async steerExpedition(
    id: string,
    message: string,
    action: 'append' | 'hint' = 'append',
  ): Promise<any> {
    return this.post(`/expedition/${id}/steer`, { message, action });
  }

  /** Stream SSE events from an expedition. */
  async *streamExpeditionEvents(id: string): AsyncGenerator<SSEEvent> {
    try {
      const r = await fetch(`${this.baseUrl}/expedition/${id}/stream`, {
        headers: { 'X-Caller-Type': 'PLATFORM', ...this.authHeaders() },
        signal: AbortSignal.timeout(600_000),  // 10 min timeout for watching
      });
      if (!r.ok) {
        yield {
          type: 'error',
          data: { type: 'error', error: `HTTP ${r.status}` },
        };
        return;
      }
      yield* this.readSSE(r);
    } catch (err: any) {
      yield {
        type: 'error',
        data: { type: 'error', error: err?.message || 'Stream failed' },
      };
    }
  }

  /** GET a JSON document from the spine (https://127.0.0.1:8150 + the AitherNet CA), or
   *  null. ONE address: the old list also tried https://localhost (::1, refused) and
   *  http:// (hangs the TLS listener), so a down spine cost every caller ~2 x timeout. */
  private async _spineJson(path: string, timeoutMs: number): Promise<any> {
    try {
      const r = await spineFetch(`${spineBaseUrl()}${path}`, { signal: AbortSignal.timeout(timeoutMs) });
      return r.ok ? await r.json() : null;
    } catch { return null; }
  }

  async getLLMStatus(): Promise<any> {
    return this._spineJson('/health', 3000);
  }

  /** O(1) cached snapshot of which LLM backends are up and what models they
   *  serve (no live inference) — used for the banner's "model @ where" line. */
  async getBackendSnapshot(): Promise<any> {
    return this._spineJson('/llm/backends/snapshot', 3000);
  }

  /** Warm the orchestrator model with a tiny non-thinking generation so the
   *  first REAL turn isn't cold (the cold model intermittently streams zero
   *  tokens → the eager first pass falls through to the slow grounded path).
   *  Returns the model id + round-trip ms, or null on failure (never throws). */
  async warmupModel(model: string): Promise<{ model: string; ms: number } | null> {
    const payload = {
      model,
      messages: [{ role: 'user', content: 'ok' }],
      max_tokens: 1,
      temperature: 0,
      stream: false,
      metadata: { enable_thinking: false, effort: 1, source: 'shell_warmup', priority: 'background' },
    };
    const t0 = Date.now();
    try {
      const r = await spineFetch(`${spineBaseUrl()}/v1/chat/completions`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(30000),
      });
      if (r.ok) {
        await r.text().catch(() => '');  // drain
        return { model, ms: Date.now() - t0 };
      }
    } catch {}
    return null;
  }

  async getGpuStatus(): Promise<{ zone: string; active: boolean } | null> {
    return this._spineJson('/reasoning/exclusive/status', 2000);
  }

  async getLLMModels(): Promise<any> {
    return (await this._spineJson('/models', 3000)) ?? { models: [] };
  }

  /* ── Helpers ──────────────────────────────────────────────── */

  private async parseErrorResponse(r: Response): Promise<{ error: string; status: number }> {
    const text = await r.text().catch(() => '');
    try {
      const data = JSON.parse(text);
      return { error: data.detail || data.error || `HTTP ${r.status}`, status: r.status };
    } catch {
      return { error: text || `HTTP ${r.status}`, status: r.status };
    }
  }

  async getDetailed(path: string): Promise<any> {
    try {
      const r = await fetch(`${this.baseUrl}${path}`, {
        // X-Caller-Type: PLATFORM — consistent with post/put/patch/delete below.
        // Without it, GETs resolved as anonymous, so /agents was filtered to []
        // by AgentCatalog (public/anonymous → no agents) and the banner showed
        // "0 agents" even though 53 identities are deployable.
        headers: { 'X-Caller-Type': 'PLATFORM', ...this.authHeaders() },
        signal: AbortSignal.timeout(5000),
      });
      if (!r.ok) return this.parseErrorResponse(r);
      return r.json();
    } catch (err: any) {
      return { error: err?.message || 'Request failed', status: 0 };
    }
  }

  async postDetailed(path: string, body: Record<string, any> = {}): Promise<any> {
    try {
      const r = await fetch(`${this.baseUrl}${path}`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json', 'X-Caller-Type': 'PLATFORM', ...this.authHeaders() },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) return this.parseErrorResponse(r);
      return r.json();
    } catch (err: any) {
      return { error: err?.message || 'Request failed', status: 0 };
    }
  }

  /** A request with an explicit method and timeout that PRESERVES the error shape
   *  ({error, status}; status 0 = never reached a server). For control-plane calls
   *  (`aither ops`) whose server side may take longer than getDetailed's 5 s. */
  async requestDetailed(method: 'GET' | 'POST', path: string, body?: Record<string, any>,
                        timeoutMs = 60000): Promise<any> {
    try {
      const headers: Record<string, string> = { 'X-Caller-Type': 'PLATFORM', ...this.authHeaders() };
      if (method === 'POST') headers['Content-Type'] = 'application/json';
      const r = await fetch(`${this.baseUrl}${path}`, {
        method,
        headers,
        body: method === 'POST' ? JSON.stringify(body ?? {}) : undefined,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (!r.ok) return this.parseErrorResponse(r);
      return r.json();
    } catch (err: any) {
      return { error: err?.message || 'Request failed', status: 0 };
    }
  }

  async get(path: string): Promise<any> {
    const result = await this.getDetailed(path);
    return result?.error ? null : result;
  }

  async post(path: string, body: Record<string, any> = {}): Promise<any> {
    const result = await this.postDetailed(path, body);
    return result?.error ? null : result;
  }

  async put(path: string, body: Record<string, any> = {}): Promise<any> {
    try {
      const r = await fetch(`${this.baseUrl}${path}`, {
        method: 'PUT',
        headers: { 'Content-Type': 'application/json', 'X-Caller-Type': 'PLATFORM', ...this.authHeaders() },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        try { return { error: JSON.parse(text).detail || `HTTP ${r.status}` }; } catch { return { error: `HTTP ${r.status}` }; }
      }
      return r.json();
    } catch { return null; }
  }

  async patch(path: string, body: Record<string, any> = {}): Promise<any> {
    try {
      const r = await fetch(`${this.baseUrl}${path}`, {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json', 'X-Caller-Type': 'PLATFORM', ...this.authHeaders() },
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        try { return { error: JSON.parse(text).detail || `HTTP ${r.status}` }; } catch { return { error: `HTTP ${r.status}` }; }
      }
      return r.json();
    } catch { return null; }
  }

  async delete(path: string): Promise<any> {
    try {
      const r = await fetch(`${this.baseUrl}${path}`, {
        method: 'DELETE',
        headers: { 'X-Caller-Type': 'PLATFORM', ...this.authHeaders() },
        signal: AbortSignal.timeout(15000),
      });
      if (!r.ok) {
        const text = await r.text().catch(() => '');
        try { return { error: JSON.parse(text).detail || `HTTP ${r.status}` }; } catch { return { error: `HTTP ${r.status}` }; }
      }
      return r.json();
    } catch { return null; }
  }

  /**
   * Read SSE stream from a fetch Response.
   * Mirrors shell-core's parseSSEChunk / createSSEReader.
   */
  private async *readSSE(response: Response): AsyncGenerator<SSEEvent> {
    // Events after which the turn is OVER — stop reading immediately rather than
    // waiting on the server to close the response body. See TERMINAL_EVENTS use below.
    const TERMINAL_EVENTS = new Set(['complete', 'done', 'error', 'llm_error']);
    let endedEarly = false;
    const body = response.body as ReadableStream<Uint8Array> | null;
    if (!body) throw new Error('No response body');

    const reader = body.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const CHUNK_TIMEOUT_MS = 120_000; // 120s between chunks
    const WARN_TIMEOUT_MS = 60_000;   // warn after 60s of silence
    let lastChunkAt = Date.now();
    let warningSent = false;

    // Retain the in-flight read across a warning-yield so reader.read() is
    // never called twice concurrently (that throws on a locked reader).
    let pendingRead: ReturnType<typeof reader.read> | null = null;
    try {
      while (true) {
        // Race reader.read() against a timeout so the client never hangs
        // if the backend stalls (e.g. reasoning model cold-start, 404 retry loop).
        const readPromise: ReturnType<typeof reader.read> = pendingRead ?? reader.read();
        pendingRead = readPromise;
        // IMPORTANT: keep a handle to the timeout timer and clear it once the
        // chunk arrives. Otherwise every chunk (hundreds per streamed turn) leaks
        // a live 120s timer; the swarm of late, post-settle rejections keeps the
        // event loop hot and is a class of stray-rejection the crash reporter
        // used to turn into process.exit(1).
        let chunkTimer: ReturnType<typeof setTimeout> | null = null;
        const timeoutPromise = new Promise<never>((_, reject) => {
          chunkTimer = setTimeout(() => reject(new Error('SSE chunk timeout')), CHUNK_TIMEOUT_MS);
        });

        // Warn after 60s of silence WITHOUT consuming the read: race a sentinel
        // alongside it so we can surface "still working" and keep waiting.
        let warnTimer: ReturnType<typeof setTimeout> | null = null;
        const racers: Promise<ReadableStreamReadResult<Uint8Array> | { __warn: true }>[] = [readPromise, timeoutPromise];
        if (!warningSent) {
          racers.push(new Promise<{ __warn: true }>((res) => {
            warnTimer = setTimeout(() => res({ __warn: true }), WARN_TIMEOUT_MS);
          }));
        }

        let result: ReadableStreamReadResult<Uint8Array> | { __warn: true };
        try {
          result = await Promise.race(racers);
          if (chunkTimer) clearTimeout(chunkTimer);
          if (warnTimer) clearTimeout(warnTimer);
        } catch (err: any) {
          if (chunkTimer) clearTimeout(chunkTimer);
          if (warnTimer) clearTimeout(warnTimer);
          // A user abort (Ctrl+C) must surface as AbortError to the caller —
          // swallowing it here made Ctrl+C look like a silent timeout.
          if (err?.name === 'AbortError') throw err;
          const silentMs = Date.now() - lastChunkAt;
          if (err?.message === 'SSE chunk timeout') {
            // Timeout — emit a typed timeout event (not a hard error) so the
            // renderer and REPL can check if the agent is still processing.
            yield { type: 'stream_timeout', data: { type: 'stream_timeout', timeout_ms: CHUNK_TIMEOUT_MS, silent_ms: silentMs } };
          } else {
            // Mid-stream transport failure (connection reset — e.g. Genesis or
            // the LB restarted under the turn). This used to be mislabeled as
            // stream_timeout and rendered as NOTHING: the turn looked done and
            // the grounded answer was silently thrown away. Surface it.
            yield {
              type: 'stream_interrupted',
              data: {
                type: 'stream_interrupted',
                error: String(err?.cause?.message || err?.message || err || 'connection lost'),
                silent_ms: silentMs,
              },
            };
          }
          break;
        }

        // Silence warning fired — surface it and keep waiting on the SAME read.
        if ((result as { __warn?: true }).__warn) {
          warningSent = true;
          yield { type: 'stream_warning', data: { type: 'stream_warning', silent_ms: Date.now() - lastChunkAt, message: 'Still working — model may be warming up…' } };
          continue;  // pendingRead retained → no second reader.read()
        }
        pendingRead = null;  // real chunk consumed
        lastChunkAt = Date.now();
        const { done, value } = result as ReadableStreamReadResult<Uint8Array>;
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        // Normalize \r\n → \n (SSE servers may use either)
        buffer = buffer.replace(/\r\n/g, '\n');
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';

        for (const part of parts) {
          if (!part.trim()) continue;
          const event = this.parseBlock(part);
          if (event) {
            yield event;
            // END THE TURN ON THE TERMINAL EVENT — do not wait for the server to
            // close the body. The server may still be finishing tail work after
            // `complete` (memory write, detached enrichment handoff); waiting for
            // the body to end kept `processing` true in the REPL and BLOCKED the
            // next conversational turn. `complete` means the answer is final —
            // that is the turn.
            if (TERMINAL_EVENTS.has(event.type)) { endedEarly = true; return; }
          }
        }
      }

      if (buffer.trim()) {
        const event = this.parseBlock(buffer);
        if (event) yield event;
      }
    } finally {
      // Ended on a terminal event with the body still open — cancel it so the
      // socket is released instead of lingering until GC.
      if (endedEarly) { try { await reader.cancel(); } catch { /* already closed */ } }
      try { reader.releaseLock(); } catch { /* cancel() may have released it */ }
    }
  }

  private parseBlock(block: string): SSEEvent | null {
    let eventType: string | undefined;
    let eventData: Record<string, any> | null = null;
    const dataLines: string[] = [];

    for (const line of block.split('\n')) {
      if (line.startsWith('event: ')) {
        eventType = line.slice(7).trim();
      } else if (line.startsWith('data: ')) {
        // Per the SSE spec, multiple `data:` lines in one event are joined
        // with `\n` — a prior version kept only the LAST line, silently
        // truncating/corrupting any answer whose JSON serialization spans
        // more than one `data:` line (long answers, deeply nested objects).
        dataLines.push(line.slice(6));
      }
    }
    if (dataLines.length > 0) {
      const joined = dataLines.join('\n');
      try {
        eventData = JSON.parse(joined);
      } catch {
        eventData = { raw: joined.trim() };
      }
    }

    if (!eventData) return null;
    if (eventType && !eventData.type) eventData.type = eventType;

    return {
      type: eventData.type || eventType || 'unknown',
      data: eventData,
    };
  }

  /* ── ADK / awnode chat — OpenAI /v1/chat/completions → native events ── */

  /** Stream chat from an OpenAI-compatible backend, translated to native SSEEvents.
   *  optionalRoleProvider: when set, use this provider instead of the default config.provider.
   *  This is used for per-role routing (orchestrator, reasoning, perception). */
  private async *_streamOpenAI(
    message: string,
    opts: StreamChatOpts,
    optionalRoleProvider?: ProviderOverride,
  ): AsyncGenerator<SSEEvent> {
    const messages: Array<{ role: string; content: string | ContentPart[] }> = [];
    // A loaded pack is the FIRST system message. The genesis path carries persona
    // as a field; this bare OpenAI path has no such concept, so without this the
    // pack would change nothing here and `awsh gobbonet` would be a banner over
    // an unchanged assistant.
    const packPrompt = getActiveConfig()?.packPrompt;
    if (packPrompt) messages.push({ role: 'system', content: packPrompt });
    if (opts.sessionContext?.summary) {
      messages.push({ role: 'system', content: `Conversation so far:\n${opts.sessionContext.summary}` });
    }
    for (const add of (opts.systemAdditions || [])) messages.push({ role: 'system', content: add });
    // The shell's live situation block (clock, cwd, shell, host) — same rule as
    // the genesis path: last, so the stable prefix stays cacheable.
    if (!opts.noSituation) {
      const sit = buildSituation();
      if (sit) messages.push({ role: 'system', content: sit });
    }
    // Images ride as OpenAI content parts. Until 2026-10-04 this path sent the text
    // ONLY -- `awsh ask --image shot.png "what is this"` reached the model without the
    // image, and only the genesis path carried `attachments` at all.
    messages.push({ role: 'user', content: userContent(message, opts.attachments) });
    // ONE system message. Gemma-style chat templates (llama.cpp's Bonsai-2, the vision
    // fallback) accept a single leading system turn: measured 2026-10-04, the same image
    // request 502'd with the shell's two system blocks and answered with them joined.
    const sys = messages.filter((m) => m.role === 'system').map((m) => m.content as string);
    if (sys.length > 1) {
      const rest = messages.filter((m) => m.role !== 'system');
      messages.length = 0;
      messages.push({ role: 'system', content: sys.join('\n\n') }, ...rest);
    }

    // A direct provider override (DeepSeek etc) takes precedence: use ITS model,
    // endpoint, and API key — bypassing the AitherOS token/headers entirely.
    // Per-role providers (e.g., reasoning → DeepSeek R1) come second; default config last.
    const provider = optionalRoleProvider || getActiveConfig()?.provider;
    const model = provider?.model
      || opts.model
      // An image turn with no explicit model goes to the vision route: the agent
      // default is the text orchestrator, which 400s on an image part.
      || (opts.attachments?.length ? VISION_MODEL : undefined)
      || this._backend?.agent
      // NOT `name` when detection failed: detectBackend() returns the SENTINEL
      // {type:'unknown', name:'offline'} after a health timeout, and using that
      // as a model id sends `"model":"offline"` -- a name no backend serves, so
      // a turn that was one step from working 400s instead. A sentinel is the
      // absence of an answer, not an answer.
      || (this._backend && this._backend.type !== 'unknown' ? this._backend.name : undefined)
      || DEFAULT_AGENT;
    // A THINKING turn goes non-streamed. Measured 2026-10-03 on :8182, same body
    // but the stream flag: aither-coding + enable_thinking answered "drive - the
    // car needs to be washed" after 59 s non-streamed, and streamed it answered
    // the orchestrator's "walk if it's short" in 0.3 s with no reasoning at all.
    // The scheduler's stream path does not reach the requested backend with
    // thinking, so a streamed thinking turn is a fast wrong answer.
    const body = {
      // An image turn goes non-streamed too: measured 2026-10-04 on :8182 the same
      // aither-vision request answered "CAR WASH 42, red square" with stream:false
      // and {"error": "HTTP 400"} with stream:true (the scheduler's stream path).
      model, messages, stream: !opts.thinking && !opts.attachments?.length,
      // A person typed this: the spine's user priority and the desk source (whose
      // prefix earns its reserved interactive slots). A direct provider is a strict
      // OpenAI-compatible API that may reject an unknown field, so it gets only
      // what it already got.
      ...(provider
        ? (opts.thinking ? { metadata: { enable_thinking: true } } : {})
        : { metadata: {
            priority: opts.priority || 'user', source: SPINE_SOURCE,
            ...(opts.thinking ? { enable_thinking: true } : {}),
          } }),
    };

    // Prefer the provider's endpoint, then the configured raw-inference endpoint
    // (gateway /v1 or MicroScheduler), so 'raw' mode reaches the model even when
    // baseUrl points at Genesis. A spine URL in any dead spelling (http://,
    // localhost) is moved onto https://127.0.0.1:8150 and dialled with the CA.
    const llmUrl = normalizeSpineUrl(
      (provider?.llmUrl || getActiveConfig()?.llmUrl || '').replace(/\/+$/, ''));
    const completionsUrl = llmUrl
      ? `${llmUrl}/chat/completions`
      : `${this.baseUrl}/v1/chat/completions`;
    const doFetch = (url: string, init: SpineInit): Promise<Response> =>
      isSpineUrl(url) ? spineFetch(url, init) : fetch(url, init);

    // Provider key uses a plain Bearer; otherwise the AitherOS caller headers.
    const headers: Record<string, string> = provider
      ? { 'Content-Type': 'application/json', ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}) }
      : { 'Content-Type': 'application/json', 'X-Caller-Type': 'PLATFORM', ...this.authHeaders() };

    let response: Response;
    try {
      response = await doFetch(completionsUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: opts.signal,
      });
    } catch (err: any) {
      const localD = provider ? null : await this._tryLocalFailover(completionsUrl);
      if (localD) {
        yield { type: 'backend_switch', data: { type: 'backend_switch', message: `Inference endpoint unreachable — switched to the local agent daemon (${localD}).` } };
        yield* this._streamChatInner(message, opts);
        return;
      }
      throw new Error(`Cannot connect to inference endpoint (${completionsUrl}): ${err.message}`);
    }
    if (!response.ok && (response.status === 400 || response.status === 403) &&
        !provider && opts.fallbackModel && opts.fallbackModel !== model) {
      yield* this._streamOpenAI(message, { ...opts, model: opts.fallbackModel, fallbackModel: undefined });
      return;
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      // A direct provider is opt-in (--provider / per-role config). Its refusal names
      // the way back to the local stack, never a key to buy: a 402 is an account with
      // no credit, and more keys do not fix that.
      if (provider && (response.status === 401 || response.status === 402 || response.status === 403)) {
        throw new Error(providerRefusal(provider.name, response.status));
      }
      // 401/403 — surface the ACTIONABLE fix.
      if (response.status === 401 || response.status === 403) {
        // Before claiming the user is signed out, try the credential the
        // PLATFORM minted for this machine. Once only, and only when it differs
        // from what was just refused -- retrying the same token would be a
        // second identical 401 dressed up as resilience.
        const fallbackToken = sessionBearer();
        if (fallbackToken && fallbackToken !== this._authToken) {
          this._authToken = fallbackToken;
          const retry = await doFetch(completionsUrl, {
            method: 'POST',
            headers: {
              'Content-Type': 'application/json',
              'X-Caller-Type': 'PLATFORM',
              ...this.authHeaders(),
            },
            body: JSON.stringify(body),
            signal: opts.signal,
          });
          if (retry.ok) {
            yield { type: 'session_start', data: { type: 'session_start', agent: this._backend?.agent || opts.agent || 'agent', model } };
            yield* this._readOpenAISSE(retry, model);
            return;
          }
        }
        throw new Error(cloudSignInHint(localDaemonBootingNote()));
      }
      // ── 5xx on a STREAMING request → retry ONCE without `stream` ──────────
      //
      // Measured 2026-08-20 against BOTH mcp.aitherium.com and the local gateway
      // :8182, byte-identical bodies apart from one key:
      //
      //     {"model":"<default-agent>","messages":[...]}                -> 200
      //     {"model":"<default-agent>","messages":[...],"stream":true}  -> 500
      //
      // So the gateway's SSE path is broken while its non-streaming path is
      // fine. That took out EVERY one-shot the shell makes — `awsh "question"`,
      // the omnibox, and any script piping through it — and it presented as a
      // bare "Inference failed: HTTP 500", which reads as the model being down
      // rather than as a transport fault the client can route around.
      //
      // This is a CLIENT-SIDE workaround for a SERVER-SIDE bug, deliberately
      // narrow: only 5xx, only when we asked for a stream, only one retry, and
      // it does not swallow the failure if the retry also fails. The answer
      // arrives in one chunk rather than token-by-token, which is a visible
      // degradation and the right trade against not answering at all. Remove it
      // when the gateway serves SSE again — and note the 200-vs-500 probe above
      // is how to tell, since nothing else reports this.
      if (response.status >= 500 && body.stream) {
        const started = Date.now();
        const retry = await doFetch(completionsUrl, {
          method: 'POST',
          headers,
          body: JSON.stringify({ ...body, stream: false }),
          signal: opts.signal,
        }).catch(() => null);
        if (retry?.ok) {
          const json: any = await retry.json().catch(() => null);
          const content = json?.choices?.[0]?.message?.content;
          if (content) {
            // Reasoning models emit <think>…</think> INLINE in the message. The
            // streaming path never showed it (it arrives as typed `thinking`
            // events the renderer handles separately), so leaving it here would
            // make the fallback dump a wall of chain-of-thought where the stream
            // showed a sentence — worst on the omnibox, where the whole point is
            // that one typed word gets one short answer.
            //
            // The guard matters more than the strip: a model that emits ONLY
            // reasoning would otherwise be turned into silence, which reads as
            // "it didn't answer" rather than "it answered oddly". Never trade a
            // messy answer for no answer.
            const raw = String(content);
            const stripped = raw.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
            yield {
              type: 'session_start',
              data: { type: 'session_start', agent: this._backend?.agent || opts.agent || 'agent', model },
            };
            yield { type: 'token', data: { type: 'token', t: stripped || raw } };
            yield {
              type: 'complete',
              data: { type: 'complete', model, duration_ms: Date.now() - started, eager: false },
            };
            return;
          }
        }
      }
      throw new Error(`Inference failed: HTTP ${response.status} ${text.slice(0, 200)}`);
    }

    if (!body.stream) {
      const started = Date.now();
      const json: any = await response.json().catch(() => null);
      const raw = String(json?.choices?.[0]?.message?.content ?? '');
      if (!raw.trim()) throw new Error('Inference returned no answer');
      const stripped = raw.replace(/<think(?:ing)?>[\s\S]*?<\/think(?:ing)?>/gi, '').trim();
      const served = String(json?.model || model);
      yield { type: 'session_start', data: { type: 'session_start', agent: this._backend?.agent || opts.agent || 'agent', model: served } };
      yield { type: 'token', data: { type: 'token', t: stripped || raw } };
      yield { type: 'complete', data: { type: 'complete', model: served, duration_ms: Date.now() - started, eager: false } };
      return;
    }

    // Guard the silent-no-op: a 200 that's an HTML page (e.g. a "coming soon"
    // placeholder host, or a captive portal) is NOT an inference stream. Without
    // this the SSE parser finds no `data:` lines and the turn renders a confusing
    // "(no response)". Fail loudly with the endpoint so it's obvious what's wrong.
    const ctype = (response.headers.get('content-type') || '').toLowerCase();
    if (ctype.includes('text/html')) {
      throw new Error(
        `Inference endpoint returned an HTML page, not a chat stream (${completionsUrl}). ` +
        `That host isn't serving /v1 — check AITHER_CLOUD_URL / --gateway.`,
      );
    }

    yield { type: 'session_start', data: { type: 'session_start', agent: this._backend?.agent || opts.agent || 'agent', model } };
    yield* this._readOpenAISSE(response, model);
  }

  /** Parse an OpenAI delta SSE stream into native token/complete events. */
  private async *_readOpenAISSE(response: Response, model: string): AsyncGenerator<SSEEvent> {
    const stream = response.body as ReadableStream<Uint8Array> | null;
    if (!stream) throw new Error('No response body');
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    const think = new ThinkFilter();
    const started = Date.now();
    // MicroScheduler's NATIVE event shape arrives on this path too. Its
    // /v1/chat/completions passes llm_generate's own stream through verbatim
    // when stream:true -- `{"type":"token","t":"..."}` then
    // `{"type":"complete","full_content":"..."}`, no `choices` at all -- and the
    // gateway proxies it byte-for-byte. Measured 2026-10-03: once #11420 stopped
    // the gateway 500ing (which had masked this by forcing the non-stream retry),
    // every omnibox turn got a 200 carrying ~30 tokens and printed "(no answer
    // from the agent)" in 0.3 s, because nothing here read `t`.
    let yielded = false;
    let nativeFinal = '';
    const emit = (text: string): SSEEvent | null => {
      const safe = think.push(text);
      if (!safe) return null;
      yielded = true;
      return { type: 'token', data: { type: 'token', t: safe } };
    };
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = buffer.replace(/\r\n/g, '\n');
        const lines = buffer.split('\n');
        buffer = lines.pop() || '';
        for (const line of lines) {
          const l = line.trim();
          if (!l.startsWith('data:')) continue;
          const payload = l.slice(5).trim();
          if (payload === '[DONE]') continue;
          let json: any;
          try { json = JSON.parse(payload); } catch { continue; /* keep-alives / non-JSON */ }
          const choice = json?.choices?.[0];
          let delta = choice?.delta?.content ?? choice?.message?.content;
          if (!choice && json?.type === 'token') delta = json.t ?? json.token;
          if (!choice && json?.type === 'complete') {
            nativeFinal = String(json.full_content || json.content || '');
          }
          // The gateway reports a failed upstream as `data: {"error": ...}`; a
          // swallowed error is a 200 with no answer, which reads as a mute model.
          const err = json?.error ?? (json?.type === 'error' ? json.message : undefined);
          if (!choice && err) {
            throw new Error(`Inference failed: ${typeof err === 'string' ? err : (err.message || JSON.stringify(err))}`);
          }
          if (delta) {
            // Tag-aware and chunk-safe; see src/think-filter.ts for why this
            // cannot be a per-chunk regex.
            const ev = emit(String(delta));
            if (ev) yield ev;
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
    // A native stream that carried no tokens but a final answer: use it.
    if (!yielded && nativeFinal) {
      const ev = emit(nativeFinal);
      if (ev) yield ev;
    }
    const tail = think.flush();
    if (tail) yield { type: 'token', data: { type: 'token', t: tail } };
    yield { type: 'complete', data: { type: 'complete', model, duration_ms: Date.now() - started, eager: false } };
  }
}
