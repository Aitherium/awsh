/**
 * Envelope maths for real lip-sync. These are the assertions that would have caught the
 * class this feature is built to avoid: an envelope that LOOKS plausible but does not
 * track the audio (wrong chunk offset, unsigned 8-bit read as signed, silence amplified
 * into a full-scale mouth).
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  parseWav,
  amplitudeEnvelope,
  levelAt,
  DEFAULT_WINDOW_MS,
} from '../src/tui/audio-envelope.js';

/** Build a 16-bit PCM mono WAV. `samples` are floats in -1..1. */
function wav16(samples: number[], sampleRate = 16000, extraChunk = false): Buffer {
  const data = Buffer.alloc(samples.length * 2);
  samples.forEach((s, i) => data.writeInt16LE(Math.max(-32768, Math.min(32767, Math.round(s * 32767))), i * 2));
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0); fmt.writeUInt16LE(1, 2);
  fmt.writeUInt32LE(sampleRate, 4); fmt.writeUInt32LE(sampleRate * 2, 8);
  fmt.writeUInt16LE(2, 12); fmt.writeUInt16LE(16, 14);

  const chunks: Buffer[] = [];
  const chunk = (id: string, body: Buffer) => {
    const h = Buffer.alloc(8);
    h.write(id, 0, 'ascii'); h.writeUInt32LE(body.length, 4);
    // Word alignment: odd-sized chunks carry a pad byte.
    chunks.push(h, body, ...(body.length % 2 ? [Buffer.alloc(1)] : []));
  };
  chunk('fmt ', fmt);
  // A metadata chunk between fmt and data — TTS backends really emit these, and a
  // fixed-44-byte reader would decode it as audio.
  if (extraChunk) chunk('LIST', Buffer.from('INFOhello!', 'ascii'));
  chunk('data', data);

  const body = Buffer.concat(chunks);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'ascii'); head.writeUInt32LE(4 + body.length, 4); head.write('WAVE', 8, 'ascii');
  return Buffer.concat([head, body]);
}

const loud = (n: number) => Array.from({ length: n }, (_, i) => (i % 2 ? 0.9 : -0.9));
const quiet = (n: number) => Array.from({ length: n }, (_, i) => (i % 2 ? 0.02 : -0.02));
const silence = (n: number) => Array.from({ length: n }, () => 0);

test('parseWav reads format and payload', () => {
  const info = parseWav(wav16(loud(1000)));
  assert.ok(info);
  assert.equal(info!.format, 1);
  assert.equal(info!.channels, 1);
  assert.equal(info!.sampleRate, 16000);
  assert.equal(info!.bitsPerSample, 16);
  assert.equal(info!.data.length, 2000);
});

test('parseWav walks chunks — a LIST before data is not read as audio', () => {
  const withMeta = parseWav(wav16(loud(1000), 16000, true));
  const without = parseWav(wav16(loud(1000), 16000, false));
  assert.ok(withMeta && without);
  // Same audio either way: the payload must come from the data chunk, not a fixed offset.
  assert.equal(withMeta!.data.length, without!.data.length);
  assert.deepEqual(withMeta!.data, without!.data);
});

test('parseWav rejects non-WAV and truncated input', () => {
  assert.equal(parseWav(Buffer.alloc(0)), null);
  assert.equal(parseWav(Buffer.from('not audio at all', 'ascii')), null);
  const mp3ish = Buffer.concat([Buffer.from('ID3'), Buffer.alloc(64)]);
  assert.equal(parseWav(mp3ish), null);
});

test('envelope normalises to the PEAK, so a quiet voice still opens the mouth', () => {
  const l = amplitudeEnvelope(wav16(loud(16000)));
  const q = amplitudeEnvelope(wav16(quiet(16000)));
  assert.ok(l && q);
  const maxOf = (xs: number[]) => xs.reduce((m, v) => Math.max(m, v), 0);
  // A -34dBFS render must reach the same normalised peak as a hot one.
  assert.ok(maxOf(l!.levels) > 0.99, `loud peak ${maxOf(l!.levels)}`);
  assert.ok(maxOf(q!.levels) > 0.99, `quiet peak ${maxOf(q!.levels)}`);
});

