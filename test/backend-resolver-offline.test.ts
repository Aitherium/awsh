/**
 * The backend ladder offline: the cloud rung is refused, never probed. With nothing local
 * answering the resolver lands on 'offline' having dialed only loopback; with the
 * machine's model server answering /v1/models it lands on 'local-llm' (raw inference).
 * fetch is stubbed: no socket is opened and no daemon is spawned.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync, rmSync } from 'node:fs';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { resolveBackend } from '../src/backend-resolver.js';
import { CLOUD_URL, type ShellConfig } from '../src/config.js';

function offlineConfig(): ShellConfig {
  return {
    genesisUrl: 'http://127.0.0.1:8001', defaultAgent: 'aither', sessionId: 's', historyFile: '/dev/null',
    identityUrl: 'http://127.0.0.1:8115', mcpUrl: '', inferenceMode: 'auto',
    llmUrl: 'http://127.0.0.1:8199/v1', requireAuth: false, authToken: null, authUser: null,
    backendType: 'unknown', backendName: '', endpointPinned: false, offline: true,
  } as ShellConfig;
}

async function withStubbedFetch<T>(
  answer: (url: string) => Response | null,
  body: (dialed: string[]) => Promise<T>,
): Promise<T> {
  const dialed: string[] = [];
  const realFetch = globalThis.fetch;
  const home = mkdtempSync(join(tmpdir(), 'awsh-resolver-'));
  const prev = {
    HOME: process.env.HOME, USERPROFILE: process.env.USERPROFILE,
    AUTO: process.env.AITHERSHELL_AUTOSTART_ADK, ADK: process.env.ADK_DAEMON_URL,
  };
  process.env.HOME = home;
  process.env.USERPROFILE = home;
  process.env.AITHERSHELL_AUTOSTART_ADK = '0';
  process.env.ADK_DAEMON_URL = 'http://127.0.0.1:9001';
  globalThis.fetch = (async (input: any) => {
    const url = typeof input === 'string' ? input : String(input?.url ?? input);
    dialed.push(url);
    const r = answer(url);
    if (!r) throw new TypeError('fetch failed (stub: nothing listening)');
    return r;
  }) as typeof fetch;
  try {
    return await body(dialed);
  } finally {
    globalThis.fetch = realFetch;
    for (const [k, v] of [['HOME', prev.HOME], ['USERPROFILE', prev.USERPROFILE],
      ['AITHERSHELL_AUTOSTART_ADK', prev.AUTO], ['ADK_DAEMON_URL', prev.ADK]] as const) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    rmSync(home, { recursive: true, force: true });
  }
}

const isLoopback = (u: string) => /^https?:\/\/(127\.|localhost|\[::1\])/.test(u);

test('offline + nothing local: chosen offline, zero probes to the cloud', async () => {
  await withStubbedFetch(() => null, async (dialed) => {
    const cfg = offlineConfig();
    const r = await resolveBackend(cfg);
    assert.equal(r.chosen, 'offline');
    assert.equal(r.reachable, false);
    assert.equal(r.switched, false);
    assert.ok(dialed.length > 0, 'the local rungs were not probed at all');
    assert.ok(dialed.every(isLoopback), `dialed off-box: ${dialed.filter((u) => !isLoopback(u)).join(', ')}`);
    assert.ok(!dialed.some((u) => u.startsWith(CLOUD_URL)));
    assert.equal(cfg.genesisUrl, 'http://127.0.0.1:8001', 'config was repointed at a cloud edge');
    assert.equal(cfg.cloudRefused, CLOUD_URL);
    assert.equal(cfg.autoFailover, undefined);
  });
});

test('offline + model server answering /v1/models: chosen local-llm, raw mode', async () => {
  const models = JSON.stringify({ data: [{ id: 'bonsai-selfhost' }] });
  await withStubbedFetch(
    (url) => (url === 'http://127.0.0.1:8199/v1/models'
      ? new Response(models, { status: 200, headers: { 'Content-Type': 'application/json' } })
      : null),
    async (dialed) => {
      const cfg = offlineConfig();
      const r = await resolveBackend(cfg);
      assert.equal(r.chosen, 'local-llm');
      assert.equal(r.url, 'http://127.0.0.1:8199/v1');
      assert.equal(cfg.inferenceMode, 'raw');
      assert.equal(cfg.model, 'bonsai-selfhost');
      assert.ok(dialed.every(isLoopback));
    },
  );
});

test('offline + a pinned REMOTE api_url: refused before any probe, pin cleared', async () => {
  await withStubbedFetch(() => null, async (dialed) => {
    const cfg = offlineConfig();
    cfg.endpointPinned = true;
    cfg.genesisUrl = 'https://gateway.example.com';
    const r = await resolveBackend(cfg);
    assert.notEqual(r.chosen, 'pinned');
    assert.equal(r.chosen, 'offline');
    assert.equal(cfg.endpointPinned, false);
    assert.ok(dialed.every(isLoopback), `dialed off-box: ${dialed.filter((u) => !isLoopback(u)).join(', ')}`);
  });
});

test('offline + a non-loopback llm_url is not dialed', async () => {
  await withStubbedFetch(() => null, async (dialed) => {
    const cfg = offlineConfig();
    cfg.llmUrl = 'https://llm.example.com/v1';
    const r = await resolveBackend(cfg);
    assert.equal(r.chosen, 'offline');
    assert.ok(dialed.every(isLoopback));
  });
});
