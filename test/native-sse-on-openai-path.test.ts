/**
 * MicroScheduler's NATIVE stream on the OpenAI path.
 *
 * With stream:true, MicroScheduler's /v1/chat/completions passes llm_generate's
 * own event stream through verbatim (`event: token` / `{"t": ...}`, then a
 * `complete` carrying `full_content`), and the gateway proxies it unchanged.
 * Measured 2026-10-03: the omnibox got a 200 with ~30 tokens and printed
 * "(no answer from the agent)" because the parser only read `choices[].delta`.
 */
import { strict as assert } from 'assert';
import { test, describe } from 'node:test';
import { GenesisClient } from '../src/client.js';

function rawSse(lines: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const l of lines) c.enqueue(enc.encode(l));
      c.close();
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
}

async function collect(lines: string[]): Promise<string> {
  const client = new GenesisClient('http://127.0.0.1:1');
  const gen = (client as any)._readOpenAISSE(rawSse(lines), 'test-model');
  let out = '';
  for await (const ev of gen) if (ev.type === 'token') out += ev.data.t;
  return out;
}

const ev = (name: string, data: object) => `event: ${name}\ndata: ${JSON.stringify(data)}\n\n`;

describe('native MicroScheduler events on the OpenAI path', () => {
  test('reads token events (the live shape, captured 2026-10-03)', async () => {
    const out = await collect([
      ev('session_start', { model: 'aither-orchestrator', agent: 'openai_compat', type: 'session_start' }),
      ev('token', { t: 'Why', n: 1, type: 'token' }),
      ev('token', { t: ' not?', n: 2, type: 'token' }),
      ev('complete', { content: 'Why not?', full_content: 'Why not?', type: 'complete' }),
    ]);
    assert.equal(out, 'Why not?');
  });

  test('a complete with no tokens still yields its full_content', async () => {
    assert.equal(await collect([ev('complete', { full_content: 'OK', type: 'complete' })]), 'OK');
  });

  test('complete does not double an answer already streamed as tokens', async () => {
    const out = await collect([
      ev('token', { t: 'OK', type: 'token' }),
      ev('complete', { full_content: 'OK', type: 'complete' }),
    ]);
    assert.equal(out, 'OK');
  });

  test('an upstream error chunk is raised, not swallowed into silence', async () => {
    await assert.rejects(collect(['data: {"error": "Backend error (503)"}\n\n']), /Backend error/);
  });

  test('OpenAI chunks still work', async () => {
    const out = await collect([
      `data: ${JSON.stringify({ choices: [{ delta: { content: 'hi' } }] })}\n\n`,
      'data: [DONE]\n\n',
    ]);
    assert.equal(out, 'hi');
  });
});
