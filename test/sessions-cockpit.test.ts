/**
 * Cockpit gaps: branch / capability / token columns, the offline fallback,
 * the focus tail, and `/sessions` routing inside the REPL.
 *
 * Every test here failed on the pre-change sessions-client.ts: the row had no
 * branch, cap or token column, and none of the fallback / focus / routing
 * exports existed.
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdirSync, mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import * as client from '../src/sessions-client.js';
import { buildSessionsPanel, sessionsColumnLayout } from '../src/tui/sessions-view.js';
import type { UnifiedSession } from '../src/sessions-client.js';

function row(over: Partial<UnifiedSession> = {}): UnifiedSession {
  return {
    id: 'abc12345-0000',
    title: 'repo feat 10:00',
    cwd: '/tmp/repo',
    harness: 'claude',
    origin: 'daemon',
    status: 'working',
    last_activity_at: Date.now() / 1000,
    last_activity_summary: 'running Bash',
    transcript_path: '',
    pid: null,
    steer_capability: 'full',
    ...over,
  };
}

const W = { name: 20, cwd: 20, summary: 20 };

test('grid: row carries the branch and token spend', () => {
  const r = client.formatSessionRow(row({ branch: 'keystone/w4', tokens_spent: 1_234_567 }), W);
  assert.ok(r.includes('keystone/w4'), r);
  assert.ok(r.includes('1.2M'), r);
});

test('grid: unknown branch / tokens render as "-" not blank', () => {
  const r = client.formatSessionRow(row(), W);
  assert.ok(/\s-\s/.test(r), r);
});

test('formatTokens: compact units', () => {
  assert.equal(client.formatTokens(undefined), '-');
  assert.equal(client.formatTokens(0), '-');
  assert.equal(client.formatTokens(950), '950');
  assert.equal(client.formatTokens(12_345), '12k');
  assert.equal(client.formatTokens(4_100_000), '4.1M');
});

test('capability tier is rendered on every row', () => {
  assert.ok(client.formatSessionRow(row({ steer_capability: 'full' }), W).includes(' full '));
  assert.ok(client.formatSessionRow(row({ steer_capability: 'turn-boundary' }), W).includes(' turn '));
  assert.ok(client.formatSessionRow(row({ steer_capability: 'none' }), W).includes(' none '));
  assert.equal(client.capabilityTag('bogus'), '?');
});

// ── offline fallback ──────────────────────────────────────────────

function line(o: unknown): string {
  return JSON.stringify(o) + '\n';
}

function fakeHome(): { home: string; cwd: string } {
  const home = mkdtempSync(join(tmpdir(), 'awsh-cockpit-'));
  const cwd = join(home, 'work', 'repo');
  mkdirSync(join(home, '.claude', 'sessions'), { recursive: true });
  const proj = join(home, '.claude', 'projects', client.encodeProjectDir(cwd));
  mkdirSync(proj, { recursive: true });
  const now = new Date().toISOString();
  writeFileSync(join(proj, 'sess-live.jsonl'),
    line({ type: 'user', gitBranch: 'feat/offline', timestamp: now, message: { content: 'fix the cockpit' } })
    + line({ type: 'assistant', gitBranch: 'feat/offline', timestamp: now,
      message: { stop_reason: 'end_turn', content: [{ type: 'text', text: 'done' }] } })
    + line({ type: 'system', subtype: 'turn_duration', timestamp: now }));
  writeFileSync(join(home, '.claude', 'sessions', '111.json'),
    JSON.stringify({ sessionId: 'sess-live', pid: 111, cwd, name: 'repo feat 10:00', entrypoint: 'cli' }));
  writeFileSync(join(home, '.claude', 'sessions', '222.json'),
    JSON.stringify({ sessionId: 'sess-dead', pid: 222, cwd, entrypoint: 'cli' }));
  writeFileSync(join(home, '.claude', 'sessions', '333.json'),
    JSON.stringify({ sessionId: 'sess-sdk', pid: 333, cwd, entrypoint: 'sdk-cli' }));
  return { home, cwd };
}

test('offline: discovers live tabs from Claude state files + transcripts', () => {
  const { home } = fakeHome();
  const rows = client.discoverLocalSessions({ home, isAlive: (pid) => pid !== 222 });
  assert.equal(rows.length, 1, JSON.stringify(rows));
  const r = rows[0];
  assert.equal(r.id, 'sess-live');
  assert.equal(r.origin, 'discovered');
  assert.equal(r.steer_capability, 'none');
  assert.equal(r.status, 'waiting-input');
  assert.equal(r.branch, 'feat/offline');
  assert.ok(r.transcript_path.endsWith('sess-live.jsonl'));
});

test('offline: a down daemon falls back instead of throwing', async () => {
  const { home } = fakeHome();
  const snap = await client.fetchSessionsWithFallback(
    async () => { throw new Error('fetch failed'); },
    () => client.discoverLocalSessions({ home, isAlive: () => true }),
  );
  assert.equal(snap.source, 'local');
  assert.match(snap.daemonError || '', /fetch failed/);
  assert.equal(snap.sessions.length, 2); // sdk excluded, both cli rows kept
});

test('offline: daemon answer is used when it answers', async () => {
  const snap = await client.fetchSessionsWithFallback(async () => [row()], () => { throw new Error('unused'); });
  assert.equal(snap.source, 'daemon');
  assert.equal(snap.sessions.length, 1);
});

test('status: pending tool past 90s reads blocked?', () => {
  const old = new Date(Date.now() - 300_000).toISOString();
  const t = line({ type: 'assistant', timestamp: old,
    message: { stop_reason: 'tool_use', content: [{ type: 'tool_use', id: 't1', name: 'Bash' }] } });
  const d = client.deriveTranscriptStatus(t);
  assert.equal(d.status, 'blocked?');
  assert.match(d.summary, /Bash pending 5m/);
});

// ── focus ─────────────────────────────────────────────────────────

test('focus: transcript turns keep prompts, text and tool calls; drop machine turns', () => {
  const t = line({ type: 'user', message: { content: 'please fix it' } })
    + line({ type: 'user', message: { content: '<system-reminder>x</system-reminder>' } })
    + line({ type: 'assistant', message: { content: [
      { type: 'text', text: 'On it.' },
      { type: 'tool_use', id: 'a', name: 'Bash', input: { command: 'ls -la' } },
    ] } })
    + line({ type: 'user', message: { content: [{ type: 'tool_result', tool_use_id: 'a', content: 'x' }] } });
  const turns = client.transcriptTurns(t);
  assert.deepEqual(turns, [
    { role: 'user', text: 'please fix it' },
    { role: 'assistant', text: 'On it.' },
    { role: 'tool', text: 'Bash: ls -la' },
  ]);
});

test('focus: target resolves by row number, id prefix or unique title', () => {
  const rows = [row({ id: 'aaa1', title: 'alpha-x' }), row({ id: 'bbb2', title: 'beta-x' })];
  assert.equal(client.resolveSessionTarget(rows, '2')?.id, 'bbb2');
  assert.equal(client.resolveSessionTarget(rows, 'aaa')?.id, 'aaa1');
  assert.equal(client.resolveSessionTarget(rows, 'bet')?.id, 'bbb2');
  assert.equal(client.resolveSessionTarget(rows, '9'), undefined);
  assert.equal(client.resolveSessionTarget(rows, '-x'), undefined); // ambiguous title
});

// ── REPL routing ──────────────────────────────────────────────────

test('/sessions in the REPL opens the cockpit, not a forge/trace listing', () => {
  assert.deepEqual(client.routeSessionsCommand(''), { kind: 'cockpit' });
  assert.deepEqual(client.routeSessionsCommand('focus 3'), { kind: 'focus', target: '3' });
  assert.deepEqual(client.routeSessionsCommand('abc123'), { kind: 'focus', target: 'abc123' });
  assert.deepEqual(client.routeSessionsCommand('traces xyz'), { kind: 'traces', args: 'xyz' });
});

// ── Width budget (review of d0a3557) ─────────────────────────────

const ANSI = new RegExp(String.fromCharCode(27) + '\\[[0-9;]*m', 'g');
const strip = (l: string): string => l.replace(ANSI, '');

test('layout: a 100-column pane keeps a 15-char title whole; tok/branch collapse first', () => {
  const narrow = sessionsColumnLayout(100).widths;
  assert.ok(narrow.name >= 15, `name column ${narrow.name} < 15 at width 100`);
  assert.equal(narrow.branch, 0);
  const lines = buildSessionsPanel([row({ title: 'working-session' })], 100).map(strip);
  assert.ok(lines.some((l) => l.includes('working-session')), lines.join('\n'));
});

test('layout: a wide pane shows branch and tok, and the name column never shrinks', () => {
  const wide = sessionsColumnLayout(160).widths;
  assert.equal(wide.branch, client.BRANCH_WIDTH);
  assert.equal(wide.tokens, true);
  for (let w = 80; w <= 200; w += 1) {
    const n = sessionsColumnLayout(w).widths;
    const used = 40 + n.name + n.cwd + n.summary + (n.tokens ? 8 : 0) + (n.branch ? n.branch + 2 : 0);
    assert.ok(used <= Math.max(80, w - 2), `width ${w}: row needs ${used}`);
    assert.ok(n.name >= 15, `width ${w}: name ${n.name}`);
  }
  const r = buildSessionsPanel([row({ branch: 'keystone/w4', tokens_spent: 1_234_567 })], 160).map(strip);
  assert.ok(r.some((l) => l.includes('keystone/w4') && l.includes('1.2M')), r.join('\n'));
});

test('row: a title containing the status word keeps every column after status', () => {
  const lines = buildSessionsPanel(
    [row({ title: 'working-session', status: 'working', last_activity_summary: 'running Bash' })],
    160,
  ).map(strip);
  const r = lines.find((l) => l.includes('working-session')) || '';
  assert.ok(r.includes('running Bash'), `summary dropped: ${r}`);
  assert.ok(/working-session.*working\s+now/.test(r), `status/age dropped: ${r}`);
});
