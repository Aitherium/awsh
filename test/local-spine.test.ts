/**
 * awsh talks to the local spine only: https://127.0.0.1:8150, verified against the
 * AitherNet CA, at user priority, and says where a slow turn is waiting.
 *
 * Before (2026-11-11): every spine call tried [AITHER_LLM_URL, https://localhost:8150,
 * http://localhost:8150] -- localhost reaches ::1, which the spine refuses, and plain
 * http into its TLS listener hangs; the raw path sent no priority; a direct provider's
 * 401 told the user to `export DEEPSEEK_API_KEY` (that account now answers 402); the
 * omnibox's decision model was the paid DeepSeek API; and a turn queued behind a full
 * lane showed nothing for up to 120 s.
 */
import { strict as assert } from 'assert';
import { readFileSync } from 'fs';
import { test, describe, afterEach } from 'node:test';
import {
  GenesisClient, SPINE_URL, SPINE_SOURCE, spineBaseUrl, isSpineUrl, normalizeSpineUrl,
  spineFetch, spineCaCandidates, providerRefusal, withSpineProgress, type SSEEvent,
} from '../src/client.js';
import { formatLaneProgress, DELIBERATE_MODEL, DELIBERATE_FALLBACK } from '../src/omnibox.js';
import { localModelCandidates, LOCAL_MICROSCHEDULER_URL } from '../src/backend-resolver.js';
import { setActiveConfig, loadConfig } from '../src/config.js';

const SRC = readFileSync(new URL('../src/client.ts', import.meta.url), 'utf8');

describe('one spine address', () => {
  test('default, http ignored, localhost pinned to 127.0.0.1, /v1 dropped, remote https kept', () => {
    assert.equal(SPINE_URL, 'https://127.0.0.1:8150');
    assert.equal(spineBaseUrl({}), 'https://127.0.0.1:8150');
    assert.equal(spineBaseUrl({ AITHER_LLM_URL: 'http://localhost:8150' }), 'https://127.0.0.1:8150');
    assert.equal(spineBaseUrl({ AITHER_LLM_URL: 'https://localhost:8150/v1' }), 'https://127.0.0.1:8150');
    assert.equal(spineBaseUrl({ AITHER_LLM_URL: 'https://aitheros-microscheduler:8150/v1' }),
      'https://aitheros-microscheduler:8150');
  });

  test('dead spellings are moved onto the https origin; other URLs are untouched', () => {
    assert.equal(normalizeSpineUrl('http://localhost:8150/v1', {}), 'https://127.0.0.1:8150/v1');
    assert.equal(normalizeSpineUrl('http://[::1]:8150/llm/queue/detail', {}),
      'https://127.0.0.1:8150/llm/queue/detail');
    assert.equal(normalizeSpineUrl('https://gateway.example/v1', {}), 'https://gateway.example/v1');
    assert.equal(isSpineUrl('http://127.0.0.1:8001/health', {}), false);
  });

  test('the client source no longer names a localhost or http spine', () => {
    assert.ok(!/localhost:8150/.test(SRC), 'a localhost:8150 candidate is still in client.ts');
    assert.ok(!/http:\/\/[^'"`\s]*:8150/.test(SRC), 'a plain-http spine candidate is still in client.ts');
  });

  test('the resolver probes the spine on https://127.0.0.1 even when configured as http://localhost', () => {
    assert.equal(LOCAL_MICROSCHEDULER_URL, 'https://127.0.0.1:8150/v1');
    assert.deepEqual(localModelCandidates('http://localhost:8150/v1', {}), [LOCAL_MICROSCHEDULER_URL]);
  });

  test('the CA candidates include the repo CA next to this tree and AITHER_CA_BUNDLE first', () => {
    const c = spineCaCandidates({ env: { AITHER_CA_BUNDLE: '/x/ca.pem' }, home: '/h', here: '/r/.PRODUCTS/.AITHERSHELL/cli/src' });
    assert.equal(c[0], '/x/ca.pem');
    assert.ok(c.some((p) => p.replace(/\\/g, '/').endsWith('/r/AitherOS/Library/Data/tls/ca-chain.pem')), c.join(' '));
  });

  test('with no CA the spine is refused, never dialled unverified', async () => {
    await assert.rejects(spineFetch(`${SPINE_URL}/health`, {}, []), /never dialled unverified/);
  });
});

describe('every spine call dials https://127.0.0.1:8150 once', () => {
  const original = globalThis.fetch;
  afterEach(() => { globalThis.fetch = original; delete process.env.AITHER_LLM_URL; });

  const bodies: any[] = [];
  function record(): string[] {
    const urls: string[] = [];
    bodies.length = 0;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      urls.push(String(url));
      if (init?.body) bodies.push(JSON.parse(String(init.body)));
      return new Response('{"status":"healthy"}', { status: 200, headers: { 'content-type': 'application/json' } });
    }) as typeof fetch;
    return urls;
  }

  test('getLLMStatus with AITHER_LLM_URL=http://localhost:8150', async () => {
    process.env.AITHER_LLM_URL = 'http://localhost:8150';
    const urls = record();
    assert.deepEqual(await new GenesisClient('http://127.0.0.1:9001').getLLMStatus(), { status: 'healthy' });
    assert.deepEqual(urls, ['https://127.0.0.1:8150/health']);
  });

  test('the warmup goes to the spine at background priority', async () => {
    const urls = record();
    await new GenesisClient('http://127.0.0.1:9001').warmupModel('aither-orchestrator');
    assert.deepEqual(urls, ['https://127.0.0.1:8150/v1/chat/completions']);
    assert.equal(bodies[0].metadata.priority, 'background');
  });
});

