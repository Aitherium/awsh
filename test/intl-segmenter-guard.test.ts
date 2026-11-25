/**
 * The awsh half of the 2026-11-09 node segfault: EL9's nodejs-20.20.2 crashed on
 * `new Intl.Segmenter('en')` in a WSL2 guest and string-width (via ora) builds one at
 * import, so awsh died before its first prompt. These pin the decision and the fallback
 * segmenter's cluster boundaries; the probe itself is injected, never spawned here.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';

process.env.AWSH_INTL_SEGMENTER = 'native'; // the import-time side effect must not spawn
const { decideSegmenter, graphemeClusters, FallbackSegmenter, installSegmenterFallback } =
  await import('../src/intl-segmenter-guard.js');

const ok = () => ({ ok: true, status: 0, signal: null });

test('decideSegmenter: a probe that dies by SIGSEGV selects the fallback and says why', () => {
  const d = decideSegmenter({ env: {}, hasNative: true, isBun: false, probe: () => ({ ok: false, status: null, signal: 'SIGSEGV' }) });
  assert.equal(d.use, 'polyfill');
  assert.match(d.reason, /SIGSEGV/);
});

test('decideSegmenter: a healthy probe keeps the native segmenter', () => {
  assert.equal(decideSegmenter({ env: {}, hasNative: true, isBun: false, probe: ok }).use, 'native');
});

test('decideSegmenter: no Intl.Segmenter at all -> fallback without probing', () => {
  let probed = false;
  const d = decideSegmenter({ env: {}, hasNative: false, isBun: false, probe: () => { probed = true; return ok(); } });
  assert.equal(d.use, 'polyfill');
  assert.equal(probed, false);
});

test('decideSegmenter: AWSH_INTL_SEGMENTER overrides; bun is never probed', () => {
  const boom = () => { throw new Error('must not probe'); };
  assert.equal(decideSegmenter({ env: { AWSH_INTL_SEGMENTER: 'polyfill' }, hasNative: true, isBun: false, probe: boom }).use, 'polyfill');
  assert.equal(decideSegmenter({ env: { AWSH_INTL_SEGMENTER: 'native' }, hasNative: false, isBun: false, probe: boom }).use, 'native');
  assert.equal(decideSegmenter({ env: {}, hasNative: true, isBun: true, probe: boom }).use, 'native');
});

test('graphemeClusters: combining marks, flags, ZWJ emoji, skin tones and CRLF stay whole', () => {
  const cp = String.fromCodePoint;
  assert.deepEqual(graphemeClusters('e' + cp(0x301) + 'a'), ['e' + cp(0x301), 'a']);
  const us = cp(0x1f1fa, 0x1f1f8);
  const gb = cp(0x1f1ec, 0x1f1e7);
  assert.deepEqual(graphemeClusters(us + gb), [us, gb]);
  const family = cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467);
  assert.deepEqual(graphemeClusters(family + 'x'), [family, 'x']);
  const wave = cp(0x1f44b, 0x1f3fd);
  assert.deepEqual(graphemeClusters(wave), [wave]);
  const crlf = String.fromCharCode(13, 10);
  assert.deepEqual(graphemeClusters('a' + crlf + 'b'), ['a', crlf, 'b']);
  assert.deepEqual(graphemeClusters(''), []);
});

test('graphemeClusters agrees with the native segmenter on a mixed line', () => {
  const cp = String.fromCodePoint;
  const line = 'awsh> h' + cp(0xe9) + 'llo ' + cp(0x1f468, 0x200d, 0x1f4bb) + ' ' + cp(0x1f1ef, 0x1f1f5) +
    ' e' + cp(0x301) + ' ' + cp(0x4e16, 0x754c);
  const native = [...new Intl.Segmenter('en').segment(line)].map((s) => s.segment);
  assert.deepEqual(graphemeClusters(line), native);
});

test('FallbackSegmenter: Intl.Segmenter shape -- indices, containing(), word-likeness, options', () => {
  const seg = new FallbackSegmenter('en');
  const parts = [...seg.segment('ab')];
  assert.deepEqual(parts.map((p) => [p.segment, p.index]), [['a', 0], ['b', 1]]);
  assert.equal(seg.segment('abc').containing(2)?.segment, 'c');
  assert.deepEqual(seg.resolvedOptions(), { locale: 'en', granularity: 'grapheme' });
  const words = [...new FallbackSegmenter('en', { granularity: 'word' }).segment('its 42!')];
  assert.deepEqual(words.map((w) => [w.segment, w.isWordLike]), [['its', true], [' ', false], ['42', true], ['!', false]]);
  assert.throws(() => new FallbackSegmenter('en', { granularity: 'line' as never }), RangeError);
});

test('installSegmenterFallback replaces Intl.Segmenter on the target it is given', () => {
  const fake = {} as typeof Intl;
  assert.equal(installSegmenterFallback(fake), true);
  assert.equal((fake as unknown as { Segmenter: unknown }).Segmenter, FallbackSegmenter);
});
