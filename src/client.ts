/**
 * AitherShell HTTP + SSE client.
 * Pure Node.js — no browser APIs, no React.
 *
 * Works against any AitherOS-compatible backend:
 *   - Genesis (full AitherOS stack)
 *   - ADK server (standalone agent via `adk serve`)
 *   - Any server implementing /chat/stream SSE protocol
 *
 * Chat routing is handled by the backend's /chat/stream endpoint.
 * This client is a thin SSE consumer — no trivial intercept,
 * no fallback chains, no Veil dependency.
 */

import type { BackendType, ProviderOverride } from './config.js';
import { getActiveConfig, applyCloudFallback, DEFAULT_AGENT} from './config.js';
import { ThinkFilter } from './think-filter.js';
import { buildSituation } from './situation.js';
import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';

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
    if (!cfg || cfg.endpointPinned || cfg.autoFailover) return false;
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
    return headers;
  }

  /* ── Streaming chat — POST /chat/stream (SSE) ───────────── */

  async *streamChat(message: string, opts: StreamChatOpts = {}): AsyncGenerator<SSEEvent> {
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
    const _additions = [
      ...(_packCfg?.packPrompt ? [_packCfg.packPrompt] : []),
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

  async getLLMStatus(): Promise<any> {
    try {
      const candidates = [process.env.AITHER_LLM_URL, 'https://localhost:8150', 'http://localhost:8150'].filter(Boolean) as string[];
      for (const base of candidates) {
        try {
          const r = await fetch(`${base}/health`, { signal: AbortSignal.timeout(3000) });
          if (r.ok) return r.json();
        } catch {}
      }
      return null;
    } catch { return null; }
  }

  /** Resolve the MicroScheduler base URL the same way getLLMStatus does. */
  private _msCandidates(): string[] {
    return [process.env.AITHER_LLM_URL, 'https://localhost:8150', 'http://localhost:8150']
      .filter(Boolean) as string[];
  }

  /** O(1) cached snapshot of which LLM backends are up and what models they
   *  serve (no live inference) — used for the banner's "model @ where" line. */
  async getBackendSnapshot(): Promise<any> {
    for (const base of this._msCandidates()) {
      try {
        const r = await fetch(`${base}/llm/backends/snapshot`, { signal: AbortSignal.timeout(3000) });
        if (r.ok) return r.json();
      } catch {}
    }
    return null;
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
    for (const base of this._msCandidates()) {
      const t0 = Date.now();
      try {
        const r = await fetch(`${base}/v1/chat/completions`, {
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
    }
    return null;
  }

  async getGpuStatus(): Promise<{ zone: string; active: boolean } | null> {
    try {
      const candidates = [process.env.AITHER_LLM_URL, 'https://localhost:8150', 'http://localhost:8150'].filter(Boolean) as string[];
      for (const base of candidates) {
        try {
          const r = await fetch(`${base}/reasoning/exclusive/status`, { signal: AbortSignal.timeout(2000) });
          if (r.ok) return r.json();
        } catch {}
      }
      return null;
    } catch { return null; }
  }

  async getLLMModels(): Promise<any> {
    try {
      const candidates = [process.env.AITHER_LLM_URL, 'https://localhost:8150', 'http://localhost:8150'].filter(Boolean) as string[];
      for (const base of candidates) {
        try {
          const r = await fetch(`${base}/models`, { signal: AbortSignal.timeout(3000) });
          if (r.ok) return r.json();
        } catch {}
      }
      return { models: [] };
    } catch { return { models: [] }; }
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
    const messages: Array<{ role: string; content: string }> = [];
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
    messages.push({ role: 'user', content: message });

    // A direct provider override (DeepSeek etc) takes precedence: use ITS model,
    // endpoint, and API key — bypassing the AitherOS token/headers entirely.
    // Per-role providers (e.g., reasoning → DeepSeek R1) come second; default config last.
    const provider = optionalRoleProvider || getActiveConfig()?.provider;
    const model = provider?.model
      || opts.model || this._backend?.agent
      // NOT `name` when detection failed: detectBackend() returns the SENTINEL
      // {type:'unknown', name:'offline'} after a health timeout, and using that
      // as a model id sends `"model":"offline"` -- a name no backend serves, so
      // a turn that was one step from working 400s instead. A sentinel is the
      // absence of an answer, not an answer.
      || (this._backend && this._backend.type !== 'unknown' ? this._backend.name : undefined)
      || DEFAULT_AGENT;
    const body = { model, messages, stream: true };

    // Prefer the provider's endpoint, then the configured raw-inference endpoint
    // (gateway /v1 or MicroScheduler), so 'raw' mode reaches the model even when
    // baseUrl points at Genesis.
    const llmUrl = (provider?.llmUrl || getActiveConfig()?.llmUrl || '').replace(/\/+$/, '');
    const completionsUrl = llmUrl
      ? `${llmUrl}/chat/completions`
      : `${this.baseUrl}/v1/chat/completions`;

    // Provider key uses a plain Bearer; otherwise the AitherOS caller headers.
    const headers: Record<string, string> = provider
      ? { 'Content-Type': 'application/json', ...(provider.apiKey ? { Authorization: `Bearer ${provider.apiKey}` } : {}) }
      : { 'Content-Type': 'application/json', 'X-Caller-Type': 'PLATFORM', ...this.authHeaders() };

    let response: Response;
    try {
      response = await fetch(completionsUrl, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: opts.signal,
      });
    } catch (err: any) {
      throw new Error(`Cannot connect to inference endpoint (${completionsUrl}): ${err.message}`);
    }
    if (!response.ok) {
      const text = await response.text().catch(() => '');
      // 401/403 — surface the ACTIONABLE fix, provider-aware.
      if (response.status === 401 || response.status === 403) {
        if (provider) {
          throw new Error(
            `${provider.name} rejected the request (HTTP ${response.status}). ` +
            `Set an API key: \x1b[36mexport DEEPSEEK_API_KEY=…\x1b[0m (or AITHER_DEEPSEEK_API_KEY), then retry.`,
          );
        }
        // Before claiming the user is signed out, try the credential the
        // PLATFORM minted for this machine. Once only, and only when it differs
        // from what was just refused -- retrying the same token would be a
        // second identical 401 dressed up as resilience.
        const fallbackToken = sessionBearer();
        if (fallbackToken && fallbackToken !== this._authToken) {
          this._authToken = fallbackToken;
          const retry = await fetch(completionsUrl, {
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
        throw new Error(
          `Cloud gateway requires sign-in — run \x1b[36m/login\x1b[0m to authenticate, ` +
          `or start local AitherOS to use the free local backend.`,
        );
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
        const retry = await fetch(completionsUrl, {
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
          try {
            const json = JSON.parse(payload);
            const choice = json.choices?.[0];
            const delta = choice?.delta?.content ?? choice?.message?.content;
            if (delta) {
              // Tag-aware and chunk-safe; see src/think-filter.ts for why this
              // cannot be a per-chunk regex.
              const safe = think.push(String(delta));
              if (safe) yield { type: 'token', data: { type: 'token', t: safe } };
            }
          } catch { /* skip keep-alives / non-JSON */ }
        }
      }
    } finally {
      reader.releaseLock();
    }
    const tail = think.flush();
    if (tail) yield { type: 'token', data: { type: 'token', t: tail } };
    yield { type: 'complete', data: { type: 'complete', model, duration_ms: Date.now() - started, eager: false } };
  }
}
