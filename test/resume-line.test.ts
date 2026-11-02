/**
 * WHERE YOU LEFT OFF: the home screen reads the session-focus records and says the
 * newest thread and its next step — or says nothing at all. Fresh, stale, missing and
 * malformed data are each pinned; none may ever produce an error line.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { clip, formatResume, loadFocusRecords, resumeLines } from '../src/resume-line.js';

const NOW = 1_800_000_000;

function fixture(): { focus: string; labels: string } {
  const base = mkdtempSync(join(tmpdir(), 'awsh-resume-'));
  const focus = join(base, 'focus');
  const labels = join(base, 'labels');
  mkdirSync(join(focus, 'c-aitheros-fresh'), { recursive: true });
  mkdirSync(join(focus, 'seen'), { recursive: true });
  mkdirSync(labels, { recursive: true });
  return { focus, labels };
}

function rec(dir: string, sid: string, body: Record<string, unknown> | string): string {
  const p = join(dir, `${sid}.json`);
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify({ session_id: sid, ...body }));
  utimesSync(p, NOW - 60, NOW - 60); // file mtime is "now-ish"; `updated` decides staleness
  return p;
}

test('fresh: newest thread with its next step, label wins over first ask, rest counted', () => {
  const { focus, labels } = fixture();
  const proj = join(focus, 'c-aitheros-fresh');
  rec(proj, 'aaaaaaaa-1', { first_ask: 'make the Iris song', next: 'approve the lyrics draft', updated: NOW - 7200 });
  rec(proj, 'bbbbbbbb-2', { first_ask: 'old thing', updated: NOW - 86400 });
  rec(proj, 'cccccccc-3', { first_ask: 'older thing', next: 'x', updated: NOW - 2 * 86400 });
  writeFileSync(join(labels, 'aaaaaaaa-1.json'), JSON.stringify({ title: 'making the Iris song' }));
  writeFileSync(join(focus, 'seen', 'zzz.json'), JSON.stringify({ session_id: 'zzz', updated: NOW }));
  const lines = resumeLines({ focusDir: focus, labelsDir: labels, nowSec: NOW });
  assert.equal(lines[0], 'Last: making the Iris song (2 h ago) — next: approve the lyrics draft');
  assert.match(lines[1], /^ {2}2 more threads \(bbbbbbbb, cccccccc\) — .*--show <id>$/);
  assert.equal(lines.length, 2);
});

test('fresh: a session recorded under two project keys is one thread, newest copy wins', () => {
  const { focus, labels } = fixture();
  mkdirSync(join(focus, 'c-aitheros-fresh-aitheros'));
  rec(join(focus, 'c-aitheros-fresh'), 'dup', { first_ask: 'old ask', updated: NOW - 600 });
  rec(join(focus, 'c-aitheros-fresh-aitheros'), 'dup', { first_ask: 'new ask', updated: NOW - 300 });
  const lines = resumeLines({ focusDir: focus, labelsDir: labels, nowSec: NOW });
  assert.deepEqual(lines, ['Last: new ask (5 min ago)']);
});

test('stale: nothing newer than three days says nothing', () => {
  const { focus, labels } = fixture();
  rec(join(focus, 'c-aitheros-fresh'), 's1', { first_ask: 'ancient', next: 'n', updated: NOW - 4 * 86400 });
  assert.deepEqual(resumeLines({ focusDir: focus, labelsDir: labels, nowSec: NOW }), []);
});

test('stale: an old file mtime is skipped without being parsed', () => {
  const { focus, labels } = fixture();
  const p = rec(join(focus, 'c-aitheros-fresh'), 's2', '{not json');
  utimesSync(p, NOW - 5 * 86400, NOW - 5 * 86400);
  assert.deepEqual(loadFocusRecords({ focusDir: focus, labelsDir: labels, nowSec: NOW }), []);
});

test('missing: no focus dir at all says nothing', () => {
  const base = mkdtempSync(join(tmpdir(), 'awsh-resume-none-'));
  assert.deepEqual(resumeLines({ focusDir: join(base, 'nope'), labelsDir: join(base, 'nope2'), nowSec: NOW }), []);
});

test('malformed: bad JSON, arrays, missing ids, bad timestamps and empty goals are skipped', () => {
  const { focus, labels } = fixture();
  const proj = join(focus, 'c-aitheros-fresh');
  rec(proj, 'm1', '{broken');
  rec(proj, 'm2', '[1,2,3]');
  writeFileSync(join(proj, 'm3.json'), JSON.stringify({ first_ask: 'no id', updated: NOW }));
  rec(proj, 'm4', { first_ask: 'bad ts', updated: 'yesterday' });
  rec(proj, 'm5', { first_ask: '   ', updated: NOW - 10 });
  writeFileSync(join(labels, 'm6.json'), '{bad label');
  rec(proj, 'm6', { first_ask: 'the one good record', next: 42, updated: NOW - 120 });
  const lines = resumeLines({ focusDir: focus, labelsDir: labels, nowSec: NOW });
  assert.deepEqual(lines, ['Last: the one good record (2 min ago)']);
});

test('AWSH_RESUME=0 turns it off', () => {
  const { focus, labels } = fixture();
  rec(join(focus, 'c-aitheros-fresh'), 'o1', { first_ask: 'x', updated: NOW });
  process.env.AWSH_RESUME = '0';
  try {
    assert.deepEqual(resumeLines({ focusDir: focus, labelsDir: labels, nowSec: NOW }), []);
  } finally {
    delete process.env.AWSH_RESUME;
  }
});

test('long goals clip at a word boundary with a visible ellipsis; whitespace collapses', () => {
  const out = clip('fix   the\nlogin page so that every tenant can sign in again today', 30);
  assert.ok(out.endsWith('…') && out.length <= 30, out);
  assert.ok(!/\s{2}|\n/.test(out));
  assert.deepEqual(formatResume([]), []);
});
