/**
 * Resolve base URLs + auth headers for the auxiliary AitherOS services the TUI
 * talks to directly (AitherSense affect :8096, AitherVoice :8084).
 *
 * Principle (owner directive): do NOT assume localhost/no-auth. When the shell
 * is pointed at a remote endpoint (gateway.aitherium.com / mcp.aitherium.com),
 * these services must be reached THROUGH the gateway with the shell's API key
 * (aither_sk_live_* → Bearer + X-API-Key), exactly like the main GenesisClient.
 * Only a genuine localhost endpoint uses the direct perception ports over the
 * internal CA (where local calls are unauthenticated by design).
 */

export interface EndpointConfig {
  genesisUrl: string;          // the shell's primary endpoint (localhost or gateway)
  mcpUrl?: string;             // gateway base (mcp.aitherium.com) when remote
  authToken?: string | null;   // aither_sk_live_* / aither_pat_ / bearer
  tenantId?: string | null;
  userId?: string | null;
}

export interface ResolvedEndpoint {
  /** Service root — callers append the action path (e.g. '/synthesize', '/affect'). */
  baseUrl: string;
  /** Auth + tenancy headers to send (empty for local). */
  headers: Record<string, string>;
  /** True when routed through the authenticated gateway (vs. direct local port). */
  remote: boolean;
  /** Fallback URL for local voice (adk bridge at :8085 if AitherVoice :8084 unavailable). */
  fallbackUrl?: string;
}

const LOCAL_HOST = /^(127\.0\.0\.1|localhost|\[?::1\]?)$/i;

function isLocalUrl(url: string): boolean {
  try { return LOCAL_HOST.test(new URL(url).hostname); } catch { return false; }
}

/** Build the same auth headers the GenesisClient sends (Bearer + X-API-Key + tenancy). */
export function authHeaders(cfg: EndpointConfig): Record<string, string> {
  const h: Record<string, string> = {};
  const t = cfg.authToken;
  if (t) {
    h['Authorization'] = `Bearer ${t}`;
    if (t.startsWith('aither_sk_live_') || t.startsWith('aither_pat_')) h['X-API-Key'] = t;
  }
  if (cfg.tenantId) h['X-Tenant-ID'] = cfg.tenantId;
  if (cfg.userId) h['X-User-ID'] = cfg.userId;
  return h;
}

/**
 * Resolve the endpoint for an auxiliary service.
 * - local  → direct perception port over the internal CA (voice :8084/voice, affect :8096)
 *            for voice, fall back to adk bridge at :8085/voice if :8084 unavailable
 * - remote → the gateway origin + service prefix, carrying the API key
 */
export function resolveServiceEndpoint(cfg: EndpointConfig, service: 'voice' | 'affect'): ResolvedEndpoint {
  const remote = !isLocalUrl(cfg.genesisUrl);
  if (!remote) {
    // Genuine local dev: perception services on their own ports, internal CA, no auth.
    // For voice: try AitherVoice :8084 first, fall back to adk bridge :8085
    return {
      baseUrl: service === 'voice' ? 'https://127.0.0.1:8084/voice' : 'https://127.0.0.1:8096',
      headers: {},
      remote: false,
      // adk standalone voice bridge (`adk voice serve`) binds HTTP on loopback
      // (no TLS — secure by network isolation), so the fallback MUST be http://.
      // A https:// fallback here silently fails synth against the http-only bridge
      // while the health probe (which tries both schemes) still reports "available".
      fallbackUrl: service === 'voice' ? 'http://127.0.0.1:8085/voice' : undefined,
    };
  }
  // Remote: route through the gateway with the key. The gateway proxies service
  // prefixes off its origin (…/voice, …/affect). If a route isn't exposed the
  // caller degrades gracefully (voice stays quiet, affect keeps last value).
  const origin = (() => {
    try { return new URL(cfg.mcpUrl || cfg.genesisUrl).origin; }
    catch { return (cfg.mcpUrl || cfg.genesisUrl).replace(/\/+$/, ''); }
  })();
  return {
    baseUrl: service === 'voice' ? `${origin}/voice` : `${origin}/affect`,
    headers: authHeaders(cfg),
    remote: true,
  };
}
