/**
 * <think> suppression on the STREAMING path, across chunk boundaries.
 *
 * Reasoning models emit chain-of-thought inline in `content`. The buffered
 * fallback strips it with one regex; the streaming path cannot, because a tag
 * arrives SPLIT across SSE chunks ("<thi" then "nk>") often enough that a
 * per-chunk regex leaks the opening tag and then the whole body.
 *
 * Both paths must agree, or the user's output depends on whether the gateway
 * happened to stream -- which is gateway internals leaking into the answer.
 */
import { strict as assert } from 'assert';
import { test, describe } from 'node:test';
import { GenesisClient } from '../src/client.js';

/** Build a Response whose body yields exactly these chunks, as OpenAI SSE. */
function sseResponse(chunks: string[]): Response {
  const enc = new TextEncoder();
  const stream = new ReadableStream<Uint8Array>({
    start(c) {
      for (const piece of chunks) {
        c.enqueue(enc.encode(
          `data: ${JSON.stringify({ choices: [{ delta: { content: piece } }] })}\n\n`));
      }
      c.enqueue(enc.encode('data: [DONE]\n\n'));
      c.close();
    },
  });
  return new Response(stream, { headers: { 'content-type': 'text/event-stream' } });
}

async function collect(chunks: string[]): Promise<string> {
  const client = new GenesisClient('http://127.0.0.1:1');
  // _readOpenAISSE is private; reach it the way a test legitimately can.
  const gen = (client as any)._readOpenAISSE(sseResponse(chunks), 'test-model');
  let out = '';
  for await (const ev of gen) if (ev.type === 'token') out += ev.data.t;
  return out;
}

describe('<think> suppression on the streaming path', () => {
  test('strips a think block delivered in ONE chunk', async () => {
    assert.equal(await collect(['<think>reasoning</think>ANSWER']), 'ANSWER');
  });

  test('strips a block whose OPENING TAG is split across chunks', async () => {
    // The case a per-chunk regex cannot see.
    assert.equal(await collect(['<thi', 'nk>reasoning</think>ANSWER']), 'ANSWER');
  });

  test('strips a block whose CLOSING TAG is split across chunks', async () => {
    assert.equal(await collect(['<think>reasoning</thi', 'nk>ANSWER']), 'ANSWER');
  });

  test('strips a block spanning many chunks', async () => {
    assert.equal(
      await collect(['<think>', 'a', 'b', 'c', '</think>', 'ANS', 'WER']), 'ANSWER');
  });

  test('leaves ordinary content completely alone', async () => {
    assert.equal(await collect(['hello ', 'world']), 'hello world');
  });

  test('keeps text BEFORE and AFTER a think block', async () => {
    assert.equal(await collect(['pre<think>x</think>post']), 'prepost');
  });

  test('never turns an answer into SILENCE', async () => {
    // A model emitting ONLY reasoning must still produce something -- otherwise
    // it reads as "it didn't answer" rather than "it answered oddly".
    const out = await collect(['<think>only reasoning, no answer</think>']);
    assert.ok(out.length > 0, 'stripping must never yield an empty reply');
  });

  test('a lone < is not mistaken for a tag', async () => {
    assert.equal(await collect(['5 < 6 and 7 > 2']), '5 < 6 and 7 > 2');
  });
});
