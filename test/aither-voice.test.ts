/**
 * Aither speaks in her own voice. Pinned: with no voice picked, the shell asks Genesis's
 * platform door (POST /voice-builds/platform-voice/say) and never the stock AitherVoice
 * service; long text goes in <= 240-char pieces joined into one WAV; a refusal is reported,
 * never re-voiced; and a "nova" the old default wrote into ~/.aither/config.json does not
 * keep a stock voice in her place.
 */
import { strict as assert } from 'node:assert';
import { test, describe } from 'node:test';
import { readFileSync, unlinkSync } from 'node:fs';
import {
  AITHER_VOICE, PLATFORM_SAY_MAX_CHARS, PLATFORM_SAY_MAX_PIECES, PLATFORM_SAY_PATH, VoiceController,
  chunkForSay, joinWav, resolveVoiceName, savedVoiceChoice, synthesize, wavSeconds,
  type GenesisVoiceClient,
} from '../src/tui/voice.js';
import { parseWav } from '../src/tui/audio-envelope.js';

/** A real 16-bit mono PCM WAV of `samples` samples at 22050 Hz. */
function wav(samples: number, rate = 22050, bits = 16): Buffer {
  const data = Buffer.alloc(samples * (bits / 8));
  for (let i = 0; i < samples; i++) data.writeInt16LE(Math.round(Math.sin(i / 5) * 8000), i * 2);
  const h = Buffer.alloc(44);
  h.write('RIFF', 0, 'ascii'); h.writeUInt32LE(36 + data.length, 4); h.write('WAVE', 8, 'ascii');
  h.write('fmt ', 12, 'ascii'); h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * (bits / 8), 28); h.writeUInt16LE(bits / 8, 32);
  h.writeUInt16LE(bits, 34); h.write('data', 36, 'ascii'); h.writeUInt32LE(data.length, 40);
  return Buffer.concat([h, data]);
}

function genesis(reply: (body: any) => any) {
  const calls: Array<{ method: string; path: string; body?: any }> = [];
  const client: GenesisVoiceClient = {
    async requestDetailed(method, path, body) { calls.push({ method, path, body }); return reply(body); },
    async getDetailed(path) { calls.push({ method: 'GET', path }); return { voices: [] }; },
  };
  return { client, calls };
}

// A stock-path call would go here; nothing listens on port 9, so any such call fails the test.
const STOCK = 'https://127.0.0.1:9/voice';

