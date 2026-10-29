/**
 * The attention beam's pure half: ranking, the dead-session rule, and the bar line.
 *
 * Each arm pins a defect measured on 2026-10-28 (an approval card at #29 of 132,
 * eight zombie "needs you" cards pinned above it, and a count line that named
 * nothing). The mutations that must fail are noted per arm.
 */
import assert from 'node:assert/strict';
import { test } from 'node:test';
import {
  BEAM_MAX, FRESH_SECONDS, formatBeam, formatOptions, fmtAge, isAsk, isHot,
  rankBeam, stillWaiting, type BeamCard,
} from '../src/beam.ts';

const NOW = 1_800_000_000;
const card = (over: Partial<BeamCard> = {}): BeamCard => ({
  id: 'd-aaaa', title: 'Publish the brief', kind: 'decision', urgency: 'normal',
  createdAt: NOW - 600, options: [{ key: 'post' }, { key: 'skip' }], ...over,
});

test('the NEWEST high ask leads; ties are not broken oldest-first', () => {
  // The live defect: an old card always won its urgency band, so a card raised that
  // hour sat at #29. Mutation: sort ascending by age -> this fails.
  const old = card({ id: 'd-old', urgency: 'high', createdAt: NOW - 20 * 3600, title: 'old high' });
  const fresh = card({ id: 'd-new', urgency: 'high', createdAt: NOW - 60, title: 'fresh high' });
  const { fresh: ranked } = rankBeam([old, fresh], NOW);
  assert.deepEqual(ranked.map((c) => c.id), ['d-new', 'd-old']);
});

test('credential and blocked lead before any urgency', () => {
  const crit = card({ id: 'd-crit', urgency: 'critical', createdAt: NOW - 30 });
  const cred = card({ id: 'd-cred', kind: 'credential', urgency: 'normal', options: [], createdAt: NOW - 9000 });
  assert.deepEqual(rankBeam([crit, cred], NOW).fresh.map((c) => c.id), ['d-cred', 'd-crit']);
});

test('asks older than a day are counted, not headlined', () => {
  const stale = card({ id: 'd-stale', createdAt: NOW - FRESH_SECONDS - 10 });
  const beam = rankBeam([stale], NOW);
  assert.equal(beam.fresh.length, 0);
  assert.equal(beam.open, 1);
  assert.equal(fmtAge(beam.oldestAge), '1d');
});

test('a needs-you card of a dead session is not an ask; of a live one it is', () => {
  // The eight zombies: their resolve hook only fires when the owner types in THAT
  // session again, which a finished session never sees. Mutation: return true
  // unconditionally -> this fails.
  const zombie = card({ id: 'd-z', kind: 'blocked', options: [], createdAt: NOW - 300,
    dedupeKey: 'cc-waiting:sess-dead:1799999700', sourceSessionId: 'sess-dead' });
  assert.equal(stillWaiting(zombie, new Set(['sess-live'])), false);
  assert.equal(rankBeam([zombie], NOW, new Set(['sess-live'])).open, 0);
  assert.equal(rankBeam([zombie], NOW, new Set(['sess-dead'])).open, 1);
  // Liveness unknown is NOT permission to hide an ask.
  assert.equal(rankBeam([zombie], NOW, null).open, 1);
  // The session also rides the key alone when source is absent.
  const byKey = { ...zombie, sourceSessionId: undefined };
  assert.equal(stillWaiting(byKey, new Set(['sess-dead'])), true);
});

test('the bar names asks with their id and age, and a click maps back to the card', () => {
  const beam = rankBeam([card({ id: 'd-ts7e', title: 'Election Day is Tuesday', urgency: 'high' })], NOW);
  const segs = formatBeam(beam, NOW, 120);
  assert.ok(segs[0].plain.startsWith('d-ts7e 10m Election Day'), segs[0].plain);
  assert.equal(segs[0].key, 'decision:d-ts7e');
  assert.equal(segs.at(-1)?.key, 'decisions');
  assert.match(segs.at(-1)!.plain, /\(\+0, 1 open\)/);
});

test('nothing waiting renders nothing (no permanent zero)', () => {
  assert.deepEqual(formatBeam(rankBeam([], NOW), NOW, 120), []);
});

test('the bar fits its width: titles shorten, the count survives, nothing overflows', () => {
  const cards = Array.from({ length: 5 }, (_, i) => card({
    id: `d-l${i}`, title: 'x'.repeat(300), urgency: 'normal', createdAt: NOW - i,
  }));
  const segs = formatBeam(rankBeam(cards, NOW), NOW, 90);
  const used = segs.reduce((n, s, i) => n + s.plain.length + (i ? 3 : 0), 0);  // + separators
  assert.ok(used <= 90, `bar used ${used} of 90`);
  assert.ok(segs.length <= BEAM_MAX + 1);
  assert.match(segs.at(-1)!.plain, /open\)/);
});

test('a narrow bar keeps a count instead of an unusable fragment', () => {
  const segs = formatBeam(rankBeam([card()], NOW), NOW, 24);
  assert.equal(segs.length, 1);
  assert.match(segs[0].plain, /^DECIDE 1 waiting$/);
});

test('red means now: high/critical/credential/blocked; normal is amber', () => {
  assert.equal(isHot(card({ urgency: 'high' })), true);
  assert.equal(isHot(card({ urgency: 'critical' })), true);
  assert.equal(isHot(card({ kind: 'credential', options: [] })), true);
  assert.equal(isHot(card({ kind: 'blocked', options: [] })), true);
  assert.equal(isHot(card({ urgency: 'normal' })), false);
  // Painters are injected, so the colour choice is observable without chalk.
  const paint = { red: (s: string) => `<R>${s}`, amber: (s: string) => `<A>${s}`,
    dim: (s: string) => `<D>${s}`, bold: (s: string) => s };
  const hot = formatBeam(rankBeam([card({ urgency: 'high' })], NOW), NOW, 120, paint);
  assert.ok(hot[0].text.startsWith('<R>'), hot[0].text);
  const calm = formatBeam(rankBeam([card({ urgency: 'normal' })], NOW), NOW, 120, paint);
  assert.ok(calm[0].text.startsWith('<A>'), calm[0].text);
});

test('isAsk: options or a first-kind; a bare info card is not an ask', () => {
  assert.equal(isAsk(card()), true);
  assert.equal(isAsk(card({ options: [], kind: 'info' })), false);
  assert.equal(isAsk(card({ options: [], kind: 'credential' })), true);
});

test('formatOptions spells the choices the viewer must offer', () => {
  assert.equal(formatOptions(card({ options: [{ key: 'post', label: 'Post' }, { key: 'skip' }] })),
    'post (Post) / skip');
  assert.match(formatOptions(card({ options: [] })), /no options/);
});
