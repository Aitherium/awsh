/**
 * `aither sessions live` renders the unified cockpit at the top level; before this
 * every `aither sessions` went to the Python resume browser and the cockpit was only
 * reachable by Ctrl+S inside the TUI.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { runSessionsCockpit, wantsSessionsCockpit } from '../src/sessions-command.js';

const S = [{
  id: '1', title: 'cockpit-row', cwd: '/w', harness: 'claude', origin: 'daemon', status: 'exited',
  last_activity_at: Date.now() / 1000, last_activity_summary: 's', transcript_path: '', pid: null,
  steer_capability: 'none',
}] as any[];

test('cockpit words route to the cockpit; the Python verbs keep theirs', () => {
  for (const a of [['live'], ['cockpit'], ['--live'], ['--watch']]) assert.equal(wantsSessionsCockpit(a), true, a.join(' '));
  for (const a of [[], ['browse'], ['search', 'x'], ['resume', 'id'], ['--list']]) assert.equal(wantsSessionsCockpit(a), false, a.join(' '));
});

test('only the FIRST argument selects the cockpit; a Python verb keeps its own --watch', () => {
  // `aither sessions ingest --watch` is the documented D-42 auto-sync verb (adk shell cli.py);
  // `search live` searches for the word 'live'. Neither may open the cockpit redraw loop.
  for (const a of [['ingest', '--watch'], ['ingest', '-w'], ['search', 'live'], ['search', 'cockpit'], ['browse', '--live']]) {
    assert.equal(wantsSessionsCockpit(a), false, a.join(' '));
  }
  for (const a of [['-w'], ['LIVE'], ['live', '--harness', 'claude'], ['--watch', '--interval', '5']]) {
    assert.equal(wantsSessionsCockpit(a), true, a.join(' '));
  }
});

test('one-shot render prints the same panel the overlay uses', async () => {
  let out = '';
  const code = await runSessionsCockpit(['cockpit'], {
    snapshot: async () => ({ sessions: S, source: 'daemon' }), write: (t) => { out += t; }, width: 120,
  });
  assert.equal(code, 0);
  assert.match(out, /cockpit-row/);
  assert.match(out, /exited/);
  assert.doesNotMatch(out, /Ctrl\+S/, 'no overlay key hint outside the TUI');
});

test('live mode redraws each frame', async () => {
  let frames = 0;
  await runSessionsCockpit(['live'], {
    snapshot: async () => { frames++; return { sessions: S, source: 'local', daemonError: 'down' }; },
    write: () => {}, width: 100, maxFrames: 2, intervalMs: 1,
  });
  assert.equal(frames, 2);
});