test('digital silence stays 0 — never amplified into a full-scale mouth', () => {
  const env = amplitudeEnvelope(wav16(silence(16000)));
  assert.ok(env);
  assert.ok(env!.levels.every((v) => v === 0), 'silence produced a non-zero level');
});

test('envelope tracks loudness over time', () => {
  // 0.5s silence, then 0.5s loud, at 16kHz.
  const env = amplitudeEnvelope(wav16([...silence(8000), ...loud(8000)]));
  assert.ok(env);
  assert.ok(levelAt(env!, 100) < 0.05, 'should be quiet at 100ms');
  assert.ok(levelAt(env!, 750) > 0.9, 'should be loud at 750ms');
});

test('levels are bounded 0..1 and duration comes from the sample count', () => {
  const env = amplitudeEnvelope(wav16(loud(16000)));
  assert.ok(env);
  assert.ok(env!.levels.every((v) => v >= 0 && v <= 1));
  assert.equal(env!.windowMs, DEFAULT_WINDOW_MS);
  // 16000 samples @ 16kHz = 1000ms.
  assert.ok(Math.abs(env!.durationMs - 1000) <= 1, `durationMs ${env!.durationMs}`);
});

test('levelAt is 0 outside the audio — a stuck-open mouth is the failure mode', () => {
  const env = amplitudeEnvelope(wav16(loud(16000)));
  assert.ok(env);
  assert.equal(levelAt(env!, -5), 0);
  assert.equal(levelAt(env!, 60_000), 0);
});

test('8-bit WAV is unsigned — reading it as signed would invert loud and quiet', () => {
  // 8-bit silence is 0x80, NOT 0x00. A signed read makes it read as full-scale.
  const data = Buffer.alloc(8000, 0x80);
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(1, 0); fmt.writeUInt16LE(1, 2);
  fmt.writeUInt32LE(8000, 4); fmt.writeUInt32LE(8000, 8);
  fmt.writeUInt16LE(1, 12); fmt.writeUInt16LE(8, 14);
  const mk = (id: string, b: Buffer) => {
    const h = Buffer.alloc(8); h.write(id, 0, 'ascii'); h.writeUInt32LE(b.length, 4);
    return Buffer.concat([h, b]);
  };
  const body = Buffer.concat([mk('fmt ', fmt), mk('data', data)]);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'ascii'); head.writeUInt32LE(4 + body.length, 4); head.write('WAVE', 8, 'ascii');
  const env = amplitudeEnvelope(Buffer.concat([head, body]));
  assert.ok(env);
  assert.ok(env!.levels.every((v) => v === 0), '8-bit 0x80 must decode as silence');
});

test('unsupported encodings return null rather than a fabricated envelope', () => {
  // Format 2 (MS ADPCM) — decodable by nobody here; must NOT guess.
  const fmt = Buffer.alloc(16);
  fmt.writeUInt16LE(2, 0); fmt.writeUInt16LE(1, 2);
  fmt.writeUInt32LE(16000, 4); fmt.writeUInt32LE(16000, 8);
  fmt.writeUInt16LE(1, 12); fmt.writeUInt16LE(4, 14);
  const mk = (id: string, b: Buffer) => {
    const h = Buffer.alloc(8); h.write(id, 0, 'ascii'); h.writeUInt32LE(b.length, 4);
    return Buffer.concat([h, b]);
  };
  const body = Buffer.concat([mk('fmt ', fmt), mk('data', Buffer.alloc(400))]);
  const head = Buffer.alloc(12);
  head.write('RIFF', 0, 'ascii'); head.writeUInt32LE(4 + body.length, 4); head.write('WAVE', 8, 'ascii');
  assert.equal(amplitudeEnvelope(Buffer.concat([head, body])), null);
});
