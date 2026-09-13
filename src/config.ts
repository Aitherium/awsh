import { readFileSync, existsSync } from 'node:fs';
import { join } from 'node:path';
import { homedir } from 'node:os';
import { randomUUID } from 'node:crypto';
import { getActiveToken, getActiveUser, ensureRootProfile, isRootProvisioningAllowed, type AuthUser } from './auth.js';

export type BackendType = 'genesis' | 'adk' | 'unknown';

/**
 * Inference routing mode:
 *   'auto'    — Genesis /chat/stream when reachable (full agentic pipeline:
 *               tools, memory, effort), else the gateway's raw /v1/chat/completions.
 *   'genesis' — always the Genesis-orchestrated pipeline.
 *   'raw'     — always raw model inference (bypass Genesis; hit the gateway's
 *               OpenAI-compatible /v1/chat/completions → MicroScheduler/vLLM).
 *               This is the portable path: works on any endpoint with internet +
 *               an aither_sk_live_* key, no local Genesis required.
 */
export type InferenceMode = 'auto' | 'genesis' | 'raw';

/**
 * A direct OpenAI-compatible provider the shell talks to WITHOUT the AitherOS
 * pipeline — e.g. DeepSeek. When set, inference goes straight to `llmUrl` with
 * `model`, authenticated by THIS provider's key (not the AitherOS token). This is
 * what makes `--deepseek` / `/deepseek` work standalone with just an API key, no
 * fleet required. Keys come from env (never hardcoded — secret-safety rule).
 */
export interface ProviderOverride {
  /** Display id, e.g. 'deepseek'. */
  name: string;
  /** OpenAI-compatible base, e.g. https://api.deepseek.com/v1. */
  llmUrl: string;
  /** Model id, e.g. deepseek-chat (flash) or deepseek-reasoner. */
  model: string;
  /** Bearer API key for THIS provider (from env/vault). Absent → 401 w/ guidance. */
  apiKey?: string;
}

/** Build the DeepSeek provider override. `variant`: 'flash'|'chat' → deepseek-chat
 *  (fast V3), 'reasoner'|'r1' → deepseek-reasoner (R1); anything else is used as a
 *  literal model id. Key from DEEPSEEK_API_KEY / AITHER_DEEPSEEK_API_KEY. */
export function deepseekProvider(variant?: string): ProviderOverride {
  const v = (variant || 'flash').toLowerCase();
  const model = v === 'reasoner' || v === 'r1' ? 'deepseek-reasoner'
    : v === 'flash' || v === 'chat' || v === 'v3' || v === '' ? 'deepseek-chat'
    : variant!;  // explicit model id passthrough
  return {
    name: 'deepseek',
    llmUrl: (process.env.DEEPSEEK_BASE_URL || 'https://api.deepseek.com/v1').replace(/\/+$/, ''),
    model,
    apiKey: process.env.DEEPSEEK_API_KEY || process.env.AITHER_DEEPSEEK_API_KEY || undefined,
  };
}

/** Build the Moonshot Kimi provider override. `variant`: 'k3'|'max'|'' → kimi-k3
 *  (launch model, OpenAI-compatible); anything else is used as a literal model id.
 *  Key from MOONSHOT_API_KEY / KIMI_API_KEY / AITHER_MOONSHOT_API_KEY. */
export function kimiProvider(variant?: string): ProviderOverride {
  const v = (variant || 'k3').toLowerCase();
  const model = v === 'k3' || v === 'max' || v === 'kimi' || v === '' ? 'kimi-k3'
    : variant!;  // explicit model id passthrough
  return {
    name: 'kimi',
    llmUrl: (process.env.MOONSHOT_BASE_URL || 'https://api.moonshot.ai/v1').replace(/\/+$/, ''),
    model,
    apiKey: process.env.MOONSHOT_API_KEY || process.env.KIMI_API_KEY
      || process.env.AITHER_MOONSHOT_API_KEY || undefined,
  };
}