describe("Aither's own voice is the default", () => {
  test('no voice picked: Genesis platform door, {text, format} only, never AitherVoice', async () => {
    const { client, calls } = genesis(() => ({ audio_base64: wav(2205).toString('base64'), format: 'wav', voice: 'custom:aither' }));
    const r = await synthesize('Hello there.', { genesis: client, baseUrl: STOCK, speed: 1.5 });
    assert.equal(r.ok, true, r.error);
    unlinkSync(r.path!);
    assert.deepEqual(calls, [{ method: 'POST', path: PLATFORM_SAY_PATH, body: { text: 'Hello there.', format: 'wav' } }]);
  });

  test('custom:aither by name takes the same door', async () => {
    const { client, calls } = genesis(() => ({ audio_base64: wav(100).toString('base64') }));
    const r = await synthesize('hi', { voice: AITHER_VOICE, genesis: client, baseUrl: STOCK });
    assert.equal(r.ok, true, r.error);
    unlinkSync(r.path!);
    assert.equal(calls[0].path, PLATFORM_SAY_PATH);
    assert.equal(resolveVoiceName('aither'), AITHER_VOICE);
    assert.equal(resolveVoiceName('Default'), AITHER_VOICE);
    assert.equal(resolveVoiceName('custom:dad'), 'custom:dad');
  });

  test('long text goes in <= 240-char pieces, joined into one WAV of the summed length', async () => {
    const text = Array.from({ length: 12 }, (_, i) => `Sentence number ${i} is here to be spoken aloud.`).join(' ');
    const { client, calls } = genesis(() => ({ audio_base64: wav(1000).toString('base64') }));
    const r = await synthesize(text, { genesis: client, baseUrl: STOCK });
    assert.equal(r.ok, true, r.error);
    const out = readFileSync(r.path!);
    unlinkSync(r.path!);
    assert.ok(calls.length > 1);
    assert.ok(calls.every((c) => c.body.text.length <= PLATFORM_SAY_MAX_CHARS));
    assert.equal(calls.map((c) => c.body.text).join(' '), text.replace(/\s+/g, ' '));
    const w = parseWav(out)!;
    assert.equal(w.data.length, calls.length * 2000);
    assert.ok(Math.abs((r.durationS || 0) - calls.length * (1000 / 22050)) < 1e-9);
  });

  test('a refusal is reported in her name and nothing else speaks', async () => {
    const { client, calls } = genesis(() => ({ error: "Aither's voice is unavailable", status: 503 }));
    const r = await synthesize('hello', { genesis: client, baseUrl: STOCK });
    assert.equal(r.ok, false);
    assert.match(r.error!, /Aither's voice/);
    assert.equal(calls.length, 1);
  });

  test('without a Genesis connection it says so (no stock stand-in)', async () => {
    const r = await synthesize('hello', { baseUrl: STOCK });
    assert.equal(r.ok, false);
    assert.match(r.error!, /Genesis connection/);
  });

  test('VoiceController: default is Aither; available() asks her to speak and keeps the reason', async () => {
    const ok = genesis(() => ({ audio_base64: wav(10).toString('base64') }));
    const vc = new VoiceController({ genesis: ok.client, baseUrl: STOCK });
    assert.equal(vc.getVoice(), AITHER_VOICE);
    assert.equal(await vc.available(), true);
    assert.equal(ok.calls[0].path, PLATFORM_SAY_PATH);
    const down = new VoiceController({ genesis: genesis(() => ({ error: 'Not authenticated', status: 401 })).client });
    assert.equal(await down.available(), false);
    assert.match(down.lastProblem(), /Aither's voice: Not authenticated/);
    vc.setVoice('aither');
    assert.equal(vc.getVoice(), AITHER_VOICE);
  });
});

describe('pieces, joining and the saved choice', () => {
  test('chunkForSay cuts at sentences, then words, never past the cap', () => {
    assert.deepEqual(chunkForSay('Short.'), ['Short.']);
    const two = chunkForSay(`${'a'.repeat(200)}. ${'b'.repeat(100)}`);
    assert.equal(two.length, 2);
    assert.ok(two[0].endsWith('.'));
    const words = chunkForSay('word '.repeat(200));
    assert.ok(words.every((p) => p.length <= PLATFORM_SAY_MAX_CHARS && !p.endsWith(' ')));
    assert.ok(chunkForSay('x'.repeat(600)).every((p) => p.length <= PLATFORM_SAY_MAX_CHARS));
    assert.ok(PLATFORM_SAY_MAX_PIECES * PLATFORM_SAY_MAX_CHARS >= 1600);
  });

  test('joinWav refuses pieces that disagree, and wavSeconds reads the length', () => {
    assert.equal(joinWav([wav(10), wav(10, 16000)]), null);
    assert.equal(joinWav([wav(10), Buffer.from('not a wav')]), null);
    const j = joinWav([wav(22050), wav(22050)])!;
    assert.equal(wavSeconds(j), 2);
  });

  test('a bare saved "nova" is the old default echoing back, not a choice', () => {
    assert.equal(savedVoiceChoice({ voice: 'nova', speed: 1.25 }), null);
    assert.equal(savedVoiceChoice({ voice: 'nova', picked: true }), 'nova');
    assert.equal(savedVoiceChoice({ voice: 'custom:dad' }), 'custom:dad');
    assert.equal(savedVoiceChoice({ voice: 'onyx' }), 'onyx');
    assert.equal(savedVoiceChoice({}), null);
    assert.equal(savedVoiceChoice(undefined), null);
  });
});
