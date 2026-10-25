/**
 * `/posture` (alias `/house`) + the status-bar posture segment.
 *
 * What must hold:
 *  - the words are exactly Veil's (Shop open / After hours / Game on / Dark / On schedule);
 *  - status prints the posture, the must-answer surfaces and every group with its verb;
 *  - a flip calls fleet_posture_set with {word, until?}; a bad word or until never calls;
 *  - wake -> fleet_group_wake, sleep -> fleet_group_park; an unknown park tool prints
 *    "sleep not available yet on this gateway";
 *  - the bar segment exists only for a measured, recent label and never fetches inline.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { mkdtempSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  POSTURE_LABELS, POSTURE_WORDS, SLEEP_UNAVAILABLE, cacheNeedsRefresh, formatHouse, gatherHouse,
  groupRow, isUnknownTool, postureLabel, postureView, readPostureCache, recordPosture,
  runPostureCommand, segmentFromCache, type ToolCaller,
} from '../src/posture-command.js';
import { formatStatusBar, type StatusInfo } from '../src/status-banner.js';
import { getCommand } from '../src/commands.js';

const tmpCache = () => join(mkdtempSync(join(tmpdir(), 'posture-')), 'posture-cache.json');

const STATUS = {
  ok: true, label: 'Dark', posture: { desired: 'dark', applied: 'dark' },
  surfaces: { acme: { status: 200, up: true }, app: { status: 200, up: true },
    hearth: { status: 0, up: false } },
  gpu: { parked: true }, next: { word: 'shop', at: '09:00' },
};
const LIST = { ok: true, groups: {
  darkmatter: { units: ['a'], doors: [], summary: 'Darkmatter' },
  acme: { units: ['b'], doors: [], summary: 'Acme' },
} };
const EACH: Record<string, unknown> = {
  darkmatter: { group: 'darkmatter', ok: true, up: false, state: 'parked', units: { a: 'parked' },
    eta_s: 40 },
  acme: { group: 'acme', ok: true, up: true, state: 'awake', units: { b: 'up' }, idle_s: 300,
    idle_park_min: 30 },
};

function fake(over: Record<string, unknown> = {}): { call: ToolCaller; calls: [string, unknown][] } {
  const calls: [string, unknown][] = [];
  const call: ToolCaller = async (name, args) => {
    calls.push([name, args]);
    if (name in over) return over[name];
    if (name === 'fleet_posture_status') return STATUS;
    if (name === 'fleet_group_status') return args.name ? EACH[String(args.name)] : LIST;
    return { ok: true };
  };
  return { call, calls };
}

test('labels are exactly Veil\'s', () => {
  assert.deepEqual([...POSTURE_WORDS], ['shop', 'after', 'game', 'dark', 'auto']);
  assert.deepEqual({ ...POSTURE_LABELS }, {
    shop: 'Shop open', after: 'After hours', game: 'Game on', dark: 'Dark', auto: 'On schedule',
  });
  assert.equal(postureLabel({ label: 'Dark' }), 'Dark');
  assert.equal(postureLabel({ label: 'dark-ish' }), 'unknown');
  assert.equal(postureLabel(null), 'unknown');
});

test('postureView names a down surface, the GPU and the next edge', () => {
  const v = postureView(STATUS);
  assert.equal(v.label, 'Dark');
  assert.equal(v.gpu, 'parked');
  assert.equal(v.next, 'Shop open at 09:00');
  assert.equal(v.problem, 'Hearth not answering.');
  assert.equal(postureView({ error: 'owner only' }).problem, 'owner only');
});

test('groupRow: up wins, otherwise the state, otherwise down/unknown', () => {
  assert.equal(groupRow('g', { up: true, state: 'parked' }).state, 'awake');
  assert.equal(groupRow('g', { up: false, state: 'waking' }).state, 'waking');
  assert.equal(groupRow('g', { up: false }).state, 'down');
  assert.equal(groupRow('g', null).state, 'unknown');
});

test('status prints posture, surfaces and every group with its verb', async () => {
  const lines: string[] = [];
  const { call } = fake();
  const rc = await runPostureCommand([], { call, print: l => lines.push(l), cachePath: tmpCache() });
  assert.equal(rc, 0);
  const text = lines.join('\n');
  assert.match(text, /House {2}● Dark/);
  assert.match(text, /Hearth DOWN/);
  assert.match(text, /darkmatter\s+parked.*\/posture wake darkmatter/);
  assert.match(text, /acme\s+awake\s+idle 5m · sleeps after 30m idle\s+\/posture sleep acme/);
});

test('status with no house answer exits 2 and says unknown', async () => {
  const lines: string[] = [];
  const call: ToolCaller = async () => { throw new Error('MCP gateway unreachable'); };
  const rc = await runPostureCommand([], { call, print: l => lines.push(l), cachePath: null });
  assert.equal(rc, 2);
  assert.match(lines.join('\n'), /● unknown/);
});

test('a flip sends {word, until} and updates the bar cache', async () => {
  const path = tmpCache();
  const { call, calls } = fake({ fleet_posture_set: { ok: true, word: 'game', label: 'Game on' } });
  const lines: string[] = [];
  const rc = await runPostureCommand(['game', '--until', '2h'],
    { call, print: l => lines.push(l), cachePath: path });
  assert.equal(rc, 0);
  assert.deepEqual(calls, [['fleet_posture_set', { word: 'game', until: '2h' }]]);
  assert.match(lines.join('\n'), /House is now Game on until 2h/);
  assert.equal(readPostureCache(path)?.label, 'Game on');
});

test('a pending flip says so; a refusal exits 1 with the reason', async () => {
  let lines: string[] = [];
  let f = fake({ fleet_posture_set: { ok: true, pending: true } });
  assert.equal(await runPostureCommand(['dark'], { call: f.call, print: l => lines.push(l), cachePath: null }), 0);
  assert.match(lines.join('\n'), /Dark -- still applying/);
  lines = [];
  f = fake({ fleet_posture_set: { ok: false, error: 'owner only (a proven owner sign-in)' } });
  assert.equal(await runPostureCommand(['shop'], { call: f.call, print: l => lines.push(l), cachePath: null }), 1);
  assert.match(lines.join('\n'), /Shop open: owner only/);
});

test('a bad word or until never reaches the gateway', async () => {
  const { call, calls } = fake();
  const print = () => {};
  assert.equal(await runPostureCommand(['party'], { call, print, cachePath: null }), 2);
  assert.equal(await runPostureCommand(['dark', '--until', 'tomorrow'], { call, print, cachePath: null }), 2);
  assert.equal(await runPostureCommand(['wake'], { call, print, cachePath: null }), 2);
  assert.deepEqual(calls, []);
});

test('wake -> fleet_group_wake with the eta', async () => {
  const { call, calls } = fake({ fleet_group_wake: { ok: true, group: 'darkmatter', state: 'starting', eta_s: 42 } });
  const lines: string[] = [];
  assert.equal(await runPostureCommand(['wake', 'DarkMatter'], { call, print: l => lines.push(l), cachePath: null }), 0);
  assert.deepEqual(calls, [['fleet_group_wake', { name: 'darkmatter' }]]);
  assert.match(lines.join('\n'), /darkmatter is waking up -- about 42 s/);
});

test('sleep -> fleet_group_park; an unknown tool says sleep is not available yet', async () => {
  let f = fake({ fleet_group_park: { ok: true, state: 'parked' } });
  let lines: string[] = [];
  assert.equal(await runPostureCommand(['sleep', 'acme'], { call: f.call, print: l => lines.push(l), cachePath: null }), 0);
  assert.deepEqual(f.calls, [['fleet_group_park', { name: 'acme' }]]);
  assert.match(lines.join('\n'), /acme is going to sleep \(parked\)/);
  lines = [];
  f = fake({ fleet_group_park: { error: 'Unknown tool: fleet_group_park' } });
  assert.equal(await runPostureCommand(['sleep', 'acme'], { call: f.call, print: l => lines.push(l), cachePath: null }), 2);
  assert.equal(lines.join('\n').trim(), SLEEP_UNAVAILABLE);
  const thrower: ToolCaller = async () => { throw new Error('MCP tools/call error: Tool not found: fleet_group_park'); };
  lines = [];
  assert.equal(await runPostureCommand(['sleep', 'acme'], { call: thrower, print: l => lines.push(l), cachePath: null }), 2);
  assert.equal(lines.join('\n').trim(), SLEEP_UNAVAILABLE);
  assert.equal(isUnknownTool({ error: 'owner only' }), false);
});

test('gatherHouse reports a missing group list instead of an empty one', async () => {
  const { call } = fake({ fleet_group_status: { ok: false, error: 'no unit plane here' } });
  const { view } = await gatherHouse(call);
  assert.equal(view.groupsProblem, 'no unit plane here');
  assert.match(formatHouse(view).join('\n'), /! no unit plane here/);
});

test('bar segment: measured + recent only; a failed refresh keeps the last label', () => {
  const now = 1_000_000;
  assert.deepEqual(segmentFromCache(null, now), { text: '', word: null, alert: false });
  const path = tmpCache();
  recordPosture(STATUS, path, now);
  const seg = segmentFromCache(readPostureCache(path), now + 10);
  assert.equal(seg.text, 'Dark · Hearth down');
  assert.equal(seg.word, 'dark');
  assert.equal(seg.alert, true);
  recordPosture({ error: 'gateway down' }, path, now + 120);
  const kept = readPostureCache(path);
  assert.equal(kept?.label, 'Dark');
  assert.equal(kept?.error, 'gateway down');
  assert.equal(cacheNeedsRefresh(kept, now + 130), false);
  assert.equal(cacheNeedsRefresh(kept, now + 200), true);
  assert.equal(segmentFromCache(kept, now + 4000).text, '');
});

test('status bar renders the posture segment', () => {
  const info: StatusInfo = {
    online: true, backendName: 'genesis', models: [], serviceLines: [],
    posture: { text: 'Shop open', word: 'shop', alert: false },
  } as unknown as StatusInfo;
  const seg = formatStatusBar(info).find(s => s.key === 'posture');
  assert.ok(seg);
  assert.equal(seg!.plain, '● Shop open');
});

test('/posture and /house resolve', () => {
  assert.ok(getCommand('posture'));
  assert.equal(getCommand('house'), getCommand('posture'));
});
