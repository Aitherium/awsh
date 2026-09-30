/**
 * doctor.ts: every verdict from stubbed probes. The rules pinned here:
 *   - an offline box with a loopback model, a loopback-only harness and a 0600 token passes;
 *   - a non-loopback url while offline fails (and is listed, never dialed);
 *   - a probe that crashes, or a table that cannot be read, is 'unknown' (exit 2), never 0.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { DOCTOR_EXIT, crashReport, parseProcNet, runDoctor, type DoctorProbes } from '../src/doctor.js';
import type { LayeredConfig } from '../src/offline.js';

const VENDOR = '/usr/lib/awsh/shell.yaml';

function layered(values: Record<string, string>): LayeredConfig {
  const sources: Record<string, string> = {};
  for (const k of Object.keys(values)) sources[k] = VENDOR;
  return { values, sources, layers: [{ path: VENDOR, present: true, keys: Object.keys(values) }], unreadable: [] };
}

function probes(over: Partial<DoctorProbes> = {}, values: Record<string, string> = {
  offline: 'true', llm_url: 'http://127.0.0.1:8199/v1',
}): DoctorProbes & { dialed: string[] } {
  const dialed: string[] = [];
  return {
    dialed,
    nodeVersion: 'v22.3.0',
    env: {},
    home: '/home/u',
    platform: 'linux',
    loadConfig: () => layered(values),
    getJson: async (url: string) => {
      dialed.push(url);
      if (url.endsWith('/v1/models')) return { status: 200, body: { data: [{ id: 'bonsai-selfhost' }] } };
      if (url.endsWith('/health')) return { status: 200, body: { status: 'ok' } };
      return { status: 404, body: null };
    },
    listeners: async () => [{ address: '127.0.0.1', port: 8362 }],
    fileMode: () => 0o100600,
    ...over,
  };
}

test('offline box with a loopback model, loopback harness and 0600 token passes', async () => {
  const rep = await runDoctor(probes());
  assert.equal(rep.verdict, 'pass', JSON.stringify(rep.checks));
  assert.equal(DOCTOR_EXIT[rep.verdict], 0);
  assert.equal(rep.model, 'bonsai-selfhost');
  assert.equal(rep.harness_bind, '127.0.0.1:8362');
  assert.deepEqual(rep.nonloopback_urls, []);
  assert.equal(rep.strict, true);
});

test('a non-loopback url while offline fails, is listed, and is never dialed', async () => {
  const p = probes({}, { offline: 'true', llm_url: 'http://127.0.0.1:8199/v1', mcp_url: 'https://gateway.example.com/mcp' });
  const rep = await runDoctor(p);
  assert.equal(rep.verdict, 'fail');
  assert.equal(DOCTOR_EXIT[rep.verdict], 1);
  assert.deepEqual(rep.nonloopback_urls, ['https://gateway.example.com/mcp']);
  assert.ok(p.dialed.every((u) => u.startsWith('http://127.0.0.1')), p.dialed.join(','));
});

test('offline:false plus a cloud url on an image fails', async () => {
  const rep = await runDoctor(probes({}, { offline: 'false', api_url: 'https://gateway.example.com' }));
  assert.equal(rep.verdict, 'fail');
  assert.equal(rep.checks.find((c) => c.id === 'offline')?.ok, false);
});

test('a harness bound to 0.0.0.0 fails', async () => {
  const rep = await runDoctor(probes({ listeners: async () => [{ address: '0.0.0.0', port: 8362 }] }));
  assert.equal(rep.verdict, 'fail');
  assert.equal(rep.harness_bind, '0.0.0.0:8362');
});

test('no model listed fails', async () => {
  const rep = await runDoctor(probes({ getJson: async () => ({ status: 200, body: { data: [] } }) }));
  assert.equal(rep.checks.find((c) => c.id === 'local-llm')?.ok, false);
  assert.equal(rep.verdict, 'fail');
});

test('a group-readable token fails', async () => {
  const rep = await runDoctor(probes({ fileMode: () => 0o100644 }));
  assert.equal(rep.checks.find((c) => c.id === 'harness-token')?.ok, false);
});

test('an unreadable listener table is unknown (exit 2), never a pass', async () => {
  const rep = await runDoctor(probes({ listeners: async () => null }));
  assert.equal(rep.verdict, 'unknown');
  assert.equal(DOCTOR_EXIT[rep.verdict], 2);
});

test('a probe that crashes is unknown (exit 2), never a pass', async () => {
  const rep = await runDoctor(probes({ getJson: async () => { throw new Error('boom'); } }));
  assert.equal(rep.verdict, 'unknown');
  assert.equal(DOCTOR_EXIT[rep.verdict], 2);
});

test('a config loader that throws is unknown', async () => {
  const rep = await runDoctor(probes({ loadConfig: () => { throw new Error('EACCES'); } }));
  assert.equal(rep.verdict, 'unknown');
});

test('crashReport is unknown', () => {
  assert.equal(crashReport(new Error('x')).verdict, 'unknown');
});

test('desktop (not offline, no vendor layer): offline checks are advisory', async () => {
  const p = probes({
    loadConfig: () => ({ values: {}, sources: {}, layers: [], unreadable: [] }),
    getJson: async () => ({ status: null, body: null }),
    listeners: async () => [],
  });
  const rep = await runDoctor(p);
  assert.equal(rep.strict, false);
  assert.equal(rep.verdict, 'pass');
});

test('parseProcNet decodes LISTEN rows for v4 and v6', () => {
  const v4 = '  sl  local_address rem_address   st\n   0: 0100007F:20AA 00000000:0000 0A 0\n   1: 00000000:0016 00000000:0000 01 0\n';
  assert.deepEqual(parseProcNet(v4, false), [{ address: '127.0.0.1', port: 0x20aa }]);
  const v6 = 'hdr\n   0: 00000000000000000000000001000000:2329 00000000000000000000000000000000:0000 0A 0\n';
  assert.deepEqual(parseProcNet(v6, true), [{ address: '::1', port: 0x2329 }]);
});
