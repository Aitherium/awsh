/**
 * intl-segmenter-guard.ts -- keep awsh alive on a node whose Intl.Segmenter is missing
 * or crashes. MUST be the first import of main.ts: ESM evaluates imports in order, and
 * string-width (via ora) runs `new Intl.Segmenter()` at module load.
 *
 * Measured 2026-11-09: EL9's nodejs-20.20.2 module build SEGFAULTS (exit 139) on
 * `new Intl.Segmenter('en')` in a WSL2 guest, so awsh died before its first prompt. A
 * segfault cannot be caught in-process, so "feature-detect" here means: probe the
 * constructor in a CHILD node once, cache the verdict per (node binary, version,
 * kernel), and when the child dies install a small pure-JS segmenter BEFORE any
 * dependency touches the native one. Width math then stays correct for ASCII, combining
 * marks, ZWJ emoji and flags -- the cases a terminal prompt actually shows.
 *
 * AWSH_INTL_SEGMENTER=native skips the probe; =polyfill forces the fallback.
 */

import { spawnSync } from 'node:child_process';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { homedir, release } from 'node:os';
import { join } from 'node:path';

type Granularity = 'grapheme' | 'word' | 'sentence';

interface SegmentData {
  segment: string;
  index: number;
  input: string;
  isWordLike?: boolean;
}

const ZWJ = 0x200d;
const isRegionalIndicator = (cp: number): boolean => cp >= 0x1f1e6 && cp <= 0x1f1ff;
const EXTEND_RE = /^[\p{M}\u200c\u{1f3fb}-\u{1f3ff}\u{e0020}-\u{e007f}]$/u;

/** Split `input` into approximate extended grapheme clusters (UAX #29 subset: CR LF,
 *  combining marks, variation selectors, skin-tone modifiers, tag sequences, ZWJ
 *  sequences, regional-indicator pairs). */
export function graphemeClusters(input: string): string[] {
  const out: string[] = [];
  let cur = '';
  let curCps: number[] = [];
  for (const ch of input) {
    const cp = ch.codePointAt(0) as number;
    const prev = curCps.length ? curCps[curCps.length - 1] : -1;
    const join =
      curCps.length > 0 && (
        (prev === 0x0d && cp === 0x0a) ||
        EXTEND_RE.test(ch) ||
        cp === ZWJ ||
        prev === ZWJ ||
        (isRegionalIndicator(cp) && curCps.length === 1 && isRegionalIndicator(prev))
      );
    if (join) {
      cur += ch;
      curCps.push(cp);
    } else {
      if (cur) out.push(cur);
      cur = ch;
      curCps = [cp];
    }
  }
  if (cur) out.push(cur);
  return out;
}

const WORD_RE = /[\p{L}\p{N}\p{M}_'\u2019]+|\s+|[^\p{L}\p{N}\p{M}_'\u2019\s]/gu;

function wordPieces(input: string): SegmentData[] {
  const out: SegmentData[] = [];
  for (const m of input.matchAll(WORD_RE)) {
    out.push({ segment: m[0], index: m.index as number, input, isWordLike: /[\p{L}\p{N}]/u.test(m[0]) });
  }
  return out;
}

function sentencePieces(input: string): SegmentData[] {
  const out: SegmentData[] = [];
  const re = /[^.!?]*(?:[.!?]+\s*|$)/g;
  for (const m of input.matchAll(re)) {
    if (m[0] === '') { re.lastIndex++; continue; }
    out.push({ segment: m[0], index: m.index as number, input });
  }
  return out;
}

/** A minimal stand-in for Intl.Segmenter: same constructor, segment(), containing(),
 *  resolvedOptions() and supportedLocalesOf() shapes. */
export class FallbackSegmenter {
  readonly #granularity: Granularity;
  readonly #locale: string;

  constructor(locales?: string | string[], options?: { granularity?: Granularity }) {
    const first = Array.isArray(locales) ? locales[0] : locales;
    this.#locale = first || 'en';
    const g = options?.granularity ?? 'grapheme';
    if (g !== 'grapheme' && g !== 'word' && g !== 'sentence') {
      throw new RangeError(`Value ${String(g)} out of range for Intl.Segmenter options property granularity`);
    }
    this.#granularity = g;
  }

  static supportedLocalesOf(locales?: string | string[]): string[] {
    return locales === undefined ? [] : (Array.isArray(locales) ? locales : [locales]);
  }

