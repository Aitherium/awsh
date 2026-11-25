/**
 * 2026-11-17: a crash reboot left the desktop NIC without DHCP. awsh had
 * api_url: https://mcp.aitherium.com pinned, so resolveBackend returned the DEAD remote
 * pin and every turn died "fetch failed" while the local agent daemon :9001 was healthy.
 * A dead remote pin must yield to a healthy local daemon, out loud; a live one must not,
 * and AWSH_HONOR_REMOTE_PIN=1 keeps even a dead pin.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';
import { resolveBackend, findLocalAgentDaemon } from '../src/backend-resolver.js';
import type { ShellConfig } from '../src/config.js';

function fakeDaemon(): Promise<{ server: Server; url: string }> {
  return new Promise((resolve) => {
    const server = createServer((req, res) => {
      res.setHeader('Content-Type', 'application/json');
      res.end(JSON.stringify({ status: 'healthy', agent: 'adk-daemon', gateway_mcp_connected: true }));
    });
    server.listen(0, '127.0.0.1', () => {
      const { port } = server.address() as AddressInfo;
      resolve({ server, url: `http://127.0.0.1:${port}` });
    });
  });
}

// A remote address that refuses fast: TEST-NET-1 would hang; an unused loopback-free
// hostname under .invalid never resolves (RFC 6761).
const DEAD_REMOTE = 'https://dead-pin.invalid';

function pinnedConfig(): ShellConfig {
  return {
    genesisUrl: DEAD_REMOTE, endpointPinned: true, inferenceMode: 'auto',
    llmUrl: `${DEAD_REMOTE}/v1`, mcpUrl: `${DEAD_REMOTE}/mcp`,
  } as unknown as ShellConfig;
}

test('dead remote pin + healthy local daemon -> switches to the daemon and clears the pin', async () => {
  const { server, url } = await fakeDaemon();
  const prev = process.env.ADK_DAEMON_URL;
  process.env.ADK_DAEMON_URL = url;
  delete process.env.AWSH_HONOR_REMOTE_PIN;
  try {
    const cfg = pinnedConfig();
    const r = await resolveBackend(cfg);
    assert.equal(r.chosen, 'adk');
    assert.equal(r.switched, true);
    assert.equal(cfg.genesisUrl, url);
    assert.equal(cfg.endpointPinned, false);
    assert.equal(cfg.llmUrl, '', 'a remote llmUrl would keep raw turns on the dead edge');
    assert.equal(await findLocalAgentDaemon(), url);
  } finally {
    server.close();
    if (prev === undefined) delete process.env.ADK_DAEMON_URL; else process.env.ADK_DAEMON_URL = prev;
  }
});

test('AWSH_HONOR_REMOTE_PIN=1 keeps a dead remote pin', async () => {
  const { server, url } = await fakeDaemon();
  const prev = process.env.ADK_DAEMON_URL;
  process.env.ADK_DAEMON_URL = url;
  process.env.AWSH_HONOR_REMOTE_PIN = '1';
  try {
    const cfg = pinnedConfig();
    const r = await resolveBackend(cfg);
    assert.equal(r.chosen, 'pinned');
    assert.equal(r.reachable, false);
    assert.equal(cfg.genesisUrl, DEAD_REMOTE);
  } finally {
    server.close();
    delete process.env.AWSH_HONOR_REMOTE_PIN;
    if (prev === undefined) delete process.env.ADK_DAEMON_URL; else process.env.ADK_DAEMON_URL = prev;
  }
});
