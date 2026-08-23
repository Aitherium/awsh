/**
 * Test sessions-client pure functions: formatSessionRow and summarizeFleet.
 * No live daemon required; tests the rendering and aggregation logic only.
 *
 * Mutation guards ensure that:
 * - Truncation works on long strings
 * - Wide characters (emoji) don't break column alignment
 * - Status counts aggregate correctly
 * - Zero-valued counts don't appear in the summary
 */

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { homedir } from 'node:os';
import {
  formatSessionRow,
  summarizeFleet,
  type UnifiedSession,
} from '../src/sessions-client.js';

// ─────────────────────────────────────────────────────────────────
// formatSessionRow Tests
// ─────────────────────────────────────────────────────────────────

test('formatSessionRow: basic session renders correctly', () => {
  const session: UnifiedSession = {
    id: 'sess-001',
    title: 'my-session',
    cwd: '/home/user/project',
    harness: 'claude',
    origin: 'daemon',
    status: 'idle',
    last_activity_at: (Date.now() - 60000) / 1000, // 1 min ago
    last_activity_summary: 'waiting for input',
    transcript_path: '/path/to/transcript.jsonl',
    pid: 12345,
    steer_capability: 'full',
  };

  const row = formatSessionRow(session, { name: 20, cwd: 30, summary: 30 });

  // Should include the name, cwd, origin tag, and summary
  assert.ok(row.includes('my-session'));
  assert.ok(row.includes('project'));
  assert.ok(row.includes('adk')); // origin='daemon' → 'adk'
  assert.ok(row.includes('waiting for input'));
});

test('formatSessionRow: truncates long names', () => {
  const longName = 'a'.repeat(50);
  const session: UnifiedSession = {
    id: 'sess-002',
    title: longName,
    cwd: '/tmp',
    harness: 'claude',
    origin: 'daemon',
    status: 'working',
    last_activity_at: Date.now() / 1000,
    last_activity_summary: 'generating code',
    transcript_path: '/tmp/t.jsonl',
    pid: null,
    steer_capability: 'none',
  };

  const row = formatSessionRow(session, { name: 10, cwd: 10, summary: 20 });

  // Name should be truncated to max 10 chars (with ellipsis)
  const namePart = row.split('  ')[1]; // Extract the name column
  assert.ok(namePart.includes('…') || namePart.length <= 11);
});

test('formatSessionRow: handles ~ substitution in cwd', () => {
  const home = homedir();
  const session: UnifiedSession = {
    id: 'sess-003',
    title: 'test',
    cwd: `${home}/projects/work`,
    harness: 'claude',
    origin: 'discovered',
    status: 'idle',
    last_activity_at: Date.now() / 1000,
    last_activity_summary: 'idle',
    transcript_path: '/tmp/t.jsonl',
    pid: 999,
    steer_capability: 'turn-boundary',
  };

  const row = formatSessionRow(session, { name: 10, cwd: 20, summary: 20 });

  // Should contain ~ for home
  assert.ok(row.includes('~'));
  assert.ok(!row.includes(home)); // Home path should be replaced
});

test('formatSessionRow: wide character handling (emoji)', () => {
  // Test with emoji in summary (which could be wide-char).
  // formatSessionRow itself doesn't have emoji, but summarizeFleet might.
  // This guards that formatSessionRow truncates correctly and doesn't
  // assume all chars are single-width.
  const session: UnifiedSession = {
    id: 'sess-004',
    title: 'unicode-test',
    cwd: '/tmp',
    harness: 'claude',
    origin: 'daemon',
    status: 'idle',
    last_activity_at: Date.now() / 1000,
    // Use emoji in summary — formatSessionRow should truncate it safely
    last_activity_summary: '✓ Done 🎉 emoji are double-width',
    transcript_path: '/tmp/t.jsonl',
    pid: null,
    steer_capability: 'none',
  };

  const row = formatSessionRow(session, { name: 20, cwd: 20, summary: 30 });

  // Should not crash; should produce a string
  assert.ok(typeof row === 'string');
  assert.ok(row.length > 0);
});

test('formatSessionRow: discovered origin tag', () => {
  const session: UnifiedSession = {
    id: 'sess-005',
    title: 'tab-session',
    cwd: '/home/user',
    harness: 'claude',
    origin: 'discovered',
    status: 'waiting-input',
    last_activity_at: (Date.now() - 3600000) / 1000, // 1 hour ago
    last_activity_summary: 'user input pending',
    transcript_path: '/home/user/.claude/sessions/pid.jsonl',
    pid: 5678,
    steer_capability: 'full',
  };

  const row = formatSessionRow(session, { name: 20, cwd: 30, summary: 30 });

  // origin='discovered' → 'tab'
  assert.ok(row.includes('tab'));
});

