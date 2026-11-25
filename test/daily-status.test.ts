/**
 * `awsh status` -- fleet + Atlas board + waiting cards, answerable inline.
 *
 * What must hold: each source degrades to ONE line with its remedy and never blanks
 * the others; cards are numbered most-urgent-then-oldest and that is the numbering
 * `answer <n>` uses; an option the card does not offer is refused, never sent.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { formatCards, formatDaily, gatherDaily, orderCards, parseCardAnswer, type WaitingCard } from '../src/daily-status.js';
import { summarizePs } from '../src/fleet-health.js';
import { unwrapToolResult } from '../src/daily-driver.js';

const CARDS: WaitingCard[] = [
  { id: 'aaa111', title: 'old normal', urgency: 'normal', created_at: 1, options: [{ key: 'yes' }, { key: 'no' }] },
  { id: 'bbb222', title: 'new critical', urgency: 'critical', created_at: 5, options: [{ key: 'merge', recommended: true }, { key: 'hold' }] },
  { id: 'aaa999', title: 'newer normal', urgency: 'normal', created_at: 3 },
];

test('orderCards: critical first, then oldest', () => {
  assert.deepEqual(orderCards(CARDS).map((c) => c.id), ['bbb222', 'aaa111', 'aaa999']);
});

test('formatCards numbers in that order and marks the recommended option', () => {
  const lines = formatCards(CARDS);
  assert.match(lines[0], /3 waiting/);
  assert.match(lines[1], /^ {2}1\. new critical \[critical\] {2}\[merge\*\/hold\]$/);
  assert.match(lines[2], /^ {2}2\. old normal/);
});

test('formatCards: unavailable names the remedy; empty says so', () => {
  assert.match(formatCards(null, 'fetch failed')[0], /adk harness serve/);
  assert.match(formatCards([])[0], /nothing waiting/);
});

test('parseCardAnswer: by number, by id prefix, case-insensitive option, note kept', () => {
  assert.deepEqual(parseCardAnswer('1 MERGE ship it', CARDS), { id: 'bbb222', key: 'merge', note: 'ship it' });
  assert.deepEqual(parseCardAnswer('aaa1 no', CARDS), { id: 'aaa111', key: 'no', note: '' });
});

test('parseCardAnswer refuses unknown options, ambiguous prefixes, missing cards', () => {
  assert.match(String(parseCardAnswer('1 yolo', CARDS)), /no option "yolo"/);
  assert.match(String(parseCardAnswer('aaa x', CARDS)), /matches 2 cards/);
  assert.match(String(parseCardAnswer('9 yes', CARDS)), /no waiting card 9/);
  assert.match(String(parseCardAnswer('1', CARDS)), /usage/);
});

test('gatherDaily: a throwing source degrades alone', async () => {
  const s = await gatherDaily({
    measureFleet: () => { throw new Error('boom'); },
    fetchBoard: async () => { throw new Error('gateway down'); },
    fetchCards: async () => CARDS,
  });
  assert.equal(s.fleet, null);
  assert.equal(s.board.error, 'gateway down');
  assert.equal(s.cards?.length, 3);
  const text = formatDaily(s).join('\n');
  assert.match(text, /Fleet: {4}no container runtime/);
  assert.match(text, /Atlas board unavailable: gateway down/);
  assert.match(text, /3 waiting/);
});

test('formatDaily shows the real fleet count and the problem names', async () => {
  const fleet = summarizePs('a\tUp 1 hour (healthy)\t\nb\tUp 1 hour (unhealthy)\t', 'podman');
  const s = await gatherDaily({
    measureFleet: () => fleet,
    fetchBoard: async () => ({ counts: { demiurge: 2 } }),
    fetchCards: async () => { throw new Error('fetch failed'); },
  });
  const text = formatDaily(s).join('\n');
  assert.match(text, /fleet 2\/2 up · 1 unhealthy/);
  assert.match(text, /b \(unhealthy\)/);
  assert.match(text, /demiurge 2/);
  assert.match(text, /Cards: {4}unavailable \(fetch failed\)/);
});

test('unwrapToolResult parses MCP text content and raises tool errors', () => {
  assert.deepEqual(unwrapToolResult({ content: [{ type: 'text', text: '{"counts":{"x":1}}' }] }), { counts: { x: 1 } });
  assert.equal(unwrapToolResult({ content: [{ type: 'text', text: 'plain' }] }), 'plain');
  assert.throws(() => unwrapToolResult({ isError: true, content: [{ type: 'text', text: 'denied' }] }), /denied/);
});
