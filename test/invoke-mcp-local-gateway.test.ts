/**
 * invokeMcpTool falls back to the LOCAL AitherOS MCP gateway when none is configured.
 *
 * What must hold (measured 2026-11-09 in awnix: with mcpUrl '' every tool went to
 * `/tools/call` on the :8099 demo agent): a located gateway gets the call with the
 * session bearer and the chat backend is not asked; no gateway -> the old
 * `/tools/call` path; offline never probes; a configured gateway is never
 * second-guessed; the probe runs once per process.
 */
import { test, beforeEach, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpHome = mkdtempSync(join(tmpdir(), 'awsh-gw-test-'));
process.env.USERPROFILE = tmpHome;
process.env.HOME = tmpHome;

const { invokeMcpTool, setGatewayLocatorForTest } = await import('../src/commands.ts');
const { setActiveConfig } = await import('../src/config.ts');
const { resetRemoteMcpClient } = await import('../src/mcp-client.ts');

const realFetch = globalThis.fetch;
const GW = 'http://127.0.0.1:8182/mcp';
let seen: Array<{ url: string; auth: string | null; method: string }> = [];

function stubGateway(): void {
  globalThis.fetch = (async (url: any, init: any) => {
    const body = JSON.parse(init.body);
    seen.push({ url: String(url), auth: new Headers(init.headers).get('authorization'), method: body.method });
    if (body.id === undefined) return new Response(null, { status: 202 });
    const result = body.method === 'tools/call'
      ? { content: [{ type: 'text', text: JSON.stringify({ counts: { demiurge: 2 } }) }] }
      : { protocolVersion: '2025-03-26', capabilities: {} };
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: body.id, result }),
      { status: 200, headers: { 'content-type': 'application/json' } });
  }) as typeof fetch;
}

function genesis() {
  const calls: any[] = [];
  return {
    calls,
    client: { postDetailed: async (path: string, body: any) => { calls.push([path, body]); return { result: '"from-genesis"' }; } } as any,
  };
}

function config(over: Record<string, unknown> = {}) {
  setActiveConfig({ mcpUrl: '', authToken: null, offline: false, ...over } as any);
}

beforeEach(() => { seen = []; resetRemoteMcpClient(); stubGateway(); });
afterEach(() => { globalThis.fetch = realFetch; setGatewayLocatorForTest(); });

test('no configured gateway: the located local gateway gets the call, with the session bearer', async () => {
  config();
  setGatewayLocatorForTest(async () => ({ url: GW, token: 'sb-token', tried: [] }));
  const g = genesis();
  const out = await invokeMcpTool(g.client, 'atlas_board', { view: 'full' });
  assert.deepEqual(out, { counts: { demiurge: 2 } });
  assert.equal(g.calls.length, 0);
  const call = seen.find((s) => s.method === 'tools/call');
  assert.equal(call?.url, GW);
  assert.equal(call?.auth, 'Bearer sb-token');
});

test('no gateway answers: the chat backend /tools/call path, as before', async () => {
  config();
  setGatewayLocatorForTest(async () => null);
  const g = genesis();
  assert.equal(await invokeMcpTool(g.client, 'atlas_board', {}), 'from-genesis');
  assert.deepEqual(g.calls[0][0], '/tools/call');
  assert.equal(seen.length, 0);
});

test('offline never probes for a gateway', async () => {
  config({ offline: true });
  let probed = 0;
  setGatewayLocatorForTest(async () => { probed++; return { url: GW, token: '', tried: [] }; });
  const g = genesis();
  await invokeMcpTool(g.client, 't', {});
  assert.equal(probed, 0);
  assert.equal(g.calls.length, 1);
});

test('a configured gateway is used as-is; the locator is not consulted', async () => {
  config({ mcpUrl: 'https://mcp.example/mcp' });
  let probed = 0;
  setGatewayLocatorForTest(async () => { probed++; return null; });
  await invokeMcpTool(genesis().client, 't', {});
  assert.equal(probed, 0);
  assert.ok(seen.every((s) => s.url === 'https://mcp.example/mcp'));
});

test('the probe runs once per process, not per tool call', async () => {
  config();
  let probed = 0;
  setGatewayLocatorForTest(async () => { probed++; return { url: GW, token: 't', tried: [] }; });
  await invokeMcpTool(genesis().client, 'a', {});
  await invokeMcpTool(genesis().client, 'b', {});
  assert.equal(probed, 1);
});
