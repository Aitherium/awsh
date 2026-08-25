/**
 * A launched pack must reach the MODEL, not just the banner.
 *
 * `awsh gobbonet` prints "◈ GobboNet · pack gobbonet · as gobbo" and opens a
 * shell. If the pack does not make it into the request, that banner is a claim
 * about behaviour that nothing behind it honours. packs.ts already REFUSES to
 * launch a pack with no system_prompt for exactly this reason -- "a shell that
 * says it loaded a persona and did not is worse than one that refuses" -- and
 * this asserts the other half of that promise.
 *
 * WHY THIS FILE EXISTS RATHER THAN A CODE READ. On 2026-08-21 the injection was
 * read, found correct, and reported as verified. It was correct -- on the raw
 * OpenAI path, which the owner's config does not use. Measured against the real
 * config (backendType unknown, mode auto, no llmUrl), the shell took the genesis
 * path and sent:
 *
 *     {"message":"hi","persona":"aither", ...}
 *
 * No pack prompt, and the persona was the default. The pack changed NOTHING on
 * the path in use, and every cheap signal -- banner, manifest path, identity
 * line -- said it had loaded. Reading is not running, and one path being right
 * says nothing about the other.
 *
 * So both paths are asserted here, in both directions.
 */

import { strict as assert } from 'assert';
import { SITUATION_HEADER } from '../src/situation.js';
import { test, describe, beforeEach, afterEach } from 'node:test';
import { GenesisClient } from '../src/client.js';
import { setActiveConfig, loadConfig } from '../src/config.js';

const PACK_PROMPT = 'You are GobboNet running as a shell. LOCAL FIRST.';

interface Captured { url: string; body: Record<string, unknown> | string }

/**
 * @param asGenesis  answer /health as GENESIS, so detectBackend() classifies the
 *   backend and streamChat takes the agent-pipeline path. Without this the
 *   probe fails, detection returns the {type:'unknown'} sentinel, and an
 *   unknown backend now deliberately routes to the STANDARD /v1 route -- so a
 *   test meaning to exercise the genesis path would silently exercise the other
 *   one and pass for the wrong reason.
 */
