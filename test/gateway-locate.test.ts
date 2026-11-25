/**
 * Locating the harness daemon and the MCP gateway.
 *
 * What must hold (measured 2026-11-09 inside awnix): the harness is NOT on
 * 127.0.0.1:8362 there but behind the fleet bridge relay 10.89.0.1:8362, with its
 * bearer in the Windows profile; the gateway is 127.0.0.1:8182 (never localhost);
 * an explicit env value disables the search; a bearer from a foreign profile is
 * used only when exactly one profile has it.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import {
  FLEET_BRIDGE_IP, LOCAL_HARNESS_URL, LOCAL_MCP_GATEWAY,
  gatewayUrlCandidates, harnessUrlCandidates, locateHarness, locateMcpGateway, tokenFileCandidates,
} from '../src/gateway-locate.js';

test('harness candidates: loopback first, the fleet bridge only inside WSL', () => {
  assert.deepEqual(harnessUrlCandidates({}, false), [LOCAL_HARNESS_URL]);
  assert.deepEqual(harnessUrlCandidates({}, true), [LOCAL_HARNESS_URL, `http://${FLEET_BRIDGE_IP}:8362`]);
});

test('an explicit AITHER_HARNESS_URL is the only candidate', () => {
  assert.deepEqual(harnessUrlCandidates({ AITHER_HARNESS_URL: 'http://h:1/' }, true), ['http://h:1']);
});

test('gateway default is 127.0.0.1:8182, never localhost; explicit wins and /mcp is stripped', () => {
  assert.deepEqual(gatewayUrlCandidates({}), [LOCAL_MCP_GATEWAY]);
  assert.ok(!LOCAL_MCP_GATEWAY.includes('localhost'));
  assert.deepEqual(gatewayUrlCandidates({ AITHER_MCP_URL: 'https://g.example/mcp' }), ['https://g.example']);
});

test('token files: own home first, then Windows profiles under /mnt/c inside WSL', () => {
  const list = (p: string) => (p === '/mnt/c/Users' ? ['Public', 'wzns', 'desktop.ini'] : []);
  assert.deepEqual(tokenFileCandidates('harness_token', '/root', true, list), [
    join('/root', '.aither', 'harness_token'), '/mnt/c/Users/wzns/.aither/harness_token',
  ]);
  assert.deepEqual(tokenFileCandidates('harness_token', '/root', false, list), [join('/root', '.aither', 'harness_token')]);
});

test('locateHarness inside awnix: loopback dead, bridge alive, Windows-profile bearer', async () => {
  const env: NodeJS.ProcessEnv = {};
  const probes: string[] = [];
  const found = await locateHarness({
    env, home: '/root', isWsl: true,
    listDir: (p) => (p === '/mnt/c/Users' ? ['wzns'] : []),
    readFile: (p) => (p === '/mnt/c/Users/wzns/.aither/harness_token' ? 'tok-win' : null),
    probe: async (url, token) => {
      probes.push(`${url}${token ? ` ${token}` : ''}`);
      if (url.startsWith(LOCAL_HARNESS_URL)) return 0;
      if (url.endsWith('/health')) return 200;
      return token === 'tok-win' ? 200 : 401;
    },
  });
  assert.equal(found?.url, `http://${FLEET_BRIDGE_IP}:8362`);
  assert.equal(env.AITHER_HARNESS_URL, `http://${FLEET_BRIDGE_IP}:8362`);
  assert.equal(env.AITHER_HARNESS_TOKEN, 'tok-win');
  assert.deepEqual(probes, [
    `${LOCAL_HARNESS_URL}/health`,
    `http://${FLEET_BRIDGE_IP}:8362/health`,
    `http://${FLEET_BRIDGE_IP}:8362/agents tok-win`,
  ]);
});

test('two Windows profiles with different bearers: neither is guessed', async () => {
  const env: NodeJS.ProcessEnv = {};
  const found = await locateHarness({
    env, home: '/root', isWsl: true,
    listDir: (p) => (p === '/mnt/c/Users' ? ['a', 'b'] : []),
    readFile: (p) => (p.includes('/a/') ? 'ta' : p.includes('/b/') ? 'tb' : null),
    probe: async () => 200,
  });
  assert.equal(found, null);
  assert.equal(env.AITHER_HARNESS_URL, undefined);
});

test('a rejected bearer is not exported', async () => {
  const env: NodeJS.ProcessEnv = {};
  const found = await locateHarness({
    env, home: '/h', isWsl: false, listDir: () => [], readFile: () => 'bad',
    probe: async (url) => (url.endsWith('/health') ? 200 : 401),
  });
  assert.equal(found, null);
  assert.equal(env.AITHER_HARNESS_TOKEN, undefined);
});

test('locateMcpGateway: healthy loopback gateway with the session bearer', async () => {
  const gw = await locateMcpGateway({
    env: {}, home: '/h', isWsl: false, listDir: () => [],
    readFile: (p) => (p.endsWith('session-bearer') ? 'sb' : null),
    probe: async (url) => (url === `${LOCAL_MCP_GATEWAY}/health` ? 200 : 0),
  });
  assert.deepEqual(gw && { url: gw.url, token: gw.token }, { url: `${LOCAL_MCP_GATEWAY}/mcp`, token: 'sb' });
});

test('locateMcpGateway: a dead gateway is null, not a URL that will hang', async () => {
  const gw = await locateMcpGateway({ env: {}, home: '/h', isWsl: false, listDir: () => [], readFile: () => null, probe: async () => 0 });
  assert.equal(gw, null);
});
