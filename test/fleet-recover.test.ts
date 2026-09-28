/**
 * `/docker recover` -- the targeted fleet-host recovery plan. No test runs wsl.
 */
import { strict as assert } from 'assert';
import { test, describe } from 'node:test';
import {
  fleetProbeArgv, fleetRecoverPlan, fleetStateIsUp, parseFleetState,
  readNodesFleetDistro, resolveFleetDistro,
} from '../src/fleet-recover.js';

const ENV = { AITHER_FLEET_DISTRO: 'fleetx' };

describe('fleet recover plan', () => {
  test('terminates the fleet distro only', () => {
    assert.deepEqual(fleetRecoverPlan(ENV)[0][1], ['wsl', '--terminate', 'fleetx']);
  });

  test('re-attaches the data disk, then probes systemd through the resolver', () => {
    const plan = fleetRecoverPlan(ENV);
    assert.deepEqual(plan[1][1], ['schtasks', '/run', '/tn', 'AitherOS-AttachFleetData']);
    assert.deepEqual(plan[2][1], ['wsl', '-d', 'fleetx', '-u', 'root', '--', 'systemctl', 'is-system-running']);
    assert.deepEqual(plan[2][1], fleetProbeArgv(ENV));
  });

  test('no step is a global shutdown or a VM kill', () => {
    for (const [, argv] of fleetRecoverPlan(ENV)) {
      const j = argv.join(' ').toLowerCase();
      assert.ok(!j.includes('--shutdown'), j);
      assert.ok(!j.includes('vmmem'), j);
      assert.ok(!j.includes('wslservice'), j);
      assert.ok(!j.includes('debian'), j);
    }
  });

  test('the attach task is overridable', () => {
    assert.equal(fleetRecoverPlan({ ...ENV, AITHER_FLEET_ATTACH_TASK: 'X' })[1][1][3], 'X');
  });
});

describe('fleet distro resolution', () => {
  test('env wins, in the resolver order', () => {
    assert.equal(resolveFleetDistro({ FLEET_DISTRO: 'b', AITHER_WSL_DISTRO: 'a' }), 'a');
  });

  test('nodes.yaml line scan matches the Python resolver', () => {
    const y = 'nodes:\n  debian-fleet:\n    host: x\n    fleet_distro: "awnix" # c\n  other:\n    fleet_distro: nope\n';
    assert.equal(readNodesFleetDistro(y), 'awnix');
    assert.equal(readNodesFleetDistro('nodes:\n  debian-fleet:\n    host: x\n  other:\n    fleet_distro: nope\n'), null);
    assert.equal(readNodesFleetDistro('nodes:\n  debian-fleet:\n    fleet_distro: bad name\n'), null);
  });

  test('default is awnix, never Debian', () => {
    assert.equal(resolveFleetDistro({ AITHER_NODES_YAML: 'Z:\\absent\\nodes.yaml' }).length > 0, true);
    assert.notEqual(resolveFleetDistro({ AITHER_NODES_YAML: 'Z:\\absent\\nodes.yaml' }), 'Debian');
  });
});

describe('fleet state judgement', () => {
  test('parses the last line and strips NULs', () => {
    assert.equal(parseFleetState('r\u0000u\u0000n\u0000\nrunning\n'), 'running');
    assert.equal(parseFleetState(''), 'unreachable');
    assert.equal(parseFleetState(null), 'unreachable');
  });

  test('up / mid-boot is left alone; offline and unreachable are not', () => {
    for (const s of ['running', 'degraded', 'starting']) assert.equal(fleetStateIsUp(s), true, s);
    for (const s of ['offline', 'unreachable', 'maintenance', '']) assert.equal(fleetStateIsUp(s), false, s);
  });
});