export interface ShellConfig {
  genesisUrl: string;
  defaultAgent: string;
  sessionId: string;
  historyFile: string;
  model?: string;
  identityUrl: string;
  /** Name of the brain pack loaded via `awsh <pack>`, if any. */
  packName?: string;
  /** Absolute path to that pack's manifest. Carried so the REPL can find the
   *  repo root WITHOUT process.cwd(): the shell is normally launched from the
   *  user's home directory, and a pack's app_script is resolved relative to
   *  the root -- so a wrong root reads as 'the app script is missing'. */
  packManifest?: string;
  /** True when that pack declares an app (app_script). The shell offers /gui
   *  only then -- a command for a capability the pack does not have sends the
   *  user somewhere that will tell them nothing exists. Derived from the
   *  manifest so a new pack needs no shell change. */
  packDeclaresApp?: boolean;
  /** The pack's app_secret_file, when it declares one. Presence is what
   *  makes /password available -- a password command for a pack with no
   *  password can only tell the user nothing exists. */
  packSecretFile?: string;
  /** Commands the launched pack contributes, verbatim from its manifest.
   *  Empty for a pack that declares none, which is all 82 of them today. */
  packCommands?: { name: string; description?: string; run?: string; url?: string }[];
  /** That pack's system prompt, sent as the first system message. */
  packPrompt?: string;
  /** Human title from the pack manifest, shown as the shell's wordmark. */
  packTitle?: string;
  /** The pack's `identity:` — sent as `persona` on the genesis path, which
   *  selects a configured agent server-side rather than prompting for one. */
  packIdentity?: string;
  /** MCP gateway base URL (mcp.aitherium.com on remote endpoints). */
  mcpUrl: string;
  /** Inference routing — Genesis-orchestrated vs raw model (default 'auto'). */
  inferenceMode: InferenceMode;
  /** Raw-mode LLM endpoint (the gateway's /v1, or MicroScheduler). Falls back
   *  to genesisUrl/AITHER_LLM_URL when unset. */
  llmUrl: string;
  /** When true, no silent root — a real device-flow login is required. */
  requireAuth: boolean;
  authToken: string | null;
  authUser: AuthUser | null;
  /** Detected backend type — set after first health probe. */
  backendType: BackendType;
  /** Backend display name (e.g. agent name from ADK, "Genesis" for full stack). */
  backendName: string;
  /** CLI-level overrides (--will, --effort, --safety, --private, --image). */
  effort?: number;
  safetyLevel?: string;
  privateMode?: boolean;
  /** Base64 data URL image attachments from --image flag. */
  imageAttachments?: string[];
  /** Resume: session id to continue (set by --continue/--resume/--session). */
  resumeSessionId?: string;
  /** True when the session was resumed. */
  resumed?: boolean;
  /** Headless print mode (-p/--print): one-shot, scriptable. */
  printMode?: boolean;
  /** Headless output format. */
  outputFormat?: 'text' | 'json' | 'stream-json';
  /** True when the endpoint was chosen EXPLICITLY (env var, config file, or
   *  --gateway). Pinned endpoints are honored as-is; only the unpinned DEFAULT
   *  (local Genesis) is eligible for automatic cloud failover. */
  endpointPinned?: boolean;
  /** Set once the resolver has auto-failed-over from a dead local backend to the
   *  public cloud gateway. Drives the non-blocking "using cloud" announce and
   *  lets mid-session failover avoid re-switching in a loop. */
  autoFailover?: boolean;
  /** Direct provider override (DeepSeek, etc). When set, inference bypasses the
   *  AitherOS pipeline entirely and hits this provider with its own key. */
  provider?: ProviderOverride;
  /** Per-role model/API overrides: orchestrator (fast), reasoning (slow/expensive),
   *  perception (vision/multimodal). When a role-specific provider is configured,
   *  inference for that role uses its llmUrl/model/apiKey instead of the default. */
  providers?: Partial<Record<'orchestrator' | 'reasoning' | 'perception', ProviderOverride>>;
}

/** The always-on public edge the shell fails over to when no local backend is
 *  reachable. This MUST be the host that actually serves OpenAI-compatible
 *  inference at /v1/chat/completions — verified live: gateway.aitherium.com
 *  (service "aitheros-gateway") answers with 401 unauthenticated (real route),
 *  whereas mcp.aitherium.com is a coming-soon placeholder whose /v1 returns an
 *  HTML page → the shell would silently render "(no response)". Override with
 *  AITHER_CLOUD_URL. */
/**
 * The agent this shell asks when nothing else names one.
 *
 * Deliberately ONE occurrence, and overridable: the default is a serving name on
 * the fleet this CLI ships against, so every extra literal is both a place to
 * drift and a platform detail repeated into a published artifact. Point it
 * elsewhere with $AWSH_DEFAULT_AGENT.
 */
export const DEFAULT_AGENT = process.env.AWSH_DEFAULT_AGENT || 'aither-orchestrator';

export const CLOUD_URL = (process.env.AITHER_CLOUD_URL || 'https://gateway.aitherium.com')
  .replace(/\/+$/, '');

