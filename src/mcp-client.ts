/**
 * Minimal MCP StreamableHTTP client.
 *
 * Talks JSON-RPC to a remote MCP gateway (e.g. https://mcp.aitherium.com/mcp)
 * using the MCP "Streamable HTTP" transport: each request is a POST whose
 * response is either a single `application/json` body or a `text/event-stream`
 * carrying the JSON-RPC reply. No external deps — mirrors client.ts's thin SSE
 * style so the bundle still compiles via `bun build --compile`.
 *
 * Why this exists: the shell's chat backend (genesisUrl) speaks a REST
 * `/tools/call`, but the cloud gateway (config.mcpUrl) speaks the MCP protocol
 * at `/mcp`. When mcpUrl is set we route tool discovery + invocation here so
 * awnode's tools work in-REPL against the cloud workspace.
 */

import type { ShellConfig } from './config.js';
import { getActiveToken } from './auth.js';

const PROTOCOL_VERSION = '2025-06-18';
const CLIENT_INFO = { name: 'aither-shell', version: '1.7.3' };

export interface McpToolDef {
  name: string;
  description?: string;
  inputSchema?: Record<string, any>;
}

export interface McpCallResult {
  content?: Array<{ type: string; text?: string; [k: string]: any }>;
  isError?: boolean;
  [k: string]: any;
}

export class McpHttpClient {
  readonly url: string;
  private token: string | null;
  private sessionId: string | null = null;
  private nextId = 1;
  private initialized = false;
  private initInFlight: Promise<void> | null = null;

  constructor(url: string, token?: string | null) {
    // Strip trailing slashes only — keep the `/mcp` path intact.
    this.url = url.replace(/\/+$/, '');
    this.token = token ?? null;
  }

  /** Send a JSON-RPC request (or notification) and return its `result`. */
  private async rpc(method: string, params?: any, isNotification = false): Promise<any> {
    const id = isNotification ? undefined : this.nextId++;
    const body: Record<string, any> = { jsonrpc: '2.0', method };
    if (params !== undefined) body.params = params;
    if (id !== undefined) body.id = id;

    const headers: Record<string, string> = {
      'Content-Type': 'application/json',
      Accept: 'application/json, text/event-stream',
      'MCP-Protocol-Version': PROTOCOL_VERSION,
    };
    if (this.token) {
      headers['Authorization'] = `Bearer ${this.token}`;
      headers['X-API-Key'] = this.token;
    }
    if (this.sessionId) headers['Mcp-Session-Id'] = this.sessionId;

    let resp: Response;
    try {
      resp = await fetch(this.url, {
        method: 'POST',
        headers,
        body: JSON.stringify(body),
        signal: AbortSignal.timeout(60_000),
      });
    } catch (err: any) {
      throw new Error(`MCP gateway unreachable (${method}): ${err?.message || err}`);
    }

    // The initialize response assigns the session id for subsequent calls.
    const sid = resp.headers.get('mcp-session-id');
    if (sid) this.sessionId = sid;

    if (isNotification) return undefined; // 202 Accepted, no JSON-RPC reply

    if (!resp.ok) {
      const text = await resp.text().catch(() => '');
      if (resp.status === 401 || resp.status === 403) {
        throw new Error(`MCP auth failed (HTTP ${resp.status}) — run \`/login\` or check your token.`);
      }
      throw new Error(`MCP ${method} failed: HTTP ${resp.status} ${text.slice(0, 200)}`);
    }

    const ctype = resp.headers.get('content-type') || '';
    const message = ctype.includes('text/event-stream')
      ? await this.readSseForId(resp, id as number)
      : await resp.json();

    if (message?.error) {
      const e = message.error;
      throw new Error(`MCP ${method} error: ${e?.message || JSON.stringify(e)}`);
    }
    return message?.result;
  }

  /** Read an SSE response body and return the JSON-RPC message matching `id`. */
  private async readSseForId(resp: Response, id: number): Promise<any> {
    const stream = resp.body as ReadableStream<Uint8Array> | null;
    if (!stream) throw new Error('No MCP response body');
    const reader = stream.getReader();
    const decoder = new TextDecoder();
    let buffer = '';
    try {
      while (true) {
        const { done, value } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        buffer = buffer.replace(/\r\n/g, '\n');
        const parts = buffer.split('\n\n');
        buffer = parts.pop() || '';
        for (const part of parts) {
          for (const line of part.split('\n')) {
            if (!line.startsWith('data:')) continue;
            const payload = line.slice(line.indexOf(':') + 1).trim();
            if (!payload) continue;
            try {
              const msg = JSON.parse(payload);
              // Skip server-initiated requests/notifications; we want our reply.
              if (msg && msg.id === id) return msg;
            } catch {
              /* keep-alive or partial — ignore */
            }
          }
        }
      }
    } finally {
      reader.releaseLock();
    }
    throw new Error(`MCP stream ended without a reply for id ${id}`);
  }

  /** Initialize the MCP session (idempotent, single-flight). */
  async connect(): Promise<void> {
    if (this.initialized) return;
    if (this.initInFlight) return this.initInFlight;
    this.initInFlight = (async () => {
      await this.rpc('initialize', {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: {},
        clientInfo: CLIENT_INFO,
      });
      // Best-effort "initialized" notification — some servers require it.
      try {
        await this.rpc('notifications/initialized', undefined, true);
      } catch {
        /* non-fatal */
      }
      this.initialized = true;
    })();
    try {
      await this.initInFlight;
    } finally {
      this.initInFlight = null;
    }
  }

  /** List the tools the authenticated caller is entitled to. */
  async listTools(): Promise<McpToolDef[]> {
    await this.connect();
    const result = await this.rpc('tools/list', {});
    return (result?.tools || []) as McpToolDef[];
  }

  /** Invoke a tool by name. Returns the MCP `{content, isError}` result. */
  async callTool(name: string, args: Record<string, any> = {}): Promise<McpCallResult> {
    await this.connect();
    return (await this.rpc('tools/call', { name, arguments: args })) as McpCallResult;
  }

  /** Cheap reachability + auth check. */
  async ping(): Promise<boolean> {
    try {
      await this.connect();
      return true;
    } catch {
      return false;
    }
  }
}

// ── Singleton keyed by (url, token) ───────────────────────────────────────
// The REPL reuses one session per endpoint; a token/endpoint change rebuilds it.

let _client: McpHttpClient | null = null;
let _key = '';

/**
 * Return a remote MCP client for the active config, or null when no MCP
 * gateway URL is configured (local/Genesis mode uses the chat backend's
 * REST /tools/call instead).
 */
export function getRemoteMcpClient(config: ShellConfig | null | undefined): McpHttpClient | null {
  if (!config?.mcpUrl) return null;
  // Prefer the live token from ~/.aither/auth.json so an in-REPL /login or
  // /logout re-keys the client; fall back to the token captured at load time.
  const token = getActiveToken() ?? config.authToken ?? null;
  const key = `${config.mcpUrl}::${token || ''}`;
  if (_client && _key === key) return _client;
  _client = new McpHttpClient(config.mcpUrl, token);
  _key = key;
  return _client;
}

/** Drop the cached client (e.g. after logout/endpoint change). */
export function resetRemoteMcpClient(): void {
  _client = null;
  _key = '';
}