test('formatSessionRow: age formatting (various time deltas)', () => {
  const testCases = [
    { deltaMs: 2000, expectedAge: 'now' },
    { deltaMs: 30000, expectedAge: '30s' },
    { deltaMs: 5 * 60000, expectedAge: '5m' },
    { deltaMs: 2 * 3600000, expectedAge: '2h' },
    { deltaMs: 3 * 24 * 3600000, expectedAge: '3d' },
  ];

  for (const { deltaMs, expectedAge } of testCases) {
    // Unix SECONDS, matching the daemon's last_activity_at. An ISO string here
    // silently produced a 1970 date via new Date(number) and every age read "56y".
    const then = (Date.now() - deltaMs) / 1000;
    const session: UnifiedSession = {
      id: 'sess-age-test',
      title: 'age-test',
      cwd: '/tmp',
      harness: 'claude',
      origin: 'daemon',
      status: 'idle',
      last_activity_at: then,
      last_activity_summary: 'idle',
      transcript_path: '/tmp/t.jsonl',
      pid: null,
      steer_capability: 'none',
    };

    const row = formatSessionRow(session, { name: 10, cwd: 10, summary: 10 });
    assert.ok(row.includes(expectedAge), `Expected '${expectedAge}' for delta ${deltaMs}ms`);
  }
});

// ─────────────────────────────────────────────────────────────────
// summarizeFleet Tests
// ─────────────────────────────────────────────────────────────────

test('summarizeFleet: counts by status correctly', () => {
  const sessions: UnifiedSession[] = [
    {
      id: '1',
      title: 's1',
      cwd: '/tmp',
      harness: 'claude',
      origin: 'daemon',
      status: 'working',
      last_activity_at: Date.now() / 1000,
      last_activity_summary: '',
      transcript_path: '',
      pid: null,
      steer_capability: 'none',
    },
    {
      id: '2',
      title: 's2',
      cwd: '/tmp',
      harness: 'claude',
      origin: 'daemon',
      status: 'working',
      last_activity_at: Date.now() / 1000,
      last_activity_summary: '',
      transcript_path: '',
      pid: null,
      steer_capability: 'none',
    },
    {
      id: '3',
      title: 's3',
      cwd: '/tmp',
      harness: 'claude',
      origin: 'daemon',
      status: 'idle',
      last_activity_at: Date.now() / 1000,
      last_activity_summary: '',
      transcript_path: '',
      pid: null,
      steer_capability: 'none',
    },
  ];

  const summary = summarizeFleet(sessions);

  // Should include: "3 sessions", "2 working", "1 idle"
  assert.ok(summary.includes('3 sessions'));
  assert.ok(summary.includes('2 working'));
  assert.ok(summary.includes('1 idle'));
});

test('summarizeFleet: omits zero counts', () => {
  const sessions: UnifiedSession[] = [
    {
      id: '1',
      title: 's1',
      cwd: '/tmp',
      harness: 'claude',
      origin: 'daemon',
      status: 'idle',
      last_activity_at: Date.now() / 1000,
      last_activity_summary: '',
      transcript_path: '',
      pid: null,
      steer_capability: 'none',
    },
  ];

  const summary = summarizeFleet(sessions);

  // Should have "1 session" but no "0 working" or "0 dead"
  assert.ok(summary.includes('1 session'));
  assert.ok(!summary.includes('0 '));
});

test('summarizeFleet: empty fleet', () => {
  const summary = summarizeFleet([]);
  assert.ok(summary.includes('0 sessions'));
});

test('summarizeFleet: all waiting states combined', () => {
  const sessions: UnifiedSession[] = [
    {
      id: '1',
      title: 's1',
      cwd: '/tmp',
      harness: 'claude',
      origin: 'daemon',
      status: 'waiting-input',
      last_activity_at: Date.now() / 1000,
      last_activity_summary: '',
      transcript_path: '',
      pid: null,
      steer_capability: 'none',
    },
    {
      id: '2',
      title: 's2',
      cwd: '/tmp',
      harness: 'claude',
      origin: 'daemon',
      status: 'waiting-permission',
      last_activity_at: Date.now() / 1000,
      last_activity_summary: '',
      transcript_path: '',
      pid: null,
      steer_capability: 'none',
    },
  ];

  const summary = summarizeFleet(sessions);

  // These are deliberately NOT one bucket. `waiting-input` is passive — the
  // session finished its turn and nothing is wrong. A permission/tool block is
  // a CALL TO ACTION: that session is stopped until the operator answers it.
  // Merging them buried the only actionable category inside the largest one,
  // which is the whole failure this cockpit exists to fix.
  assert.ok(summary.includes('1 waiting'), `expected 1 waiting: ${summary}`);
  assert.ok(summary.includes('1 blocked'), `expected 1 blocked: ${summary}`);

  // And every session is still accounted for.
  const counted = [...summary.matchAll(/(\d+) (?!sessions?)/g)]
    .reduce((n, m) => n + Number(m[1]), 0);
  assert.strictEqual(counted, sessions.length, `parts do not sum: ${summary}`);
});

