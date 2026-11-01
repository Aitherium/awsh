/**
 * The status row's width contract: keep what FITS, count what it could not show.
 *
 * Measured 2026-11-01: the awsh status bar ran off the right edge of the terminal, so
 * the one segment that mattered (a waiting ask) was the part clipped away, and the
 * remaining row was a solid red smear. These arms pin the fix in both directions.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import { VISIBLE_WIDTH, fitSegments, fitText, visibleWidth } from '../src/tui/status-bar-fit.ts';

const sep = (n: number) => n * VISIBLE_WIDTH;
const seg = (i: number, width = 9) => ({
  key: `k${i}`, text: `segment-${i}`.padEnd(width, '.'), plain: `segment-${i}`.padEnd(width, '.'),
});

test('seven segments at 60 columns keep the brand and exactly five, and count two', () => {
  // This is the screenshot's row: more segments than columns. Mutation: drop the tail
  // silently (hidden === 0) or drop the brand -> this fails.
  const seven = Array.from({ length: 7 }, (_, i) => seg(i));
  const { kept, hidden } = fitSegments(seven, 60);
  assert.equal(kept[0].key, 'k0');
  assert.equal(kept.length, 5);
  assert.equal(hidden, 2);
  const width = kept.reduce((n, s, i) => n + (i ? VISIBLE_WIDTH : 0) + visibleWidth(s.plain), 0);
  assert.ok(width <= 60, `kept ${width} of 60`);
});

test('the brand survives even when it is wider than the terminal', () => {
  const brand = { key: 'brand', text: 'x'.repeat(80), plain: 'x'.repeat(80) };
  const { kept, hidden } = fitSegments([brand, seg(1)], 20);
  assert.deepEqual(kept.map((k) => k.key), ['brand']);
  assert.equal(hidden, 1);
});

test('an empty row is empty, not a count', () => {
  assert.deepEqual(fitSegments([], 80), { kept: [], hidden: 0 });
});

test('width comes from the plain width, so colour never eats the budget', () => {
  const ANSI = String.fromCharCode(27);
  const painted = { key: 'a', text: `${ANSI}[31mred${ANSI}[0m`, plain: 'red' };
  assert.equal(visibleWidth(painted.text), 3);
  const { kept } = fitSegments([painted, { key: 'b', text: 'yy', plain: 'yy' }], 8);
  assert.equal(kept.length, 2);
});

test('fitText leaves text that fits untouched and ellipsizes the rest', () => {
  assert.equal(fitText('hello', 10), 'hello');
  assert.equal(fitText('hello world', 80), 'hello world');
  const cut = fitText('hello world', 5);
  assert.equal(visibleWidth(cut), 5);
  assert.ok(cut.endsWith('…'), cut);
  assert.ok(cut.startsWith('hell'), cut);
});

test('fitText keeps the colour escapes of a clipped string', () => {
  const ANSI = String.fromCharCode(27);
  const cut = fitText(`${ANSI}[33m10 down · /doctor: Pulse, Strata${ANSI}[0m`, 12);
  assert.ok(cut.startsWith(`${ANSI}[33m`), 'the opening escape was dropped');
  assert.equal(visibleWidth(cut), 12);
  // The trailing reset is BEHIND the cut, so the loop never copies it. Without an
  // explicit close the terminal stays amber and the next row (the prompt) is smeared.
  assert.ok(cut.endsWith(`${ANSI}[0m`), 'clipped colour was left open');
});

test('fitText does not inject a reset into unstyled text', () => {
  assert.equal(fitText('hello world', 5), 'hell…');
});

test('fitText never returns more than the single column it was given', () => {
  assert.equal(visibleWidth(fitText('abcdef', 1)), 1);
});
