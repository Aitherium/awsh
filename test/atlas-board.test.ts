/**
 * `aither -c board`.
 *
 * What must hold: the board is read through the MCP tool `atlas_board` (one
 * source for every surface), the server-rendered text is printed verbatim,
 * counts skip empty stages, and a gateway failure prints one line instead of
 * throwing out of `status`.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  fetchAtlasBoard, formatAtlasBoard, formatCounts, formatAge,
} from '../src/atlas-board.js';

const BOARD = {
  counts: { triage: 0, demiurge: 2, owner: 3, lyra: 1 },
  rows: [{ number: 15726, stage: 'owner', age_s: 7200, pr: 'https://github.com/x/y/pull/15726', thread: '1', thread_url: 'https://discord.com/channels/g/1' }],
  metrics: { merged_24h: 4 },
  text: 'ATLAS BOARD\n#15726 owner 2h',
  updated_at: 1793000000,
};

test('reads the atlas_board MCP tool, full view', async () => {
  const calls: Array<[string, unknown]> = [];
  const board = await fetchAtlasBoard(async (tool, params) => { calls.push([tool, params]); return BOARD; });
  assert.deepEqual(calls, [['atlas_board', { view: 'full' }]]);
  assert.equal(board.rows?.[0].number, 15726);
});

test('a JSON string answer is parsed; a non-JSON string becomes an error', async () => {
  assert.equal((await fetchAtlasBoard(async () => JSON.stringify(BOARD))).text, BOARD.text);
  assert.match(String((await fetchAtlasBoard(async () => 'boom')).error), /boom/);
});

test('a throwing transport never escapes', async () => {
  const board = await fetchAtlasBoard(async () => { throw new Error('gateway down'); });
  assert.equal(board.error, 'gateway down');
  assert.deepEqual(formatAtlasBoard(board), ['Atlas board unavailable: gateway down']);
});

test('counts: empty stages skipped, largest first', () => {
  assert.equal(formatCounts(BOARD.counts), 'owner 3 · demiurge 2 · lyra 1');
  assert.equal(formatCounts({ triage: 0 }), 'no tracked issues');
});

test('full prints the server text verbatim; counts-only does not', () => {
  const full = formatAtlasBoard(BOARD, { full: true });
  assert.ok(full.includes('  ATLAS BOARD'));
  assert.ok(full.some((l) => l.includes('updated 2026-')));
  const short = formatAtlasBoard(BOARD);
  assert.ok(!short.some((l) => l.includes('ATLAS BOARD')));
});

test('without server text, rows render with age and PR link', () => {
  const lines = formatAtlasBoard({ ...BOARD, text: '' }, { full: true });
  assert.ok(lines.some((l) => l.includes('#15726  owner  2h  https://github.com/x/y/pull/15726')));
  assert.equal(formatAge(90000), '1d');
  assert.equal(formatAge(undefined), '');
});