describe('a raw turn is a person\'s turn', () => {
  const original = globalThis.fetch;
  afterEach(() => { globalThis.fetch = original; });

  async function sentBody(llmUrl: string): Promise<{ url: string; body: any }> {
    let seen: { url: string; body: any } | null = null;
    globalThis.fetch = (async (url: string, init?: RequestInit) => {
      if (init?.body) seen = { url: String(url), body: JSON.parse(String(init.body)) };
      return new Response('data: [DONE]\n\n', { status: 200, headers: { 'content-type': 'text/event-stream' } });
    }) as typeof fetch;
    const config = loadConfig();
    config.inferenceMode = 'raw';
    config.llmUrl = llmUrl;
    delete config.provider;
    setActiveConfig(config);
    try {
      for await (const _e of new GenesisClient('http://127.0.0.1:9001').streamChat('hi', { noSituation: true })) { void _e; }
    } catch { /* the stub stream ends at once */ }
    assert.ok(seen, 'no chat request was made');
    return seen!;
  }

  test('user priority + desk source, to https://127.0.0.1:8150 even from an http llm_url', async () => {
    const { url, body } = await sentBody('http://localhost:8150/v1');
    assert.equal(url, 'https://127.0.0.1:8150/v1/chat/completions');
    assert.deepEqual(body.metadata, { priority: 'user', source: SPINE_SOURCE });
    assert.equal(SPINE_SOURCE, 'desk:awsh');
  });
});

describe('a refusing direct provider points back at the local stack', () => {
  test('402 says no credit; no key advice anywhere', () => {
    const m = providerRefusal('deepseek', 402);
    assert.match(m, /402/);
    assert.match(m, /127\.0\.0\.1:8150/);
    assert.ok(!/DEEPSEEK_API_KEY|export /.test(m));
    assert.ok(!/DEEPSEEK_API_KEY/.test(SRC), 'client.ts still tells the user to set a DeepSeek key');
  });
});

describe('the omnibox decision model is local', () => {
  test('aither-deliberate (Bonsai) then local reasoning pool, never the paid API', () => {
    assert.equal(DELIBERATE_MODEL, 'aither-deliberate');
    assert.match(DELIBERATE_FALLBACK, /^aither-reason/);
    assert.notEqual(DELIBERATE_FALLBACK, DELIBERATE_MODEL);
  });
});

