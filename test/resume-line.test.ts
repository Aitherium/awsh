/**
 * WHERE YOU LEFT OFF: the home screen reads the session-focus records and says the
 * newest OWNER thread and its next step — or says nothing at all. Fresh, stale, missing
 * and malformed data are each pinned; none may ever produce an error line. So are the
 * three noise fixes: machine sessions excluded, titles cleaned, no command hint.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, utimesSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  cleanTitle, clip, formatResume, isMachineSession, loadFocusRecords, resumeLines,
} from '../src/resume-line.js';

const NOW = 1_800_000_000;

function fixture(): { base: string; focus: string; labels: string; projects: string } {
  const base = mkdtempSync(join(tmpdir(), 'awsh-resume-'));
  const focus = join(base, 'focus');
  const labels = join(base, 'labels');
  const projects = join(base, '.claude', 'projects', 'C--AitherOS-Fresh');
  mkdirSync(join(focus, 'c-aitheros-fresh'), { recursive: true });
  mkdirSync(join(focus, 'seen'), { recursive: true });
  mkdirSync(labels, { recursive: true });
  mkdirSync(projects, { recursive: true });
  return { base, focus, labels, projects };
}

function rec(dir: string, sid: string, body: Record<string, unknown> | string): string {
  const p = join(dir, `${sid}.json`);
  writeFileSync(p, typeof body === 'string' ? body : JSON.stringify({ session_id: sid, ...body }));
  utimesSync(p, NOW - 60, NOW - 60); // file mtime is "now-ish"; `updated` decides staleness
  return p;
}

/** A transcript whose head carries `entrypoint`, like Claude Code writes it. */
function transcript(dir: string, sid: string, entrypoint: string): string {
  const p = join(dir, `${sid}.jsonl`);
  writeFileSync(p, JSON.stringify({ type: 'user', entrypoint, userType: 'external' }) + '\n');
  return p;
}

test('fresh: newest thread with its next step, label wins over first ask, live rest counted', () => {
  const { focus, labels } = fixture();
  const proj = join(focus, 'c-aitheros-fresh');
  rec(proj, 'aaaaaaaa-1', { first_ask: 'make the Iris song', next: 'approve the lyrics draft', updated: NOW - 7200 });
  rec(proj, 'bbbbbbbb-2', { first_ask: 'recent thing', updated: NOW - 86400 });
  rec(proj, 'cccccccc-3', { first_ask: 'idle two days', next: 'x', updated: NOW - 2 * 86400 });
  writeFileSync(join(labels, 'aaaaaaaa-1.json'), JSON.stringify({ title: 'making the Iris song' }));
  writeFileSync(join(focus, 'seen', 'zzz.json'), JSON.stringify({ session_id: 'zzz', updated: NOW }));
  const lines = resumeLines({ focusDir: focus, labelsDir: labels, nowSec: NOW });
  assert.deepEqual(lines, [
    'Last: making the Iris song (2 h ago) — next: approve the lyrics draft',
    '  1 more thread',
  ]);
});

test('more line: dropped entirely when no other thread was touched in 24 h; no command hint', () => {
  const { focus, labels } = fixture();
  const proj = join(focus, 'c-aitheros-fresh');
  rec(proj, 'n1', { first_ask: 'only live one', updated: NOW - 60 });
  rec(proj, 'n2', { first_ask: 'idle 25 h', updated: NOW - 25 * 3600 });
  const lines = resumeLines({ focusDir: focus, labelsDir: labels, nowSec: NOW });
  assert.deepEqual(lines, ['Last: only live one (1 min ago)']);
  assert.ok(!lines.join('\n').includes('session-focus.py'));
});

test('title: a fallback label (pre-clipped first ask) loses to the full first ask', () => {
  const { focus, labels } = fixture();
  rec(join(focus, 'c-aitheros-fresh'), 'fb', { first_ask: '- iris + media-forge to make song + music video', updated: NOW - 60 });
  writeFileSync(join(labels, 'fb.json'), JSON.stringify({ title: 'Iris + media-forge to make song +…', source: 'fallback' }));
  assert.deepEqual(resumeLines({ focusDir: focus, labelsDir: labels, nowSec: NOW }),
    ['Last: iris + media-forge to make song + music video (1 min ago)']);
});

