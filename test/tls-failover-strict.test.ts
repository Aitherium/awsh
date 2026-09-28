/**
 * The shell's TLS relaxation was decided ONCE at import, from the
 * configured (private) endpoint set. When local Genesis is unreachable,
 * applyCloudFallback() repoints the shell at a PUBLIC edge and the user's
 * bearer/PAT goes there -- with NODE_TLS_REJECT_UNAUTHORIZED=0 still set, i.e.
 * MITM-exposed. The failover must restore strict verification, and must stop
 * pointing MCP at the dead loopback gateway.
 */
import { test, beforeEach, after } from 'node:test';
import assert from 'node:assert/strict';
import { applyCloudFallback, type ShellConfig } from '../src/config.js';
import { relaxTlsForPrivateTrustDomain, tlsRelaxedByShell, _resetTlsTrustForTests } from '../src/tls-trust.js';

const saved = process.env.NODE_TLS_REJECT_UNAUTHORIZED;

beforeEach(() => {
  _resetTlsTrustForTests();
  delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
});

after(() => {
  if (saved === undefined) delete process.env.NODE_TLS_REJECT_UNAUTHORIZED;
  else process.env.NODE_TLS_REJECT_UNAUTHORIZED = saved;
});

function localConfig(): ShellConfig {
  return {
    genesisUrl: 'https://127.0.0.1:8001',
    mcpUrl: 'http://127.0.0.1:8182/mcp',
    identityUrl: 'https://127.0.0.1:8115',
  } as unknown as ShellConfig;
}

test('failover to a PUBLIC edge restores strict TLS the shell had relaxed', () => {
  assert.equal(relaxTlsForPrivateTrustDomain(), true);
  assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, '0');
  applyCloudFallback(localConfig(), 'https://gateway.aitherium.com');
  assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, undefined,
    'bearer would be sent to a public edge with certificate verification disabled');
  assert.equal(tlsRelaxedByShell(), false);
});

test('failover to another PRIVATE host keeps the private-domain relaxation', () => {
  relaxTlsForPrivateTrustDomain();
  applyCloudFallback(localConfig(), 'https://10.0.0.5:8001');
  assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, '0');
});

test("an operator's own NODE_TLS_REJECT_UNAUTHORIZED is never touched", () => {
  process.env.NODE_TLS_REJECT_UNAUTHORIZED = '0';
  assert.equal(relaxTlsForPrivateTrustDomain(), false);
  applyCloudFallback(localConfig(), 'https://gateway.aitherium.com');
  assert.equal(process.env.NODE_TLS_REJECT_UNAUTHORIZED, '0');
});

test('failover replaces a loopback MCP url but keeps an explicit public one', () => {
  const c = localConfig();
  applyCloudFallback(c, 'https://gateway.aitherium.com');
  assert.notEqual(c.mcpUrl, 'http://127.0.0.1:8182/mcp');
  assert.ok(!/127\.0\.0\.1/.test(String(c.mcpUrl)));

  const d = localConfig();
  (d as { mcpUrl?: string }).mcpUrl = 'https://mcp.example.com/mcp';
  applyCloudFallback(d, 'https://gateway.aitherium.com');
  assert.equal(d.mcpUrl, 'https://mcp.example.com/mcp');
});
