/**
 * Fleet health from the runtime that runs the fleet.
 *
 * What must hold (measured 2026-11-09 in awnix: banner `10 down`, podman 54 containers,
 * 0 unhealthy): docker failing falls through to podman; podman's `(starting)` spelling
 * counts as starting; Exited(0) and Created are not faults; a crash is.
 */
import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  classifyStatus, containerPs, formatFleet, fleetProblems, measureFleet, summarizePs,
} from '../src/fleet-health.js';
import { discoverLocalServices, parseDockerPs } from '../src/status-banner.js';

const PODMAN = [
  'aitheros-flux\tExited (0) 5 weeks ago\t127.0.0.1:8117->8117/tcp',
  'exciting_hodgkin\tCreated\t8150/tcp',
  'aitheros-postgres\tUp 11 hours (healthy)\t127.0.0.1:5432->5432/tcp',
  'aitheros-pulse\tUp 13 seconds (starting)\t',
  'aitheros-strata\tUp 2 hours (unhealthy)\t',
  'aitheros-mail\tExited (137) 3 minutes ago\t',
  'aitheros-dns\tUp 11 hours\t53/tcp',
].join('\n');

test('classifyStatus: podman and docker spellings', () => {
  assert.equal(classifyStatus('Up 13 seconds (starting)'), 'starting');
  assert.equal(classifyStatus('Up 5 seconds (health: starting)'), 'starting');
  assert.equal(classifyStatus('Up 1 hour (healthy)'), 'healthy');
  assert.equal(classifyStatus('Up 1 hour (unhealthy)'), 'unhealthy');
  assert.equal(classifyStatus('Up 1 hour'), 'running');
  assert.equal(classifyStatus('Exited (0) 5 weeks ago'), 'idle');
  assert.equal(classifyStatus('Exited (1) 2 minutes ago'), 'failed');
  assert.equal(classifyStatus('Created'), 'idle');
});

test('summarizePs counts the whole fleet; finished jobs are not owed', () => {
  const f = summarizePs(PODMAN, 'podman');
  assert.equal(f.total, 7);
  assert.equal(f.running, 4);
  assert.equal(f.healthy, 1);
  assert.equal(f.starting, 1);
  assert.equal(f.unhealthy, 1);
  assert.equal(f.failed, 1);
  assert.equal(f.idle, 2);
  assert.deepEqual(f.unhealthyNames, ['aitheros-strata']);
  assert.deepEqual(f.failedNames, ['aitheros-mail']);
  assert.equal(formatFleet(f), 'fleet 4/5 up · 1 unhealthy · 1 crashed · 1 starting');
  assert.deepEqual(fleetProblems(f), ['aitheros-strata (unhealthy)', 'aitheros-mail (crashed)']);
});

test('fleetProblems caps at five and says how many more', () => {
  const rows = Array.from({ length: 8 }, (_, i) => `c${i}\tUp 1 hour (unhealthy)\t`).join('\n');
  const p = fleetProblems(summarizePs(rows, 'podman'));
  assert.equal(p.length, 6);
  assert.equal(p[5], '+3 more');
});

test('containerPs: docker missing falls through to podman', () => {
  const asked: string[] = [];
  const ps = containerPs((cmd) => {
    asked.push(cmd);
    return cmd === 'docker' ? { status: null, stdout: null } : { status: 0, stdout: PODMAN };
  });
  assert.deepEqual(asked, ['docker', 'podman']);
  assert.equal(ps?.runtime, 'podman');
});

test('containerPs: docker answering wins and podman is not asked', () => {
  const asked: string[] = [];
  const ps = containerPs((cmd) => { asked.push(cmd); return { status: 0, stdout: '' }; });
  assert.deepEqual(asked, ['docker']);
  assert.equal(ps?.runtime, 'docker');
  assert.equal(ps?.text, '');
});

test('no runtime answers -> null, never an empty fleet', () => {
  assert.equal(measureFleet(() => ({ status: 1, stdout: '' })), null);
});

test('banner discovery uses podman when docker is absent (the 10-down bug)', () => {
  const live = discoverLocalServices((cmd) =>
    cmd === 'docker' ? { status: null, stdout: null } : { status: 0, stdout: PODMAN });
  assert.ok(live);
  assert.equal(live!.get('aitheros-postgres')?.hostPort, '5432');
  assert.equal(live!.get('aitheros-pulse')?.health, 'starting');
});

test('parseDockerPs reads podman (starting) as starting', () => {
  assert.equal(parseDockerPs('x\tUp 3 seconds (starting)\t').get('x')?.health, 'starting');
});
