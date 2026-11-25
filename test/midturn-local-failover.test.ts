/**
 * The mid-turn half of remote-pin-local-failover (2026-11-17): a session that STARTED online
 * against https://mcp.aitherium.com loses the internet; the next turn must move to the
 * healthy local agent daemon instead of dying "Cannot connect to inference endpoint ...
 * fetch failed". AWSH_HONOR_REMOTE_PIN=1 keeps the old (dying) behaviour.
 */
import { test, afterEach } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const tmpHome = mkdtempSync(join(tmpdir(), 'awsh-midturn-'));
process.env.USERPROFILE = tmpHome;
process.env.HOME = tmpHome;
process.env.AWSH_GROUNDING = '0';
process.env.AWSH_SPINE_PROGRESS = '0';

const { GenesisClient } = await import('../src/client.ts');
const { setActiveConfig } = await import('../src/config.ts');

const DEAD = 'https://dead-edge.invalid';
const DAEMON = 'http://127.0.0.1:59001';
const realFetch = globalThis.fetch;

function stubNetwork(): void {
  process.env.ADK_DAEMON_URL = DAEMON;
  globalThis.fetch = (async (url: any) => {
    const u = String(url);
    if (u.startsWith(DEAD)) throw new TypeError('fetch failed');
    if (u === `${DAEMON}/health`) {
      return new Response(JSON.stringify({ status: 'healthy', agent: 'adk-daemon', gateway_mcp_connected: true }),
        { status: 200, headers: { 'content-type': 'application/json' } });
    }
    return new Response('data: {"type":"done"}\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
  }) as typeof fetch;
}

afterEach(() => {
  globalThis.fetch = realFetch;
  delete process.env.AWSH_HONOR_REMOTE_PIN;
  delete process.env.ADK_DAEMON_URL;
});

function cfg(): any {
  return {
    genesisUrl: DEAD, endpointPinned: true, inferenceMode: 'auto',
    llmUrl: `${DEAD}/v1`, mcpUrl: `${DEAD}/mcp`,
  };
}

test('a remote endpoint that refuses mid-turn moves the turn to the local daemon', async () => {
  stubNetwork();
  const c = cfg();
  setActiveConfig(c);
  const client = new GenesisClient(DEAD);
  let switched: any = null;
  for await (const ev of client.streamChat('why is the network down?')) {
    if (ev.type === 'backend_switch') { switched = ev; break; }
  }
  assert.ok(switched, 'expected a backend_switch event, got none');
  assert.match(String(switched.data.message), /local agent daemon/);
  assert.equal(client.baseUrl, DAEMON);
  assert.equal(c.genesisUrl, DAEMON);
  assert.equal(c.endpointPinned, false);
  assert.equal(c.llmUrl, '');
});

test('AWSH_HONOR_REMOTE_PIN=1 keeps the remote and the turn fails loudly', async () => {
  stubNetwork();
  process.env.AWSH_HONOR_REMOTE_PIN = '1';
  setActiveConfig(cfg());
  const client = new GenesisClient(DEAD);
  await assert.rejects(async () => {
    for await (const _ of client.streamChat('hi')) { /* drain */ }
  }, /Cannot connect/);
  assert.equal(client.baseUrl, DEAD);
});
