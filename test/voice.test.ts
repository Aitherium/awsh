/**
 * AitherVoice client: unit-test the pure pieces (request body, result parsing,
 * OS player selection, affect→speed modulation). Network + playback are not
 * exercised here (they hit the live service / OS).
 */
import { strict as assert } from 'assert';
import { test, describe } from 'node:test';
import { buildSynthesisBody, parseSynthesisResult, pickPlayer, VoiceController, SPEED_DEFAULT, SPEED_MIN, SPEED_MAX,
         nextStartupEstimate, levelTap, setLevelSink, getLevel, playerStartupOffsetMs, DEFAULT_PLAYER_STARTUP_MS } from '../src/tui/voice.js';
import { transcodeToWav, envelopeFor } from '../src/tui/voice.js';
import { amplitudeEnvelope, type Envelope } from '../src/tui/audio-envelope.js';
import { spawnSync } from 'node:child_process';
import { readFileSync, unlinkSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { resolveServiceEndpoint, authHeaders } from '../src/tui/service-endpoint.js';

describe('voice client', () => {
  test('buildSynthesisBody sets defaults + always requests base64', () => {
    const b = buildSynthesisBody('hi') as any;
    assert.equal(b.text, 'hi');
    assert.equal(b.voice, 'nova');
    assert.equal(b.format, 'wav');
    assert.equal(b.return_base64, true);
    const b2 = buildSynthesisBody('yo', { voice: 'onyx', speed: 1.3, format: 'mp3' }) as any;
    assert.equal(b2.voice, 'onyx'); assert.equal(b2.speed, 1.3); assert.equal(b2.format, 'mp3');
  });

  test('parseSynthesisResult decodes base64 / reports failure', () => {
    const audio = Buffer.from('RIFFfake', 'utf8').toString('base64');
    const ok = parseSynthesisResult({ success: true, audio_base64: audio, format: 'wav' });
    assert.equal(ok.ok, true);
    assert.ok(ok.audio instanceof Buffer && ok.audio.toString('utf8') === 'RIFFfake');
    assert.equal(parseSynthesisResult({ success: false, error: 'nope' }).ok, false);
    assert.equal(parseSynthesisResult({ success: true }).ok, false); // no audio
  });

  test('pickPlayer prefers ffplay, else platform-native', () => {
    assert.deepEqual(pickPlayer('win32', true, 'a.wav')?.cmd, 'ffplay');
    assert.equal(pickPlayer('win32', false, 'a.wav')?.cmd, 'powershell');
    assert.equal(pickPlayer('darwin', false, 'a.wav')?.cmd, 'afplay');
    assert.equal(pickPlayer('linux', false, 'a.wav')?.cmd, 'aplay');
    // windows native command references the file
    assert.ok(pickPlayer('win32', false, 'C:/x.wav')?.args.join(' ').includes('C:/x.wav'));
  });

  test('user speed is the base; setSpeed clamps to the service range', () => {
    const vc = new VoiceController();
    assert.equal(vc.getSpeed(), SPEED_DEFAULT);
    assert.equal(vc.setSpeed(1.75), 1.75);
    assert.equal(vc.getSpeed(), 1.75);
    assert.equal(vc.setSpeed(99), SPEED_MAX);    // clamped high
    assert.equal(vc.setSpeed(0), SPEED_MIN);     // clamped low
  });

  test('setAffect nudges AROUND the user speed, never clobbers it', () => {
    const vc = new VoiceController();
    vc.setSpeed(2.0);
    vc.setAffect({ arousal: 1 });                 // max nudge = +15%
    assert.ok(vc.effectiveSpeed() >= 2.0 && vc.effectiveSpeed() <= 2.3 + 1e-9);
    vc.setAffect({ arousal: 0 });                 // calm → exactly the user rate
    assert.equal(vc.effectiveSpeed(), 2.0);
    // A later speed change re-applies on top of the last-known arousal.
    vc.setAffect({ arousal: 1 });
    vc.setSpeed(1.0);
    assert.ok(vc.effectiveSpeed() >= 1.0 && vc.effectiveSpeed() <= 1.15 + 1e-9);
    vc.say('');  // no-op (disabled) but should not throw
  });

  test('setAffect + say never throw when disabled', () => {
    const vc = new VoiceController();
    assert.equal(vc.isEnabled(), false);
    vc.say('hello');           // disabled → no-op
    vc.setAffect(null);        // null-safe
    assert.equal(vc.isSpeaking(), false);
  });
});

describe('service endpoint resolution (gateway vs local)', () => {
  test('local endpoint → direct perception ports, no auth headers', () => {
    const cfg = { genesisUrl: 'http://127.0.0.1:8001', authToken: 'aither_sk_live_xxx' };
    const voice = resolveServiceEndpoint(cfg, 'voice');
    assert.equal(voice.remote, false);
    assert.equal(voice.baseUrl, 'https://127.0.0.1:8084/voice');
    assert.deepEqual(voice.headers, {});   // local = no auth
    const affect = resolveServiceEndpoint(cfg, 'affect');
    assert.equal(affect.baseUrl, 'https://127.0.0.1:8096');
  });

  test('remote endpoint → gateway origin + API key headers', () => {
    const cfg = { genesisUrl: 'https://gateway.aitherium.com', mcpUrl: 'https://mcp.aitherium.com', authToken: 'aither_sk_live_abc', tenantId: 't1' };
    const voice = resolveServiceEndpoint(cfg, 'voice');
    assert.equal(voice.remote, true);
    assert.equal(voice.baseUrl, 'https://mcp.aitherium.com/voice');
    assert.equal(voice.headers['Authorization'], 'Bearer aither_sk_live_abc');
    assert.equal(voice.headers['X-API-Key'], 'aither_sk_live_abc');
    assert.equal(voice.headers['X-Tenant-ID'], 't1');
  });

  test('authHeaders only sets X-API-Key for sk_live/pat tokens', () => {
    assert.equal(authHeaders({ genesisUrl: '', authToken: 'plain-jwt' })['X-API-Key'], undefined);
    assert.equal(authHeaders({ genesisUrl: '', authToken: 'aither_pat_x' })['X-API-Key'], 'aither_pat_x');
  });
});

/**
 * Lip-sync timing. The first version drove the mouth from `Date.now() - spawnTime` with no
 * offset, so it LED the audio by ~316 ms — measured on this box as 336/311/284/333 ms across
 * 0.5/1/2/4 s files, i.e. constant player+device startup, not proportional. That reads as
 * "the lip-sync is broken", and nothing in a screenshot or a passing test could show it.
 */
describe('lip-sync timing', () => {
  const env = (levels: number[], windowMs = 50): Envelope =>
    ({ windowMs, levels, durationMs: levels.length * windowMs });

  test('levelTap holds the mouth SHUT through the player start-up window', () => {
    const e = env([1, 1, 1, 1]);
    assert.equal(levelTap(e, 0, 300), 0);
    assert.equal(levelTap(e, 299, 300), 0, 'mouth opened before audio was audible');
    assert.equal(levelTap(e, 300, 300), 1, 'mouth did not open when audio started');
  });

  test('levelTap indexes the envelope from the SHIFTED clock, not the raw one', () => {
    const e = env([0.1, 0.2, 0.3, 0.4]);
    // 300ms offset + 150ms into the audio = bucket 3.
    assert.equal(levelTap(e, 450, 300), 0.4);
    // Without the shift this would be bucket 9 — past the end, i.e. silence mid-word.
    assert.equal(levelTap(e, 500, 300), 0);
  });

  test('levelTap yields 0 for undecodable audio — never a fabricated mouth', () => {
    assert.equal(levelTap(null, 500, 300), 0);
  });

  test('nextStartupEstimate converges toward a repeated real measurement', () => {
    let est = 100;
    for (let i = 0; i < 30; i++) est = nextStartupEstimate(est, 316);
    assert.ok(Math.abs(est - 316) <= 1, `expected ~316, got ${est}`);
  });

  test('nextStartupEstimate REFUSES an out-of-range sample instead of clamping it', () => {
    // A stalled spawn (or a negative from clock skew) must not drag the estimate at all —
    // clamping still moves it, which is how one bad sample pins the mouth late all session.
    assert.equal(nextStartupEstimate(316, 90_000), 316);
    assert.equal(nextStartupEstimate(316, -50), 316);
    assert.equal(nextStartupEstimate(316, Number.NaN), 316);
  });

  test('the shipped default is the measured value, not a guess', () => {
    assert.equal(DEFAULT_PLAYER_STARTUP_MS, 316);
    assert.equal(playerStartupOffsetMs(), DEFAULT_PLAYER_STARTUP_MS);
  });

  /**
   * AitherVoice IGNORES the requested format. Verified live 2026-07-30: asking for
   * `format:"wav"` returns `format:"mp3"` and MPEG frame-sync bytes, identically to asking
   * for mp3. audio-envelope.ts correctly refuses to decode that — which meant lip-sync was
   * INERT in production: no levels, no error, a mouth that never moved. Nothing looked
   * broken, which is the whole problem.
   */
  test('a non-WAV synthesis still yields an envelope (the service always returns mp3)', () => {
    const mp3 = join(tmpdir(), `aither-voice-test-${process.pid}.mp3`);
    // 0.3s of a 440Hz tone as real mp3 — generated, not committed as a fixture.
    const made = spawnSync('ffmpeg', ['-v', 'quiet', '-y', '-f', 'lavfi', '-i',
      'sine=frequency=440:duration=0.3', '-codec:a', 'libmp3lame', mp3]);

    if (made.status !== 0) {
      // No ffmpeg (or no lame): assert the HONEST-FAILURE contract instead of skipping.
      // A silent skip here is how "the feature is inert" passes CI forever.
      assert.equal(transcodeToWav('definitely-not-a-file.mp3'), null,
        'without ffmpeg, transcode must return null — never a fabricated buffer');
      return;
    }
    try {
      assert.equal(amplitudeEnvelope(readFileSync(mp3)), null,
        'raw mp3 must NOT decode as WAV — that is the honest-failure contract');
      const env = envelopeFor(mp3);
      assert.ok(env, 'envelopeFor must fall back to a transcode when the direct decode fails');
      assert.ok(env!.levels.length > 2, `expected several buckets, got ${env!.levels.length}`);
      assert.ok(Math.max(...env!.levels) > 0.9, 'a 440Hz tone must drive the mouth near peak');
    } finally { try { unlinkSync(mp3); } catch { /* */ } }
  });

  test('transcodeToWav returns null for a file that does not exist', () => {
    assert.equal(transcodeToWav(join(tmpdir(), 'no-such-audio-file.mp3')), null);
  });

  test('setLevelSink(null) unhooks — a stale sink would keep a dead avatar moving', () => {
    const seen: number[] = [];
    setLevelSink(l => seen.push(l));
    setLevelSink(null);
    assert.deepEqual(seen, []);
    assert.equal(typeof getLevel(), 'number');
  });
});
