/**
 * offline.ts: config layer precedence, CRLF-safe parsing of the vendor file, and the
 * rule that an offline shell never repoints at a cloud edge.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { isLoopbackUrl, isOffline, loadLayeredConfig, parseFlatConfig, systemConfigLayers } from '../src/offline.js';
import { applyCloudFallback, loadConfig, type ShellConfig } from '../src/config.js';

function box(): { root: string; home: string; done: () => void } {
  const base = mkdtempSync(join(tmpdir(), 'awsh-layers-'));
  const root = join(base, 'root');
  const home = join(base, 'home');
  mkdirSync(join(root, 'usr', 'lib', 'awsh', 'shell.d'), { recursive: true });
  mkdirSync(join(root, 'etc', 'awsh'), { recursive: true });
  mkdirSync(join(home, '.aither'), { recursive: true });
  return { root, home, done: () => rmSync(base, { recursive: true, force: true }) };
}

test('layers: vendor < shell.d (name order) < /etc < ~/.aither', () => {
  const b = box();
  try {
    writeFileSync(join(b.root, 'usr/lib/awsh/shell.yaml'), 'offline: true\nllm_url: http://127.0.0.1:8199/v1\nmodel: a\n');
    writeFileSync(join(b.root, 'usr/lib/awsh/shell.d/50-tenant.yaml'), 'llm_url: http://127.0.0.1:8089/v1\n');
    writeFileSync(join(b.root, 'usr/lib/awsh/shell.d/10-early.yaml'), 'llm_url: http://127.0.0.1:1111/v1\nmodel: b\n');
    writeFileSync(join(b.root, 'etc/awsh/shell.yaml'), 'model: c\n');
    writeFileSync(join(b.home, '.aither/shell.yaml'), 'default_agent: mine\n');
    const cfg = loadLayeredConfig({ home: b.home, root: b.root });
    assert.equal(cfg.values.llm_url, 'http://127.0.0.1:8089/v1', '50-tenant must beat 10-early');
    assert.equal(cfg.values.model, 'c', '/etc beats the vendor layers');
    assert.equal(cfg.values.default_agent, 'mine');
    assert.equal(cfg.values.offline, 'true');
    assert.match(cfg.sources.model, /etc[\\/]awsh[\\/]shell\.yaml$/);
    assert.deepEqual(cfg.unreadable, []);
    const order = systemConfigLayers({ home: b.home, root: b.root }).map((p) => p.replace(/\\/g, '/'));
    assert.ok(order[1].endsWith('10-early.yaml') && order[2].endsWith('50-tenant.yaml'));
  } finally { b.done(); }
});

test('the user file beats /etc', () => {
  const b = box();
  try {
    writeFileSync(join(b.root, 'etc/awsh/shell.yaml'), 'llm_url: http://127.0.0.1:1/v1\n');
    writeFileSync(join(b.home, '.aither/shell.yaml'), 'llm_url: http://127.0.0.1:2/v1\n');
    assert.equal(loadLayeredConfig({ home: b.home, root: b.root }).values.llm_url, 'http://127.0.0.1:2/v1');
  } finally { b.done(); }
});

test('a CRLF vendor file parses with no stray carriage return', () => {
  const parsed = parseFlatConfig('offline: true\r\nllm_url: "http://127.0.0.1:8199/v1"\r\n');
  assert.equal(parsed.offline, 'true');
  assert.equal(parsed.llm_url, 'http://127.0.0.1:8199/v1');
  for (const v of Object.values(parsed)) assert.ok(!v.includes('\r'));
});

test('isOffline: env wins in both directions, then the file', () => {
  assert.equal(isOffline({}, { offline: 'true' }), true);
  assert.equal(isOffline({}, {}), false);
  assert.equal(isOffline({ AITHER_OFFLINE: '1' }, {}), true);
  assert.equal(isOffline({ AITHER_OFFLINE: '0' }, { offline: 'true' }), false);
});

test('isLoopbackUrl: LAN is not loopback', () => {
  assert.ok(isLoopbackUrl('http://127.0.0.1:8199/v1'));
  assert.ok(isLoopbackUrl('http://[::1]:9001'));
  assert.ok(isLoopbackUrl('http://localhost:8362'));
  assert.ok(!isLoopbackUrl('http://192.168.1.4:8199/v1'));
  assert.ok(!isLoopbackUrl('https://gateway.aitherium.com'));
  assert.ok(!isLoopbackUrl('not a url'));
});

test('offline: applyCloudFallback changes nothing and records the refusal', () => {
  const cfg = {
    genesisUrl: 'http://127.0.0.1:8001', mcpUrl: '', llmUrl: 'http://127.0.0.1:8199/v1',
    identityUrl: 'http://127.0.0.1:8115', inferenceMode: 'raw', backendType: 'unknown',
    backendName: '', offline: true,
  } as unknown as ShellConfig;
  const before = JSON.stringify(cfg);
  applyCloudFallback(cfg, 'https://gateway.example.com');
  assert.equal(cfg.cloudRefused, 'https://gateway.example.com');
  assert.equal(cfg.autoFailover, undefined);
  const { cloudRefused: _ignored, ...rest } = cfg as ShellConfig & { cloudRefused?: string };
  assert.equal(JSON.stringify(rest), before);
});

test('loadConfig reads the system layers and sets offline', () => {
  const b = box();
  const prev = { HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE, ROOT: process.env.AWSH_CONFIG_ROOT, OFF: process.env.AITHER_OFFLINE, LLM: process.env.AITHER_LLM_URL };
  try {
    writeFileSync(join(b.root, 'usr/lib/awsh/shell.yaml'), 'offline: true\r\nllm_url: http://127.0.0.1:8199/v1\r\n');
    process.env.HOME = b.home;
    process.env.USERPROFILE = b.home;
    process.env.AWSH_CONFIG_ROOT = b.root;
    delete process.env.AITHER_OFFLINE;
    delete process.env.AITHER_LLM_URL;
    const cfg = loadConfig();
    assert.equal(cfg.offline, true);
    assert.equal(cfg.llmUrl, 'http://127.0.0.1:8199/v1');
  } finally {
    for (const [k, v] of [['HOME', prev.HOME], ['USERPROFILE', prev.USERPROFILE], ['AWSH_CONFIG_ROOT', prev.ROOT], ['AITHER_OFFLINE', prev.OFF], ['AITHER_LLM_URL', prev.LLM]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    b.done();
  }
});