describe('formatLaneProgress', () => {
  const mine = { source: 'desk:awsh', model: 'aither-orchestrator' };

  test('queued: lane and position, oldest first', () => {
    const line = formatLaneProgress({
      queued: [
        { source: 'llm_client', model: 'x', age_s: 50 },
        { source: 'desk:awsh', model: 'aither-orchestrator', age_s: 10 },
        { source: 'forge:a', model: 'y', age_s: 80 },
      ],
      inflight: [
        { source: 'llm_client', model: 'aither-orchestrator', lane: 'llamacpp_local', age_s: 113 },
        { source: 'openai_compat', model: 'z', lane: 'llamacpp_local', age_s: 5 },
        { source: 'openai_compat', model: 'z', lane: 'llamacpp_pool', age_s: 5, done: true },
      ],
    }, mine);
    assert.equal(line, 'queued on llamacpp_local (3 of 3)');
  });

  test('running: its own lane and how many are in flight there', () => {
    assert.equal(formatLaneProgress({ queued: [], inflight: [
      { source: 'desk:awsh', model: 'aither-orchestrator', lane: 'llamacpp_local' },
      { source: 'llm_client', model: 'q', lane: 'llamacpp_local' },
      { source: 'llm_client', model: 'q', lane: 'llamacpp_pool' },
    ] }, mine), 'running on llamacpp_local (2 in flight)');
  });

  test('cannot tell which is ours: the whole spine; idle: nothing', () => {
    assert.equal(formatLaneProgress({ queued: [{ source: 'a' }], inflight: [{ source: 'b', lane: 'l' }] },
      mine), 'spine busy (1 queued, 1 running)');
    assert.equal(formatLaneProgress({ queued: [], inflight: [] }, mine), null);
    assert.equal(formatLaneProgress(null, mine), null);
  });
});

describe('withSpineProgress', () => {
  async function* slow(): AsyncGenerator<SSEEvent> {
    yield { type: 'session_start', data: { type: 'session_start' } };
    await new Promise((r) => setTimeout(r, 60));
    yield { type: 'token', data: { type: 'token', t: 'hi' } };
    await new Promise((r) => setTimeout(r, 30));
    yield { type: 'complete', data: { type: 'complete' } };
  }

  test('says where the turn waits before the first token, once per change, then stops', async () => {
    let probes = 0;
    const out: SSEEvent[] = [];
    for await (const e of withSpineProgress(slow(), async () => { probes++; return 'queued on llamacpp_local (1 of 2)'; },
      { firstMs: 5, everyMs: 5 })) out.push(e);
    const types = out.map((e) => e.type);
    assert.deepEqual(types.filter((t) => t !== 'status'), ['session_start', 'token', 'complete']);
    const statuses = out.filter((e) => e.type === 'status');
    assert.equal(statuses.length, 1, 'a repeated line was yielded twice');
    assert.equal(statuses[0].data.phase, 'spine_queue');
    assert.equal(statuses[0].data.message, 'queued on llamacpp_local (1 of 2)');
    assert.ok(types.indexOf('status') < types.indexOf('token'));
    const after = probes;
    assert.ok(after >= 1);
  });

  test('a failing probe yields nothing and the stream is unchanged', async () => {
    const out: string[] = [];
    for await (const e of withSpineProgress(slow(), async () => { throw new Error('down'); },
      { firstMs: 5, everyMs: 5 })) out.push(e.type);
    assert.deepEqual(out, ['session_start', 'token', 'complete']);
  });

  test('an inner error still reaches the caller', async () => {
    async function* boom(): AsyncGenerator<SSEEvent> {
      await new Promise((r) => setTimeout(r, 20));
      throw new Error('lane llamacpp_local is full');
    }
    await assert.rejects(async () => {
      for await (const _e of withSpineProgress(boom(), async () => null, { firstMs: 5, everyMs: 5 })) { void _e; }
    }, /lane llamacpp_local is full/);
  });
});
