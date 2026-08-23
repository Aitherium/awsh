/**
 * Unit tests for the minimal MCP StreamableHTTP client.
 * Stubs global.fetch — no network, no cloud. Run: npm test
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

// Isolate ~/.aither/auth.json lookups from the real machine BEFORE mcp-client
// (→ auth.js) resolves its module-level AUTH_FILE from homedir(). Without this,
// getActiveToken() could return the developer's real token and mask config tokens.
const tmpHome = mkdtempSync(join(tmpdir(), 'aithershell-test-'));
process.env.USERPROFILE = tmpHome;
process.env.HOME = tmpHome;

const { McpHttpClient, getRemoteMcpClient, resetRemoteMcpClient } =
  await import('../src/mcp-client.ts');

type Captured = { url: string; init: RequestInit; body: any };

const realFetch = globalThis.fetch;

/** Build a fetch stub that replies per JSON-RPC method, capturing requests. */
function stubFetch(
  responder: (method: string, body: any) => { json?: any; sse?: any; sessionId?: string; status?: number },
  captured: Captured[],
) {
  globalThis.fetch = (async (url: any, init: any) => {
    const body = JSON.parse(init.body);
    captured.push({ url: String(url), init, body });
    const r = responder(body.method, body);
    const headers = new Headers();
    if (r.sessionId) headers.set('mcp-session-id', r.sessionId);
    const status = r.status ?? (body.id === undefined ? 202 : 200);
    if (body.id === undefined) {
      // notification — 202 Accepted, empty body
      return new Response(null, { status, headers });
    }
    if (r.sse !== undefined) {
      headers.set('content-type', 'text/event-stream');
      const payload = JSON.stringify({ jsonrpc: '2.0', id: body.id, result: r.sse });
      const stream = new ReadableStream<Uint8Array>({
        start(controller) {
          controller.enqueue(new TextEncoder().encode(`event: message\ndata: ${payload}\n\n`));
          controller.close();
        },
      });
      return new Response(stream, { status, headers });
    }
    headers.set('content-type', 'application/json');
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: body.id, result: r.json }),
      { status, headers },
    );
  }) as typeof fetch;
}

beforeEach(() => resetRemoteMcpClient());
afterEach(() => { globalThis.fetch = realFetch; });

test('getRemoteMcpClient returns null without an mcp URL', () => {
  assert.equal(getRemoteMcpClient(null as any), null);
  assert.equal(getRemoteMcpClient({ mcpUrl: '' } as any), null);
});

test('getRemoteMcpClient caches by (url, token) and rebuilds on change', () => {
  const a = getRemoteMcpClient({ mcpUrl: 'https://mcp.x/mcp', authToken: 't1' } as any);
  const b = getRemoteMcpClient({ mcpUrl: 'https://mcp.x/mcp', authToken: 't1' } as any);
  assert.ok(a && a === b, 'same url+token returns the cached client');
  const c = getRemoteMcpClient({ mcpUrl: 'https://mcp.x/mcp', authToken: 't2' } as any);
  assert.notEqual(a, c, 'token change rebuilds the client');
});

test('listTools initializes, sends auth, and propagates the session id', async () => {
  const captured: Captured[] = [];
  stubFetch((method) => {
    if (method === 'initialize') return { json: { protocolVersion: '2025-06-18' }, sessionId: 'sess-123' };
    if (method === 'tools/list') return { json: { tools: [{ name: 'code_search', description: 'search' }] } };
    return { json: {} };
  }, captured);

  const client = new McpHttpClient('https://mcp.aitherium.com/mcp', 'tok-abc');
  const tools = await client.listTools();

  assert.deepEqual(tools.map(t => t.name), ['code_search']);
  // First call is initialize; auth header present.
  assert.equal(captured[0].body.method, 'initialize');
  assert.equal((captured[0].init.headers as any)['Authorization'], 'Bearer tok-abc');
  // The "initialized" notification carries the captured session id.
  const initialized = captured.find(c => c.body.method === 'notifications/initialized');
  assert.ok(initialized, 'sends notifications/initialized');
  assert.equal((initialized!.init.headers as any)['Mcp-Session-Id'], 'sess-123');
  // tools/list also carries the session id.
  const list = captured.find(c => c.body.method === 'tools/list');
  assert.equal((list!.init.headers as any)['Mcp-Session-Id'], 'sess-123');
});

test('callTool returns the MCP content result', async () => {
  const captured: Captured[] = [];
  stubFetch((method, body) => {
    if (method === 'initialize') return { json: {}, sessionId: 's' };
    if (method === 'tools/call') {
      assert.equal(body.params.name, 'echo');
      assert.deepEqual(body.params.arguments, { msg: 'hi' });
      return { json: { content: [{ type: 'text', text: 'ok' }] } };
    }
    return { json: {} };
  }, captured);

  const client = new McpHttpClient('https://mcp.x/mcp', 't');
  const result = await client.callTool('echo', { msg: 'hi' });
  assert.deepEqual(result.content, [{ type: 'text', text: 'ok' }]);
});

test('parses an SSE (text/event-stream) JSON-RPC reply', async () => {
  stubFetch((method) => {
    if (method === 'initialize') return { json: {}, sessionId: 's' };
    if (method === 'tools/list') return { sse: { tools: [{ name: 'remote_tool' }] } };
    return { json: {} };
  }, []);

  const client = new McpHttpClient('https://mcp.x/mcp', 't');
  const tools = await client.listTools();
  assert.deepEqual(tools.map(t => t.name), ['remote_tool']);
});

test('surfaces a JSON-RPC error from the gateway', async () => {
  stubFetch((method) => {
    if (method === 'initialize') return { json: {} };
    return { json: undefined };
  }, []);
  // Override to inject an error envelope for tools/call.
  globalThis.fetch = (async (_url: any, init: any) => {
    const body = JSON.parse(init.body);
    const headers = new Headers({ 'content-type': 'application/json' });
    if (body.method === 'initialize') {
      return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result: {} }), { status: 200, headers });
    }
    if (body.id === undefined) return new Response(null, { status: 202 });
    return new Response(
      JSON.stringify({ jsonrpc: '2.0', id: body.id, error: { code: -32603, message: 'boom' } }),
      { status: 200, headers },
    );
  }) as typeof fetch;

  const client = new McpHttpClient('https://mcp.x/mcp', 't');
  await assert.rejects(() => client.callTool('x', {}), /boom/);
});