  resolvedOptions(): { locale: string; granularity: Granularity } {
    return { locale: this.#locale, granularity: this.#granularity };
  }

  segment(input: unknown): Iterable<SegmentData> & { containing(index?: number): SegmentData | undefined } {
    const text = String(input);
    let pieces: SegmentData[];
    if (this.#granularity === 'word') pieces = wordPieces(text);
    else if (this.#granularity === 'sentence') pieces = sentencePieces(text);
    else {
      pieces = [];
      let index = 0;
      for (const g of graphemeClusters(text)) {
        pieces.push({ segment: g, index, input: text });
        index += g.length;
      }
    }
    return {
      [Symbol.iterator]: () => pieces[Symbol.iterator](),
      containing(index = 0): SegmentData | undefined {
        const i = Math.trunc(Number(index) || 0);
        return pieces.find((p) => i >= p.index && i < p.index + p.segment.length);
      },
    };
  }
}

/** What the child node runs: construct, segment, count -- what string-width does. */
export const SEGMENTER_PROBE =
  'const s=new Intl.Segmenter("en",{granularity:"grapheme"});' +
  'const n=[...s.segment("e\\u0301a")].length;if(n!==2)process.exit(3);new Intl.Segmenter();';

export interface ProbeResult { ok: boolean; status: number | null; signal: string | null }

export type SegmenterDecision =
  | { use: 'native'; reason: string }
  | { use: 'polyfill'; reason: string };

/** Pure decision. `probe` is only called when nothing else decides. */
export function decideSegmenter(opts: {
  env: NodeJS.ProcessEnv;
  hasNative: boolean;
  isBun: boolean;
  probe: () => ProbeResult;
}): SegmenterDecision {
  const forced = (opts.env.AWSH_INTL_SEGMENTER || '').trim().toLowerCase();
  if (forced === 'native') return { use: 'native', reason: 'AWSH_INTL_SEGMENTER=native' };
  if (forced === 'polyfill') return { use: 'polyfill', reason: 'AWSH_INTL_SEGMENTER=polyfill' };
  if (!opts.hasNative) return { use: 'polyfill', reason: 'this runtime has no Intl.Segmenter' };
  // A bun-compiled binary's execPath is awsh itself, not a node; and JSC is not the ICU
  // build that crashed. Nothing to probe.
  if (opts.isBun) return { use: 'native', reason: 'bun runtime' };
  const r = opts.probe();
  if (r.ok) return { use: 'native', reason: 'probe ok' };
  const how = r.signal ? `signal ${r.signal}` : `exit ${r.status}`;
  return { use: 'polyfill', reason: `Intl.Segmenter probe died (${how})` };
}

function runProbe(): ProbeResult {
  const env = { ...process.env };
  delete env.NODE_OPTIONS; // never re-enter a --require/--import hook from the probe
  const r = spawnSync(process.execPath, ['-e', SEGMENTER_PROBE], { stdio: 'ignore', timeout: 10_000, env });
  return { ok: r.status === 0 && !r.signal, status: r.status, signal: r.signal };
}

function cachedProbe(): ProbeResult {
  const key = `${process.execPath}|${process.version}|${release()}`;
  const dir = join(homedir(), '.aither', 'cache');
  const file = join(dir, 'awsh-intl-segmenter.json');
  try {
    const c = JSON.parse(readFileSync(file, 'utf8')) as { key?: string; result?: ProbeResult };
    if (c.key === key && c.result && typeof c.result.ok === 'boolean') return c.result;
  } catch { /* no cache yet */ }
  const result = runProbe();
  try {
    mkdirSync(dir, { recursive: true });
    writeFileSync(file, JSON.stringify({ key, result }));
  } catch { /* read-only home: probe again next launch */ }
  return result;
}

/** Install the fallback onto the global Intl. Returns true when it was installed. */
export function installSegmenterFallback(target: typeof Intl = Intl): boolean {
  Object.defineProperty(target, 'Segmenter', {
    value: FallbackSegmenter,
    writable: true,
    configurable: true,
    enumerable: false,
  });
  return (target as unknown as { Segmenter: unknown }).Segmenter === FallbackSegmenter;
}

// ── side effect: runs at import, before any dependency module evaluates ─────────────
const decision = decideSegmenter({
  env: process.env,
  hasNative: typeof (Intl as unknown as { Segmenter?: unknown }).Segmenter === 'function',
  isBun: !!(process.versions as Record<string, string | undefined>).bun,
  probe: cachedProbe,
});
if (decision.use === 'polyfill') {
  installSegmenterFallback();
  if (process.env.AWSH_INTL_SEGMENTER !== 'polyfill') {
    process.stderr.write(
      `  ! ${decision.reason} on node ${process.version}; using awsh's built-in text segmenter. ` +
      'Install the official nodejs.org build to restore native Intl.Segmenter.\n',
    );
  }
}

export const segmenterDecision: SegmenterDecision = decision;
