/**
 * /gpu, /gaming and /fleet are argv builders over AitherOS/dev/tools/fleet_verbs.py.
 * They never reach Docker Desktop (the pre-awnix /gaming did) and never implement a verb.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';

const { fleetVerbArgs, findFleetVerbsTool, fleetVerbCommand, FleetVerbError, FLEET_VERBS_REL } =
  await import('../src/fleet-verbs.js');
const { getCommand } = await import('../src/commands.js');

test('the owner verbs build the fleet_verbs argv; a typed command is the consent', () => {
  assert.deepEqual(fleetVerbArgs('gpu', 'sleep'), ['gpu', 'sleep', '--execute']);
  assert.deepEqual(fleetVerbArgs('gpu', 'wake'), ['gpu', 'wake', '--execute']);
  assert.deepEqual(fleetVerbArgs('gpu', 'wake --force'), ['gpu', 'wake', '--execute', '--force']);
  assert.deepEqual(fleetVerbArgs('gpu', 'status'), ['status']);
  assert.deepEqual(fleetVerbArgs('fleet', 'sleep'), ['fleet', 'sleep', '--execute']);
  assert.deepEqual(fleetVerbArgs('fleet', 'wake'), ['fleet', 'wake', '--execute']);
  assert.deepEqual(fleetVerbArgs('fleet', 'critical --dry-run'), ['fleet', 'critical']);
  assert.deepEqual(fleetVerbArgs('fleet', ''), ['status']);
  assert.deepEqual(fleetVerbArgs('gpu', 'sleep --json'), ['gpu', 'sleep', '--execute', '--json']);
});

test('the old /gaming words keep their meaning: off/stop/pause = sleep, on/start/resume = wake', () => {
  for (const w of ['off', 'stop', 'pause', 'light', '']) {
    assert.deepEqual(fleetVerbArgs('gpu', w), ['gpu', 'sleep', '--execute'], w);
  }
  for (const w of ['on', 'start', 'resume', 'up']) {
    assert.deepEqual(fleetVerbArgs('gpu', w), ['gpu', 'wake', '--execute'], w);
  }
  assert.deepEqual(fleetVerbArgs('fleet', 'down'), ['fleet', 'sleep', '--execute']);
  assert.deepEqual(fleetVerbArgs('fleet', 'up'), ['fleet', 'wake', '--execute']);
});

test('--force only rides on gpu wake; unknown words are refused; /fleet refresh is not a verb', () => {
  assert.deepEqual(fleetVerbArgs('gpu', 'sleep --force'), ['gpu', 'sleep', '--execute']);
  assert.throws(() => fleetVerbArgs('fleet', 'explode'), FleetVerbError);
  assert.throws(() => fleetVerbArgs('gpu', 'critical'), FleetVerbError);
  assert.equal(fleetVerbArgs('fleet', 'refresh --dry-run'), null);
});

test('the tool is found from AITHEROS_ROOT first, and spawned with the configured python', () => {
  const root = 'X:\\repo';
  const want = join(root, FLEET_VERBS_REL);
  const found = findFleetVerbsTool({ AITHEROS_ROOT: root }, '', (p: string) => p === want);
  assert.equal(found, want);
  assert.equal(findFleetVerbsTool({}, '', () => false), null);
  assert.deepEqual(fleetVerbCommand('t.py', ['gpu', 'sleep'], { AITHER_PYTHON: 'py3' }),
    { file: 'py3', args: ['t.py', 'gpu', 'sleep'] });
  assert.equal(fleetVerbCommand('t.py', [], {}, 'win32').file, 'python');
  assert.equal(fleetVerbCommand('t.py', [], {}, 'linux').file, 'python3');
});

test('/gpu, /gaming and /fleet are registered and /gaming is no longer the Docker script', () => {
  for (const name of ['gpu', 'gaming', 'fleet']) assert.ok(getCommand(name), name);
  assert.match(getCommand('gaming').description, /fleet_verbs/);
  assert.doesNotMatch(String(getCommand('gaming').handler), /Switch-GamingMode|docker/i);
  assert.match(getCommand('fleet').usage, /sleep\|wake\|critical/);
});

test('a refused or unjudgeable verb sets the process exit code (aither -c "gpu wake" in a script)', async () => {
  const { runFleetVerbCommand } = await import('../src/commands.js');
  const before = process.exitCode;
  const log = console.log;
  console.log = () => {};
  try {
    assert.equal(runFleetVerbCommand('gpu', 'explode'), 2);
    assert.equal(process.exitCode, 2);
    process.exitCode = 0;
    assert.equal(runFleetVerbCommand('gpu', 'help'), 0);
    assert.equal(process.exitCode, 0);
  } finally {
    console.log = log;
    process.exitCode = before;
  }
});