/** Public MCP tool gateway (separate edge from inference). Not required for chat;
 *  the command registry degrades to the bundled commands.json when it's absent.
 *  Override with AITHER_CLOUD_MCP_URL. */
const CLOUD_MCP_URL = (process.env.AITHER_CLOUD_MCP_URL || `${CLOUD_URL}/mcp`).replace(/\/+$/, '');

/** Public identity/device-login edge (SecurityCore). When failover lands on cloud
 *  because local is down, /login MUST NOT target the dead local identity service
 *  (127.0.0.1:8115) — repoint it here. Verified live: idp.aitherium.com/health →
 *  SecurityCore 200; device flow is /auth/device/code. Override AITHER_IDENTITY_URL. */
export const CLOUD_IDENTITY_URL = (process.env.AITHER_CLOUD_IDENTITY_URL || 'https://idp.aitherium.com')
  .replace(/\/+$/, '');

/** True if a URL is loopback/private (still the local default, safe to repoint). */
function isLoopback(url: string): boolean {
  try {
    const h = new URL(url).hostname;
    return h === 'localhost' || h === '127.0.0.1' || h === '::1' ||
      /^10\./.test(h) || /^192\.168\./.test(h) ||
      /^172\.(1[6-9]|2\d|3[01])\./.test(h) ||
      h.endsWith('.local') || h.endsWith('.internal');
  } catch { return false; }
}

/** Resolve a per-role provider from fileConfig keys + environment variables.
 *  Role-specific config keys: {role}_url, {role}_model, {role}_key_env (names an env var).
 *  Env overrides: AITHER_{ROLE}_URL, AITHER_{ROLE}_MODEL, AITHER_{ROLE}_KEY.
 *  Returns undefined if the role is unconfigured. */
export function roleProvider(
  role: 'orchestrator' | 'reasoning' | 'perception',
  fileConfig: Record<string, string>,
): ProviderOverride | undefined {
  const upper = role.toUpperCase();
  // Flat keys from shell.yaml: orchestrator_url, orchestrator_model, orchestrator_key_env
  const fileUrl = fileConfig[`${role}_url`];
  const fileModel = fileConfig[`${role}_model`];
  const fileKeyEnv = fileConfig[`${role}_key_env`];

  // Env var overrides: AITHER_ORCHESTRATOR_URL, AITHER_ORCHESTRATOR_MODEL, AITHER_ORCHESTRATOR_KEY
  const envUrl = process.env[`AITHER_${upper}_URL`];
  const envModel = process.env[`AITHER_${upper}_MODEL`];
  const envKey = process.env[`AITHER_${upper}_KEY`];
  const envKeyEnv = process.env[`AITHER_${upper}_KEY_ENV`];

  const url = envUrl || fileUrl;
  const model = envModel || fileModel;
  const keyEnvName = envKeyEnv || fileKeyEnv;

  // Must have at least url + model to be valid
  if (!url || !model) return undefined;

  // Resolve the API key: if keyEnvName is set, look it up; otherwise empty
  const apiKey = keyEnvName ? process.env[keyEnvName] : envKey;

  return {
    name: role,
    llmUrl: url.replace(/\/+$/, ''),
    model,
    apiKey,
  };
}

/** Repoint a config at the public cloud gateway (raw inference + MCP tools). Used
 *  by the startup resolver AND by mid-session failover in the client. Idempotent;
 *  never forces a blocking login (sets `autoFailover` so the caller can announce
 *  and offer /login instead). Explicit mcp/llm URLs are preserved. */
export function applyCloudFallback(config: ShellConfig, url: string = CLOUD_URL): void {
  const base = url.replace(/\/+$/, '');
  config.genesisUrl = base;
  config.mcpUrl = config.mcpUrl || (base === CLOUD_URL ? CLOUD_MCP_URL : `${base}/mcp`);
  config.llmUrl = config.llmUrl || `${base}/v1`;
  config.inferenceMode = 'raw';       // cloud edge = raw /v1, no local Genesis pipeline
  config.backendType = 'adk';         // gateway/OpenAI-compatible code path
  config.backendName = 'AitherGateway';
  // Repoint /login at the PUBLIC identity edge — but only if it's still the local
  // default. Otherwise the "run /login" we offer would hit a dead 127.0.0.1:8115.
  if (isLoopback(config.identityUrl)) config.identityUrl = CLOUD_IDENTITY_URL;
  config.autoFailover = true;
}

