/**
 * Zero-dependency WAV → amplitude envelope, for driving a mouth from real audio.
 *
 * AitherVoice synthesises to a temp file which we hand to an OS player (ffplay /
 * SoundPlayer / afplay / aplay). None of those report loudness back, so the only way
 * to lip-sync to the ACTUAL speech is to read the samples ourselves and replay the
 * envelope on a timer alongside playback. Same spirit as portrait.ts: parse the
 * container by hand rather than take an audio dependency.
 *
 * Pure functions — no I/O, no timers — so the envelope maths is unit-testable and the
 * scheduling lives in voice.ts.
 *
 * HONEST FAILURE: anything we cannot decode returns `null`, and the caller then leaves
 * the consumer on its coarse speaking/idle state. We never synthesise a fake envelope —
 * a plausible-looking mouth that does not match the audio is worse than no mouth,
 * because it looks like the feature works.
 */

/** WAVE format tags we understand. */
const WAVE_FORMAT_PCM = 0x0001;
const WAVE_FORMAT_IEEE_FLOAT = 0x0003;
const WAVE_FORMAT_EXTENSIBLE = 0xfffe;

export interface WavInfo {
  format: number;         // 1 = PCM, 3 = IEEE float (0xFFFE resolved to one of these)
  channels: number;
  sampleRate: number;
  bitsPerSample: number;
  data: Buffer;           // raw bytes of the `data` chunk
}

/**
 * Parse a RIFF/WAVE buffer into its format + PCM payload.
 *
 * Walks the chunk list rather than assuming the canonical 44-byte header — TTS
 * backends routinely emit `LIST`/`fact`/`cue ` chunks before `data`, and a fixed
 * offset silently reads metadata as audio (which decodes to noise, i.e. a mouth that
 * flaps at random). Returns null on anything malformed or unsupported.
 */
export function parseWav(buf: Buffer): WavInfo | null {
  if (!buf || buf.length < 12) return null;
  if (buf.toString('ascii', 0, 4) !== 'RIFF') return null;
  if (buf.toString('ascii', 8, 12) !== 'WAVE') return null;

  let offset = 12;
  let fmt: { format: number; channels: number; sampleRate: number; bitsPerSample: number } | null = null;
  let data: Buffer | null = null;

  while (offset + 8 <= buf.length) {
    const id = buf.toString('ascii', offset, offset + 4);
    const size = buf.readUInt32LE(offset + 4);
    const body = offset + 8;
    // A truncated final chunk is common when a stream is cut; clamp instead of bailing.
    const end = Math.min(body + size, buf.length);

    if (id === 'fmt ' && end - body >= 16) {
      let format = buf.readUInt16LE(body);
      const channels = buf.readUInt16LE(body + 2);
      const sampleRate = buf.readUInt32LE(body + 4);
      const bitsPerSample = buf.readUInt16LE(body + 14);
      // EXTENSIBLE carries the true tag in the first 2 bytes of its GUID subformat.
      if (format === WAVE_FORMAT_EXTENSIBLE && end - body >= 26) {
        format = buf.readUInt16LE(body + 24);
      }
      fmt = { format, channels, sampleRate, bitsPerSample };
    } else if (id === 'data') {
      data = buf.subarray(body, end);
    }

    // Chunks are word-aligned: an odd size is followed by a pad byte.
    offset = body + size + (size % 2);
    if (size === 0) break;   // malformed — refuse to spin
  }

  if (!fmt || !data || !data.length) return null;
  if (fmt.channels < 1 || fmt.sampleRate < 1000) return null;
  if (fmt.format !== WAVE_FORMAT_PCM && fmt.format !== WAVE_FORMAT_IEEE_FLOAT) return null;
  if (fmt.format === WAVE_FORMAT_IEEE_FLOAT && fmt.bitsPerSample !== 32) return null;
  if (fmt.format === WAVE_FORMAT_PCM && ![8, 16, 24, 32].includes(fmt.bitsPerSample)) return null;

  return { ...fmt, data };
}