test('fresh: a session recorded under two project keys is one thread, newest copy wins', () => {
  const { focus, labels } = fixture();
  mkdirSync(join(focus, 'c-aitheros-fresh-aitheros'));
  rec(join(focus, 'c-aitheros-fresh'), 'dup', { first_ask: 'old ask', updated: NOW - 600 });
  rec(join(focus, 'c-aitheros-fresh-aitheros'), 'dup', { first_ask: 'new ask', updated: NOW - 300 });
  const lines = resumeLines({ focusDir: focus, labelsDir: labels, nowSec: NOW });
  assert.deepEqual(lines, ['Last: new ask (5 min ago)']);
});

test('owner only: sdk-launched, non-projects transcripts, temp/worktree cwds and machine asks are excluded', () => {
  const { base, focus, labels, projects } = fixture();
  const proj = join(focus, 'c-aitheros-fresh');
  rec(proj, 'owner', {
    first_ask: 'the owner typed this', updated: NOW - 3000, project: 'C:\\AitherOS-Fresh',
    transcript: transcript(projects, 'owner', 'cli'),
  });
  rec(proj, 'sdk', { first_ask: 'spawned', updated: NOW - 10, transcript: transcript(projects, 'sdk', 'sdk-cli') });
  const harness = join(base, 'harness');
  mkdirSync(harness);
  rec(proj, 'harness', { first_ask: 'go', updated: NOW - 20, transcript: transcript(harness, 'h', 'cli') });
  rec(proj, 'wt', { first_ask: 'worktree work', updated: NOW - 30, project: 'D:\\repo\\.worktrees\\feat-x' });
  rec(proj, 'tmp', { first_ask: 'temp work', updated: NOW - 40, project: '/tmp/scratch' });
  rec(proj, 'card', { first_ask: 'Owner answered credential card d-rcff: stored=True', updated: NOW - 50 });
  rec(proj, 'resume', { first_ask: 'You are helping the user resume their previously-killed Claude', updated: NOW - 60 });
  const lines = resumeLines({ focusDir: focus, labelsDir: labels, nowSec: NOW });
  assert.deepEqual(lines, ['Last: the owner typed this (50 min ago)']);
  // An unreadable transcript is not evidence of a machine session.
  assert.equal(isMachineSession({ first_ask: 'x', transcript: join(projects, 'missing.jsonl') }), false);
});

test('title: image/paste markers stripped, URL to last segment, whitespace collapsed, 60-char word clip', () => {
  assert.equal(cleanTitle('https://github.com/wizzense/i-have-adhd -- [Image #1] [Image #2]'), 'i-have-adhd');
  // A labeller's own clip stays visible after cleaning (truncation is never silent).
  assert.equal(cleanTitle('Iris + media-forge to make song +…'), 'Iris + media-forge to make song…');
  assert.equal(
    cleanTitle('[Image #1] [Image #2]  fix   the\n[Pasted text #3 +42 lines] login page'),
    'fix the login page',
  );
  assert.equal(cleanTitle('see https://blog.aitherium.com/blog/item-one?x=1#h now'), 'see item-one now');
  assert.equal(cleanTitle('https://aitherium.com/'), 'aitherium.com');
  const long = cleanTitle('aitheros awdk genesis stack optimization and enhancement across every lane we run');
  assert.ok(long.length <= 60 && long.endsWith('…') && !long.includes('  '), long);
});

test('title: a record whose ask is only markers falls back to nothing and is skipped', () => {
  const { focus, labels } = fixture();
  rec(join(focus, 'c-aitheros-fresh'), 'imgs', { first_ask: '[Image #1] [Image #2]', updated: NOW - 5 });
  assert.deepEqual(resumeLines({ focusDir: focus, labelsDir: labels, nowSec: NOW }), []);
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

test('clip: word boundary with a visible ellipsis; empty input renders nothing', () => {
  const out = clip('fix   the\nlogin page so that every tenant can sign in again today', 30);
  assert.ok(out.endsWith('…') && out.length <= 30, out);
  assert.ok(!/\s{2}|\n/.test(out));
  assert.deepEqual(formatResume([]), []);
});

test('title: separator runs left by stripped markers collapse to one dash', () => {
  assert.equal(
    cleanTitle('https://github.com/wizzense/i-have-adhd -- [Image #1] -- want to adopt it'),
    'i-have-adhd — want to adopt it',
  );
});

test('next: a "nothing for you" closing is not shown as a step', () => {
  const lines = formatResume([{ sessionId: 's', goal: 'g', next: 'nothing for you. Lead reports.', latestAsk: '', updated: NOW - 60 }], NOW);
  assert.deepEqual(lines, ['Last: g (1 min ago)']);
});