export function loadConfig(): ShellConfig {
  const home = homedir();
  const configDir = join(home, '.aither');
  const configFile = join(configDir, 'shell.yaml');

  let fileConfig: Record<string, string> = {};
  if (existsSync(configFile)) {
    try {
      const content = readFileSync(configFile, 'utf-8');
      // Split on /\r?\n/, NOT '\n'. shell.yaml is written CRLF on Windows; a bare
      // '\n' split leaves a trailing '\r', and in JS '.' does NOT match '\r' (it
      // is a line terminator), so the '$' anchor never matched and EVERY line was
      // silently dropped — the entire config file was ignored on Windows
      // (api_url/mcp_url/identity_url/model all fell back to defaults).
      for (const line of content.split(/\r?\n/)) {
        const match = line.match(/^(\w+):\s*(.+)$/);
        if (match) fileConfig[match[1]] = match[2].trim().replace(/^["']|["']$/g, '');
      }
    } catch { /* ignore bad config */ }
  }

  // Load auth from shared ~/.aither/auth.json.
  // Normally auto-provision root (like Linux console login). But when
  // AITHER_REQUIRE_AUTH is set (remote endpoints), do NOT — leave the session
  // unauthenticated so the shell forces a real device-flow login.
  const requireAuth = !isRootProvisioningAllowed();
  let authToken = getActiveToken();
  if (!authToken && !requireAuth) {
    ensureRootProfile();
    authToken = getActiveToken();
  }
  const authUser = getActiveUser();

  // --gateway / AITHER_GATEWAY_URL: one knob to become a portable thin client
  // pointed at the public gateway for BOTH tools and inference. It defaults the
  // API/MCP/LLM URLs to the gateway and forces raw inference unless overridden.
  const gatewayUrl = (process.env.AITHER_GATEWAY_URL || fileConfig.gateway_url || '').replace(/\/+$/, '');

  // AITHER_API_URL is the canonical env var; AITHER_GENESIS_URL is legacy alias.
  // An endpoint from ANY explicit source (env, config file, or --gateway via
  // gatewayUrl) is "pinned" — honored as-is. Only the bare 127.0.0.1 DEFAULT
  // (nothing set) is eligible for automatic cloud failover.
  const explicitEndpoint = process.env.AITHER_API_URL
    || process.env.AITHER_GENESIS_URL
    || fileConfig.api_url
    || fileConfig.genesis_url
    || gatewayUrl;
  const apiUrl = explicitEndpoint || 'http://127.0.0.1:8001';

  const rawMode = (process.env.AITHER_INFERENCE_MODE || fileConfig.inference_mode || '').toLowerCase();
  const inferenceMode: InferenceMode =
    rawMode === 'genesis' || rawMode === 'raw' || rawMode === 'auto'
      ? (rawMode as InferenceMode)
      : (gatewayUrl ? 'raw' : 'auto');

  const mcpUrl = process.env.AITHER_MCP_URL
    || fileConfig.mcp_url
    || (gatewayUrl ? `${gatewayUrl}/mcp` : '');

  const llmUrl = process.env.AITHER_LLM_URL
    || fileConfig.llm_url
    || (gatewayUrl ? `${gatewayUrl}/v1` : '');

  // Build per-role provider map: each role can have its own model/endpoint/key
  const providers: Partial<Record<'orchestrator' | 'reasoning' | 'perception', ProviderOverride>> = {};
  for (const role of ['orchestrator', 'reasoning', 'perception'] as const) {
    const prov = roleProvider(role, fileConfig);
    if (prov) providers[role] = prov;
  }

  return {
    genesisUrl: apiUrl,
    defaultAgent: process.env.AITHER_AGENT || fileConfig.default_agent || 'aither',
    sessionId: randomUUID(),
    historyFile: join(configDir, 'shell_history'),
    model: process.env.AITHER_MODEL || fileConfig.model || undefined,
    identityUrl: process.env.AITHER_IDENTITY_URL || fileConfig.identity_url || 'http://127.0.0.1:8115',
    mcpUrl,
    inferenceMode,
    llmUrl,
    requireAuth,
    authToken,
    authUser,
    backendType: 'unknown',
    backendName: '',
    endpointPinned: !!explicitEndpoint,
    providers: Object.keys(providers).length > 0 ? providers : undefined,
  };
}

// ── Active config bridge ──────────────────────────────────────────────────
// A process-wide reference to the loaded config so deep helpers (e.g. MCP tool
// invocation in commands.ts) can resolve mcpUrl/authToken without threading
// `config` through every call site. Set once at REPL/headless startup.

let _activeConfig: ShellConfig | null = null;

export function setActiveConfig(config: ShellConfig): void {
  _activeConfig = config;
}

export function getActiveConfig(): ShellConfig | null {
  return _activeConfig;
}
