/**
 * The ear's two decisions: who speaks, and telling silence from a refusal.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { ownsMouth, listenArgs, parseListen, listenOnce, DEFAULT_SECONDS } from '../src/ear.js';

test('the desk owns the mouth when it is up; /voice is still a manual override', () => {
  assert.equal(ownsMouth(true), false);          // desk present -> awsh stays quiet
  assert.equal(ownsMouth(false), true);          // no desk -> awsh reads it out
  assert.equal(ownsMouth(true, true), true);     // the user asked for it anyway
  assert.equal(ownsMouth(false, true), true);
});

test('listen argv carries the surface, so the mic lease names who is holding it', () => {
  assert.deepEqual(listenArgs(), ['listen', '--json', '--seconds', String(DEFAULT_SECONDS), '--surface', 'awsh']);
  assert.deepEqual(
    listenArgs({ seconds: 3, steer: 'abc123', surface: 'awsh-pty' }),
    ['listen', '--json', '--seconds', '3', '--surface', 'awsh-pty', '--steer', 'abc123'],
  );
});

test('a silent room is ok-with-nothing; a refusal is an ERROR, not silence', () => {
  const quiet = parseListen(JSON.stringify({ heard: '', steered: '', seq: 0 }), '', 0);
  assert.equal(quiet.ok, true);
  assert.equal(quiet.heard, '');

  // The case that used to be indistinguishable from silence: the desk holds the mic.
  const busy = parseListen('', 'awvoice: the microphone is held by awdesk (pid 42) since now', 2);
  assert.equal(busy.ok, false);
  assert.match(busy.error!, /held by awdesk/);
  assert.doesNotMatch(busy.error!, /^awvoice:/);   // the prefix is stripped for display
});

test('a steered transcript reports where it went', () => {
  const r = parseListen(JSON.stringify({ heard: 'run the tests', steered: 'sess-1', seq: 77 }), '', 0);
  assert.deepEqual([r.ok, r.heard, r.steered, r.seq], [true, 'run the tests', 'sess-1', 77]);
});

test('non-JSON output is a failure, never an empty transcript', () => {
  const r = parseListen('Traceback (most recent call last):', '', 0);
  assert.equal(r.ok, false);
  assert.match(r.error!, /did not return JSON/);
});

test('a blocked console shim falls back to python -m, and a missing awvoice says so', () => {
  const calls: string[][] = [];
  const r = listenOnce({ seconds: 2 }, (cmd, args) => {
    calls.push([cmd, ...args]);
    if (cmd === 'awvoice') return { stdout: '', stderr: "'awvoice' is not recognized", status: null };
    return { stdout: JSON.stringify({ heard: 'fallback worked' }), stderr: '', status: 0 };
  });
  assert.equal(r.heard, 'fallback worked');
  assert.equal(calls[0][0], 'awvoice');
  assert.deepEqual(calls[1].slice(0, 3), ['python', '-m', 'awvoice.cli']);

  const gone = listenOnce({}, () => ({ stdout: '', stderr: 'ENOENT', status: null }));
  assert.equal(gone.ok, false);
  assert.match(gone.error!, /not installed/);
});
