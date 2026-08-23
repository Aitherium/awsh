/**
 * AitherVoice TTS — opt-in "speak Aither's answers aloud".
 *
 * Talks to the AitherVoice service (PerceptionMedia :8084, compound prefix
 * /voice) over HTTPS with the internal CA (rejectUnauthorized:false), falling
 * back to HTTP. Synthesises to a temp file and plays it via an OS player
 * child-process — no audio npm deps. Off by default; the REPL flips `enabled`
 * via a /voice command and calls `say()` with each finished answer, so playback
 * is serialised (one utterance at a time) and never blocks the UI.
 *
 * POST /voice/synthesize  { text, voice, speed, format, return_base64:true }
 *   → { success, audio_base64, format, duration_seconds, error }
 */
import { spawnSync, spawn } from 'node:child_process';
import { request as httpsRequest } from 'node:https';
import { request as httpRequest } from 'node:http';
import { writeFileSync, mkdirSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { amplitudeEnvelope, levelAt, type Envelope } from './audio-envelope.js';

export interface VoiceOptions {
  baseUrl?: string;                   // service root incl. /voice prefix; local or gateway
  fallbackUrl?: string;               // fallback endpoint for local voice (adk bridge :8085)
  headers?: Record<string, string>;   // auth headers (Bearer + X-API-Key) when routed via the gateway
  voice?: string;                     // nova|alloy|echo|fable|onyx|shimmer (default nova)
  format?: string;                    // wav|mp3|opus|… (default wav — most reliable for local playback)
  speed?: number;                     // 0.25..4.0
}

const DEFAULTS = { baseUrl: 'https://127.0.0.1:8084/voice', voice: 'nova', format: 'wav', speed: 1.0 };

// User-tunable playback rate (× normal). The service accepts 0.25–4.0; the
// controller default is brisker than 1.0 because the fleet voices read slow.
export const SPEED_MIN = 0.25;
export const SPEED_MAX = 4.0;
export const SPEED_DEFAULT = 1.25;
export const clampSpeed = (n: number): number => Math.max(SPEED_MIN, Math.min(SPEED_MAX, n));

/**
 * How long an answer may be held back waiting for TTS before it is shown anyway (ms).
 *
 * Measured 2026-07-29: genesis returned a complete answer in 1.2s and the shell rendered it
 * at 33.7s, because speakSynced awaited synthesis before revealing a single character and a
 * cold edge-tts round-trip took 7.2s. The screen is simply BLANK for that whole window,
 * which is indistinguishable from a hung shell. Past this budget the text wins and the
 * audio catches up.
 */
export const REVEAL_BUDGET_MS = 900;

/** Build the /voice/synthesize request body (pure — unit-tested). */
export function buildSynthesisBody(text: string, opts: VoiceOptions = {}): Record<string, unknown> {
  return {
    text,
    voice: opts.voice ?? DEFAULTS.voice,
    speed: opts.speed ?? DEFAULTS.speed,
    format: opts.format ?? DEFAULTS.format,
    return_base64: true,
  };
}

/** Parse a SynthesisResult into a decoded audio buffer (pure — unit-tested). */
export function parseSynthesisResult(json: any): { ok: boolean; audio?: Buffer; format?: string; error?: string } {
  if (!json || json.success === false) return { ok: false, error: json?.error || 'synthesis failed' };
  if (typeof json.audio_base64 === 'string' && json.audio_base64.length) {
    return { ok: true, audio: Buffer.from(json.audio_base64, 'base64'), format: json.format || 'wav' };
  }
  return { ok: false, error: 'no audio_base64 in response' };
}

/**
 * Choose an OS audio-player command for `file` (pure — unit-tested).
 * Prefers ffplay (handles any format, silent) when present; else a
 * platform-native player. WAV is the safe default for the native players.
 */
export function pickPlayer(platform: NodeJS.Platform, hasFfplay: boolean, file: string): { cmd: string; args: string[] } | null {
  if (hasFfplay) return { cmd: 'ffplay', args: ['-nodisp', '-autoexit', '-loglevel', 'quiet', file] };
  switch (platform) {
    case 'win32':
      // System.Media.SoundPlayer plays WAV synchronously without a UI window.
      return { cmd: 'powershell', args: ['-NoProfile', '-Command', `(New-Object Media.SoundPlayer '${file}').PlaySync()`] };
    case 'darwin':
      return { cmd: 'afplay', args: [file] };
    case 'linux':
      return { cmd: 'aplay', args: ['-q', file] };
    default:
      return null;
  }
}

function ffplayAvailable(): boolean {
  try { return spawnSync('ffplay', ['-version'], { stdio: 'ignore' }).status === 0; }
  catch { return false; }
}

function httpJson(url: string, body: unknown, headers: Record<string, string> = {}, timeoutMs = 20000): Promise<any> {
  return new Promise((resolve, reject) => {
    const u = new URL(url);
    const payload = Buffer.from(JSON.stringify(body));
    const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(
      u,
      {
        method: 'POST',
        rejectUnauthorized: false,   // internal CA
        headers: { 'Content-Type': 'application/json', 'Content-Length': payload.length, 'X-Caller-Type': 'PLATFORM', ...headers },
        timeout: timeoutMs,
      } as any,
      (res) => {
        const chunks: Buffer[] = [];
        res.on('data', (c) => chunks.push(c));
        res.on('end', () => {
          try { resolve(JSON.parse(Buffer.concat(chunks).toString('utf8'))); }
          catch (e) { reject(e); }
        });
      },
    );
    req.on('error', reject);
    req.on('timeout', () => req.destroy(new Error('voice synth timeout')));
    req.write(payload); req.end();
  });
}

/** Synthesise `text` → a temp audio file path (try primary, fallback to secondary, HTTPS first, HTTP fallback). */
export async function synthesize(text: string, opts: VoiceOptions = {}): Promise<{ ok: boolean; path?: string; format?: string; durationS?: number; error?: string }> {
  const base = (opts.baseUrl ?? DEFAULTS.baseUrl).replace(/\/+$/, '');
  const fallback = opts.fallbackUrl?.replace(/\/+$/, '') || '';
  const headers = opts.headers ?? {};
  const body = buildSynthesisBody(text, opts);
  let json: any;
  try {
    json = await httpJson(`${base}/synthesize`, body, headers);
  } catch (e: any) {
    // HTTP fallback ONLY for a local https endpoint (dev). Remote/gateway stays HTTPS.
    if (/^https:\/\/(127\.0\.0\.1|localhost)/.test(base)) {
      try { json = await httpJson(`${base.replace('https://', 'http://')}/synthesize`, body, headers); }
      catch (e2: any) {
        // Try fallback endpoint if primary failed and fallback is configured.
        // Try it as-configured AND (for a local endpoint) the other scheme, so a
        // https-configured fallback still reaches the http-only adk bridge — this
        // is what keeps available() and synthesize() from disagreeing (the silent
        // "voice available but never speaks" no-op).
        if (fallback) {
          const fbUrls = [`${fallback}/synthesize`];
          if (/^https:\/\/(127\.0\.0\.1|localhost)/.test(fallback)) {
            fbUrls.push(`${fallback.replace('https://', 'http://')}/synthesize`);
          } else if (/^http:\/\/(127\.0\.0\.1|localhost)/.test(fallback)) {
            fbUrls.push(`${fallback.replace('http://', 'https://')}/synthesize`);
          }
          let got = false;
          for (const fu of fbUrls) {
            try { json = await httpJson(fu, body, headers); got = true; break; } catch { /* try next */ }
          }
          if (!got) return { ok: false, error: 'voice unreachable (primary + fallback)' };
        } else {
          return { ok: false, error: `voice unreachable: ${e2?.message || e2}` };
        }
      }
    } else {
      return { ok: false, error: `voice unreachable: ${e?.message || e}` };
    }
  }
  const parsed = parseSynthesisResult(json);
  if (!parsed.ok || !parsed.audio) return { ok: false, error: parsed.error };
  const dir = join(tmpdir(), 'aither-voice');
  try { mkdirSync(dir, { recursive: true }); } catch { /* */ }
  const file = join(dir, `speak_${process.pid}_${(json.duration_seconds || 0)}.${parsed.format || 'wav'}`);
  writeFileSync(file, parsed.audio);
  return { ok: true, path: file, format: parsed.format, durationS: Number(json.duration_seconds) || undefined };
}

const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Reveal `text` in ~N small steps spread across `durationMs`, appending deltas. */
async function revealOver(text: string, durationMs: number, append: (delta: string) => void): Promise<void> {
  const steps = Math.max(1, Math.min(text.length, 140));
  const per = Math.ceil(text.length / steps);
  const interval = durationMs / Math.ceil(text.length / per);
  for (let i = 0; i < text.length; i += per) {
    append(text.slice(i, i + per));
    await sleep(interval);
  }
}

// ── Lip-sync: replay the real amplitude envelope alongside playback ───────────
//
// None of the OS players report loudness back, so the only way to drive a mouth from the
// ACTUAL speech is to decode the WAV ourselves (audio-envelope.ts) and walk the envelope on
// a timer while the player runs.
//
// The catch that made the first version look broken: the player does not start emitting
// audio the instant it is spawned. Measured on this box 2026-07-29 — 336 / 311 / 284 /
// 333 ms across 0.5 / 1 / 2 / 4 s files, i.e. a roughly CONSTANT ~316 ms of process +
// device startup, not a proportional one. Ignoring it makes the mouth lead the voice by a
// third of a second, which reads as "the lip-sync is wrong" rather than "it is early".

/** Startup overhead assumed before a self-calibrated sample exists (ms, measured). */
export const DEFAULT_PLAYER_STARTUP_MS = 316;
/** A sample outside this range is a stall or a clock artefact, not startup — discard it. */
const STARTUP_SAMPLE_MAX_MS = 2000;

let startupOffsetMs = DEFAULT_PLAYER_STARTUP_MS;

/**
 * Fold one measured sample into the running startup estimate (pure — unit-tested).
 *
 * An EWMA rather than a fresh reading: a single stalled spawn would otherwise pin the
 * mouth half a second late for the rest of the session. Out-of-range samples are refused
 * outright, which is why this returns `current` unchanged rather than clamping — a clamped
 * bogus sample still drags the estimate.
 */
export function nextStartupEstimate(current: number, sampleMs: number, weight = 0.3): number {
  if (!Number.isFinite(sampleMs) || sampleMs < 0 || sampleMs > STARTUP_SAMPLE_MAX_MS) return current;
  return Math.round(current * (1 - weight) + sampleMs * weight);
}

/** The startup offset currently in use (ms). */
export function playerStartupOffsetMs(): number { return startupOffsetMs; }

/**
 * Level to emit at `elapsedMs` after SPAWN (pure — unit-tested).
 *
 * Shifting by the startup offset is the whole fix: during the first ~316 ms the player is
 * still opening the device, so the honest level is 0 (mouth shut), not `levels[0]`.
 */
export function levelTap(env: Envelope | null, elapsedMs: number, offsetMs: number): number {
  if (!env) return 0;
  return levelAt(env, elapsedMs - offsetMs);
}

let levelSink: ((level: number) => void) | null = null;
let currentLevel = 0;

/** Route every playback level to `fn` (the REPL wires this to Persona). null unhooks. */
export function setLevelSink(fn: ((level: number) => void) | null): void { levelSink = fn; }

/** The level emitted most recently — the docked avatar reads this to pick a mouth frame. */
export function getLevel(): number { return currentLevel; }

function emitLevel(level: number, onLevel?: (level: number) => void): void {
  currentLevel = level;
  try { onLevel?.(level); } catch { /* a consumer must never break playback */ }
  try { levelSink?.(level); } catch { /* ditto */ }
}

/**
 * PCM for `file` when it is not already a WAV we can read, via ffmpeg.
 *
 * AitherVoice IGNORES the requested format: `buildSynthesisBody` asks for wav and the
 * service answers mp3 every time (verified 2026-07-30 — `format:"mp3"` in the JSON and an
 * `ff f3` MPEG frame sync in the bytes, for BOTH `format:"wav"` and `format:"mp3"`
 * requests). audio-envelope.ts honestly returns null for that, which is correct and also
 * means the whole lip-sync path was INERT in production: no levels, no error, a mouth that
 * simply never moved from real amplitude. Nothing looked broken.
 *
 * No npm dependency is added — ffmpeg ships with the ffplay this module already prefers as
 * its player, so on any box that can play the audio well we can also measure it. If ffmpeg
 * is absent we still return null rather than inventing an envelope.
 */
export function transcodeToWav(file: string): Buffer | null {
  try {
    const r = spawnSync(
      'ffmpeg',
      ['-v', 'quiet', '-i', file, '-ac', '1', '-ar', '16000', '-f', 'wav', 'pipe:1'],
      { maxBuffer: 64 * 1024 * 1024, timeout: 10_000 },
    );
    if (r.status !== 0 || !r.stdout?.length) return null;
    return Buffer.from(r.stdout);
  } catch { return null; }
}

/** Decode `file` into an envelope, or null if we genuinely cannot read it. */
export function envelopeFor(file: string): Envelope | null {
  try {
    const direct = amplitudeEnvelope(readFileSync(file));
    if (direct) return direct;
    const wav = transcodeToWav(file);
    return wav ? amplitudeEnvelope(wav) : null;
  } catch { return null; }
}

/**
 * Play an audio file, resolving when playback ends (or immediately if no player).
 *
 * While it plays, the real amplitude envelope is walked on a timer and pushed to `onLevel`
 * and the module level sink. Undecodable audio yields NO levels at all rather than a
 * fabricated one — see the honest-failure note in audio-envelope.ts.
 */
export function play(file: string, onLevel?: (level: number) => void): Promise<void> {
  return new Promise((resolve) => {
    const player = pickPlayer(process.platform, ffplayAvailable(), file);
    if (!player) { resolve(); return; }
    const env = envelopeFor(file);
    let timer: NodeJS.Timeout | null = null;
    const startedAt = Date.now();

    const stop = () => {
      if (timer) { clearInterval(timer); timer = null; }
      // Calibrate: wall-clock minus the audio's own duration IS the startup overhead.
      if (env && env.durationMs > 0) {
        startupOffsetMs = nextStartupEstimate(startupOffsetMs, Date.now() - startedAt - env.durationMs);
      }
      emitLevel(0, onLevel);   // mouth shuts when the audio stops, always
      resolve();
    };

    try {
      const p = spawn(player.cmd, player.args, { stdio: 'ignore' });
      if (env) {
        timer = setInterval(() => {
          emitLevel(levelTap(env, Date.now() - startedAt, startupOffsetMs), onLevel);
        }, env.windowMs);
        if (typeof timer.unref === 'function') timer.unref();
      }
      p.on('exit', stop);
      p.on('error', stop);
    } catch { stop(); }
  });
}

/**
 * Serialised voice controller for the REPL. `say()` queues utterances so answers
 * never overlap; enable/disable is a cheap toggle. All failures are swallowed so
 * voice never breaks the chat loop.
 */
export class VoiceController {
  private enabled = false;
  private opts: VoiceOptions;
  private queue: Promise<void> = Promise.resolve();
  private speaking = false;
  /** The user's chosen rate — affect nudges AROUND this, never replaces it. */
  private baseSpeed = SPEED_DEFAULT;
  private lastArousal = 0;

  constructor(opts: VoiceOptions = {}) {
    this.opts = opts;
    if (typeof opts.speed === 'number') this.baseSpeed = clampSpeed(opts.speed);
    this.opts.speed = this.baseSpeed;
  }

  /** Route live playback amplitude somewhere (the REPL sends it to Persona). null unhooks. */
  setLevelSink(fn: ((level: number) => void) | null): void { setLevelSink(fn); }
  /** Amplitude of the audio playing right now, 0..1 (0 when silent or undecodable). */
  level(): number { return getLevel(); }

  isEnabled(): boolean { return this.enabled; }
  setVoice(voice: string): void { this.opts.voice = voice; }
  getVoice(): string { return this.opts.voice ?? DEFAULTS.voice; }
  enable(): void { this.enabled = true; }
  disable(): void { this.enabled = false; }
  isSpeaking(): boolean { return this.speaking; }

  /** Set the user's base speaking rate (clamped to the service's 0.25–4.0). */
  setSpeed(speed: number): number {
    this.baseSpeed = clampSpeed(speed);
    this.applySpeed();
    return this.baseSpeed;
  }
  getSpeed(): number { return this.baseSpeed; }
  /** The rate actually sent to the service (base × gentle affect nudge). */
  effectiveSpeed(): number { return this.opts.speed ?? this.baseSpeed; }

  private applySpeed(): void {
    // Arousal adds up to +15% on top of the user's rate — excited talks a bit
    // faster, but the user's /voice speed choice always dominates.
    this.opts.speed = clampSpeed(this.baseSpeed * (1 + 0.15 * this.lastArousal));
  }

  /** Health probe against the configured base, fallback, and HTTP variants. */
  async available(): Promise<boolean> {
    const base = (this.opts.baseUrl ?? DEFAULTS.baseUrl).replace(/\/+$/, '');
    const fallback = (this.opts.fallbackUrl ?? '').replace(/\/+$/, '') || '';
    const urls = [];
    // Add primary endpoint (HTTPS + HTTP for local)
    urls.push(`${base}/health`);
    if (/^https:\/\/(127\.0\.0\.1|localhost)/.test(base)) {
      urls.push(`${base.replace('https://', 'http://')}/health`);
    }
    // Add fallback endpoint if configured (HTTPS + HTTP for local)
    if (fallback) {
      urls.push(`${fallback}/health`);
      if (/^https:\/\/(127\.0\.0\.1|localhost)/.test(fallback)) {
        urls.push(`${fallback.replace('https://', 'http://')}/health`);
      }
    }
    for (const url of urls) {
      try {
        const u = new URL(url);
        const ok = await new Promise<boolean>((resolve) => {
          const req = (u.protocol === 'https:' ? httpsRequest : httpRequest)(
            u, { method: 'GET', rejectUnauthorized: false, timeout: 3000, headers: this.opts.headers || {} } as any,
            (res) => { res.resume(); resolve((res.statusCode || 500) < 500); },
          );
          req.on('error', () => resolve(false));
          req.on('timeout', () => { req.destroy(); resolve(false); });
          req.end();
        });
        if (ok) return true;
      } catch { /* try next url */ }
    }
    return false;
  }

  /**
   * Modulate prosody from AitherSense affect. AitherVoice ALSO reads affect
   * server-side (its backends shape prosody from mood/valence/arousal), so this
   * is a reinforcing client-side nudge, not the sole source: arousal adds a
   * small speed-up on top of the user's base rate (see applySpeed) — it must
   * never override a /voice speed choice.
   */
  setAffect(affect: { arousal?: number; valence?: number } | null): void {
    if (!affect) return;
    const ar = typeof affect.arousal === 'number' ? affect.arousal : 0.4;
    this.lastArousal = Math.max(0, Math.min(1, ar));
    this.applySpeed();
  }

  /**
   * Speak `text` AND drive a text reveal paced to the audio, so the printed
   * words appear as Aither says them (fixes the "instant text, slow late voice"
   * desync). `reveal(delta)` receives incremental chunks; call it to append to
   * the output pane. Falls back to revealing everything at once if voice is
   * disabled or synthesis fails. Awaits until playback + reveal both finish.
   */
  async speakSynced(
    text: string,
    reveal: (delta: string) => void,
  ): Promise<{ ok: boolean; error?: string; deferred?: boolean }> {
    const full = text ?? '';
    if (!this.enabled || !full.trim()) { reveal(full); return { ok: true }; }
    try {
      const clean = full.replace(/```[\s\S]*?```/g, ' code block ').replace(/[*_`#>]/g, '');
      const synth = synthesize(clean.slice(0, 1600), this.opts);
      // Attach a catch NOW: if the budget wins the race nobody awaits `synth` on this
      // tick, and an unattached rejection takes the process down.
      synth.catch(() => { /* handled on whichever path consumes it */ });

      // Race synthesis against the budget. Awaiting synthesis before revealing ANYTHING is
      // what blanked the screen for 33.7s against a 1.2s answer: cold edge-tts is a cloud
      // round-trip, and the user is left staring at nothing with no way to tell that the
      // answer already arrived.
      let budgetTimer: NodeJS.Timeout | undefined;
      const budget = new Promise<'budget'>((res) => {
        budgetTimer = setTimeout(() => res('budget'), REVEAL_BUDGET_MS);
      });
      const winner = await Promise.race([synth.then(() => 'synth' as const).catch(() => 'synth' as const), budget]);
      if (budgetTimer) clearTimeout(budgetTimer);

      if (winner === 'budget') {
        // Text NOW, audio when it lands. No paced reveal — pacing to a duration we do not
        // yet know would desync worse than not pacing at all.
        reveal(full);
        this.queue = this.queue.then(async () => {
          if (!this.enabled) return;
          try {
            const r = await synth;
            if (r.ok && r.path) { this.speaking = true; await play(r.path); }
          } catch { /* swallow — voice must never break the loop */ }
          finally { this.speaking = false; }
        });
        return { ok: true, deferred: true };
      }

      const r = await synth;
      if (!r.ok || !r.path) {
        // Synthesis failed — reveal the text at once (NOT the paced/talking loop) so
        // we never fake a speaking mouth when there's no audio. Report why.
        reveal(full);
        return { ok: false, error: r.error };
      }
      this.speaking = true;   // she is ACTUALLY speaking now → mouth animates
      // Estimate duration: prefer the service value; else ~15 chars/sec of speech.
      const durationMs = Math.max(600, Math.round((r.durationS || full.length / 15) * 1000));
      const playing = play(r.path);                     // audio starts now
      await revealOver(full, durationMs, reveal);        // text types out over the same window
      await playing;
      return { ok: true };
    } catch (e: any) { reveal(full); return { ok: false, error: e?.message || 'voice error' }; }
    finally { this.speaking = false; }
  }

  /** Queue `text` to be spoken (no-op when disabled). Never throws. */
  say(text: string): void {
    if (!this.enabled || !text.trim()) return;
    const clean = text.replace(/```[\s\S]*?```/g, ' code block ').replace(/[*_`#>]/g, '').slice(0, 1200);
    this.queue = this.queue.then(async () => {
      if (!this.enabled) return;
      this.speaking = true;
      try {
        const r = await synthesize(clean, this.opts);
        if (r.ok && r.path) await play(r.path);
      } catch { /* swallow — voice must never break the loop */ }
      finally { this.speaking = false; }
    });
  }
}