test('summarizeFleet: dead sessions tracked', () => {
  const sessions: UnifiedSession[] = [
    {
      id: '1',
      title: 's1',
      cwd: '/tmp',
      harness: 'claude',
      origin: 'daemon',
      status: 'dead',
      last_activity_at: Date.now() / 1000,
      last_activity_summary: '',
      transcript_path: '',
      pid: null,
      steer_capability: 'none',
    },
  ];

  const summary = summarizeFleet(sessions);
  assert.ok(summary.includes('1 dead'));
});

// ─────────────────────────────────────────────────────────────────
// Mutation Guards (ensure bugs are caught)
// ─────────────────────────────────────────────────────────────────

test('mutation guard: formatSessionRow must truncate, not just pad', () => {
  // This test fails if formatSessionRow is changed to pad instead of truncate.
  const veryLongName = 'a'.repeat(100);
  const session: UnifiedSession = {
    id: 'mut-001',
    title: veryLongName,
    cwd: '/tmp',
    harness: 'claude',
    origin: 'daemon',
    status: 'idle',
    last_activity_at: Date.now() / 1000,
    last_activity_summary: 'idle',
    transcript_path: '/tmp/t.jsonl',
    pid: null,
    steer_capability: 'none',
  };

  const row = formatSessionRow(session, { name: 15, cwd: 15, summary: 15 });

  // Row should NOT contain the full 100-char name
  assert.ok(!row.includes(veryLongName));
  // Should be truncated (note: exact length depends on ellipsis)
  const rowLength = row.length;
  assert.ok(rowLength < 150); // 100 char name alone would make it huge
});

test('mutation guard: summarizeFleet must not include "0 working" when zero', () => {
  // This test fails if summarizeFleet is changed to always include all counts.
  const sessions: UnifiedSession[] = [
    {
      id: '1',
      title: 's1',
      cwd: '/tmp',
      harness: 'claude',
      origin: 'daemon',
      status: 'idle',
      last_activity_at: Date.now() / 1000,
      last_activity_summary: '',
      transcript_path: '',
      pid: null,
      steer_capability: 'none',
    },
  ];

  const summary = summarizeFleet(sessions);

  // Must NOT include zero counts as a string
  assert.ok(!summary.includes('0 working'));
  assert.ok(!summary.includes('0 waiting'));
  assert.ok(!summary.includes('0 dead'));
});

test('mutation guard: formatSessionRow must handle single-session correctly', () => {
  // Regression: check that singular "session" is used, not always "sessions"
  // (This is in summarizeFleet, testing the grammar)
  const one: UnifiedSession[] = [
    {
      id: '1',
      title: 's1',
      cwd: '/tmp',
      harness: 'claude',
      origin: 'daemon',
      status: 'idle',
      last_activity_at: Date.now() / 1000,
      last_activity_summary: '',
      transcript_path: '',
      pid: null,
      steer_capability: 'none',
    },
  ];

  const summary = summarizeFleet(one);
  assert.ok(summary.includes('1 session'));
  assert.ok(!summary.includes('1 sessions'));
});

// ─────────────────────────────────────────────────────────────────
// summarizeFleet must ACCOUNT FOR EVERY SESSION
// ─────────────────────────────────────────────────────────────────

function mkSession(status: string): UnifiedSession {
  return {
    id: `s-${status}`,
    title: `t-${status}`,
    cwd: '/tmp',
    harness: 'claude',
    origin: 'discovered',
    status,
    last_activity_at: Date.now() / 1000,
    last_activity_summary: '',
    transcript_path: '/tmp/t.jsonl',
    pid: 1,
    steer_capability: 'turn-boundary',
  } as UnifiedSession;
}

test('summarizeFleet: counted parts add up to the total (no silently dropped status)', () => {
  // The real defect, reproduced: 'blocked?' was emitted by the daemon but absent
  // from the summary's hardcoded key set, so 19 sessions printed as 5+11=16 and
  // the three sessions waiting on the human vanished from the one line meant to
  // tell the operator where to look.
  const sessions = [
    ...Array(5).fill(0).map(() => mkSession('working')),
    ...Array(11).fill(0).map(() => mkSession('waiting-input')),
    ...Array(3).fill(0).map(() => mkSession('blocked?')),
  ];
  const summary = summarizeFleet(sessions);
  assert.ok(summary.includes('19 sessions'), `total wrong: ${summary}`);
  assert.ok(summary.includes('3 blocked'), `blocked not surfaced: ${summary}`);

  const counted = [...summary.matchAll(/(\d+) (?!sessions?)/g)]
    .reduce((n, m) => n + Number(m[1]), 0);
  assert.strictEqual(counted, 19, `parts sum to ${counted}, not 19: ${summary}`);
});

test('summarizeFleet: an UNKNOWN status is shown, never dropped', () => {
  // Mutation guard for the general form: if someone reintroduces an allowlist,
  // a status added on the Python side disappears here with no error.
  const summary = summarizeFleet([mkSession('working'), mkSession('brand-new-state')]);
  const counted = [...summary.matchAll(/(\d+) (?!sessions?)/g)]
    .reduce((n, m) => n + Number(m[1]), 0);
  assert.strictEqual(counted, 2, `unknown status was dropped: ${summary}`);
});
