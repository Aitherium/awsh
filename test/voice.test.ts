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

// ── Workspace custom voices (`custom:<name>`) via Genesis /voice-builds ───────
// The live fleet has zero custom voices, so every test here uses a mocked Genesis client.
import { synthesize, listCustomVoices, voiceListLines, isCustomVoice, customSayPath, customSayBody,
         CUSTOM_SAY_TIMEOUT_MS, CUSTOM_SAY_MAX_CHARS, type GenesisVoiceClient } from '../src/tui/voice.js';

function mockGenesis(reply: { say?: any; list?: any }) {
  const calls: Array<{ method: string; path: string; body?: any; timeoutMs?: number }> = [];
  const client: GenesisVoiceClient = {
    async requestDetailed(method, path, body, timeoutMs) { calls.push({ method, path, body, timeoutMs }); return reply.say; },
    async getDetailed(path) { calls.push({ method: 'GET', path }); return reply.list; },
  };
  return { client, calls };
}

describe('custom voices', () => {
  const wav = Buffer.from('RIFFcustom', 'utf8');

  test('custom:foo speaks through POST /voice-builds/voices/foo/say and never calls AitherVoice', async () => {
    const { client, calls } = mockGenesis({ say: { audio_base64: wav.toString('base64'), format: 'wav', voice: 'custom:foo' } });
    // baseUrl points at a port nothing listens on: a stock-path call would fail the test.
    const r = await synthesize('hello', { voice: 'custom:foo', speed: 1.5, genesis: client, baseUrl: 'https://127.0.0.1:9/voice' });
    assert.equal(r.ok, true, r.error);
    assert.deepEqual(readFileSync(r.path!), wav);
    unlinkSync(r.path!);
    assert.equal(calls.length, 1);
    assert.deepEqual(calls[0], { method: 'POST', path: '/voice-builds/voices/foo/say', body: { text: 'hello', speed: 1.5 }, timeoutMs: CUSTOM_SAY_TIMEOUT_MS });
  });

  test('a Genesis error is reported, never silently re-voiced', async () => {
    const { client } = mockGenesis({ say: { error: 'No such voice in this workspace', status: 404 } });
    const r = await synthesize('hello', { voice: 'custom:ghost', genesis: client });
    assert.equal(r.ok, false);
    assert.match(r.error!, /custom voice: No such voice/);
  });

  test('custom voice without a Genesis client fails cleanly', async () => {
    const r = await synthesize('hello', { voice: 'custom:dad' });
    assert.equal(r.ok, false);
    assert.match(r.error!, /Genesis connection/);
  });

  test('a stock voice never touches Genesis', async () => {
    const { client, calls } = mockGenesis({ say: { audio_base64: wav.toString('base64') } });
    const r = await synthesize('hello', { voice: 'nova', genesis: client, baseUrl: 'https://127.0.0.1:9/voice' });
    assert.equal(r.ok, false);         // stock path tried the (unreachable) AitherVoice URL
    assert.equal(calls.length, 0);
  });

  test('names with spaces or a slash are URL-encoded', () => {
    assert.equal(customSayPath('custom:grandpa joe'), '/voice-builds/voices/grandpa%20joe/say');
    assert.equal(customSayPath('custom:a/b'), '/voice-builds/voices/a%2Fb/say');
    assert.equal(isCustomVoice('custom:'), false);
    assert.equal(isCustomVoice('nova'), false);
    assert.equal(isCustomVoice('custom:dad'), true);
  });

  test('listCustomVoices maps names to custom:<name>; empty/error -> []', async () => {
    assert.deepEqual(await listCustomVoices(mockGenesis({ list: { voices: [] } }).client), []);
    assert.deepEqual(await listCustomVoices(mockGenesis({ list: { error: 'Not Found', status: 404 } }).client), []);
    assert.deepEqual(await listCustomVoices(undefined), []);
    const { client, calls } = mockGenesis({ list: { voices: [{ id: 'v1', name: 'dad', reader: 'r', language: 'en', built_at: 1, gate: {} }] } });
    assert.deepEqual(await listCustomVoices(client), ['custom:dad']);
    assert.deepEqual(calls, [{ method: 'GET', path: '/voice-builds/voices' }]);
  });

  test('/voice list renders stock names and the empty-workspace line', () => {
    const empty = voiceListLines([]);
    assert.match(empty[0], /nova, alloy, echo, fable, onyx, shimmer/);
    assert.equal(empty[1], '  (no custom voices in this workspace)');
    assert.deepEqual(voiceListLines(['custom:dad']).slice(1), ['  custom: custom:dad']);
  });

  test('custom say body fits the Genesis SayRequest bounds (text <= 1000, speed 0.5..2.0)', async () => {
    // The TUI sends up to 1600 chars and speeds up to 4x; Genesis would 422 both.
    const long = 'word '.repeat(400);                     // 2000 chars
    const b = customSayBody(long, 3.5);
    assert.ok(b.text.length <= CUSTOM_SAY_MAX_CHARS && b.text.length > 800, String(b.text.length));
    assert.ok(!b.text.endsWith(' '));
    assert.equal(b.speed, 2.0);
    assert.equal(customSayBody('hi', 0.25).speed, 0.5);
    assert.equal(customSayBody('hi', undefined).speed, 1.0);
    assert.deepEqual(customSayBody('hi', 1.25), { text: 'hi', speed: 1.25 });
    const { client, calls } = mockGenesis({ say: { audio_base64: wav.toString('base64'), format: 'wav' } });
    const r = await synthesize(long, { voice: 'custom:foo', speed: 4, genesis: client });
    assert.equal(r.ok, true, r.error);
    unlinkSync(r.path!);
    assert.ok(calls[0].body.text.length <= CUSTOM_SAY_MAX_CHARS);
    assert.equal(calls[0].body.speed, 2.0);
  });

  test('VoiceController.available() for a custom voice checks the workspace list, not AitherVoice', async () => {
    const present = new VoiceController({ voice: 'custom:dad', genesis: mockGenesis({ list: { voices: [{ name: 'dad' }] } }).client });
    assert.equal(await present.available(), true);
    const absent = new VoiceController({ voice: 'custom:mom', genesis: mockGenesis({ list: { voices: [] } }).client });
    assert.equal(await absent.available(), false);
  });
});
