/**
 * `aither harness tell` — exactly-one resolution and the steering envelope (2026-09-19).
 * Three tabs on stage were all titled "AitherOS-Fresh" the day this was written; a tell
 * that guesses puts the owner's words in front of the wrong session.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { resolveTellTarget, tellEvent, type TellRow } from '../src/harness-client.js';

const ROWS: TellRow[] = [
  { id: 'aaaa1111bbbb2222', title: 'awdk', origin: 'daemon', extras: { harness_session_id: '11111111-2222-3333-4444-555555555555' } },
  { id: '99999999-8888-7777-6666-555555555555', title: 'AitherOS-Fresh', origin: 'discovered' },
  { id: 'cccccccc-8888-7777-6666-555555555555', title: 'AitherOS-Fresh', origin: 'discovered' },
];

test('resolves by row id, by the Claude id the program carries, and by a prefix of either', () => {
  assert.deepEqual(resolveTellTarget(ROWS, 'aaaa1111bbbb2222').map((r) => r.id), ['aaaa1111bbbb2222']);
  assert.deepEqual(resolveTellTarget(ROWS, '11111111-2222-3333-4444-555555555555').map((r) => r.id), ['aaaa1111bbbb2222']);
  assert.deepEqual(resolveTellTarget(ROWS, 'AAAA11').map((r) => r.id), ['aaaa1111bbbb2222']);
  assert.deepEqual(resolveTellTarget(ROWS, '99999').map((r) => r.id), ['99999999-8888-7777-6666-555555555555']);
});

test('a unique title word resolves; an ambiguous title returns every match for the caller to refuse', () => {
  assert.deepEqual(resolveTellTarget(ROWS, 'awdk').map((r) => r.id), ['aaaa1111bbbb2222']);
  assert.equal(resolveTellTarget(ROWS, 'aitheros-fresh').length, 2);
  assert.deepEqual(resolveTellTarget(ROWS, 'nothing-like-this'), []);
  assert.deepEqual(resolveTellTarget(ROWS, '   '), []);
});

test('an exact id wins over a title that merely contains the same text', () => {
  const rows: TellRow[] = [{ id: 'veil', title: 'x' }, { id: 'zzzz', title: 'the veil tab' }];
  assert.deepEqual(resolveTellTarget(rows, 'veil').map((r) => r.id), ['veil']);
});

test('tellEvent is a human steering event addressed to exactly one target', () => {
  const ev: any = tellEvent('aaaa1111bbbb2222', 'look at the gate');
  assert.equal(ev.type, 'steering');
  assert.equal(ev.room, 'main');
  assert.deepEqual(ev.to, ['aaaa1111bbbb2222']);
  assert.equal(ev.hops, 0);
  assert.equal(ev.actor.kind, 'human');
  assert.equal(ev.payload.text, 'look at the gate');
});