function captureRequests(asGenesis = false): { seen: Captured[]; restore: () => void } {
  const seen: Captured[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (async (url: string, init?: RequestInit) => {
    if (asGenesis && String(url).endsWith('/health')) {
      return new Response(JSON.stringify({ status: 'ok', service: 'AitherGenesis' }),
                          { status: 200, headers: { 'content-type': 'application/json' } });
    }
    if (init?.body) {
      let parsed: Record<string, unknown> | string;
      try { parsed = JSON.parse(String(init.body)); } catch { parsed = String(init.body); }
      seen.push({ url: String(url), body: parsed });
    }
    // 200 with an immediately-closed SSE stream: enough for the request to have
    // been MADE, which is all this asserts.
    return new Response('data: [DONE]' + String.fromCharCode(10, 10), {
      status: 200,
      headers: { 'content-type': 'text/event-stream' },
    });
  }) as typeof globalThis.fetch;
  return { seen, restore: () => { globalThis.fetch = original; } };
}

async function drain(gen: AsyncGenerator<unknown>): Promise<void> {
  try {
    for await (const _evt of gen) { void _evt; }
  } catch { /* the stub ends abruptly; the request body is already captured */ }
}

/** The chat request, whichever path was taken. */
function chatBody(seen: Captured[]): Record<string, unknown> {
  const hit = seen.find((s) => s.url.includes('/chat/stream') || s.url.includes('/chat/completions'));
  assert.ok(hit, 'no chat request was made at all');
  assert.ok(typeof hit!.body === 'object', 'the chat request carried a non-JSON body');
  return hit!.body as Record<string, unknown>;
}

describe('a launched pack reaches the model', () => {
  let cap: ReturnType<typeof captureRequests>;
  afterEach(() => { cap?.restore(); });

  test('genesis path: the pack supplies BOTH the persona and the system prompt', async () => {
    cap = captureRequests(true);
    const config = loadConfig();
    config.packName = 'gobbonet';
    config.packPrompt = PACK_PROMPT;
    config.packIdentity = 'gobbo';
    setActiveConfig(config);

    await drain(new GenesisClient(config.genesisUrl)
      .streamChat('who are you?', {}) as AsyncGenerator<unknown>);

    const body = chatBody(cap.seen);
    assert.equal(body.persona, 'gobbo',
      'the persona is not the pack identity -- the banner says gobbo and the ' +
      'request asks for someone else');
    // system_additions, NOT system_prompt. genesis pops a fixed set of keys off
    // a raw dict; system_prompt is not one of them, so that spelling is dropped
    // server-side and the whole thing is wired-but-inert with a request body
    // that looks correct in every log.
    // The pack prompt is the FIRST addition (identity), and the shell's live
    // [USER'S SHELL] situation block rides LAST on every turn (situation.ts) --
    // last so the cacheable prefix is not busted by a moving timestamp.
    assert.ok(Array.isArray(body.system_additions), 'system_additions missing');
    assert.equal(body.system_additions[0], PACK_PROMPT,
      'the pack prompt is not the first entry of the field genesis consumes');
    assert.equal(body.system_additions.length, 2, 'expected pack prompt + situation block only');
    assert.ok(String(body.system_additions[1]).startsWith(SITUATION_HEADER),
      'the situation block must ride after the pack prompt');
  });

  test('genesis path: with NO pack, nothing is smuggled in', async () => {
    cap = captureRequests(true);
    // The other direction. A rule that only checks the present case passes on
    // an implementation that always injects, which would leak a persona from a
    // previous launch into a plain `awsh`.
    const config = loadConfig();
    delete config.packName;
    delete config.packPrompt;
    delete config.packIdentity;
    setActiveConfig(config);

    await drain(new GenesisClient(config.genesisUrl)
      .streamChat('who are you?', {}) as AsyncGenerator<unknown>);

    const body = chatBody(cap.seen);
    assert.equal(body.persona, 'aither', 'the default persona changed');
    // With no pack the ONLY addition is the shell's situation block; a pack
    // prompt from a previous launch must not ride along.
    assert.deepEqual(
      (body.system_additions as string[]).map((a) => a.startsWith(SITUATION_HEADER) ? '<situation>' : a),
      ['<situation>'],
      'something other than the situation block was sent for a session that launched no pack');
    assert.ok(!JSON.stringify(body).includes(PACK_PROMPT), 'a pack prompt leaked into a pack-less session');
  });

  test('an explicit @agent still beats the pack', async () => {
    cap = captureRequests(true);
    // Asking demiurge something inside a gobbonet shell must reach demiurge.
    const config = loadConfig();
    config.packName = 'gobbonet';
    config.packPrompt = PACK_PROMPT;
    config.packIdentity = 'gobbo';
    setActiveConfig(config);

    await drain(new GenesisClient(config.genesisUrl)
      .streamChat('review this', { agent: 'demiurge' }) as AsyncGenerator<unknown>);

    assert.equal(chatBody(cap.seen).persona, 'demiurge',
      'the pack overrode an explicit agent -- a pack is a default, not a cage');
  });

  test('raw OpenAI path: the pack prompt is the FIRST system message', async () => {
    cap = captureRequests(false);
    // The path that WAS correct. Kept so a fix on one path cannot regress the
    // other -- which is the exact shape of the defect this file was born from.
    const config = loadConfig();
    config.packName = 'gobbonet';
    config.packPrompt = PACK_PROMPT;
    config.inferenceMode = 'raw';
    config.llmUrl = 'http://127.0.0.1:9/v1';
    setActiveConfig(config);

    await drain(new GenesisClient('http://127.0.0.1:9')
      .streamChat('who are you?', {}) as AsyncGenerator<unknown>);

    const body = chatBody(cap.seen);
    const messages = body.messages as { role: string; content: string }[] | undefined;
    assert.ok(Array.isArray(messages), 'the raw path sent no messages array');
    const systems = messages!.filter((m) => m.role === 'system');
    assert.ok(systems.length > 0, 'no system message was sent on the raw path');
    assert.equal(systems[0].content, PACK_PROMPT,
      'the pack prompt is not first, so anything ahead of it sets the persona');
  });
});