/** Read sample `i` from `data` as a float in -1..1. Assumes `i` is in range. */
function readSample(info: WavInfo, i: number): number {
  const { data, bitsPerSample, format } = info;
  const at = i * (bitsPerSample >> 3);
  if (format === WAVE_FORMAT_IEEE_FLOAT) return data.readFloatLE(at);
  switch (bitsPerSample) {
    case 8:  return (data.readUInt8(at) - 128) / 128;        // 8-bit WAV is UNSIGNED
    case 16: return data.readInt16LE(at) / 32768;
    case 24: {
      const v = data.readUInt8(at) | (data.readUInt8(at + 1) << 8) | (data.readInt8(at + 2) << 16);
      return v / 8388608;
    }
    case 32: return data.readInt32LE(at) / 2147483648;
    default: return 0;
  }
}

export interface Envelope {
  /** Duration of each level bucket, ms. */
  windowMs: number;
  /** Per-window loudness, 0..1, normalised so the loudest window is 1. */
  levels: number[];
  /** Total audio duration in ms (from the sample count, not the file size). */
  durationMs: number;
}

/**
 * Default window: ~18 buckets/sec. Chosen deliberately — fast enough to read as
 * speech, slow enough that pushing each level over a loopback socket stays cheap
 * (Persona ignores levels ≤ 0.025, so finer granularity buys nothing visible).
 */
export const DEFAULT_WINDOW_MS = 55;

/**
 * RMS loudness per window, normalised to the loudest window.
 *
 * Normalising to the PEAK (not to full scale) is what makes this work across
 * backends: a quiet TTS voice would otherwise never open the mouth, since a -20dBFS
 * render peaks around 0.1 in absolute terms. RMS rather than peak amplitude because
 * peak tracks transients (plosives, clicks) while RMS tracks perceived loudness,
 * which is what a mouth should follow.
 */
export function amplitudeEnvelope(buf: Buffer, windowMs: number = DEFAULT_WINDOW_MS): Envelope | null {
  const info = parseWav(buf);
  if (!info) return null;

  const bytesPerSample = info.bitsPerSample >> 3;
  const frameBytes = bytesPerSample * info.channels;
  if (frameBytes <= 0) return null;
  const frames = Math.floor(info.data.length / frameBytes);
  if (frames <= 0) return null;

  const win = Math.max(10, windowMs);
  const framesPerWindow = Math.max(1, Math.round((info.sampleRate * win) / 1000));
  const levels: number[] = [];

  for (let start = 0; start < frames; start += framesPerWindow) {
    const stop = Math.min(start + framesPerWindow, frames);
    let sumSquares = 0;
    let counted = 0;
    for (let f = start; f < stop; f++) {
      // Average the channels into one mono value — a mouth has no stereo image.
      let mono = 0;
      for (let c = 0; c < info.channels; c++) mono += readSample(info, f * info.channels + c);
      mono /= info.channels;
      sumSquares += mono * mono;
      counted++;
    }
    levels.push(counted ? Math.sqrt(sumSquares / counted) : 0);
  }

  const peak = levels.reduce((m, v) => (v > m ? v : m), 0);
  // Digital silence (or a DC-only file): report zeros rather than dividing by ~0 and
  // amplifying dither into a full-scale mouth.
  const normalised = peak > 1e-4 ? levels.map((v) => Math.min(1, v / peak)) : levels.map(() => 0);

  return {
    windowMs: win,
    levels: normalised,
    durationMs: Math.round((frames / info.sampleRate) * 1000),
  };
}

/**
 * Level at `elapsedMs` into playback, or 0 past the end.
 * Separate from the envelope so the playback timer stays trivial and testable.
 */
export function levelAt(env: Envelope, elapsedMs: number): number {
  if (!env.levels.length || elapsedMs < 0) return 0;
  const i = Math.floor(elapsedMs / env.windowMs);
  return i >= 0 && i < env.levels.length ? env.levels[i] : 0;
}
